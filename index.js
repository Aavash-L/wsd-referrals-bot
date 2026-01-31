require('dotenv').config();
const express = require('express');
const { Client, GatewayIntentBits } = require('discord.js');
const { getUser, addReferral, markRewarded } = require('./db');

const app = express();
app.use(express.json());

// =====================
// Crash safety (Railway)
// =====================
process.on('unhandledRejection', (err) => console.error('unhandledRejection:', err));
process.on('uncaughtException', (err) => console.error('uncaughtException:', err));

// =====================
// Discord bot
// =====================
const client = new Client({
  intents: [GatewayIntentBits.Guilds],
});

client.once('ready', () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
});

// Slash commands
client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  if (interaction.commandName === 'ref') {
    const code = `${interaction.user.id}-pitlg5`; // temp format
    return interaction.reply({
      content: `Here’s your referral code (Whop link will be added later):\n\`${code}\``,
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
});

// =====================
// Whop webhook (real)
// =====================
app.post('/webhooks/whop', (req, res) => {
  console.log('📩 Whop event received:', req.body);
  res.sendStatus(200);
});

// =====================
// ADMIN TEST ENDPOINT
// =====================
// Allows manual testing without Whop
// POST /admin/test/credit?key=ADMIN_TEST_KEY
app.post('/admin/test/credit', (req, res) => {
  if (req.query.key !== process.env.ADMIN_TEST_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const { code, count = 1 } = req.body;
  if (!code) {
    return res.status(400).json({ error: 'Missing referral code' });
  }

  const discordId = code.split('-')[0];
  let user;

  for (let i = 0; i < count; i++) {
    user = addReferral(discordId);
  }

  console.log(`🧪 Test credit: ${count} referral(s) → ${discordId}`);

  // Reward logic (no role yet, just mark)
  if (user.referrals >= 3 && !user.rewarded) {
    markRewarded(discordId);
    console.log(`🎉 User ${discordId} hit 3 referrals (reward pending role)`);
  }

  return res.json({
    ok: true,
    user,
  });
});

// =====================
// Start server
// =====================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Server listening on port ${PORT}`);
});

// =====================
// Login bot
// =====================
if (!process.env.DISCORD_TOKEN) {
  console.error('❌ Missing DISCORD_TOKEN');
  process.exit(1);
}

client.login(process.env.DISCORD_TOKEN).catch((err) => {
  console.error('❌ Discord login failed:', err);
  process.exit(1);
});
