// ============================================================
//  Discord Economy Bot  —  bot.js
//  Features: currency, slots, daily rewards, jobs, admin cmds
//  Runtime: Node 20 LTS  |  DB: better-sqlite3  |  Deploy: Railway
// ============================================================

require("dotenv").config();
const { Client, GatewayIntentBits, EmbedBuilder, ActivityType } = require("discord.js");
const Database = require("@db-sqlite/better-sqlite3");
const path = require("path");

// ─── Config ──────────────────────────────────────────────────
const TOKEN   = process.env.DISCORD_TOKEN;
const OWNER   = process.env.OWNER_ID   || "";
const PREFIX  = process.env.PREFIX     || "!";
const DB_PATH = process.env.DB_PATH    || path.join(process.cwd(), "economy.db");

if (!TOKEN) {
  console.error("❌  DISCORD_TOKEN is not set. Exiting.");
  process.exit(1);
}

// ─── Database Setup ──────────────────────────────────────────
const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    user_id     TEXT PRIMARY KEY,
    guild_id    TEXT NOT NULL,
    username    TEXT NOT NULL,
    balance     INTEGER NOT NULL DEFAULT 100,
    bank        INTEGER NOT NULL DEFAULT 0,
    job         TEXT,
    job_cooldown INTEGER NOT NULL DEFAULT 0,
    daily_cooldown INTEGER NOT NULL DEFAULT 0,
    total_earned INTEGER NOT NULL DEFAULT 0,
    total_spent  INTEGER NOT NULL DEFAULT 0,
    spin_wins    INTEGER NOT NULL DEFAULT 0,
    spin_losses  INTEGER NOT NULL DEFAULT 0,
    created_at  INTEGER NOT NULL DEFAULT (strftime('%s','now'))
  );

  CREATE TABLE IF NOT EXISTS transactions (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id     TEXT NOT NULL,
    guild_id    TEXT NOT NULL,
    type        TEXT NOT NULL,
    amount      INTEGER NOT NULL,
    note        TEXT,
    created_at  INTEGER NOT NULL DEFAULT (strftime('%s','now'))
  );
