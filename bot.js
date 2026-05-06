'use strict';

require('dotenv').config();

const express    = require('express');
const crypto     = require('crypto');
const fs         = require('fs');
const path       = require('path');
const cron       = require('node-cron');
const nodemailer = require('nodemailer');
const axios      = require('axios');

// =====================================================================
// CONFIGURATION
// =====================================================================

const LIVE_TRADING    = process.env.LIVE_TRADING === 'true';
const WEBHOOK_SECRET  = process.env.WEBHOOK_SECRET || '';
const RISK_PER_TRADE  = parseFloat(process.env.RISK_PER_TRADE  || '2');
const MAX_DAILY_LOSS  = parseFloat(process.env.MAX_DAILY_LOSS  || '6');
const MAX_WEEKLY_LOSS = parseFloat(process.env.MAX_WEEKLY_LOSS || '10');
const PORT            = parseInt(process.env.PORT || '3000');

const SYMBOL_ALLOWLIST = (process.env.SYMBOL_ALLOWLIST || 'XRPUSDT,BTCUSDT,ETHUSDT,SOLUSDT')
    .split(',').map(s => s.trim().toUpperCase());

// Pairs that count as correlated (max 2 correlated pairs open at once)
const CORRELATED_GROUPS = [
    new Set(['BTCUSDT', 'ETHUSDT']),
    new Set(['SOLUSDT', 'AVAXUSDT']),
];

const TRADES_FILE  = path.join(__dirname, 'trades.json');
const HISTORY_FILE = path.join(__dirname, 'history.json');

// =====================================================================
// LOGGING
// =====================================================================

function log(level, message, data = null) {
    const ts   = new Date().toISOString();
    const line = `[${ts}] [${level.padEnd(5)}] ${message}`;
    console.log(line);
    if (data) console.log(JSON.stringify(data, null, 2));
}

// =====================================================================
// STATE — persisted to JSON flat files
// =====================================================================

let activeTrades     = {};   // { [symbol]: Trade }
let tradeHistory     = [];   // closed trades
let consecutiveLosses = 0;
let consecutiveWins   = 0;
let reducedSizing     = false;
let dailyPnL          = 0;   // percentage vs account
let weeklyPnL         = 0;
let dailyResetDate    = '';   // ISO date string for today
let weeklyResetDate   = '';   // ISO date string for this week's Monday

// Ring buffer for dedup — last 100 alert hashes
let recentHashes = [];

function loadState() {
    try {
        if (fs.existsSync(TRADES_FILE)) {
            const d = JSON.parse(fs.readFileSync(TRADES_FILE, 'utf8'));
            activeTrades      = d.activeTrades      || {};
            consecutiveLosses = d.consecutiveLosses || 0;
            consecutiveWins   = d.consecutiveWins   || 0;
            reducedSizing     = d.reducedSizing     || false;
            dailyPnL          = d.dailyPnL          || 0;
            weeklyPnL         = d.weeklyPnL         || 0;
            dailyResetDate    = d.dailyResetDate    || '';
            weeklyResetDate   = d.weeklyResetDate   || '';
            recentHashes      = d.recentHashes      || [];
            log('INFO', 'State loaded from trades.json');
        }
        if (fs.existsSync(HISTORY_FILE)) {
            tradeHistory = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
            log('INFO', `History loaded: ${tradeHistory.length} closed trades`);
        }
    } catch (err) {
        log('ERROR', `Failed to load state: ${err.message}`);
    }
}

function saveState() {
    try {
        const state = {
            activeTrades, consecutiveLosses, consecutiveWins,
            reducedSizing, dailyPnL, weeklyPnL,
            dailyResetDate, weeklyResetDate, recentHashes,
            updatedAt: new Date().toISOString(),
        };
        fs.writeFileSync(TRADES_FILE, JSON.stringify(state, null, 2));
    } catch (err) {
        log('ERROR', `Failed to save state: ${err.message}`);
    }
}

function saveHistory() {
    try {
        fs.writeFileSync(HISTORY_FILE, JSON.stringify(tradeHistory, null, 2));
    } catch (err) {
        log('ERROR', `Failed to save history: ${err.message}`);
    }
}

// Reset daily/weekly P&L counters when the period rolls over
function checkPeriodReset() {
    const nowDate   = new Date();
    const todayStr  = nowDate.toISOString().slice(0, 10);

    // Monday of this week
    const day  = nowDate.getDay();
    const diff = nowDate.getDate() - day + (day === 0 ? -6 : 1);
    const mon  = new Date(nowDate.setDate(diff));
    const weekStr = mon.toISOString().slice(0, 10);

    if (dailyResetDate !== todayStr) {
        log('INFO', `Daily reset: was ${dailyPnL.toFixed(2)}%`);
        dailyPnL       = 0;
        dailyResetDate = todayStr;
    }
    if (weeklyResetDate !== weekStr) {
        log('INFO', `Weekly reset: was ${weeklyPnL.toFixed(2)}%`);
        weeklyPnL       = 0;
        weeklyResetDate = weekStr;
    }
}

// =====================================================================
// WEBHOOK SECURITY
// =====================================================================

function verifySecret(req) {
    const qs  = req.query.secret;
    const hdr = req.headers['x-webhook-secret'];
    const provided = qs || hdr || '';
    if (!WEBHOOK_SECRET) return true;   // no secret configured → open
    return provided === WEBHOOK_SECRET;
}

