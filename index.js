// index.js - Discord referral bot + Whop webhook (Postgres db.js)
// MODE B ONLY: Secure webhook via URL token (/webhooks/whop/:token)
//
// Features kept:
// - /ref generates stable ref code + link
// - /refstats shows X/3
// - Whop webhook credits referrals + dedup via counted_events
// - Auto reward at 3 referrals: role + announce
// - Admin endpoints: /admin/test/credit, /admin/test/set, /admin/debug/user

require("dotenv").config();

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
  manualAddReferral,
  setReferrals,
} = require("./db");

const app = express();

// ---- env ----
const PORT = process.env.PORT || 3000;

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;

const GUILD_ID = process.env.GUILD_ID;
const REWARD_ROLE_ID = process.env.REWARD_ROLE_ID;
const ANNOUNCE_CHANNEL_ID = process.env.ANNOUNCE_CHANNEL_ID;

const WHOP_CHECKOUT_URL = process.env.WHOP_CHECKOUT_URL || "";
const WEBHOOK_URL_TOKEN = String(process.env.WEBHOOK_URL_TOKEN || "").trim();

const DEBUG_WEBHOOKS =
  String(process.env.DEBUG_WEBHOOKS || "").toLowerCase() === "true";

const BUILD_SHA = process.env.RAILWAY_GIT_COMMIT_SHA || "unknown";

// ---- crash logs ----
process.on("unhandledRejection", (err) =>
  console.error("unhandledRejection:", err)
);
process.on("uncaughtException", (err) =>
  console.error("uncaughtException:", err)
);

// ---- STARTUP DEBUG (NO secret leaks) ----
console.log("🔎 STARTUP CONFIG CHECK:");
console.log("  BUILD SHA:", BUILD_SHA);
console.log("  DEBUG_WEBHOOKS:", DEBUG_WEBHOOKS);
console.log("  WEBHOOK_URL_TOKEN length:", WEBHOOK_URL_TOKEN.length);
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
  if (req.path.startsWith("/webhooks/whop")) return next();
  return express.json()(req, res, next);
});

// ---- basic routes ----
app.get("/", (req, res) => res.status(200).send("ok"));
app.get("/health", (req, res) => res.status(200).json({ ok: true }));

// Safe debug routes
app.get("/__debug/version", (req, res) =>
  res.json({ ok: true, sha: BUILD_SHA })
);
app.post("/__debug/post", express.text({ type: "*/*" }), (req, res) => {
  console.log("✅ HIT /__debug/post", { len: (req.body || "").length });
  return res.status(200).send("ok");
});
app.get("/__debug/webhook_mode", (req, res) =>
  res.json({
    ok: true,
    mode: "URL_TOKEN",
    webhookUrlTokenLen: WEBHOOK_URL_TOKEN.length,
  })
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
  if (!expected || got !== expected) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const { discordId, count } = req.body || {};
  if (!discordId) return res.status(400).json({ error: "missing discordId" });

  const n = Number(count ?? 1);
  if (!Number.isFinite(n) || n <= 0)
    return res.status(400).json({ error: "invalid count" });

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
  if (!expected || got !== expected) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const { discordId, referrals, rewarded } = req.body || {};
  if (!discordId) return res.status(400).json({ error: "missing discordId" });

  const r = Number(referrals ?? 0);
  const rw = Number(rewarded ?? 0);

  if (!Number.isFinite(r) || r < 0)
    return res.status(400).json({ error: "invalid referrals" });
  if (!Number.isFinite(rw) || (rw !== 0 && rw !== 1))
    return res.status(400).json({ error: "invalid rewarded" });

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
  if (!expected || got !== expected) {
    return res.status(401).json({ error: "Unauthorized" });
  }

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

function normalizeEventType(t) {
  return String(t || "").trim().toLowerCase().replace(/_/g, ".");
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

async function awardIfNeeded(discordUserId) {
  const user = await getUser(discordUserId);
  if (!user) return;

  if ((user.referrals ?? 0) >= 3 && user.rewarded !== 1) {
    await markRewarded(discordUserId);

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
      return interaction.reply({
        content: "❌ Something went wrong. Try again.",
        ephemeral: true,
      });
    }
  }
});

// -------------------------
// Whop webhook (MODE B: tokenized URL)
// -------------------------
app.post(
  "/webhooks/whop/:token",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    if (!WEBHOOK_URL_TOKEN) {
      return res
        .status(500)
        .json({ ok: false, error: "missing_WEBHOOK_URL_TOKEN" });
    }

    if (String(req.params.token || "") !== WEBHOOK_URL_TOKEN) {
      return res.status(401).json({ ok: false, error: "bad_webhook_token" });
    }

    const rawBody = req.body?.toString("utf8") || "";

    let event;
    try {
      event = JSON.parse(rawBody);
    } catch {
      return res.status(400).json({ ok: false, error: "bad_json" });
    }

    const eventType = normalizeEventType(event?.type);
    const eventId = extractEventId(event);

    if (DEBUG_WEBHOOKS) {
      console.log("📩 WHOP EVENT:", {
        type: eventType,
        eventId,
        extractedRef: extractRefCode(event),
      });
    }

    // Credit only paid events
    const paidTypes = new Set(["invoice.paid", "payment.succeeded"]);
    if (!paidTypes.has(eventType)) {
      return res.status(200).json({ ok: true, ignored: true, type: eventType });
    }

    // Dedup
    if (eventId && (await isEventCounted(eventId))) {
      return res.status(200).json({ ok: true, deduped: true });
    }

    const refCode = extractRefCode(event);
    console.log("🔎 Extracted refCode:", refCode);

    if (!refCode) {
      if (eventId) await markEventCounted(eventId);
      return res.status(200).json({
        ok: true,
        ignored: true,
        reason: "no_ref_code",
      });
    }

    const discordUserId = await lookupDiscordIdByRefCode(refCode);
    console.log("👤 Ref code maps to discordUserId:", discordUserId);

    if (!discordUserId) {
      if (eventId) await markEventCounted(eventId);
      return res.status(200).json({
        ok: true,
        ignored: true,
        reason: "unknown_ref_code",
      });
    }

    if (eventId) await markEventCounted(eventId);

    const updated = await addReferral(discordUserId);
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
if (!CLIENT_ID) {
  console.warn("⚠️ Missing CLIENT_ID (only needed to register slash commands).");
}

app.listen(PORT, "0.0.0.0", () =>
  console.log(`🚀 Server listening on port ${PORT}`)
);

client.login(DISCORD_TOKEN).catch((err) => {
  console.error("❌ Discord login failed:", err);
  process.exit(1);
});
