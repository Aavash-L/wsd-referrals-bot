require('dotenv').config();
const express = require('express');
const { Client, GatewayIntentBits } = require('discord.js');
const { getUser } = require('./db');

const app = express();
app.use(express.json());

// Safety logs
process.on('unhandledRejection', (err) => console.error('unhandledRejection:', err));
process.on('uncaughtException', (err) => console.error('uncaughtException:', err));

// Discord bot
const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.once('ready', () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
});

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

// Health route
app.get('/', (req, res) => res.status(200).send('WSD Referrals Bot is running.'));

// Webhook endpoint (Whop will call this)
app.post('/webhooks/whop', (req, res) => {
  console.log('📩 Whop webhook received');
  console.log(JSON.stringify(req.body, null, 2));
  res.sendStatus(200);
});

// Test endpoint (YOU can hit this now)
app.post('/webhooks/whop/test', (req, res) => {
  console.log('🧪 Test webhook hit');
  console.log(JSON.stringify(req.body, null, 2));
  res.json({ ok: true, received: req.body });
});

// Start server
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`🚀 Server listening on port ${PORT}`));

// Login Discord
if (!process.env.DISCORD_TOKEN) {
  console.error('❌ Missing DISCORD_TOKEN');
  process.exit(1);
}
client.login(process.env.DISCORD_TOKEN);
