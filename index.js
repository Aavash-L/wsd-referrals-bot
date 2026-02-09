require("dotenv").config();

const crypto = require("crypto");
const express = require("express");
const { Client, GatewayIntentBits, Partials } = require("discord.js");

const {
  getUser,
  addReferral,
  markRewarded,
  getOrCreateRefCode,
  lookupDiscordIdByRefCode,
  isEventCounted,
  markEventCounted,
} = require("./db");

const app = express();

// ---- env ----
const PORT = process.env.PORT || 3000;

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const GUILD_ID = process.env.GUILD_ID;
const REWARD_ROLE_ID = process.env.REWARD_ROLE_ID;
const ANNOUNCE_CHANNEL_ID = process.env.ANNOUNCE_CHANNEL_ID;

const WHOP_WEBHOOK_SECRET = process.env.WHOP_WEBHOOK_SECRET;
const WHOP_CHECKOUT_URL = process.env.WHOP_CHECKOUT_URL || "";
const DEBUG_WEBHOOKS = String(process.env.DEBUG_WEBHOOKS || "").toLowerCase() === "true";

// ---- crash logs ----
process.on("unhandledRejection", (err) => console.error("unhandledRejection:", err));
process.on("uncaughtException", (err) => console.error("uncaughtException:", err));

// ---- discord client ----
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers],
  partials: [Partials.GuildMember],
});

client.once("ready", () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
});

// ---- middleware ----
app.use((req, res, next) => {
  if (req.path === "/webhooks/whop") return next(); // raw body there
  return express.json()(req, res, next);
});

app.get("/", (req, res) => res.status(200).send("ok"));
app.get("/health", (req, res) => res.status(200).json({ ok: true }));

function buildReferralLink(code) {
  if (!WHOP_CHECKOUT_URL) return null;
  try {
    const url = new URL(WHOP_CHECKOUT_URL);
    url.searchParams.set("ref", code);
    return url.toString();
  } catch {
    return null;
  }
}

function extractRefCode(event) {
  return (
    event?.data?.metadata?.ref ||
    event?.data?.metadata?.ref_code ||
    event?.data?.ref ||
    event?.data?.ref_code ||
    event?.metadata?.ref ||
    event?.metadata?.ref_code ||
    event?.ref ||
    event?.ref_code ||
    null
  );
}

function extractEventId(event) {
  return (
    event?.data?.id ||
    event?.data?.invoice_id ||
    event?.data?.payment_id ||
    event?.id ||
    event?.invoice_id ||
    event?.payment_id ||
    null
  );
}

// Whop signature verify: `${timestamp}.${rawBody}` -> HMAC sha256 base64
function verifyWhopSignature(rawBody, timestamp, signature, secret) {
  if (!secret) return { ok: false, reason: "missing_secret" };
  if (!timestamp || !signature) return { ok: false, reason: "missing_headers" };

  const [version, provided] = String(signature).split(",");
  if (version !== "v1" || !provided) return { ok: false, reason: "bad_signature_format" };

  const payload = `${timestamp}.${rawBody}`;
  const expected = crypto.createHmac("sha256", secret).update(payload).digest("base64");

  try {
    const a = Buffer.from(expected);
    const b = Buffer.from(provided);
    if (a.length !== b.length) return { ok: false, reason: "signature_mismatch" };
    const ok = crypto.timingSafeEqual(a, b);
    return ok ? { ok: true } : { ok: false, reason: "signature_mismatch" };
  } catch {
    return { ok: false, reason: "compare_error" };
  }
}

async function awardIfNeeded(discordUserId) {
  const user = getUser(discordUserId);
  if (!user) return;

  if (user.referrals >= 3 && user.rewarded !== 1) {
    // mark first to prevent double-awards
    markRewarded(discordUserId);

    if (!GUILD_ID || !REWARD_ROLE_ID || !ANNOUNCE_CHANNEL_ID) {
      console.warn("⚠️ Missing GUILD_ID/REWARD_ROLE_ID/ANNOUNCE_CHANNEL_ID (reward still marked).");
      return;
    }

    try {
      const guild = await client.guilds.fetch(GUILD_ID);
      const member = await guild.members.fetch(discordUserId);

      await member.roles.add(REWARD_ROLE_ID);

      const channel = await guild.channels.fetch(ANNOUNCE_CHANNEL_ID);
      if (channel && channel.isTextBased()) {
        await channel.send(
          `🎉 <@${discordUserId}> just hit **3 referrals** — granting **1 month free membership**! ✅`
        );
      }
    } catch (err) {
      console.error("❌ Reward flow failed:", err);
    }
  }
}



