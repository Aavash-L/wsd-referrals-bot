// index.js - main server file for Discord referral program with Whop integration

require("dotenv").config();

const express = require("express");
const { Client, GatewayIntentBits, Partials } = require("discord.js");
const { Whop } = require("@whop/sdk");

const {
  getUser,
  addReferral,
  markRewarded,
  getOrCreateRefCode,
  lookupDiscordIdByRefCode,
  isEventCounted,
  markEventCounted,
  manualAddReferral,
  setReferrals,
} = require("./db");

const app = express();

// ---- env ----
const PORT = process.env.PORT || 3000;

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const GUILD_ID = process.env.GUILD_ID;
const REWARD_ROLE_ID = process.env.REWARD_ROLE_ID;
const ANNOUNCE_CHANNEL_ID = process.env.ANNOUNCE_CHANNEL_ID;

const WHOP_WEBHOOK_SECRET = String(process.env.WHOP_WEBHOOK_SECRET || "").trim();
const WHOP_CHECKOUT_URL = process.env.WHOP_CHECKOUT_URL || "";
const DEBUG_WEBHOOKS = String(process.env.DEBUG_WEBHOOKS || "").toLowerCase() === "true";

// ---- crash logs ----
process.on("unhandledRejection", (err) => console.error("unhandledRejection:", err));
process.on("uncaughtException", (err) => console.error("uncaughtException:", err));

// ---- STARTUP DEBUG ----
console.log("🔍 STARTUP CONFIG CHECK:");
console.log("  WHOP_WEBHOOK_SECRET length:", WHOP_WEBHOOK_SECRET.length);
console.log("  WHOP_WEBHOOK_SECRET prefix:", WHOP_WEBHOOK_SECRET.substring(0, 15) + "...");
console.log("  WHOP_WEBHOOK_SECRET suffix:", "..." + WHOP_WEBHOOK_SECRET.substring(Math.max(0, WHOP_WEBHOOK_SECRET.length - 15)));
console.log("  DEBUG_WEBHOOKS:", DEBUG_WEBHOOKS);
console.log("---");

// ---- Whop SDK (V1 webhook verification) ----
// Whop SDK expects webhookKey as base64
const whopsdk = new Whop({
  webhookKey: Buffer.from(WHOP_WEBHOOK_SECRET).toString("base64"),
});

// ---- discord client ----
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers],
  partials: [Partials.GuildMember],
});

client.once("ready", () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
});

// -------------------------
// Helpers
// -------------------------

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

// deep scan scans strings too
function extractRefCode(event) {
  const direct =
    event?.data?.metadata?.ref ||
    event?.data?.metadata?.ref_code ||
    event?.data?.ref ||
    event?.data?.ref_code ||
    event?.metadata?.ref ||
    event?.metadata?.ref_code ||
    event?.ref ||
    event?.ref_code;

  if (typeof direct === "string" && direct.trim()) return direct.trim();

  const targetPattern = /\b\d{10,}-[a-z0-9]{4,}\b/i;

  const seen = new Set();
  function walk(node) {
    if (node == null) return null;

    if (typeof node === "string") {
      const m = node.match(targetPattern);
      return m ? m[0] : null;
    }

    if (typeof node !== "object") return null;

    if (seen.has(node)) return null;
    seen.add(node);

    for (const [k, v] of Object.entries(node)) {
      if (typeof v === "string" && /ref/i.test(k)) {
        const m = v.match(targetPattern);
        if (m) return m[0];
        if (v.trim()) return v.trim();
      }

      const found = walk(v);
      if (found) return found;
    }

    return null;
  }

  return walk(event);
}

function extractEventId(event) {
  return (
    event?.id ||
    event?.data?.id ||
    event?.data?.invoice_id ||
    event?.data?.payment_id ||
    event?.invoice_id ||
    event?.payment_id ||
    null
  );
}

