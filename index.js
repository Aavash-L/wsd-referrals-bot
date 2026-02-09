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
  manualAddReferral, // make sure this exists in db.js exports
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
const DEBUG_WEBHOOKS =
  String(process.env.DEBUG_WEBHOOKS || "").toLowerCase() === "true";

// ---- crash logs ----
process.on("unhandledRejection", (err) =>
  console.error("unhandledRejection:", err)
);
process.on("uncaughtException", (err) =>
  console.error("uncaughtException:", err)
);

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
app.get("/webhooks/whop", (req, res) =>
  res.status(200).send("whop webhook endpoint alive")
);

// -------------------------
// ADMIN endpoints (manual)
// -------------------------

function readAdminKey(req) {
  const expected = (process.env.ADMIN_TEST_KEY || "").replace(/^"+|"+$/g, "");
  const got = (req.query.key || "").replace(/^"+|"+$/g, "");
  return { expected, got };
}

// POST /admin/test/credit?key=XXXX
// body: { discordId: "123", count: 1 }
app.post("/admin/test/credit", (req, res) => {
  const { expected, got } = readAdminKey(req);
  if (!expected || got !== expected) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const { discordId, count } = req.body || {};
  if (!discordId) return res.status(400).json({ error: "missing discordId" });

  const n = Number(count ?? 1);
  if (!Number.isFinite(n) || n <= 0)
    return res.status(400).json({ error: "invalid count" });

  try {
    const updated = manualAddReferral(String(discordId), n);
    return res.json({ ok: true, user: updated });
  } catch (e) {
    console.error("admin credit failed:", e);
    return res.status(500).json({ ok: false, error: "server_error" });
  }
});

// GET /admin/debug/user?key=XXXX&discordId=123
app.get("/admin/debug/user", (req, res) => {
  const { expected, got } = readAdminKey(req);
  if (!expected || got !== expected) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const discordId = String(req.query.discordId || "");
  if (!discordId) return res.status(400).json({ error: "missing discordId" });

  try {
    const user = getUser(discordId);
    return res.json({
      ok: true,
      user:
        user || { discord_user_id: discordId, referrals: 0, rewarded: 0 },
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

// ✅ fixed: deep scan now actually scans strings too
function extractRefCode(event) {
  // 1) known paths
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

  // 2) deep scan for any ref-looking string or URL containing it
  const targetPattern = /\b\d{10,}-[a-z0-9]{4,}\b/i;

  const seen = new Set();
  function walk(node) {
    if (node == null) return null;

    // ✅ handle strings
    if (typeof node === "string") {
      const m = node.match(targetPattern);
      return m ? m[0] : null;
    }

    // handle non-objects
    if (typeof node !== "object") return null;

    if (seen.has(node)) return null;
    seen.add(node);

    for (const [k, v] of Object.entries(node)) {
      // if key name contains ref and value is string
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
  if (version !== "v1" || !provided)
    return { ok: false, reason: "bad_signature_format" };

  const payload = `${timestamp}.${rawBody}`;
  const expected = crypto
    .createHmac("sha256", secret)
    .update(payload)
    .digest("base64");

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
      console.warn(
        "⚠️ Missing GUILD_ID/REWARD_ROLE_ID/ANNOUNCE_CHANNEL_ID (reward still marked)."
      );
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
    const user = getUser(interaction.user.id) || {
      referrals: 0,
      rewarded: 0,
    };

    return interaction.reply({
      content: `📈 **Referral Progress**\n👤 ${interaction.user}\n✅ **${user.referrals} / 3** successful referrals`,
    });
  }
});

// -------------------------
// Whop webhook
// -------------------------
app.post(
  "/webhooks/whop",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    const rawBody = req.body.toString("utf8");

    const signature = req.header("webhook-signature");
    const timestamp = req.header("webhook-timestamp");

    const verified = verifyWhopSignature(
      rawBody,
      timestamp,
      signature,
      WHOP_WEBHOOK_SECRET
    );
    if (!verified.ok) {
      if (DEBUG_WEBHOOKS)
        console.warn("❌ Whop signature failed:", verified.reason);
      return res
        .status(401)
        .json({ ok: false, error: "invalid_signature", reason: verified.reason });
    }

    let event;
    try {
      event = JSON.parse(rawBody);
    } catch {
      return res.status(400).json({ ok: false, error: "bad_json" });
    }

    const eventType = event?.type;

    if (DEBUG_WEBHOOKS) {
      console.log("📩 WHOP WEBHOOK IN:", {
        type: eventType,
        eventId: extractEventId(event),
        hasData: !!event?.data,
        hasMetadata: !!(event?.data?.metadata || event?.metadata),
        extractedRef: extractRefCode(event),
      });
    }

    // ✅ paid purchase only (support both legacy + v1)
    const paidTypes = new Set(["invoice.paid", "payment.succeeded"]);
    if (!paidTypes.has(eventType)) {
      return res.status(200).json({ ok: true, ignored: true, type: eventType });
    }

    const eventId = extractEventId(event);
    if (eventId && isEventCounted(eventId)) {
      return res.status(200).json({ ok: true, deduped: true });
    }

    const refCode = extractRefCode(event);
    console.log("🔎 Extracted refCode:", refCode);

    if (!refCode) {
      if (eventId) markEventCounted(eventId);
      return res.status(200).json({
        ok: true,
        ignored: true,
        reason: "no_ref_code",
      });
    }

    const discordUserId = lookupDiscordIdByRefCode(refCode);
    console.log("👤 Ref code maps to discordUserId:", discordUserId);

    if (!discordUserId) {
      if (eventId) markEventCounted(eventId);
      return res.status(200).json({
        ok: true,
        ignored: true,
        reason: "unknown_ref_code",
      });
    }

    if (eventId) markEventCounted(eventId);

    const updated = addReferral(discordUserId);
    console.log("✅ Referral added. Updated user row:", updated);

    await awardIfNeeded(discordUserId);

    return res.status(200).json({ ok: true });
  }
);

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