client.once("ready", () => {
  console.log(`✅ Logged in as ${client.user.tag}`);

  // TEMP: one-time manual credit for El Fredy
  try {
    const { manualAddReferral } = require("./db");
    const updated = manualAddReferral("1381064337229217892", 1);
    console.log("✅ Manual credit applied:", updated);
  } catch (e) {
    console.error("❌ Manual credit failed:", e);
  }
});






// ---- slash commands ----
client.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  if (interaction.commandName === "ref") {
    const code = getOrCreateRefCode(interaction.user.id);
    const link = buildReferralLink(code);

return interaction.reply({
  content: link
    ? `🔗 ${interaction.user}’s referral link:\n${link}`
    : `🔗 ${interaction.user}’s referral code:\n\`${code}\`\n\n(Set WHOP_CHECKOUT_URL to show a full link.)`,
});

  }

  if (interaction.commandName === "refstats") {
    const user = getUser(interaction.user.id);
return interaction.reply({
  content: `📈 **Referral Progress**\n👤 ${interaction.user}\n✅ **${user.referrals} / 3** successful referrals`,
});

  }
});

// ---- whop webhook ----
app.post("/webhooks/whop", express.raw({ type: "application/json" }), async (req, res) => {
  const rawBody = req.body.toString("utf8");

  const signature = req.header("webhook-signature");
  const timestamp = req.header("webhook-timestamp");

  const verified = verifyWhopSignature(rawBody, timestamp, signature, WHOP_WEBHOOK_SECRET);
  if (!verified.ok) {
    if (DEBUG_WEBHOOKS) console.warn("❌ Whop signature failed:", verified.reason);
    return res.status(401).json({ ok: false, error: "invalid_signature", reason: verified.reason });
  }

  let event;
  try {
    event = JSON.parse(rawBody);
  } catch {
    return res.status(400).json({ ok: false, error: "bad_json" });
  }

  if (DEBUG_WEBHOOKS) console.log("📩 Whop webhook type:", event?.type);

  // ✅ paid purchase only
  if (event?.type !== "invoice.paid") {
    return res.status(200).json({ ok: true, ignored: true, type: event?.type });
  }

  const eventId = extractEventId(event);
  if (eventId && isEventCounted(eventId)) {
    return res.status(200).json({ ok: true, deduped: true });
  }

  const refCode = extractRefCode(event);
  if (!refCode) {
    if (DEBUG_WEBHOOKS) console.warn("⚠️ invoice.paid but no ref code found");
    if (eventId) markEventCounted(eventId);
    return res.status(200).json({ ok: true, ignored: true, reason: "no_ref_code" });
  }

  const discordUserId = lookupDiscordIdByRefCode(refCode);
  if (!discordUserId) {
    if (DEBUG_WEBHOOKS) console.warn("⚠️ unknown ref code:", refCode);
    if (eventId) markEventCounted(eventId);
    return res.status(200).json({ ok: true, ignored: true, reason: "unknown_ref_code" });
  }

  if (eventId) markEventCounted(eventId);

  const updated = addReferral(discordUserId);
  if (DEBUG_WEBHOOKS) console.log(`✅ Referral counted for ${discordUserId}. Total: ${updated.referrals}`);

  await awardIfNeeded(discordUserId);

  return res.status(200).json({ ok: true });
});

// ---- start ----
if (!DISCORD_TOKEN) {
  console.error("❌ Missing DISCORD_TOKEN");
  process.exit(1);
}

app.listen(PORT, () => console.log(`🚀 Server listening on port ${PORT}`));

client.login(DISCORD_TOKEN).catch((err) => {
  console.error("❌ Discord login failed:", err);
  process.exit(1);
});
