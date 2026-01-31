require('dotenv').config();
const express = require('express');
const { Client, GatewayIntentBits } = require('discord.js');
const { getUser, addReferral, markRewarded } = require('./db');

const app = express();
app.use(express.json());

// --------------------
// Safety logging
// --------------------
process.on('unhandledRejection', err =>
  console.error('unhandledRejection:', err)
);
process.on('uncaughtException', err =>
  console.error('uncaughtException:', err)
);

// --------------------
// Discord bot
// --------------------
const client = new Client({
  intents: [GatewayIntentBits.Guilds],
});

client.once('ready', () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
});

// Slash commands
client.on('interactionCreate', async interaction => {
  if (!interaction.isChatInputCommand()) return;

  if (interaction.commandName === 'ref') {
    const code = `${interaction.user.id}-pitlg5`; // temp suffix
    return interaction.reply({
      content:
        `Here’s your referral code (Whop link will be added later):\n` +
        `\`${code}\`\n\n` +
        `Once WHOP_CHECKOUT_URL is set, this command will return your full link.`,
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

// --------------------
// ADMIN TEST ENDPOINT
// --------------------
app.post('/admin/test/credit', (req, res) => {
  const expected = (process.env.ADMIN_TEST_KEY || '').replace(/^"+|"+$/g, '');
  const got = (req.query.key || '').replace(/^"+|"+$/g, '');

  if (!expected || got !== expected) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const { code, count = 1 } = req.body;
  if (!code) {
    return res.status(400).json({ error: 'Missing referral code' });
  }

  const discordId = code.split('-')[0];
  if (!discordId) {
    return res.status(400).json({ error: 'Invalid referral code' });
  }

  let user;
  for (let i = 0; i < count; i++) {
    user = addReferral(discordId);
  }

  // Reward logic (3 referrals)
  if (user.referrals >= 3 && !user.rewarded) {
    markRewarded(discordId);
    console.log(`🎉 Reward triggered for ${discordId}`);
    // role + announcement will go here later
  }

  console.log(`🧪 Admin credited ${count} referral(s) to ${discordId}`);

  return res.json({
    ok: true,
    discordId,
    referrals: user.referrals,
  });
});

// --------------------
// Webhook placeholder
// --------------------
app.post('/webhooks/whop', (req, res) => {
  console.log('📩 Whop event received:', req.body);
  res.sendStatus(200);
});

// --------------------
// Start server
// --------------------
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`🚀 Server listening on port ${PORT}`);
});

// --------------------
// Discord login
// --------------------
if (!process.env.DISCORD_TOKEN) {
  console.error('❌ Missing DISCORD_TOKEN');
  process.exit(1);
}

client.login(process.env.DISCORD_TOKEN).catch(err => {
  console.error('❌ Discord login failed:', err);
  process.exit(1);
});