`);

// ─── Prepared Statements ─────────────────────────────────────
const stmts = {
  getUser:      db.prepare("SELECT * FROM users WHERE user_id = ? AND guild_id = ?"),
  upsertUser:   db.prepare(`
    INSERT INTO users (user_id, guild_id, username)
      VALUES (@user_id, @guild_id, @username)
    ON CONFLICT(user_id) DO UPDATE SET username = excluded.username
  `),
  setBalance:   db.prepare("UPDATE users SET balance = ? WHERE user_id = ? AND guild_id = ?"),
  setBank:      db.prepare("UPDATE users SET bank = ? WHERE user_id = ? AND guild_id = ?"),
  setJob:       db.prepare("UPDATE users SET job = ?, job_cooldown = ? WHERE user_id = ? AND guild_id = ?"),
  setDailyCd:   db.prepare("UPDATE users SET daily_cooldown = ? WHERE user_id = ? AND guild_id = ?"),
  addEarned:    db.prepare("UPDATE users SET total_earned = total_earned + ? WHERE user_id = ? AND guild_id = ?"),
  addSpent:     db.prepare("UPDATE users SET total_spent  = total_spent  + ? WHERE user_id = ? AND guild_id = ?"),
  addWin:       db.prepare("UPDATE users SET spin_wins    = spin_wins    + 1 WHERE user_id = ? AND guild_id = ?"),
  addLoss:      db.prepare("UPDATE users SET spin_losses  = spin_losses  + 1 WHERE user_id = ? AND guild_id = ?"),
  logTx:        db.prepare("INSERT INTO transactions (user_id, guild_id, type, amount, note) VALUES (?,?,?,?,?)"),
  leaderboard:  db.prepare(`
    SELECT username, balance + bank AS total
    FROM users WHERE guild_id = ?
    ORDER BY total DESC LIMIT 10
  `),
};

// ─── Helpers ─────────────────────────────────────────────────
function getOrCreate(userId, guildId, username) {
  stmts.upsertUser.run({ user_id: userId, guild_id: guildId, username });
  return stmts.getUser.get(userId, guildId);
}

function now() { return Math.floor(Date.now() / 1000); }

function formatCoins(n) {
  return `🪙 **${n.toLocaleString()}**`;
}

function msToHuman(ms) {
  const s = Math.ceil(ms / 1000);
  if (s < 60)   return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}

function embed(color = 0x5865F2) {
  return new EmbedBuilder().setColor(color).setTimestamp();
}

function errorEmbed(msg) {
  return embed(0xED4245).setDescription(`❌  ${msg}`);
}

function successEmbed(msg) {
  return embed(0x57F287).setDescription(`✅  ${msg}`);
}

// ─── Jobs ─────────────────────────────────────────────────────
const JOBS = {
  miner: {
    label: "⛏️  Miner",
    description: "Dig for coal and gems deep underground.",
    cooldown: 3600,         // 1 hour
    pay: [80, 200],
    messages: [
      "You swung your pickaxe into a rich vein and found {coins} worth of gems!",
      "Hours in the dark tunnels paid off — you hauled up {coins} in ores.",
      "You discovered a small diamond pocket worth {coins}!",
    ],
  },
  chef: {
    label: "👨‍🍳  Chef",
    description: "Cook mouth-watering dishes at the local bistro.",
    cooldown: 2700,         // 45 min
    pay: [60, 160],
    messages: [
      "The dinner rush was brutal but you earned {coins} in tips tonight.",
      "Your signature dish sold out — the owner handed you {coins}.",
      "A food critic loved your cooking and tipped you {coins}!",
    ],
  },
  programmer: {
    label: "💻  Programmer",
    description: "Write code for clients and fix gnarly bugs.",
    cooldown: 4800,         // 80 min
    pay: [120, 300],
    messages: [
      "You shipped a feature on deadline and billed {coins}.",
      "A client paid you {coins} for squashing a critical bug.",
      "Your open-source PR got a bounty — {coins} deposited!",
    ],
  },
  fisherman: {
    label: "🎣  Fisherman",
    description: "Cast your line and reel in the daily catch.",
    cooldown: 2400,         // 40 min
    pay: [40, 130],
    messages: [
      "You landed a big bass and sold it at the docks for {coins}.",
      "A slow morning but you sold your catch for {coins}.",
      "You found a wallet inside a fish containing {coins}!",
    ],
  },
  merchant: {
    label: "🛒  Merchant",
    description: "Buy low, sell high at the bustling market.",
    cooldown: 3200,
    pay: [90, 250],
    messages: [
      "You flipped a crate of spices for {coins} profit.",
      "Market day was busy — you cleared {coins} in sales.",
      "A rare antique netted you {coins} at auction!",
    ],
  },
};

// ─── Slot Machine ─────────────────────────────────────────────
const SLOT_SYMBOLS = ["🍒", "🍋", "🔔", "⭐", "💎", "🎰"];
const SLOT_PAYOUTS = {
  "💎💎💎": 20,   // 20× bet
  "🎰🎰🎰": 15,
  "⭐⭐⭐": 10,
  "🔔🔔🔔": 8,
  "🍋🍋🍋": 5,
  "🍒🍒🍒": 4,
  TWO_DIAMOND: 2, // any two 💎
  TWO_STAR:    1, // any two ⭐ — return bet
};

function spin() {
  return Array.from({ length: 3 }, () => SLOT_SYMBOLS[Math.floor(Math.random() * SLOT_SYMBOLS.length)]);
}

function evalSlot(reels, bet) {
  const [a, b, c] = reels;
  const key = reels.join("");

  if (SLOT_PAYOUTS[key] !== undefined) {
    return { win: true, multiplier: SLOT_PAYOUTS[key], label: "JACKPOT 🎉" };
  }
  // Partial matches
  const diamonds = reels.filter(r => r === "💎").length;
  const stars    = reels.filter(r => r === "⭐").length;

  if (diamonds === 2) return { win: true, multiplier: SLOT_PAYOUTS.TWO_DIAMOND, label: "Two Diamonds!" };
  if (stars    === 2) return { win: true, multiplier: SLOT_PAYOUTS.TWO_STAR,    label: "Two Stars!"    };
  if (a === b || b === c || a === c) return { win: true, multiplier: 1.5, label: "Pair!" };

  return { win: false, multiplier: 0, label: "No Match" };
}

// ─── Command Handlers ─────────────────────────────────────────

const commands = {};

function cmd(names, handler) {
  const arr = Array.isArray(names) ? names : [names];
  arr.forEach(n => (commands[n.toLowerCase()] = handler));
}

// ── balance / wallet
cmd(["balance", "bal", "wallet"], async (msg, args, user) => {
  const target = msg.mentions.users.first();
  const data   = target
    ? getOrCreate(target.id, msg.guild.id, target.username)
    : user;
  const name   = target ? target.displayName : msg.author.displayName;

  return embed()
    .setTitle(`💰 ${name}'s Wallet`)
    .addFields(
      { name: "Cash",       value: formatCoins(data.balance), inline: true },
      { name: "Bank",       value: formatCoins(data.bank),    inline: true },
      { name: "Net Worth",  value: formatCoins(data.balance + data.bank), inline: true },
    )
    .setThumbnail(target ? target.displayAvatarURL() : msg.author.displayAvatarURL());
});