async function awardIfNeeded(discordUserId) {
  const user = await getUser(discordUserId);
  if (!user) return;

  if ((user.referrals ?? 0) >= 3 && user.rewarded !== 1) {
    // mark first to prevent double-awards
    await markRewarded(discordUserId);

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

// -------------------------
// Whop webhook (MUST be before express.json())
// -------------------------
app.post(
  "/webhooks/whop",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    const rawBody = req.body?.toString("utf8") || "";

    try {
      // ✅ Verify + parse using Whop SDK (handles V1 headers correctly)
      // Whop V1 uses: webhook-id, webhook-timestamp, webhook-signature
      const event = whopsdk.webhooks.unwrap(rawBody, { headers: req.headers });

      // Normalize type (Whop examples use payment.succeeded; you also had invoice variants)
      const eventType = String(event?.type || "")
        .toLowerCase()
        .replace(/_/g, ".");

      if (DEBUG_WEBHOOKS) {
        console.log("📩 WHOP WEBHOOK VERIFIED:", {
          type: eventType,
          eventId: extractEventId(event),
          hasData: !!event?.data,
          extractedRef: extractRefCode(event),
          headers: {
            "webhook-id": req.headers["webhook-id"],
            "webhook-timestamp": req.headers["webhook-timestamp"],
            "webhook-signature": req.headers["webhook-signature"],
          },
        });
      }

      // ✅ Paid types (support both)
      const paidTypes = new Set(["payment.succeeded", "invoice.paid", "invoice.paid"]);
      // If Whop sends invoice_paid, normalize above converts "_" -> "."
      // so invoice_paid => invoice.paid
      if (!paidTypes.has(eventType)) {
        return res.status(200).json({ ok: true, ignored: true, type: eventType });
      }

      const eventId = extractEventId(event);
      if (eventId && (await isEventCounted(eventId))) {
        return res.status(200).json({ ok: true, deduped: true });
      }

      const refCode = extractRefCode(event);
      console.log("🔎 Extracted refCode:", refCode);

      // Many Whop “test events” won’t include your ref metadata — this is fine.
      if (!refCode) {
        if (eventId) await markEventCounted(eventId);
        return res.status(200).json({ ok: true, ignored: true, reason: "no_ref_code" });
      }

      const discordUserId = await lookupDiscordIdByRefCode(refCode);
      console.log("👤 Ref code maps to discordUserId:", discordUserId);

      if (!discordUserId) {
        if (eventId) await markEventCounted(eventId);
        return res.status(200).json({ ok: true, ignored: true, reason: "unknown_ref_code" });
      }

      if (eventId) await markEventCounted(eventId);

      const updated = await addReferral(discordUserId);
      console.log("✅ Referral added. Updated user row:", updated);

      await awardIfNeeded(discordUserId);

      return res.status(200).json({ ok: true });
    } catch (err) {
      if (DEBUG_WEBHOOKS) {
        console.error("❌ Whop verify/unwrap failed:", err?.message || err);
        console.log("📨 RAW BODY (first 200 chars):", rawBody.substring(0, 200));
        console.log("📨 HEADERS:", {
          "webhook-id": req.headers["webhook-id"],
          "webhook-timestamp": req.headers["webhook-timestamp"],
          "webhook-signature": req.headers["webhook-signature"],
        });
      }
      return res.status(401).json({ ok: false, error: "invalid_signature" });
    }
  }
);

// ---- middleware (json for everything else) ----
app.use(express.json());

// ---- basic routes ----
app.get("/", (req, res) => res.status(200).send("ok"));
app.get("/health", (req, res) => res.status(200).json({ ok: true }));
app.get("/webhooks/whop", (req, res) => res.status(200).send("whop webhook endpoint alive"));

// -------------------------
// ADMIN endpoints (manual)
// -------------------------

function readAdminKey(req) {
  const expected = String(process.env.ADMIN_TEST_KEY || "").trim();
  const got = String(req.query.key || "").trim();
  return { expected, got };
}

// POST /admin/test/credit?key=XXXX
// body: { discordId: "123", count: 1 }
app.post("/admin/test/credit", async (req, res) => {
  const { expected, got } = readAdminKey(req);
  if (!expected || got !== expected) return res.status(401).json({ error: "Unauthorized" });

  const { discordId, count } = req.body || {};
  if (!discordId) return res.status(400).json({ error: "missing discordId" });

  const n = Number(count ?? 1);
  if (!Number.isFinite(n) || n <= 0) return res.status(400).json({ error: "invalid count" });

  try {
    const updated = await manualAddReferral(String(discordId), n);
    return res.json({ ok: true, user: updated });
  } catch (e) {
    console.error("admin credit failed:", e);
    return res.status(500).json({ ok: false, error: "server_error" });
  }
});

// POST /admin/test/set?key=XXXX
// body: { discordId: "123", referrals: 0..N, rewarded: 0|1 }
app.post("/admin/test/set", async (req, res) => {
  const { expected, got } = readAdminKey(req);
  if (!expected || got !== expected) return res.status(401).json({ error: "Unauthorized" });

  const { discordId, referrals, rewarded } = req.body || {};
  if (!discordId) return res.status(400).json({ error: "missing discordId" });

  const r = Number(referrals ?? 0);
  const rw = Number(rewarded ?? 0);

  if (!Number.isFinite(r) || r < 0) return res.status(400).json({ error: "invalid referrals" });
  if (!Number.isFinite(rw) || (rw !== 0 && rw !== 1)) return res.status(400).json({ error: "invalid rewarded" });

  try {
    const updated = await setReferrals(String(discordId), r, rw);
    return res.json({ ok: true, user: updated });
  } catch (e) {
    console.error("admin set failed:", e);
    return res.status(500).json({ ok: false, error: "server_error" });
  }
});

// GET /admin/debug/user?key=XXXX&discordId=123
app.get("/admin/debug/user", async (req, res) => {
  const { expected, got } = readAdminKey(req);
  if (!expected || got !== expected) return res.status(401).json({ error: "Unauthorized" });

  const discordId = String(req.query.discordId || "");
  if (!discordId) return res.status(400).json({ error: "missing discordId" });

  try {
    const user = await getUser(discordId);
    return res.json({
      ok: true,
      user: user || { discord_user_id: discordId, referrals: 0, rewarded: 0 },
    });
  } catch (e) {
    console.error("admin debug failed:", e);
    return res.status(500).json({ ok: false, error: "server_error" });
  }
});

// -------------------------
// Slash commands
// -------------------------
client.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  try {
    if (interaction.commandName === "ref") {
      const code = await getOrCreateRefCode(interaction.user.id);
      const link = buildReferralLink(code);

      return interaction.reply({
        content: link
          ? `🔗 ${interaction.user}'s referral link:\n${link}`
          : `🔗 ${interaction.user}'s referral code:\n\`${code}\`\n\n(Set WHOP_CHECKOUT_URL to show a full link.)`,
      });
    }

    if (interaction.commandName === "refstats") {
      const row = await getUser(interaction.user.id);
      const user = row || { referrals: 0, rewarded: 0 };

      return interaction.reply({
        content: `📈 **Referral Progress**\n👤 ${interaction.user}\n✅ **${user.referrals ?? 0} / 3** successful referrals`,
      });
    }
  } catch (err) {
    console.error("interactionCreate error:", err);
    if (!interaction.replied && !interaction.deferred) {
      return interaction.reply({ content: "❌ Something went wrong. Try again.", ephemeral: true });
    }
  }
});

// ---- start ----
if (!DISCORD_TOKEN) {
  console.error("❌ Missing DISCORD_TOKEN");
  process.exit(1);
}

app.listen(PORT, "0.0.0.0", () => console.log(`🚀 Server listening on port ${PORT}`));

client.login(DISCORD_TOKEN).catch((err) => {
  console.error("❌ Discord login failed:", err);
  process.exit(1);
});
