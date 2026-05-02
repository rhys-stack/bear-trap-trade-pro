# Bear Trap Trade Pro

A 24/7 crypto trading system: TradingView Pine Script indicator + Railway Node.js webhook bot.
Trades USDT-margined perpetual futures and spot on Bitget using a bear trap detection strategy.

**Default mode: Paper trading. No live orders are placed unless `LIVE_TRADING=true`.**

---

## Project Structure

```
bear-trap-trade-pro/
├── bear_trap_pro.pine   # TradingView indicator (Pine Script v5)
├── bot.js               # Railway backend (Node.js / Express)
├── package.json
├── railway.json         # Railway deployment config
├── .env.example         # All environment variables documented
└── README.md
```

---

## Step 1 — Deploy to Railway from GitHub

1. Push this project to a new GitHub repository.
2. Go to [railway.app](https://railway.app) → **New Project** → **Deploy from GitHub repo**.
3. Select your repository. Railway detects `package.json` and builds automatically.
4. Once deployed, note your public URL (e.g. `https://bear-trap-xxx.railway.app`).

---

## Step 2 — Add Environment Variables on Railway

In your Railway project → **Variables** tab, add each variable from `.env.example`.

Minimum required for paper trading:

| Variable | Value |
|---|---|
| `WEBHOOK_SECRET` | A random secret (e.g. `openssl rand -hex 32`) |
| `EMAIL_FROM` | Sender email address |
| `EMAIL_TO` | Your email address |
| `RESEND_API_KEY` **or** `SMTP_HOST` + `SMTP_USER` + `SMTP_PASS` | Email provider |
| `SYMBOL_ALLOWLIST` | `XRPUSDT,BTCUSDT,ETHUSDT,SOLUSDT` |

All other variables have safe defaults.

---

## Step 3 — Load the Indicator in TradingView

1. Open TradingView → Pine Editor (bottom panel).
2. Paste the entire contents of `bear_trap_pro.pine`.
3. Click **Add to chart**.
4. The indicator loads on the current chart with the dashboard visible in the top-right corner.

**Recommended starting settings:**
- Chart: XRPUSDT, 1H or 4H
- Pivot Lookback: 10 (left and right)
- Min Signal Score: 3
- HTF Timeframe: 240 (4H)
- Both trend filters: enabled

---

## Step 4 — Set Up the TradingView Webhook Alert

1. In TradingView, right-click on the chart → **Add Alert** (or press `Alt+A`).
2. **Condition:** Select `Bear Trap Trade Pro` → `BUY_SIGNAL` (or any named alert condition).
3. **Actions:** Check **Webhook URL**.
4. **Webhook URL:**
   ```
   https://your-app.railway.app/webhook?secret=YOUR_WEBHOOK_SECRET
   ```
5. **Message:** Leave the message field **empty** — the indicator sends its own JSON payload via `alert()`.
6. Set expiry to the maximum (1 year or "Open-ended").
7. Click **Create**.

Repeat for `TP1_HIT`, `TP2_HIT`, and `EXIT_TRADE` alert conditions — same webhook URL.

> **Tip:** You only need to create alerts once per symbol/timeframe. Duplicate alerts for each pair you want to trade.

---

## Step 5 — Verify the Webhook

After the alert is created, check the Railway logs:

```
[INFO ] POST /webhook from ...
[INFO ] [WEBHOOK] Received: BUY_SIGNAL for XRPUSDT
[PAPER] BUY XRPUSDT @ 0.5412 | SL: 0.5380 | TP1: 0.5466 | TP2: 0.5520 | Size: 123.4567
[INFO ] Email sent: 🟢 Bear Trap BUY: XRPUSDT @ 0.5412
```

Use the health endpoint to confirm the bot is running:
```
GET https://your-app.railway.app/health
```

Use `/trades` and `/report` to inspect the current state.

---

## Go-Live Checklist

Before setting `LIVE_TRADING=true`, confirm every item:

- [ ] Bot has been running in paper mode for at least 2 weeks
- [ ] Win rate is acceptable and risk settings are validated
- [ ] `BROKER_API_KEY`, `BROKER_API_SECRET`, and `BROKER_API_PASSPHRASE` set in Railway
- [ ] Bitget API key has **Trade** permission only (no withdrawal)
- [ ] API key is IP-restricted to Railway's egress IP if possible
- [ ] `SYMBOL_ALLOWLIST` contains only USDT-margined pairs (no BTC-margined)
- [ ] `RISK_PER_TRADE` set conservatively (start at 1%)
- [ ] `MAX_DAILY_LOSS` and `MAX_WEEKLY_LOSS` set
- [ ] Email alerts confirmed working (received paper trade emails)
- [ ] You understand that this is automated — losses can occur

---

## Switching from Paper to Live Trading

1. In Railway → Variables, set:
   ```
   LIVE_TRADING=true
   BROKER_API_KEY=your_key
   BROKER_API_SECRET=your_secret
   BROKER_API_PASSPHRASE=your_passphrase
   ```
2. Redeploy (Railway auto-redeploys on variable changes).
3. Watch the logs for the `[LIVE]` prefix on the next signal.

To revert to paper mode: set `LIVE_TRADING=false` and redeploy.

---

## API Endpoints

| Endpoint | Method | Description |
|---|---|---|
| `/health` | GET | Bot status, open trades, P&L summary |
| `/webhook` | POST | Receives TradingView alerts |
| `/trades` | GET | Active trades + risk summary |
| `/report` | GET | Today's closed trades + P&L |

---

## Signal Flow

```
TradingView bar closes
    └─ Bear trap conditions met?
        └─ Score >= minimum?
            └─ Filters pass?
                └─ alert() fires → Webhook URL
                    └─ bot.js /webhook
                        ├─ Validate secret
                        ├─ Check stale / duplicate
                        ├─ Check allowlist
                        ├─ Check daily/weekly limits
                        ├─ Check correlation limit
                        └─ Open trade (paper or live)
                            ├─ Email sent
                            └─ State saved to trades.json
```

---

## No-Repainting Guarantee

The Pine Script indicator uses:
- `ta.pivotlow(low, left, right)` — pivot confirmed only after `right` bars have closed to the right
- `request.security(..., lookahead=barmerge.lookahead_off)` with `[1]` offset for HTF data
- `alert.freq_once_per_bar_close` — alerts fire only at confirmed bar close, never mid-candle
- All sweep/confirmation logic references `[1]` (previous confirmed bar) or earlier

---

## Email Setup: Gmail App Password

If using Gmail SMTP:
1. Enable 2-factor authentication on your Google account.
2. Go to Google Account → Security → App Passwords.
3. Create an app password for "Mail".
4. Use this password as `SMTP_PASS` (not your regular password).

---

## Email Setup: Resend (Recommended)

1. Sign up at [resend.com](https://resend.com).
2. Add and verify your sending domain.
3. Create an API key → copy it to `RESEND_API_KEY`.
4. Leave all `SMTP_*` variables blank.

---

## Troubleshooting

**Webhook returns 401:** `WEBHOOK_SECRET` in Railway doesn't match the `?secret=` in your TradingView URL.

**Webhook returns "Alert too old":** TradingView fired the alert more than 2 minutes after the bar closed. Check your TradingView subscription — free accounts have delayed alerts.

**Webhook returns "Ticker not in allowlist":** Add the ticker to `SYMBOL_ALLOWLIST` in Railway variables.

**No emails received:** Check Railway logs for `[EMAIL]` lines. Verify `EMAIL_FROM`, `EMAIL_TO`, and your provider credentials.

**Signal not firing:** The indicator requires score >= minimum (default 3/5). Check the dashboard to see which confluence factors are missing.
