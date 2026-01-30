require('dotenv').config();
const express = require('express');
const { Client, GatewayIntentBits } = require('discord.js');
const { getUser } = require('./db');

const app = express();
app.use(express.json());

// Discord bot
const client = new Client({
  intents: [GatewayIntentBits.Guilds],
});

client.once('clientReady', () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
});

// Slash commands
client.on('interactionCreate', async interaction => {
  if (!interaction.isChatInputCommand()) return;

  if (interaction.commandName === 'ref') {
    await interaction.reply({
      content: 'DM mods to get your personalized referral link.',
      ephemeral: true,
    });
  }

  if (interaction.commandName === 'refstats') {
    const user = getUser(interaction.user.id);

    await interaction.reply({
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

client.login(process.env.DISCORD_TOKEN);