// ── daily
cmd("daily", async (msg, args, user) => {
  const cd     = 86400; // 24 h in seconds
  const remain = (user.daily_cooldown + cd) - now();

  if (remain > 0) {
    return errorEmbed(`You already claimed your daily reward! Come back in **${msToHuman(remain * 1000)}**.`);
  }

  const reward = Math.floor(Math.random() * 201) + 100; // 100–300
  stmts.setBalance.run(user.balance + reward, user.user_id, msg.guild.id);
  stmts.setDailyCd.run(now(), user.user_id, msg.guild.id);
  stmts.addEarned.run(reward, user.user_id, msg.guild.id);
  stmts.logTx.run(user.user_id, msg.guild.id, "daily", reward, "Daily reward");

  return embed(0xFEE75C)
    .setTitle("🎁 Daily Reward")
    .setDescription(`You claimed your daily reward of ${formatCoins(reward)}!\nNew balance: ${formatCoins(user.balance + reward)}`);
});

// ── work / job
cmd(["work", "job"], async (msg, args, user) => {
  if (!user.job) {
    return errorEmbed(`You don't have a job yet! Use \`${PREFIX}getjob <job>\` to pick one.\nAvailable: ${Object.keys(JOBS).join(", ")}`);
  }

  const job    = JOBS[user.job];
  const remain = (user.job_cooldown + job.cooldown) - now();

  if (remain > 0) {
    return errorEmbed(`You're too tired to work again! Rest for **${msToHuman(remain * 1000)}**.`);
  }

  const [min, max] = job.pay;
  const earned     = Math.floor(Math.random() * (max - min + 1)) + min;
  const msgTemplate = job.messages[Math.floor(Math.random() * job.messages.length)];
  const workMsg    = msgTemplate.replace("{coins}", formatCoins(earned));

  stmts.setBalance.run(user.balance + earned, user.user_id, msg.guild.id);
  stmts.setJob.run(user.job, now(), user.user_id, msg.guild.id);
  stmts.addEarned.run(earned, user.user_id, msg.guild.id);
  stmts.logTx.run(user.user_id, msg.guild.id, "work", earned, `Job: ${user.job}`);

  return embed(0x57F287)
    .setTitle(`${job.label} — Work Complete`)
    .setDescription(workMsg)
    .setFooter({ text: `Next shift available in ${msToHuman(job.cooldown * 1000)}` });
});