function hashAlert(payload) {
    // If no timestamp (e.g. SSQ signals), bucket to the nearest minute so
    // duplicate fires within the same bar are still caught.
    const ts = payload.timestamp || Math.floor(Date.now() / 60000) * 60000;
    return crypto
        .createHash('sha256')
        .update(JSON.stringify({ s: payload.signal, t: payload.ticker, ts }))
        .digest('hex');
}

function isDuplicate(hash) {
    if (recentHashes.includes(hash)) return true;
    recentHashes.push(hash);
    if (recentHashes.length > 100) recentHashes.shift();
    return false;
}

function isStale(timestamp) {
    // timestamp from TradingView is Unix ms or ISO string
    try {
        const alertTime = new Date(
            typeof timestamp === 'number' ? timestamp : parseInt(timestamp, 10)
        );
        const ageSecs = (Date.now() - alertTime.getTime()) / 1000;
        return ageSecs > 120;  // reject alerts older than 2 minutes
    } catch {
        return false;   // if we can't parse, allow through
    }
}

// =====================================================================
// BITGET API (live mode only)
// =====================================================================

function bitgetSign(timestamp, method, reqPath, body = '') {
    const msg = `${timestamp}${method.toUpperCase()}${reqPath}${body}`;
    return crypto
        .createHmac('sha256', process.env.BROKER_API_SECRET || '')
        .update(msg)
        .digest('base64');
}

async function bitgetRequest(method, reqPath, data = null) {
    const timestamp = Date.now().toString();
    const body      = data ? JSON.stringify(data) : '';
    const sign      = bitgetSign(timestamp, method, reqPath, body);

    const headers = {
        'ACCESS-KEY':        process.env.BROKER_API_KEY        || '',
        'ACCESS-SIGN':       sign,
        'ACCESS-TIMESTAMP':  timestamp,
        'ACCESS-PASSPHRASE': process.env.BROKER_API_PASSPHRASE || '',
        'Content-Type':      'application/json',
        'locale':            'en-US',
    };

    const url = (process.env.BROKER_BASE_URL || 'https://api.bitget.com') + reqPath;

    try {
        const resp = await axios({ method, url, headers, data: data || undefined, timeout: 10000 });
        if (resp.data?.code !== '00000' && resp.data?.code !== 0) {
            throw new Error(`Bitget: ${resp.data?.msg || 'unknown error'}`);
        }
        return resp.data;
    } catch (err) {
        const msg = err.response?.data?.msg || err.message;
        throw new Error(`Bitget API error [${method} ${reqPath}]: ${msg}`);
    }
}

async function getAccountBalance() {
    const resp = await bitgetRequest(
        'GET',
        '/api/v2/mix/account/account?symbol=BTCUSDT&productType=USDT-FUTURES&marginCoin=USDT'
    );
    return parseFloat(resp?.data?.equity || '0');
}

async function placeFuturesOrder({ symbol, side, orderType, price, size, reduceOnly = false, tpPrice = null, slPrice = null }) {
    const payload = {
        symbol,
        productType:  'USDT-FUTURES',
        marginMode:   'crossed',
        marginCoin:   'USDT',
        side,
        orderType:    orderType === 'Market' ? 'market' : 'limit',
        size:         size.toFixed(6),
        reduceOnly:   reduceOnly ? 'YES' : 'NO',
    };
    if (price && orderType !== 'Market') payload.price = price.toString();
    if (tpPrice)  payload.presetStopSurplusPrice = tpPrice.toString();
    if (slPrice)  payload.presetStopLossPrice    = slPrice.toString();

    return bitgetRequest('POST', '/api/v2/mix/order/place-order', payload);
}

async function cancelOrder(symbol, orderId) {
    return bitgetRequest('POST', '/api/v2/mix/order/cancel-order', {
        symbol, orderId, productType: 'USDT-FUTURES',
    });
}

// =====================================================================
// POSITION SIZE CALCULATION
// =====================================================================

function computePositionSize(entryPrice, stopPrice, accountBalance) {
    const riskUSDT   = accountBalance * (RISK_PER_TRADE / 100);
    const riskPerUnit = Math.abs(entryPrice - stopPrice);
    if (riskPerUnit === 0) return 0;
    let size = riskUSDT / riskPerUnit;
    if (reducedSizing) {
        size *= 0.5;
        log('WARN', 'Reduced sizing active (2+ consecutive losses)');
    }
    return size;
}

// =====================================================================
// CORRELATION GUARD — max 2 correlated pairs open simultaneously
// =====================================================================

function correlatedOpenCount(symbol) {
    const group = CORRELATED_GROUPS.find(g => g.has(symbol));
    if (!group) return 0;
    return Object.keys(activeTrades).filter(sym => group.has(sym) && sym !== symbol).length;
}

// =====================================================================
// TRADE MANAGEMENT
// =====================================================================

