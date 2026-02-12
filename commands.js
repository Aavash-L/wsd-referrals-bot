require("dotenv").config();
const { REST, Routes, SlashCommandBuilder } = require("discord.js");

const CLIENT_ID = process.env.CLIENT_ID;
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;

if (!CLIENT_ID || !DISCORD_TOKEN) {
  console.error("❌ Missing CLIENT_ID or DISCORD_TOKEN in .env");
  process.exit(1);
}

const commands = [
  new SlashCommandBuilder().setName("ref").setDescription("Get your referral link / code"),
  new SlashCommandBuilder().setName("refstats").setDescription("View your referral progress"),
].map((cmd) => cmd.toJSON());

const rest = new REST({ version: "10" }).setToken(DISCORD_TOKEN);

(async () => {
  try {
    console.log("⏳ Registering slash commands...");
    await rest.put(Routes.applicationCommands(CLIENT_ID), { body: commands });
    console.log("✅ Slash commands registered");
  } catch (err) {
    console.error("❌ Failed to register commands:", err);
    process.exit(1);
  }
})();