// ── getjob
cmd("getjob", async (msg, args, user) => {
  const name = args[0]?.toLowerCase();

  if (!name) {
    const list = Object.entries(JOBS).map(([k, j]) => {
      const cdHuman = msToHuman(j.cooldown * 1000);
      return `${j.label} — \`${k}\`\n> ${j.description}\n> Pay: ${j.pay[0]}–${j.pay[1]} coins | Cooldown: ${cdHuman}`;
    }).join("\n\n");

    return embed()
      .setTitle("💼 Available Jobs")
      .setDescription(list)
      .setFooter({ text: `Use: ${PREFIX}getjob <name>` });
  }

  if (!JOBS[name]) {
    return errorEmbed(`Unknown job \`${name}\`. Available: ${Object.keys(JOBS).join(", ")}`);
  }

  stmts.setJob.run(name, 0, user.user_id, msg.guild.id);

  return successEmbed(`You are now a **${JOBS[name].label}**! Use \`${PREFIX}work\` to earn coins.`);
});

// ── jobs (alias to list)
cmd("jobs", async (msg, args, user) => {
  const list = Object.entries(JOBS).map(([k, j]) => {
    const cdHuman = msToHuman(j.cooldown * 1000);
    const current = user.job === k ? " ← **current**" : "";
    return `${j.label}${current} — \`${k}\`\n> Pay: ${j.pay[0]}–${j.pay[1]} | CD: ${cdHuman}`;
  }).join("\n\n");

  return embed()
    .setTitle("💼 Jobs Board")
    .setDescription(list)
    .setFooter({ text: `Use: ${PREFIX}getjob <name> to switch jobs` });
});

// ── spin / slot
cmd(["spin", "slot", "slots"], async (msg, args, user) => {
  const betArg = args[0];
  if (!betArg) {
    return errorEmbed(`Usage: \`${PREFIX}spin <amount|all|half>\``);
  }

  let bet;
  const bal = user.balance;

  if (betArg === "all") {
    bet = bal;
  } else if (betArg === "half") {
    bet = Math.floor(bal / 2);
  } else {
    bet = parseInt(betArg, 10);
    if (isNaN(bet) || bet <= 0) return errorEmbed("Bet must be a positive number.");
  }

  if (bet < 1)   return errorEmbed("You don't have any coins to bet!");
  if (bet > bal) return errorEmbed(`You only have ${formatCoins(bal)} in cash.`);

  const MAX_BET = 50_000;
  if (bet > MAX_BET) return errorEmbed(`Maximum bet is ${formatCoins(MAX_BET)}.`);

  const reels  = spin();
  const result = evalSlot(reels, bet);
  const display = reels.join(" │ ");

  let newBal, description;

  if (result.win) {
    const payout = Math.floor(bet * result.multiplier);
    const profit  = payout - bet;
    newBal = bal - bet + payout;
    stmts.addWin.run(user.user_id, msg.guild.id);
    stmts.addEarned.run(profit > 0 ? profit : 0, user.user_id, msg.guild.id);
    stmts.logTx.run(user.user_id, msg.guild.id, "spin_win", profit, `Slots: ${reels.join("")}`);
    description =
      `┌──────────────────┐\n` +
      `│  ${display}  │\n` +
      `└──────────────────┘\n\n` +
      `**${result.label}**\n` +
      `Bet: ${formatCoins(bet)} → Won: ${formatCoins(payout)}\n` +
      `Profit: +${formatCoins(profit)}\n` +
      `New balance: ${formatCoins(newBal)}`;
  } else {
    newBal = bal - bet;
    stmts.addLoss.run(user.user_id, msg.guild.id);
    stmts.addSpent.run(bet, user.user_id, msg.guild.id);
    stmts.logTx.run(user.user_id, msg.guild.id, "spin_loss", -bet, `Slots: ${reels.join("")}`);
    description =
      `┌──────────────────┐\n` +
      `│  ${display}  │\n` +
      `└──────────────────┘\n\n` +
      `**${result.label}**\n` +
      `You lost ${formatCoins(bet)}.\n` +
      `Remaining balance: ${formatCoins(newBal)}`;
  }

  stmts.setBalance.run(newBal, user.user_id, msg.guild.id);

  const color = result.win ? 0x57F287 : 0xED4245;
  return embed(color)
    .setTitle("🎰 Slot Machine")
    .setDescription(description)
    .setFooter({ text: `Payout table: ${PREFIX}spininfo` });
});