async function handleBuySignal(payload) {
    const { ticker, entry, stop, tp1, tp2, tp3, score, risk_reward, order_type } = payload;

    if (activeTrades[ticker]) {
        log('INFO', `[BUY] Already in trade for ${ticker} — skipped`);
        return { status: 'skipped', reason: 'already_in_trade' };
    }

    checkPeriodReset();

    if (dailyPnL <= -MAX_DAILY_LOSS) {
        log('WARN', `[BUY] Daily loss limit hit (${dailyPnL.toFixed(2)}%) — skipped`);
        return { status: 'skipped', reason: 'daily_loss_limit' };
    }
    if (weeklyPnL <= -MAX_WEEKLY_LOSS) {
        log('WARN', `[BUY] Weekly loss limit hit (${weeklyPnL.toFixed(2)}%) — skipped`);
        return { status: 'skipped', reason: 'weekly_loss_limit' };
    }
    if (correlatedOpenCount(ticker) >= 2) {
        log('WARN', `[BUY] Correlation limit for ${ticker} — skipped`);
        return { status: 'skipped', reason: 'correlation_limit' };
    }

    const entryPrice = parseFloat(entry);
    const stopPrice  = parseFloat(stop);
    const tp1Price   = parseFloat(tp1);
    const tp2Price   = parseFloat(tp2);
    const tp3Price   = parseFloat(tp3);

    if ([entryPrice, stopPrice, tp1Price, tp2Price].some(isNaN)) {
        return { status: 'error', reason: 'invalid_price_levels' };
    }
    if (stopPrice >= entryPrice) {
        return { status: 'error', reason: 'stop_above_entry' };
    }

    let accountBalance = LIVE_TRADING ? 0 : parseFloat(process.env.PAPER_BALANCE || '10000');

    if (LIVE_TRADING) {
        try {
            accountBalance = await getAccountBalance();
            log('INFO', `[LIVE] Account balance: ${accountBalance} USDT`);
        } catch (err) {
            log('ERROR', `[LIVE] Balance fetch failed: ${err.message}`);
            return { status: 'error', reason: err.message };
        }
    }

    const posSize = computePositionSize(entryPrice, stopPrice, accountBalance);
    if (posSize <= 0) {
        return { status: 'error', reason: 'invalid_position_size' };
    }

    const trade = {
        id:            `${ticker}_${Date.now()}`,
        symbol:        ticker,
        entryPrice,
        stopPrice,
        currentStop:   stopPrice,
        tp1Price,
        tp2Price,
        tp3Price,
        posSize,
        remainingSize: posSize,
        score:         parseInt(score) || 0,
        riskReward:    parseFloat(risk_reward) || 0,
        orderType:     order_type || 'Limit',
        openTime:      new Date().toISOString(),
        status:        'OPEN',
        tp1Hit:        false,
        tp2Hit:        false,
        realizedPnL:   0,
        mode:          LIVE_TRADING ? 'LIVE' : 'PAPER',
        liveOrderIds:  {},
    };

    if (LIVE_TRADING) {
        try {
            const entryOrder = await placeFuturesOrder({
                symbol:    ticker,
                side:      'buy',
                orderType: order_type || 'Limit',
                price:     entryPrice,
                size:      posSize,
                slPrice:   stopPrice,
            });
            trade.liveOrderIds.entry = entryOrder?.data?.orderId;
            log('INFO', `[LIVE] Entry order: ${trade.liveOrderIds.entry}`);
        } catch (err) {
            log('ERROR', `[LIVE] Order failed: ${err.message}`);
            return { status: 'error', reason: err.message };
        }
    } else {
        log('INFO', `[PAPER] BUY ${ticker} @ ${entryPrice} | SL: ${stopPrice} | TP1: ${tp1Price} | TP2: ${tp2Price} | Size: ${posSize.toFixed(4)}`);
    }

    activeTrades[ticker] = trade;
    saveState();
    await sendEmail('buy', trade);
    return { status: 'ok', trade };
}

async function handleTP1Hit(payload) {
    const trade = activeTrades[payload.ticker];
    if (!trade)           return { status: 'skipped', reason: 'no_active_trade' };
    if (trade.tp1Hit)     return { status: 'skipped', reason: 'tp1_already_hit' };

    const closeSize = trade.posSize * 0.4;
    const pnl       = (trade.tp1Price - trade.entryPrice) * closeSize;
    trade.realizedPnL  += pnl;
    trade.tp1Hit        = true;
    trade.remainingSize = trade.posSize * 0.6;
    trade.currentStop   = trade.entryPrice;   // move to breakeven

    const pnlPct = (pnl / (closeSize * trade.entryPrice)) * 100;
    dailyPnL  += pnlPct;
    weeklyPnL += pnlPct;

    log('INFO', `[TP1] ${trade.symbol}: partial exit 40% @ ${trade.tp1Price} | PnL: ${pnl.toFixed(2)} USDT | Stop → BE`);
    saveState();
    await sendEmail('tp1', trade);
    return { status: 'ok', trade };
}

async function handleTP2Hit(payload) {
    const trade = activeTrades[payload.ticker];
    if (!trade)           return { status: 'skipped', reason: 'no_active_trade' };
    if (!trade.tp1Hit)    return { status: 'skipped', reason: 'tp1_not_yet_hit' };
    if (trade.tp2Hit)     return { status: 'skipped', reason: 'tp2_already_hit' };

    const closeSize = trade.posSize * 0.4;
    const pnl       = (trade.tp2Price - trade.entryPrice) * closeSize;
    trade.realizedPnL  += pnl;
    trade.tp2Hit        = true;
    trade.remainingSize = trade.posSize * 0.2;

    const pnlPct = (pnl / (closeSize * trade.entryPrice)) * 100;
    dailyPnL  += pnlPct;
    weeklyPnL += pnlPct;

    log('INFO', `[TP2] ${trade.symbol}: partial exit 40% @ ${trade.tp2Price} | PnL: ${pnl.toFixed(2)} USDT | Trailing runner`);
    saveState();
    await sendEmail('tp2', trade);
    return { status: 'ok', trade };
}

