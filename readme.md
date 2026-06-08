# 🪙 Discord Economy Bot

A feature-rich Discord economy bot with a currency system, slot machine, daily rewards, jobs, banking, and admin commands. Built with **discord.js v14**, **better-sqlite3**, and ready to deploy on **Railway**.

---

## ✨ Features

| Category | Commands |
|---|---|
| 💰 Wallet | `balance`, `deposit`, `withdraw`, `pay` |
| 🎁 Daily | `daily` — 100–300 coins every 24 h |
| 💼 Jobs | `jobs`, `getjob`, `work` — 5 jobs with unique cooldowns |
| 🎰 Slots | `spin`, `spininfo` — bet coins on a 3-reel slot machine |
| 🏆 Social | `leaderboard`, `profile` |
| 🛡️ Admin | `addmoney`, `removemoney`, `setbalance`, `resetuser`, `grantjob`, `serverinfo` |

---

## 🚀 Quick Start (Local)

### 1. Prerequisites
- Node.js **18+**
- A Discord bot token ([create one here](https://discord.com/developers/applications))

### 2. Clone & Install

```bash
git clone <your-repo>
cd discord-economy-bot
npm install
```

### 3. Configure

```bash
cp .env.example .env
# Edit .env and fill in your DISCORD_TOKEN and OWNER_ID
```

**.env fields:**

| Variable | Description |
|---|---|
| `DISCORD_TOKEN` | Your bot token from the Discord Developer Portal |
| `OWNER_ID` | Your Discord user ID (right-click → Copy User ID) |
| `PREFIX` | Command prefix, default `!` |

### 4. Invite Your Bot

In the [Discord Developer Portal](https://discord.com/developers/applications):
1. Go to **OAuth2 → URL Generator**
2. Scopes: `bot`
3. Bot Permissions: `Send Messages`, `Read Message History`, `View Channels`
4. Enable **Message Content Intent** under **Privileged Gateway Intents**

### 5. Run

```bash
node bot.js
```

---

## 🚂 Deploying to Railway

1. Push your code to a GitHub repository
2. Go to [railway.app](https://railway.app) → **New Project → Deploy from GitHub**
3. Select your repository
4. Add environment variables in **Settings → Variables**:
   - `DISCORD_TOKEN`
   - `OWNER_ID`
   - `PREFIX` (optional, default `!`)
5. Railway auto-detects `railway.toml` and starts with `node bot.js`

> **Note:** Railway's ephemeral filesystem will reset the SQLite database on redeploy. For persistence, add a **Railway Volume** and set `DB_PATH=/data/economy.db` as an environment variable.

### Persistent Volume Setup (Recommended)

1. In your Railway project, click **+ New** → **Volume**
2. Mount path: `/data`
3. Add env var: `DB_PATH=/data/economy.db`

---

## 🎮 Command Reference

### Economy
| Command | Description |
|---|---|
| `!balance [@user]` | View your (or another's) wallet and bank |
| `!deposit <amount\|all>` | Move coins from cash to bank |
| `!withdraw <amount\|all>` | Move coins from bank to cash |
| `!pay @user <amount>` | Transfer coins to another user |

### Earning
| Command | Description |
|---|---|
| `!daily` | Claim 100–300 coins (24h cooldown) |
| `!jobs` | List all jobs with pay and cooldowns |
| `!getjob <name>` | Pick or switch your job |
| `!work` | Earn coins from your current job |

**Available Jobs:**

| Job | Pay Range | Cooldown |
|---|---|---|
| ⛏️ Miner | 80–200 | 60 min |
| 👨‍🍳 Chef | 60–160 | 45 min |
| 💻 Programmer | 120–300 | 80 min |
| 🎣 Fisherman | 40–130 | 40 min |
| 🛒 Merchant | 90–250 | ~53 min |

### Slot Machine
| Command | Description |
|---|---|
| `!spin <amount\|all\|half>` | Spin the slots — max bet 50,000 |
| `!spininfo` | View the full payout table |

**Payout table:**

| Combination | Multiplier |
|---|---|
| 💎 💎 💎 | 20× |
| 🎰 🎰 🎰 | 15× |
| ⭐ ⭐ ⭐ | 10× |
| 🔔 🔔 🔔 | 8× |
| 🍋 🍋 🍋 | 5× |
| 🍒 🍒 🍒 | 4× |
| Any two 💎 | 2× |
| Any two ⭐ | 1× (refund) |
| Any other pair | 1.5× |

### Admin (requires `Administrator` permission or Owner)
| Command | Description |
|---|---|
| `!addmoney @user <amount>` | Give coins to a user |
| `!removemoney @user <amount>` | Take coins from a user |
| `!setbalance @user <amount>` | Set exact cash balance |
| `!resetuser @user` | Reset a user's economy to default |
| `!grantjob @user <job>` | Assign a job (bypasses cooldown) |
| `!serverinfo` | View server-wide economy statistics |

---

## 🗄️ Database

Uses **better-sqlite3** (synchronous, fast, no connection management needed).

- `users` — per-guild user wallets, jobs, stats
- `transactions` — audit log of every economy event

Both tables are created automatically on first run.

---

## 📁 File Structure

```
discord-economy-bot/
├── bot.js           ← Entire bot in one file
├── package.json
├── package-lock.json
├── railway.toml     ← Railway deploy config
├── .env.example     ← Environment variable template
├── .gitignore
└── README.md
```
