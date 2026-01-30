require('dotenv').config();
const express = require('express');
const { Client, GatewayIntentBits } = require('discord.js');
const { getUser } = require('./db');

const app = express();

// Helpful crash logs in Railway
process.on('unhandledRejection', (err) => console.error('unhandledRejection:', err));
process.on('uncaughtException', (err) => console.error('uncaughtException:', err));

// Normal JSON parsing for regular routes (NOT for Whop)
app.use(express.json());

// Mount Whop webhook router (uses express.raw inside webhook.js)
const whopWebhook = require('./webhook');
app.use('/webhooks', whopWebhook);

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

// Health check (so you can open the URL in a browser and see it's alive)
app.get('/', (req, res) => {
  res.status(200).send('✅ WSD Referrals Bot is running');
});

// Start web server (Railway provides PORT)
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Server listening on port ${PORT}`);
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