async function handleMoveStop(payload) {
    const trade    = activeTrades[payload.ticker];
    const newStop  = parseFloat(payload.stop);

    if (!trade) return { status: 'skipped', reason: 'no_active_trade' };
    if (isNaN(newStop)) return { status: 'error', reason: 'invalid_stop' };

    // Strict: never widen stop (new stop must be >= old stop for longs)
    if (newStop < trade.currentStop) {
        log('WARN', `[STOP] Refused to widen stop for ${trade.symbol}: ${trade.currentStop} → ${newStop}`);
        return { status: 'rejected', reason: 'cannot_widen_stop' };
    }

    trade.currentStop = newStop;
    log('INFO', `[STOP] ${trade.symbol} stop updated: ${newStop}`);
    saveState();
    return { status: 'ok', trade };
}

async function handleExitTrade(payload) {
    const trade     = activeTrades[payload.ticker];
    if (!trade) return { status: 'skipped', reason: 'no_active_trade' };

    const exitPrice = parseFloat(payload.entry);  // current close price from TradingView
    const finalPnl  = (exitPrice - trade.entryPrice) * trade.remainingSize;
    trade.realizedPnL += finalPnl;
    trade.status       = 'CLOSED';
    trade.closeTime    = new Date().toISOString();
    trade.exitPrice    = exitPrice;

    const pnlPct = (finalPnl / (trade.remainingSize * trade.entryPrice)) * 100;
    dailyPnL  += pnlPct;
    weeklyPnL += pnlPct;

    if (trade.realizedPnL > 0) {
        consecutiveWins++;
        consecutiveLosses = 0;
        if (reducedSizing) {
            reducedSizing = false;
            log('INFO', '[RISK] Normal sizing restored after win');
        }
    } else {
        consecutiveLosses++;
        consecutiveWins = 0;
        if (consecutiveLosses >= 2 && !reducedSizing) {
            reducedSizing = true;
            log('WARN', '[RISK] Reduced sizing activated (2 consecutive losses)');
        }
    }

    log('INFO', `[EXIT] ${trade.symbol} closed @ ${exitPrice} | Total PnL: ${trade.realizedPnL.toFixed(2)} USDT`);

    tradeHistory.push({ ...trade });
    delete activeTrades[trade.symbol];

    saveState();
    saveHistory();
    await sendEmail('exit', trade);
    return { status: 'ok', trade };
}

// =====================================================================
// SSQ STRATEGY HANDLERS
// =====================================================================

async function handleSSQEntry(payload, direction) {
    const { ticker } = payload;

    if (activeTrades[ticker]) {
        log('INFO', `[SSQ] Already in trade for ${ticker} — skipped`);
        return { status: 'skipped', reason: 'already_in_trade' };
    }

    checkPeriodReset();

    if (dailyPnL <= -MAX_DAILY_LOSS) {
        log('WARN', `[SSQ] Daily loss limit hit (${dailyPnL.toFixed(2)}%) — skipped`);
        return { status: 'skipped', reason: 'daily_loss_limit' };
    }
    if (weeklyPnL <= -MAX_WEEKLY_LOSS) {
        log('WARN', `[SSQ] Weekly loss limit hit (${weeklyPnL.toFixed(2)}%) — skipped`);
        return { status: 'skipped', reason: 'weekly_loss_limit' };
    }
    if (correlatedOpenCount(ticker) >= 2) {
        log('WARN', `[SSQ] Correlation limit for ${ticker} — skipped`);
        return { status: 'skipped', reason: 'correlation_limit' };
    }

    const entryPrice = parseFloat(payload.entry) || 0;
    if (!entryPrice) {
        log('WARN', '[SSQ] No entry price in payload — add entry:{{close}} to your TradingView alert message');
    }

    let accountBalance = LIVE_TRADING ? 0 : parseFloat(process.env.PAPER_BALANCE || '10000');
    if (LIVE_TRADING) {
        try {
            accountBalance = await getAccountBalance();
            log('INFO', `[LIVE] Account balance: ${accountBalance} USDT`);
        } catch (err) {
            log('ERROR', `[LIVE] Balance fetch failed: ${err.message}`);
            return { status: 'error', reason: err.message };
        }
    }

    // Size the position so the notional value = RISK_PER_TRADE% of account.
    // (No stop distance provided by SSQ, so flat-% notional sizing is used.)
    const posValue = accountBalance * (RISK_PER_TRADE / 100);
    let posSize = entryPrice > 0 ? posValue / entryPrice : posValue;
    if (reducedSizing) {
        posSize *= 0.5;
        log('WARN', 'Reduced sizing active (2+ consecutive losses)');
    }

    const trade = {
        id:            `${ticker}_SSQ_${Date.now()}`,
        symbol:        ticker,
        strategy:      'SSQ',
        direction,
        entryPrice,
        posSize,
        remainingSize: posSize,
        openTime:      new Date().toISOString(),
        status:        'OPEN',
        realizedPnL:   0,
        mode:          LIVE_TRADING ? 'LIVE' : 'PAPER',
        liveOrderIds:  {},
    };

    if (LIVE_TRADING) {
        try {
            const side = direction === 'long' ? 'buy' : 'sell';
            const order = await placeFuturesOrder({ symbol: ticker, side, orderType: 'Market', size: posSize });
            trade.liveOrderIds.entry = order?.data?.orderId;
            log('INFO', `[LIVE][SSQ] ${direction.toUpperCase()} order: ${trade.liveOrderIds.entry}`);
        } catch (err) {
            log('ERROR', `[LIVE][SSQ] Order failed: ${err.message}`);
            return { status: 'error', reason: err.message };
        }
    } else {
        log('INFO', `[PAPER][SSQ] ${direction.toUpperCase()} ${ticker} @ ${entryPrice || 'unknown'} | Size: ${posSize.toFixed(4)}`);
    }

    activeTrades[ticker] = trade;
    saveState();
    await sendEmail('ssq_entry', trade);
    return { status: 'ok', trade };
}

