require('dotenv').config();
const express = require('express');
const crypto = require('crypto');
const { Client, GatewayIntentBits } = require('discord.js');
const {
  getUser,
  addReferral,
  markRewarded,
  getOrCreateRefCode,
  lookupDiscordIdByCode,
  purchaseAlreadyCounted,
  markPurchaseCounted,
} = require('./db');

const app = express();

// Helpful crash logs
process.on('unhandledRejection', (err) => console.error('unhandledRejection:', err));
process.on('uncaughtException', (err) => console.error('uncaughtException:', err));

/**
 * JSON for most routes; RAW for real whop webhook (signature verification)
 */
app.use((req, res, next) => {
  if (req.path === '/webhooks/whop') return next();
  return express.json()(req, res, next);
});

app.get('/', (req, res) => res.status(200).send('ok'));
app.get('/health', (req, res) => res.status(200).json({ ok: true }));

// Discord bot
const client = new Client({
  intents: [GatewayIntentBits.Guilds],
});

client.once('ready', () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
});

function buildReferralLink(code) {
  const base = process.env.WHOP_CHECKOUT_URL;
  if (!base) return null;
  const url = new URL(base);
  url.searchParams.set('ref', code);
  return url.toString();
}

async function grantRewardIfNeeded(discordUserId, userRow) {
  if (!userRow) return;
  if (userRow.rewarded) return;
  if (userRow.referrals < 3) return;

  // Mark rewarded first to prevent double awards
  markRewarded(discordUserId);

  const guildId = process.env.GUILD_ID;
  const roleId = process.env.REWARD_ROLE_ID;
  const announceChannelId = process.env.ANNOUNCE_CHANNEL_ID;

  if (!guildId || !roleId || !announceChannelId) {
    console.log('⚠️ Reached 3 referrals but missing GUILD_ID/REWARD_ROLE_ID/ANNOUNCE_CHANNEL_ID');
    return;
  }

  try {
    const guild = await client.guilds.fetch(guildId);
    const member = await guild.members.fetch(discordUserId).catch(() => null);

    if (member) {
      await member.roles.add(roleId).catch((e) => console.error('Role add failed:', e));
    }

    const channel = await guild.channels.fetch(announceChannelId).catch(() => null);
    if (channel && channel.isTextBased()) {
      await channel.send(`🎉 <@${discordUserId}> hit **3 referrals** — granted **1 month free**! ✅`);
    }
  } catch (err) {
    console.error('grantRewardIfNeeded error:', err);
  }
}

function isPaidEvent(event) {
  const type = (event.type || event.event || '').toLowerCase();
  const status = (event.status || event.data?.status || event.data?.payment_status || '').toLowerCase();

  if (type.includes('paid') || type.includes('payment_succeeded') || type.includes('purchase_completed')) return true;
  if (status === 'paid' || status === 'succeeded' || status === 'complete' || status === 'completed') return true;

  return false;
}

function extractRefCode(event) {
  return (
    event.ref ||
    event.ref_code ||
    event.data?.ref ||
    event.data?.ref_code ||
    event.data?.metadata?.ref ||
    event.data?.metadata?.ref_code ||
    event.metadata?.ref ||
    event.metadata?.ref_code ||
    null
  );
}

function extractPurchaseId(event) {
  return (
    event.id ||
    event.purchase_id ||
    event.order_id ||
    event.data?.id ||
    event.data?.purchase_id ||
    event.data?.order_id ||
    null
  );
}

// Slash commands
client.on('interactionCreate', async (interaction) => {
  try {
    if (!interaction.isChatInputCommand()) return;

    if (interaction.commandName === 'ref') {
      const code = getOrCreateRefCode(interaction.user.id);
      const link = buildReferralLink(code);

      if (!link) {
        // Still useful even without WHOP url — show the code so you can test
        return interaction.reply({
          content:
            `Here’s your referral code (Whop link will be added later):\n` +
            `\`${code}\`\n\n` +
            `Once WHOP_CHECKOUT_URL is set, this command will return your full link.`,
          ephemeral: true,
        });
      }

      return interaction.reply({
        content: `Here’s your referral link:\n${link}`,
        ephemeral: true,
      });
    }

    if (interaction.commandName === 'refstats') {
      const user = getUser(interaction.user.id);
      return interaction.reply({
        content: `You have **${user.referrals} / 3** successful referrals.`,
        ephemeral: true,
      });
    }
  } catch (err) {
    console.error('interactionCreate error:', err);
  }
});

/**
 * ✅ TEST ENDPOINT (NO WHOP NEEDED)
 * POST /test/referral
 * headers:
 *   x-admin-key: <ADMIN_TEST_KEY>
 * body:
 *   { "ref": "<refCode>", "purchase_id": "test_123" }
 */
