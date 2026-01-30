require('dotenv').config();
const express = require('express');
const { Client, GatewayIntentBits } = require('discord.js');
const { getUser } = require('./db');

const app = express();
app.use(express.json());

// Helpful crash logs in Railway
process.on('unhandledRejection', (err) => console.error('unhandledRejection:', err));
process.on('uncaughtException', (err) => console.error('uncaughtException:', err));

// Discord bot
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
    return interaction.reply({
      content: 'DM mods to get your personalized referral link.',
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

// Webhook placeholder (Whop will hit this later)
app.post('/webhooks/whop', (req, res) => {
  console.log('📩 Whop event received:', req.body);
  res.sendStatus(200);
});

// Start everything
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Webhook listening on port ${PORT}`);
});

// Validate env + login
if (!process.env.DISCORD_TOKEN) {
  console.error('❌ Missing DISCORD_TOKEN env var');
  process.exit(1);
}

client.login(process.env.DISCORD_TOKEN).catch((err) => {
  console.error('❌ Discord login failed:', err);
  process.exit(1);
});