async function handleSSQExit(payload) {
    const trade = activeTrades[payload.ticker];
    if (!trade) return { status: 'skipped', reason: 'no_active_trade' };

    const exitPrice = parseFloat(payload.entry) || 0;

    let finalPnl = 0;
    if (exitPrice > 0 && trade.entryPrice > 0) {
        const diff = trade.direction === 'long'
            ? exitPrice - trade.entryPrice
            : trade.entryPrice - exitPrice;
        finalPnl = diff * trade.remainingSize;

        const pnlPct = (finalPnl / (trade.remainingSize * trade.entryPrice)) * 100;
        dailyPnL  += pnlPct;
        weeklyPnL += pnlPct;
    }

    trade.realizedPnL += finalPnl;
    trade.status    = 'CLOSED';
    trade.closeTime = new Date().toISOString();
    trade.exitPrice = exitPrice;

    if (trade.realizedPnL > 0) {
        consecutiveWins++;
        consecutiveLosses = 0;
        if (reducedSizing) {
            reducedSizing = false;
            log('INFO', '[RISK] Normal sizing restored after win');
        }
    } else {
        consecutiveLosses++;
        consecutiveWins = 0;
        if (consecutiveLosses >= 2 && !reducedSizing) {
            reducedSizing = true;
            log('WARN', '[RISK] Reduced sizing activated (2 consecutive losses)');
        }
    }

    log('INFO', `[SSQ][EXIT] ${trade.symbol} ${trade.direction} closed @ ${exitPrice} | PnL: ${trade.realizedPnL.toFixed(2)} USDT`);

    tradeHistory.push({ ...trade });
    delete activeTrades[trade.symbol];
    saveState();
    saveHistory();
    await sendEmail('ssq_exit', trade);
    return { status: 'ok', trade };
}

// =====================================================================
// EMAIL
// =====================================================================

let mailer     = null;
let mailerType = null;   // 'smtp' | 'resend' | null  — set once at startup

function initMailer() {
    if (process.env.SMTP_HOST && process.env.SMTP_USER) {
        mailer = nodemailer.createTransport({
            host:   process.env.SMTP_HOST,
            port:   parseInt(process.env.SMTP_PORT || '587'),
            secure: process.env.SMTP_SECURE === 'true',
            auth: {
                user: process.env.SMTP_USER,
                pass: process.env.SMTP_PASS,
            },
        });
        mailerType = 'smtp';
        log('INFO', `Mailer: SMTP (${process.env.SMTP_HOST})`);
    } else if (process.env.RESEND_API_KEY) {
        mailerType = 'resend';
        log('INFO', 'Mailer: Resend API');
    } else {
        log('WARN', 'No email provider configured — emails disabled');
    }
}