app.post('/test/referral', async (req, res) => {
  const adminKey = process.env.ADMIN_TEST_KEY;
  const provided = req.header('x-admin-key');

  if (!adminKey || provided !== adminKey) {
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }

  try {
    const refCode = req.body?.ref;
    const purchaseId = req.body?.purchase_id || `test_${Date.now()}`;

    if (!refCode) return res.status(400).json({ ok: false, error: 'missing ref' });

    if (purchaseAlreadyCounted(purchaseId)) {
      return res.json({ ok: true, deduped: true, purchase_id: purchaseId });
    }

    const discordUserId = lookupDiscordIdByCode(refCode);
    if (!discordUserId) return res.status(404).json({ ok: false, error: 'unknown ref code' });

    markPurchaseCounted(purchaseId, refCode);

    const updated = addReferral(discordUserId);
    await grantRewardIfNeeded(discordUserId, updated);

    return res.json({ ok: true, discord_user_id: discordUserId, referrals: updated.referrals, purchase_id: purchaseId });
  } catch (err) {
    console.error('/test/referral error:', err);
    return res.status(500).json({ ok: false, error: 'server error' });
  }
});

/**
 * Your manual test endpoint (now can simulate paid events too)
 * POST /webhooks/whop/test (JSON)
 */
app.post('/webhooks/whop/test', async (req, res) => {
  try {
    const event = req.body || {};
    console.log('🧪 Whop test event:', event);

    const refCode = extractRefCode(event);
    const purchaseId = extractPurchaseId(event) || `test_${Date.now()}`;

    if (!refCode) return res.status(400).json({ ok: false, error: 'missing ref in payload' });

    if (purchaseAlreadyCounted(purchaseId)) {
      return res.json({ ok: true, deduped: true, purchase_id: purchaseId });
    }

    // For testing, assume paid unless explicitly set not paid
    const paid = event.paid === false ? false : true;
    if (!paid) return res.json({ ok: true, ignored: true, reason: 'not paid' });

    const discordUserId = lookupDiscordIdByCode(refCode);
    if (!discordUserId) return res.status(404).json({ ok: false, error: 'unknown ref code' });

    markPurchaseCounted(purchaseId, refCode);

    const updated = addReferral(discordUserId);
    await grantRewardIfNeeded(discordUserId, updated);

    return res.json({ ok: true, discord_user_id: discordUserId, referrals: updated.referrals, purchase_id: purchaseId });
  } catch (err) {
    console.error('/webhooks/whop/test error:', err);
    return res.status(500).json({ ok: false, error: 'server error' });
  }
});

/**
 * REAL Whop webhook (raw body)
 * (signature verify can be added tomorrow once owner gives you the secret)
 */
function verifyWhopSignature(req) {
  const secret = process.env.WHOP_WEBHOOK_SECRET;
  if (!secret) return true;

  const sig =
    req.header('whop-signature') ||
    req.header('x-whop-signature') ||
    req.header('x-signature') ||
    '';

  if (!sig) return false;

  const raw = req.body; // Buffer
  const expected = crypto.createHmac('sha256', secret).update(raw).digest('hex');
  const cleaned = sig.startsWith('sha256=') ? sig.slice(7) : sig;

  try {
    return crypto.timingSafeEqual(Buffer.from(cleaned, 'hex'), Buffer.from(expected, 'hex'));
  } catch {
    return false;
  }
}

app.post('/webhooks/whop', express.raw({ type: 'application/json' }), async (req, res) => {
  try {
    if (!verifyWhopSignature(req)) return res.sendStatus(401);

    const event = JSON.parse(req.body.toString('utf8'));
    console.log('📩 Whop event:', event.type || event.event || '(no type)');

    if (!isPaidEvent(event)) return res.sendStatus(200);

    const refCode = extractRefCode(event);
    const purchaseId = extractPurchaseId(event);

    if (!refCode) return res.sendStatus(200);

    if (purchaseId && purchaseAlreadyCounted(purchaseId)) return res.sendStatus(200);

    const discordUserId = lookupDiscordIdByCode(refCode);
    if (!discordUserId) return res.sendStatus(200);

    if (purchaseId) markPurchaseCounted(purchaseId, refCode);

    const updated = addReferral(discordUserId);
    await grantRewardIfNeeded(discordUserId, updated);

    return res.sendStatus(200);
  } catch (err) {
    console.error('❌ Whop webhook error:', err);
    return res.sendStatus(500);
  }
});

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server listening on port ${PORT}`));

// Validate env + login
if (!process.env.DISCORD_TOKEN) {
  console.error('❌ Missing DISCORD_TOKEN env var');
  process.exit(1);
}

client.login(process.env.DISCORD_TOKEN).catch((err) => {
  console.error('❌ Discord login failed:', err);
  process.exit(1);
});
