// index.js - Discord referral bot + Whop webhook (Postgres db.js)
// Features kept:
// - /ref generates stable ref code + link
// - /refstats shows X/3
// - Whop webhook credits referrals + dedup via counted_events
// - Auto reward at 3 referrals: role + announce
// - Admin endpoints: /admin/test/credit, /admin/test/set, /admin/debug/user

require("dotenv").config();

const crypto = require("crypto");
const express = require("express");
const { Client, GatewayIntentBits, Partials } = require("discord.js");
const { Webhook } = require("svix");

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

const WHOP_WEBHOOK_SECRET = String(process.env.WHOP_WEBHOOK_SECRET || "");
const WHOP_CHECKOUT_URL = process.env.WHOP_CHECKOUT_URL || "";
const DEBUG_WEBHOOKS = String(process.env.DEBUG_WEBHOOKS || "").toLowerCase() === "true";

const BUILD_SHA = process.env.RAILWAY_GIT_COMMIT_SHA || "unknown";

// ---- crash logs ----
process.on("unhandledRejection", (err) => console.error("unhandledRejection:", err));
process.on("uncaughtException", (err) => console.error("uncaughtException:", err));

// ---- STARTUP DEBUG (NO secret leak) ----
console.log("🔎 STARTUP CONFIG CHECK:");
console.log("  DEBUG_WEBHOOKS:", DEBUG_WEBHOOKS);
console.log("  WHOP_WEBHOOK_SECRET length:", WHOP_WEBHOOK_SECRET.length);
console.log("  BUILD SHA:", BUILD_SHA);
console.log("---");

// ---- discord client ----
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers],
  partials: [Partials.GuildMember],
});

client.once("ready", () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
});

// ---- middleware ----
// webhook must be raw; everything else JSON
app.use((req, res, next) => {
  if (req.path === "/webhooks/whop") return next();
  return express.json()(req, res, next);
});

// ---- basic routes ----
app.get("/", (req, res) => res.status(200).send("ok"));
app.get("/health", (req, res) => res.status(200).json({ ok: true }));
app.get("/webhooks/whop", (req, res) => res.status(200).send("whop webhook endpoint alive"));

// debug routes (safe)
app.get("/__debug/version", (req, res) => res.json({ ok: true, sha: BUILD_SHA }));
app.post("/__debug/post", express.text({ type: "*/*" }), (req, res) => {
  console.log("✅ HIT /__debug/post", { len: (req.body || "").length });
  return res.status(200).send("ok");
});
app.get("/__debug/whoplen", (req, res) =>
  res.json({ ok: true, whopSecretLen: WHOP_WEBHOOK_SECRET.length })
);

// -------------------------
// ADMIN endpoints
// -------------------------
function readAdminKey(req) {
  const expected = String(process.env.ADMIN_TEST_KEY || "").trim();
  const got = String(req.query.key || "").trim();
  return { expected, got };
}

// POST /admin/test/credit?key=XXXX
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

// Fallback legacy verifier (in case Whop doesn't send svix headers)
function verifyLegacyHmac(rawBody, timestamp, signature, secret) {
  if (!secret) return { ok: false, reason: "missing_secret" };
  if (!timestamp || !signature) return { ok: false, reason: "missing_headers" };

  // signature can be "v1,<sig>" or "<sig>"
  let provided = String(signature).trim();
  if (provided.includes(",")) {
    const parts = provided.split(",").map((s) => s.trim());
    if (parts[0] !== "v1") return { ok: false, reason: "bad_signature_format" };
    provided = parts[1];
  }
  if (!provided) return { ok: false, reason: "bad_signature_format" };

  const payload = `${timestamp}.${rawBody}`;
  const expected = crypto.createHmac("sha256", secret).update(payload).digest("base64");

  try {
    const a = Buffer.from(expected);
    const b = Buffer.from(provided);
    if (a.length !== b.length) return { ok: false, reason: "signature_mismatch" };
    return crypto.timingSafeEqual(a, b) ? { ok: true } : { ok: false, reason: "signature_mismatch" };
  } catch {
    return { ok: false, reason: "compare_error" };
  }
}

async function awardIfNeeded(discordUserId) {
  const user = await getUser(discordUserId);
  if (!user) return;

  if ((user.referrals ?? 0) >= 3 && user.rewarded !== 1) {
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

// -------------------------
// Whop webhook (supports Svix V1 headers + legacy fallback)
// -------------------------
app.post("/webhooks/whop", express.raw({ type: "application/json" }), async (req, res) => {
  const rawBody = req.body?.toString("utf8") || "";

  // Whop V1 (Svix-style) headers:
  const whId = req.header("webhook-id");
  const whTs = req.header("webhook-timestamp");
  const whSig = req.header("webhook-signature");

  if (DEBUG_WEBHOOKS) {
    console.log("📨 /webhooks/whop HEADERS:", {
      "webhook-id": whId || null,
      "webhook-timestamp": whTs || null,
      "webhook-signature": whSig ? whSig.substring(0, 40) + "..." : null,
      hasSecret: !!WHOP_WEBHOOK_SECRET,
      secretLen: WHOP_WEBHOOK_SECRET.length,
    });
  }

  // 1) Try Svix verify if V1 headers exist
  let event = null;
  let verified = false;

  if (whId && whTs && whSig) {
    try {
      const webhook = new Webhook(WHOP_WEBHOOK_SECRET);
      event = webhook.verify(rawBody, {
        "webhook-id": whId,
        "webhook-timestamp": whTs,
        "webhook-signature": whSig,
      });
      verified = true;
    } catch (e) {
      if (DEBUG_WEBHOOKS) console.warn("❌ Svix verify failed:", e?.message || e);
    }
  }

  // 2) Fallback: legacy HMAC style (just in case)
  if (!verified) {
    const legacy = verifyLegacyHmac(rawBody, whTs, whSig, WHOP_WEBHOOK_SECRET);
    if (!legacy.ok) {
      return res.status(401).json({ ok: false, error: "invalid_signature", reason: legacy.reason });
    }
    try {
      event = JSON.parse(rawBody);
      verified = true;
    } catch {
      return res.status(400).json({ ok: false, error: "bad_json" });
    }
  }

  // normalize type
  const eventType = String(event?.type || "").toLowerCase().replace(/_/g, ".");
  const eventId = extractEventId(event);

  if (DEBUG_WEBHOOKS) {
    console.log("📩 WHOP VERIFIED EVENT:", {
      type: eventType,
      eventId,
      extractedRef: extractRefCode(event),
    });
  }

  // only credit paid purchases
  const paidTypes = new Set(["invoice.paid", "payment.succeeded"]);
  if (!paidTypes.has(eventType)) {
    return res.status(200).json({ ok: true, ignored: true, type: eventType });
  }

  if (eventId && (await isEventCounted(eventId))) {
    return res.status(200).json({ ok: true, deduped: true });
  }

  const refCode = extractRefCode(event);
  console.log("🔎 Extracted refCode:", refCode);

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