// ── spininfo
cmd("spininfo", async () => {
  const table = [
    ["💎 💎 💎", "20×"],
    ["🎰 🎰 🎰", "15×"],
    ["⭐ ⭐ ⭐", "10×"],
    ["🔔 🔔 🔔", "8×"],
    ["🍋 🍋 🍋", "5×"],
    ["🍒 🍒 🍒", "4×"],
    ["Any two 💎", "2×"],
    ["Any two ⭐", "1× (refund)"],
    ["Any other pair", "1.5×"],
    ["No match", "0 (lose bet)"],
  ].map(([sym, mult]) => `\`${sym}\` → **${mult}**`).join("\n");

  return embed(0xFEE75C)
    .setTitle("🎰 Slot Payout Table")
    .setDescription(table);
});

// ── deposit
cmd(["deposit", "dep"], async (msg, args, user) => {
  const arg = args[0];
  if (!arg) return errorEmbed(`Usage: \`${PREFIX}deposit <amount|all>\``);

  const amount = arg === "all" ? user.balance : parseInt(arg, 10);
  if (isNaN(amount) || amount <= 0) return errorEmbed("Amount must be a positive number.");
  if (amount > user.balance)        return errorEmbed(`You only have ${formatCoins(user.balance)} in cash.`);

  stmts.setBalance.run(user.balance - amount, user.user_id, msg.guild.id);
  stmts.setBank.run(user.bank + amount, user.user_id, msg.guild.id);
  stmts.logTx.run(user.user_id, msg.guild.id, "deposit", amount, "Bank deposit");

  return successEmbed(`Deposited ${formatCoins(amount)} into your bank.\nBank: ${formatCoins(user.bank + amount)} | Cash: ${formatCoins(user.balance - amount)}`);
});

// ── withdraw
cmd(["withdraw", "with"], async (msg, args, user) => {
  const arg = args[0];
  if (!arg) return errorEmbed(`Usage: \`${PREFIX}withdraw <amount|all>\``);

  const amount = arg === "all" ? user.bank : parseInt(arg, 10);
  if (isNaN(amount) || amount <= 0) return errorEmbed("Amount must be a positive number.");
  if (amount > user.bank)           return errorEmbed(`You only have ${formatCoins(user.bank)} in your bank.`);

  stmts.setBank.run(user.bank - amount, user.user_id, msg.guild.id);
  stmts.setBalance.run(user.balance + amount, user.user_id, msg.guild.id);
  stmts.logTx.run(user.user_id, msg.guild.id, "withdraw", amount, "Bank withdrawal");

  return successEmbed(`Withdrew ${formatCoins(amount)} from your bank.\nCash: ${formatCoins(user.balance + amount)} | Bank: ${formatCoins(user.bank - amount)}`);
});

