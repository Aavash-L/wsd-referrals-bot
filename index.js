require("dotenv").config();
const express = require("express");
const { Client, GatewayIntentBits } = require("discord.js");
const { getUser, addReferral, markRewarded } = require("./db");

const app = express();
app.use(express.json());

// Helpful crash logs in Railway
process.on("unhandledRejection", (err) => console.error("unhandledRejection:", err));
process.on("uncaughtException", (err) => console.error("uncaughtException:", err));

// Discord bot
const client = new Client({
  intents: [GatewayIntentBits.Guilds],
});

client.once("ready", () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
});

// ---------------------------
// CONFIG (optional)
// ---------------------------
// Put these in Railway env later if you want:
// REWARD_ROLE_ID=123...
// ANNOUNCE_CHANNEL_ID=123...
const REWARD_ROLE_ID = process.env.REWARD_ROLE_ID || "";
const ANNOUNCE_CHANNEL_ID = process.env.ANNOUNCE_CHANNEL_ID || "";

// ---------------------------
// Slash commands
// ---------------------------
client.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  if (interaction.commandName === "ref") {
    return interaction.reply({
      content: `Here’s your referral code (Whop link will be added later):\n**${interaction.user.id}-pitlg5**\n\nOnce WHOP_CHECKOUT_URL is set, this command will return your full link.`,
      ephemeral: true,
    });
  }

  if (interaction.commandName === "refstats") {
    const user = getUser(interaction.user.id);
    return interaction.reply({
      content: `You have **${user.referrals} / 3** successful referrals.`,
      ephemeral: true,
    });
  }
});

// ---------------------------
// Helper: reward logic
// ---------------------------
async function tryReward(discordUserId) {
  const user = getUser(discordUserId);

  // already rewarded?
  if (user.rewarded) return { rewardedNow: false, user };

  // only reward at 3+
  if (user.referrals < 3) return { rewardedNow: false, user };

  // mark rewarded in DB first so it never repeats
  markRewarded(discordUserId);

  // Try to give role + announce, but do NOT crash if missing
  try {
    if (REWARD_ROLE_ID || ANNOUNCE_CHANNEL_ID) {
      // Find a guild where this member exists (good enough for testing)
      for (const [, guild] of client.guilds.cache) {
        const member = await guild.members.fetch(discordUserId).catch(() => null);
        if (!member) continue;

        if (REWARD_ROLE_ID) {
          await member.roles.add(REWARD_ROLE_ID).catch((e) =>
            console.log("⚠️ role add failed:", e?.message || e)
          );
        }

        if (ANNOUNCE_CHANNEL_ID) {
          const ch = await guild.channels.fetch(ANNOUNCE_CHANNEL_ID).catch(() => null);
          if (ch && ch.isTextBased()) {
            await ch.send(
              `🎉 <@${discordUserId}> just hit **3 successful referrals** and earned **1 month free membership**!`
            );
          }
        }

        break;
      }
    }
  } catch (e) {
    console.log("⚠️ reward side-effects failed:", e?.message || e);
  }

  return { rewardedNow: true, user: getUser(discordUserId) };
}

// ---------------------------
// Whop webhook endpoint (real one later)
// ---------------------------
app.post("/webhooks/whop", async (req, res) => {
  console.log("📩 Whop event received:", req.body);

  // TODO tomorrow: parse Whop payload and find who to credit
  // For now just 200 OK so Whop won't retry
  return res.sendStatus(200);
});

// ---------------------------
// ADMIN TEST endpoint (simulate purchases)
// POST /admin/test/credit?key=YOURKEY
// body: { "code": "USERID-pitlg5", "count": 1 }
// ---------------------------
app.post("/admin/test/credit", async (req, res) => {
  // ✅ HARD FIX AUTH (handles quotes/whitespace)
  const clean = (v) =>
    String(v ?? "")
      .trim()
      .replace(/^["']+|["']+$/g, "") // remove quotes
      .replace(/\s+/g, ""); // remove hidden whitespace

  const expected = clean(process.env.ADMIN_TEST_KEY);
  const got = clean(req.query.key);

  if (!expected || got !== expected) {
    console.log("❌ ADMIN auth failed:", {
      hasExpected: Boolean(expected),
      gotLen: got.length,
      expectedLen: expected.length,
    });
    return res.status(401).json({ error: "Unauthorized" });
  }

  const { code, count } = req.body || {};
  if (!code || typeof code !== "string") {
    return res.status(400).json({ error: "Missing code" });
  }

  const n = Number(count ?? 1);
  const add = Number.isFinite(n) && n > 0 ? Math.floor(n) : 1;

  // code format: "DISCORDID-pitlg5"
  const discordUserId = code.split("-")[0];
  if (!discordUserId) {
    return res.status(400).json({ error: "Bad code format" });
  }

  // add referrals
  let u;
  for (let i = 0; i < add; i++) {
    u = addReferral(discordUserId);
  }

  const reward = await tryReward(discordUserId);

  return res.json({
    ok: true,
    credited: add,
    discordUserId,
    user: getUser(discordUserId),
    rewardedNow: reward.rewardedNow,
  });
});

// ---------------------------
// Basic health route
// ---------------------------
app.get("/", (req, res) => {
  res.status(200).send("ok");
});

// Start everything
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Server listening on port ${PORT}`);
});

// Validate env + login
if (!process.env.DISCORD_TOKEN) {
  console.error("❌ Missing DISCORD_TOKEN env var");
  process.exit(1);
}

client.login(process.env.DISCORD_TOKEN).catch((err) => {
  console.error("❌ Discord login failed:", err);
  process.exit(1);
});