async function sendRaw(subject, html) {
    const from = process.env.EMAIL_FROM;
    const to   = process.env.EMAIL_TO;
    if (!from || !to) { log('WARN', `Email skipped — FROM/TO not set`); return; }

    try {
        // Use whichever provider was selected at startup — never mix them
        if (mailerType === 'smtp' && mailer) {
            await mailer.sendMail({ from, to, subject, html });
        } else if (mailerType === 'resend') {
            await axios.post('https://api.resend.com/emails',
                { from, to, subject, html },
                { headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}` }, timeout: 10000 }
            );
        } else {
            log('WARN', 'No mailer — skipping: ' + subject);
            return;
        }
        log('INFO', `Email sent: ${subject}`);
    } catch (err) {
        log('ERROR', `Email failed: ${err.message}`);
    }
}

const MODE_BADGE = `<span style="background:${LIVE_TRADING ? '#c0392b' : '#27ae60'};color:#fff;padding:2px 6px;border-radius:3px">${LIVE_TRADING ? '🔴 LIVE' : '📄 PAPER'}</span>`;

async function sendEmail(type, trade) {
    const sym = trade.symbol;
    let subject, html;

    switch (type) {
        case 'buy':
            subject = `🟢 Bear Trap BUY: ${sym} @ ${trade.entryPrice}`;
            html = `<h2>New Signal — ${sym}</h2>
${MODE_BADGE}
<table border="1" cellpadding="6" style="border-collapse:collapse">
<tr><td>Entry</td><td><strong>${trade.entryPrice}</strong></td></tr>
<tr><td>Stop Loss</td><td style="color:red">${trade.stopPrice}</td></tr>
<tr><td>TP1 (40%)</td><td>${trade.tp1Price}</td></tr>
<tr><td>TP2 (40%)</td><td>${trade.tp2Price}</td></tr>
<tr><td>TP3 (20%)</td><td>${trade.tp3Price}</td></tr>
<tr><td>Score</td><td>${trade.score}/5</td></tr>
<tr><td>R/R</td><td>${trade.riskReward}:1</td></tr>
<tr><td>Position Size</td><td>${trade.posSize.toFixed(4)}</td></tr>
</table>`;
            break;

        case 'tp1':
            subject = `✅ TP1 Hit: ${sym}`;
            html = `<h2>TP1 Hit — ${sym}</h2>
${MODE_BADGE}
<p>Exit 40% @ <strong>${trade.tp1Price}</strong></p>
<p>Stop moved to breakeven: <strong>${trade.entryPrice}</strong></p>
<p>Realized PnL so far: <strong>${trade.realizedPnL.toFixed(2)} USDT</strong></p>`;
            break;

        case 'tp2':
            subject = `✅✅ TP2 Hit: ${sym}`;
            html = `<h2>TP2 Hit — ${sym}</h2>
${MODE_BADGE}
<p>Exit 40% @ <strong>${trade.tp2Price}</strong></p>
<p>Trailing 20% runner active.</p>
<p>Realized PnL so far: <strong>${trade.realizedPnL.toFixed(2)} USDT</strong></p>`;
            break;

        case 'exit': {
            const isWin = trade.realizedPnL > 0;
            subject = `${isWin ? '💰' : '🔴'} CLOSED ${sym} | ${trade.realizedPnL.toFixed(2)} USDT`;
            html = `<h2>Trade Closed — ${sym}</h2>
${MODE_BADGE}
<table border="1" cellpadding="6" style="border-collapse:collapse">
<tr><td>Entry</td><td>${trade.entryPrice}</td></tr>
<tr><td>Exit</td><td>${trade.exitPrice}</td></tr>
<tr><td>Total PnL</td><td style="color:${isWin ? 'green' : 'red'}">${trade.realizedPnL.toFixed(2)} USDT</td></tr>
<tr><td>Opened</td><td>${trade.openTime}</td></tr>
<tr><td>Closed</td><td>${trade.closeTime}</td></tr>
<tr><td>Consec. Wins</td><td>${consecutiveWins}</td></tr>
<tr><td>Consec. Losses</td><td>${consecutiveLosses}</td></tr>
</table>`;
            break;
        }

        case 'ssq_entry': {
            const dir = trade.direction === 'long' ? '🟢 LONG' : '🔴 SHORT';
            subject = `${dir} SSQ: ${sym} @ ${trade.entryPrice || 'market'}`;
            html = `<h2>SSQ ${trade.direction.toUpperCase()} — ${sym}</h2>
${MODE_BADGE}
<table border="1" cellpadding="6" style="border-collapse:collapse">
<tr><td>Direction</td><td><strong>${trade.direction.toUpperCase()}</strong></td></tr>
<tr><td>Entry</td><td>${trade.entryPrice || 'unknown (add entry:{{close}} to alert)'}</td></tr>
<tr><td>Size</td><td>${trade.posSize.toFixed(4)}</td></tr>
<tr><td>Strategy</td><td>SSQ</td></tr>
<tr><td>Mode</td><td>${trade.mode}</td></tr>
</table>`;
            break;
        }

        case 'ssq_exit': {
            const isWin = trade.realizedPnL > 0;
            subject = `${isWin ? '💰' : '🔴'} SSQ CLOSED ${sym} | ${trade.realizedPnL.toFixed(2)} USDT`;
            html = `<h2>SSQ Trade Closed — ${sym}</h2>
${MODE_BADGE}
<table border="1" cellpadding="6" style="border-collapse:collapse">
<tr><td>Direction</td><td>${trade.direction.toUpperCase()}</td></tr>
<tr><td>Entry</td><td>${trade.entryPrice}</td></tr>
<tr><td>Exit</td><td>${trade.exitPrice}</td></tr>
<tr><td>Total PnL</td><td style="color:${isWin ? 'green' : 'red'}">${trade.realizedPnL.toFixed(2)} USDT</td></tr>
<tr><td>Opened</td><td>${trade.openTime}</td></tr>
<tr><td>Closed</td><td>${trade.closeTime}</td></tr>
</table>`;
            break;
        }

        default:
            return;
    }

    await sendRaw(subject, html);
}

// =====================================================================
// DAILY REPORT (07:00 UK)
// =====================================================================

async function sendDailyReport() {
    log('INFO', 'Sending daily report...');

    const todayStr  = new Date().toDateString();
    const overnight = tradeHistory.filter(t => {
        if (!t.closeTime) return false;
        return new Date(t.closeTime).toDateString() === todayStr;
    });

    const openArr   = Object.values(activeTrades);

    function tradeRecommendation(trade) {
        if (!trade.tp1Hit)              return 'WAIT — TP1 not yet reached';
        if (trade.tp1Hit && !trade.tp2Hit) return 'HOLD — TP2 in progress';
        return 'HOLD — trailing runner';
    }

    let html = `<h1>Bear Trap Trade Pro — Daily Report</h1>
<p><strong>Date:</strong> ${new Date().toUTCString()}</p>
<h2>Open Trades (${openArr.length})</h2>`;

    if (openArr.length === 0) {
        html += '<p>No open trades.</p>';
    } else {
        openArr.forEach(t => {
            html += `<h3>${t.symbol}</h3>
<table border="1" cellpadding="6" style="border-collapse:collapse">
<tr><td>Entry</td><td>${t.entryPrice}</td></tr>
<tr><td>Current Stop</td><td>${t.currentStop}</td></tr>
<tr><td>TP1</td><td>${t.tp1Price} ${t.tp1Hit ? '✅' : '—'}</td></tr>
<tr><td>TP2</td><td>${t.tp2Price} ${t.tp2Hit ? '✅' : '—'}</td></tr>
<tr><td>TP3</td><td>${t.tp3Price}</td></tr>
<tr><td>Realized PnL</td><td>${t.realizedPnL.toFixed(2)} USDT</td></tr>
<tr><td>Recommendation</td><td><strong>${tradeRecommendation(t)}</strong></td></tr>
</table>`;
        });
    }

    html += `<h2>Closed Overnight (${overnight.length})</h2>`;
    overnight.forEach(t => {
        html += `<p>${t.symbol}: ${t.realizedPnL > 0 ? '✅' : '❌'} ${t.realizedPnL.toFixed(2)} USDT</p>`;
    });

    const weekTrades = tradeHistory.filter(t => {
        const mon = new Date(); mon.setDate(mon.getDate() - mon.getDay() + 1); mon.setHours(0,0,0,0);
        return t.closeTime && new Date(t.closeTime) >= mon;
    });
    const wins     = weekTrades.filter(t => t.realizedPnL > 0).length;
    const winRate  = weekTrades.length > 0 ? ((wins / weekTrades.length) * 100).toFixed(1) : 'N/A';

    html += `<h2>This Week</h2>
<p>Trades: ${weekTrades.length} | Win Rate: ${winRate}%</p>
<p>Daily P&amp;L: ${dailyPnL.toFixed(2)}% | Weekly P&amp;L: ${weeklyPnL.toFixed(2)}%</p>
<p>Consecutive Losses: ${consecutiveLosses} | Reduced Sizing: ${reducedSizing ? '⚠️ YES' : 'No'}</p>`;

    await sendRaw('📊 Bear Trap Daily Report — ' + new Date().toDateString(), html);
}

// =====================================================================
// WEEKLY REPORT (Sunday 08:00 UK)
// =====================================================================

async function sendWeeklyReport() {
    log('INFO', 'Sending weekly report...');

    const mon = new Date();
    mon.setDate(mon.getDate() - mon.getDay() + 1);
    mon.setHours(0, 0, 0, 0);

    const weekTrades = tradeHistory.filter(t => t.closeTime && new Date(t.closeTime) >= mon);

    const wins   = weekTrades.filter(t => t.realizedPnL > 0);
    const losses = weekTrades.filter(t => t.realizedPnL <= 0);
    const totalPnl = weekTrades.reduce((sum, t) => sum + t.realizedPnL, 0);
    const winRate  = weekTrades.length > 0 ? ((wins.length / weekTrades.length) * 100).toFixed(1) : '0';

    const best  = weekTrades.sort((a, b) => b.realizedPnL - a.realizedPnL)[0];
    const worst = weekTrades.sort((a, b) => a.realizedPnL - b.realizedPnL)[0];

    const symbols = [...new Set(weekTrades.map(t => t.symbol))];

    const avgRR = weekTrades.length > 0
        ? (weekTrades.reduce((s, t) => s + (t.riskReward || 0), 0) / weekTrades.length).toFixed(2)
        : 'N/A';

    let html = `<h1>Bear Trap Trade Pro — Weekly Report</h1>
<p><strong>Week ending:</strong> ${new Date().toDateString()}</p>
<table border="1" cellpadding="6" style="border-collapse:collapse">
<tr><td>Total Trades</td><td>${weekTrades.length}</td></tr>
<tr><td>Wins</td><td>${wins.length}</td></tr>
<tr><td>Losses</td><td>${losses.length}</td></tr>
<tr><td>Win Rate</td><td>${winRate}%</td></tr>
<tr><td>Total P&amp;L</td><td style="color:${totalPnl >= 0 ? 'green' : 'red'}">${totalPnl.toFixed(2)} USDT</td></tr>
<tr><td>Best Trade</td><td>${best ? best.symbol + ': +' + best.realizedPnL.toFixed(2) + ' USDT' : 'N/A'}</td></tr>
<tr><td>Worst Trade</td><td>${worst ? worst.symbol + ': ' + worst.realizedPnL.toFixed(2) + ' USDT' : 'N/A'}</td></tr>
<tr><td>Assets Traded</td><td>${symbols.join(', ') || 'None'}</td></tr>
<tr><td>Avg R/R Achieved</td><td>${avgRR}:1</td></tr>
<tr><td>Consec. Wins</td><td>${consecutiveWins}</td></tr>
<tr><td>Consec. Losses</td><td>${consecutiveLosses}</td></tr>
</table>
<h2>Outlook for Next Week</h2>
<p>${reducedSizing ? '⚠️ Reduced sizing active — need a win to restore.' : '✅ Normal position sizing.'}</p>
<p>${weeklyPnL <= -MAX_WEEKLY_LOSS * 0.8 ? '⚠️ Approaching weekly loss limit — trade cautiously.' : '✅ Well within weekly loss limits.'}</p>`;

    await sendRaw('📈 Bear Trap Weekly Report — ' + new Date().toDateString(), html);
}

// =====================================================================
// EXPRESS APP
// =====================================================================

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));

// Log every incoming request
app.use((req, _res, next) => {
    log('INFO', `${req.method} ${req.path} from ${req.ip}`);
    next();
});

// GET /health
app.get('/health', (_req, res) => {
    res.json({
        status:      'ok',
        mode:        LIVE_TRADING ? 'LIVE' : 'PAPER',
        openTrades:  Object.keys(activeTrades).length,
        dailyPnL:    `${dailyPnL.toFixed(2)}%`,
        weeklyPnL:   `${weeklyPnL.toFixed(2)}%`,
        timestamp:   new Date().toISOString(),
        version:     '1.0.0',
    });
});

// GET /trades
app.get('/trades', (_req, res) => {
    res.json({
        active:  activeTrades,
        summary: {
            openCount:        Object.keys(activeTrades).length,
            consecutiveLosses,
            consecutiveWins,
            reducedSizing,
            dailyPnL:  `${dailyPnL.toFixed(2)}%`,
            weeklyPnL: `${weeklyPnL.toFixed(2)}%`,
        },
    });
});

// GET /report
app.get('/report', (_req, res) => {
    const todayStr   = new Date().toDateString();
    const todayTrades = tradeHistory.filter(t => t.closeTime && new Date(t.closeTime).toDateString() === todayStr);
    res.json({
        date:      todayStr,
        openTrades: activeTrades,
        todayClosedTrades: todayTrades,
        dailyPnL:  dailyPnL.toFixed(2),
        weeklyPnL: weeklyPnL.toFixed(2),
        consecutiveLosses,
        consecutiveWins,
        reducedSizing,
    });
});

// POST /webhook — receives TradingView alerts
app.post('/webhook', async (req, res) => {
    // Security check
    if (!verifySecret(req)) {
        log('WARN', `[WEBHOOK] Rejected — bad secret from ${req.ip}`);
        return res.status(401).json({ error: 'Unauthorized' });
    }

    const payload = req.body;

    // Basic structure check — never crash on bad input
    if (!payload || typeof payload !== 'object') {
        log('WARN', '[WEBHOOK] Rejected — non-object body');
        return res.status(400).json({ error: 'Invalid JSON body' });
    }

    const { signal, ticker, timestamp } = payload;

    log('INFO', `[WEBHOOK] Received: ${signal} for ${ticker}`, payload);

    // Required fields
    if (!signal || !ticker) {
        return res.status(400).json({ error: 'Missing signal or ticker' });
    }

    // Allowlist check
    if (!SYMBOL_ALLOWLIST.includes(ticker.toUpperCase())) {
        log('WARN', `[WEBHOOK] Ticker not in allowlist: ${ticker}`);
        return res.status(400).json({ error: 'Ticker not in allowlist' });
    }

    // Stale alert check
    if (timestamp && isStale(timestamp)) {
        log('WARN', `[WEBHOOK] Stale alert rejected (${ticker})`);
        return res.status(400).json({ error: 'Alert too old (>2 min)' });
    }

    // Duplicate check
    const hash = hashAlert(payload);
    if (isDuplicate(hash)) {
        log('INFO', `[WEBHOOK] Duplicate alert skipped (${ticker})`);
        return res.json({ status: 'duplicate_skipped' });
    }

    // Strategy tag validation (optional but logged)
    if (payload.strategy && payload.strategy !== 'Bear Trap Trade Pro') {
        log('WARN', `[WEBHOOK] Unknown strategy tag: ${payload.strategy}`);
    }

    let result;
    try {
        switch (signal) {
            // Bear Trap Pro signals
            case 'BUY_SIGNAL':  result = await handleBuySignal(payload);         break;
            case 'TP1_HIT':     result = await handleTP1Hit(payload);            break;
            case 'TP2_HIT':     result = await handleTP2Hit(payload);            break;
            case 'MOVE_STOP':   result = await handleMoveStop(payload);          break;
            case 'EXIT_TRADE':  result = await handleExitTrade(payload);         break;
            // SSQ strategy signals
            case 'LONG_ENTRY':  result = await handleSSQEntry(payload, 'long');  break;
            case 'SHORT_ENTRY': result = await handleSSQEntry(payload, 'short'); break;
            case 'EXIT':        result = await handleSSQExit(payload);           break;
            default:
                log('WARN', `[WEBHOOK] Unknown signal: ${signal}`);
                return res.status(400).json({ error: `Unknown signal: ${signal}` });
        }
    } catch (err) {
        log('ERROR', `[WEBHOOK] Handler threw: ${err.message}`);
        return res.status(500).json({ error: 'Internal error', detail: err.message });
    }

    saveState();
    return res.json({ received: true, result });
});

// 404 fallback
app.use((_req, res) => {
    res.status(404).json({ error: 'Not found' });
});

// =====================================================================
// CRON JOBS
// =====================================================================

function initCron() {
    // Daily report — 07:00 UK (Europe/London handles BST automatically)
    cron.schedule('0 7 * * *', async () => {
        log('INFO', '[CRON] Running daily report');
        await sendDailyReport();
    }, { timezone: 'Europe/London' });

    // Weekly report — Sunday 08:00 UK
    cron.schedule('0 8 * * 0', async () => {
        log('INFO', '[CRON] Running weekly report');
        await sendWeeklyReport();
    }, { timezone: 'Europe/London' });

    // Midnight daily P&L reset check
    cron.schedule('1 0 * * *', () => {
        checkPeriodReset();
        saveState();
    }, { timezone: 'Europe/London' });

    log('INFO', 'Cron jobs scheduled (daily 07:00, weekly Sun 08:00 UK)');
}

// =====================================================================
// STARTUP
// =====================================================================

function start() {
    log('INFO', '================================================');
    log('INFO', ' Bear Trap Trade Pro — Bot Starting');
    log('INFO', `  Mode:          ${LIVE_TRADING ? 'LIVE TRADING 🔴' : 'PAPER TRADING 📄'}`);
    log('INFO', `  Risk per trade: ${RISK_PER_TRADE}%`);
    log('INFO', `  Daily loss limit: ${MAX_DAILY_LOSS}%`);
    log('INFO', `  Weekly loss limit: ${MAX_WEEKLY_LOSS}%`);
    log('INFO', `  Allowlist: ${SYMBOL_ALLOWLIST.join(', ')}`);
    log('INFO', '================================================');

    if (LIVE_TRADING && (!process.env.BROKER_API_KEY || !process.env.BROKER_API_SECRET)) {
        log('ERROR', 'LIVE_TRADING=true but BROKER_API_KEY / BROKER_API_SECRET not set — aborting');
        process.exit(1);
    }

    loadState();
    checkPeriodReset();
    initMailer();
    initCron();

    app.listen(PORT, () => {
        log('INFO', `Server listening on port ${PORT}`);
        log('INFO', `Health check: http://localhost:${PORT}/health`);
    });
}

start();