// ── pay / give
cmd(["pay", "give"], async (msg, args, user) => {
  const target = msg.mentions.users.first();
  if (!target) return errorEmbed(`Usage: \`${PREFIX}pay @user <amount>\``);
  if (target.id === msg.author.id) return errorEmbed("You can't pay yourself.");
  if (target.bot) return errorEmbed("You can't pay a bot.");

  const amount = parseInt(args[1], 10);
  if (isNaN(amount) || amount <= 0) return errorEmbed("Amount must be a positive number.");
  if (amount > user.balance) return errorEmbed(`You only have ${formatCoins(user.balance)} in cash.`);

  const receiver = getOrCreate(target.id, msg.guild.id, target.username);

  stmts.setBalance.run(user.balance - amount, user.user_id, msg.guild.id);
  stmts.setBalance.run(receiver.balance + amount, target.id, msg.guild.id);
  stmts.logTx.run(user.user_id, msg.guild.id, "pay_out", -amount, `To ${target.username}`);
  stmts.logTx.run(target.id,     msg.guild.id, "pay_in",  amount,  `From ${msg.author.username}`);

  return successEmbed(`You paid ${formatCoins(amount)} to **${target.displayName}**.`);
});

// ── leaderboard / top
cmd(["leaderboard", "lb", "top"], async (msg) => {
  const rows = stmts.leaderboard.all(msg.guild.id);
  if (!rows.length) return errorEmbed("No users found in this server yet.");

  const medals = ["🥇", "🥈", "🥉"];
  const lines = rows.map((r, i) => {
    const medal = medals[i] || `**${i + 1}.**`;
    return `${medal} **${r.username}** — ${formatCoins(r.total)}`;
  });

  return embed(0xFEE75C)
    .setTitle(`🏆 ${msg.guild.name} Leaderboard`)
    .setDescription(lines.join("\n"));
});

// ── profile / stats
cmd(["profile", "stats"], async (msg, args, user) => {
  const target = msg.mentions.users.first();
  const data   = target ? getOrCreate(target.id, msg.guild.id, target.username) : user;
  const name   = target ? target.displayName : msg.author.displayName;
  const avatar = target ? target.displayAvatarURL() : msg.author.displayAvatarURL();

  const jobLabel = data.job ? JOBS[data.job]?.label ?? data.job : "Unemployed";
  const winRate  = data.spin_wins + data.spin_losses > 0
    ? ((data.spin_wins / (data.spin_wins + data.spin_losses)) * 100).toFixed(1)
    : "N/A";

  return embed()
    .setTitle(`📊 ${name}'s Profile`)
    .setThumbnail(avatar)
    .addFields(
      { name: "💵 Cash",         value: formatCoins(data.balance),             inline: true },
      { name: "🏦 Bank",         value: formatCoins(data.bank),                inline: true },
      { name: "💎 Net Worth",    value: formatCoins(data.balance + data.bank), inline: true },
      { name: "💼 Job",          value: jobLabel,                              inline: true },
      { name: "📈 Total Earned", value: formatCoins(data.total_earned),        inline: true },
      { name: "📉 Total Spent",  value: formatCoins(data.total_spent),         inline: true },
      { name: "🎰 Slot Wins",    value: String(data.spin_wins),                inline: true },
      { name: "💸 Slot Losses",  value: String(data.spin_losses),              inline: true },
      { name: "📊 Win Rate",     value: `${winRate}%`,                         inline: true },
    );
});

// ── help
cmd("help", async (msg) => {
  const isAdmin = msg.member?.permissions.has("Administrator") || msg.author.id === OWNER;

  return embed()
    .setTitle("📖 Economy Bot Commands")
    .addFields(
      {
        name: "💰 Economy",
        value: [
          `\`${PREFIX}balance [@user]\` — View wallet`,
          `\`${PREFIX}deposit <amt|all>\` — Move cash → bank`,
          `\`${PREFIX}withdraw <amt|all>\` — Move bank → cash`,
          `\`${PREFIX}pay @user <amt>\` — Send coins to someone`,
          `\`${PREFIX}leaderboard\` — Server richlist`,
          `\`${PREFIX}profile [@user]\` — Detailed stats`,
        ].join("\n"),
      },
      {
        name: "🎯 Earn",
        value: [
          `\`${PREFIX}daily\` — Claim daily reward (24h cooldown)`,
          `\`${PREFIX}jobs\` — List all available jobs`,
          `\`${PREFIX}getjob <name>\` — Pick or change job`,
          `\`${PREFIX}work\` — Work your job for coins`,
        ].join("\n"),
      },
      {
        name: "🎰 Gambling",
        value: [
          `\`${PREFIX}spin <amt|all|half>\` — Spin the slot machine`,
          `\`${PREFIX}spininfo\` — View payout table`,
        ].join("\n"),
      },
      isAdmin ? {
        name: "🛡️ Admin",
        value: [
          `\`${PREFIX}addmoney @user <amt>\` — Give coins`,
          `\`${PREFIX}removemoney @user <amt>\` — Take coins`,
          `\`${PREFIX}setbalance @user <amt>\` — Set cash balance`,
          `\`${PREFIX}resetuser @user\` — Reset a user's economy`,
          `\`${PREFIX}grantjob @user <job>\` — Assign a job`,
          `\`${PREFIX}serverinfo\` — DB & server stats`,
        ].join("\n"),
      } : null,
    )
    .filter(f => f !== null)
    .setFooter({ text: `Prefix: ${PREFIX}` });
});

// ─── Admin Commands ───────────────────────────────────────────

function isAdmin(msg) {
  return msg.member?.permissions.has("Administrator") || msg.author.id === OWNER;
}

cmd("addmoney", async (msg, args, user) => {
  if (!isAdmin(msg)) return errorEmbed("You don't have permission to use this command.");
  const target = msg.mentions.users.first();
  const amount = parseInt(args[1], 10);
  if (!target || isNaN(amount) || amount <= 0) return errorEmbed(`Usage: \`${PREFIX}addmoney @user <amount>\``);

  const data = getOrCreate(target.id, msg.guild.id, target.username);
  stmts.setBalance.run(data.balance + amount, target.id, msg.guild.id);
  stmts.logTx.run(target.id, msg.guild.id, "admin_add", amount, `By ${msg.author.username}`);

  return successEmbed(`Added ${formatCoins(amount)} to **${target.displayName}**. New balance: ${formatCoins(data.balance + amount)}`);
});

cmd("removemoney", async (msg, args, user) => {
  if (!isAdmin(msg)) return errorEmbed("You don't have permission to use this command.");
  const target = msg.mentions.users.first();
  const amount = parseInt(args[1], 10);
  if (!target || isNaN(amount) || amount <= 0) return errorEmbed(`Usage: \`${PREFIX}removemoney @user <amount>\``);

  const data = getOrCreate(target.id, msg.guild.id, target.username);
  const newBal = Math.max(0, data.balance - amount);
  stmts.setBalance.run(newBal, target.id, msg.guild.id);
  stmts.logTx.run(target.id, msg.guild.id, "admin_remove", -amount, `By ${msg.author.username}`);

  return successEmbed(`Removed ${formatCoins(amount)} from **${target.displayName}**. New balance: ${formatCoins(newBal)}`);
});

cmd("setbalance", async (msg, args, user) => {
  if (!isAdmin(msg)) return errorEmbed("You don't have permission to use this command.");
  const target = msg.mentions.users.first();
  const amount = parseInt(args[1], 10);
  if (!target || isNaN(amount) || amount < 0) return errorEmbed(`Usage: \`${PREFIX}setbalance @user <amount>\``);

  getOrCreate(target.id, msg.guild.id, target.username);
  stmts.setBalance.run(amount, target.id, msg.guild.id);
  stmts.logTx.run(target.id, msg.guild.id, "admin_set", amount, `By ${msg.author.username}`);

  return successEmbed(`Set **${target.displayName}**'s balance to ${formatCoins(amount)}.`);
});

cmd("resetuser", async (msg, args, user) => {
  if (!isAdmin(msg)) return errorEmbed("You don't have permission to use this command.");
  const target = msg.mentions.users.first();
  if (!target) return errorEmbed(`Usage: \`${PREFIX}resetuser @user\``);

  db.prepare(`
    UPDATE users SET balance=100, bank=0, job=NULL, job_cooldown=0, daily_cooldown=0,
      total_earned=0, total_spent=0, spin_wins=0, spin_losses=0
    WHERE user_id=? AND guild_id=?
  `).run(target.id, msg.guild.id);
  stmts.logTx.run(target.id, msg.guild.id, "admin_reset", 0, `By ${msg.author.username}`);

  return successEmbed(`Reset **${target.displayName}**'s economy to default.`);
});

cmd("grantjob", async (msg, args, user) => {
  if (!isAdmin(msg)) return errorEmbed("You don't have permission to use this command.");
  const target = msg.mentions.users.first();
  const jobName = args[1]?.toLowerCase();
  if (!target || !jobName) return errorEmbed(`Usage: \`${PREFIX}grantjob @user <job>\``);
  if (!JOBS[jobName]) return errorEmbed(`Unknown job. Available: ${Object.keys(JOBS).join(", ")}`);

  getOrCreate(target.id, msg.guild.id, target.username);
  stmts.setJob.run(jobName, 0, target.id, msg.guild.id);

  return successEmbed(`Assigned **${JOBS[jobName].label}** to **${target.displayName}**.`);
});

cmd("serverinfo", async (msg) => {
  if (!isAdmin(msg)) return errorEmbed("You don't have permission to use this command.");

  const totalUsers  = db.prepare("SELECT COUNT(*) as n FROM users WHERE guild_id=?").get(msg.guild.id).n;
  const totalTx     = db.prepare("SELECT COUNT(*) as n FROM transactions WHERE guild_id=?").get(msg.guild.id).n;
  const totalCoins  = db.prepare("SELECT SUM(balance+bank) as n FROM users WHERE guild_id=?").get(msg.guild.id).n || 0;
  const richest     = db.prepare("SELECT username, balance+bank as net FROM users WHERE guild_id=? ORDER BY net DESC LIMIT 1").get(msg.guild.id);

  return embed(0x5865F2)
    .setTitle(`🖥️ Server Economy Stats — ${msg.guild.name}`)
    .addFields(
      { name: "👥 Registered Users",    value: String(totalUsers),         inline: true },
      { name: "📋 Total Transactions",  value: String(totalTx),            inline: true },
      { name: "🪙 Total Coins in Circ.", value: formatCoins(totalCoins),   inline: true },
      { name: "👑 Richest User",        value: richest ? `${richest.username} — ${formatCoins(richest.net)}` : "None", inline: false },
    );
});

// ─── Message Event ────────────────────────────────────────────
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

client.on("ready", () => {
  console.log(`✅  Logged in as ${client.user.tag}`);
  client.user.setActivity(`${PREFIX}help | Economy Bot`, { type: ActivityType.Playing });
});

client.on("messageCreate", async (msg) => {
  if (msg.author.bot)          return;
  if (!msg.guild)              return;
  if (!msg.content.startsWith(PREFIX)) return;

  const raw  = msg.content.slice(PREFIX.length).trim();
  const parts = raw.split(/\s+/);
  const name  = parts[0].toLowerCase();
  const args  = parts.slice(1);

  const handler = commands[name];
  if (!handler) return;

  // Ensure user row exists
  const user = getOrCreate(msg.author.id, msg.guild.id, msg.author.username);

  try {
    const result = await handler(msg, args, user);
    if (result) await msg.reply({ embeds: [result] });
  } catch (err) {
    console.error(`[CMD:${name}]`, err);
    await msg.reply({ embeds: [errorEmbed("An unexpected error occurred. Please try again.")] });
  }
});

// ─── Graceful Shutdown ────────────────────────────────────────
process.on("SIGINT",  () => { db.close(); client.destroy(); process.exit(0); });
process.on("SIGTERM", () => { db.close(); client.destroy(); process.exit(0); });

// ─── Start ────────────────────────────────────────────────────
client.login(TOKEN);
