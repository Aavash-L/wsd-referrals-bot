const Database = require('better-sqlite3');
const db = new Database('data.db');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    discord_user_id TEXT PRIMARY KEY,
    referrals INTEGER DEFAULT 0,
    rewarded INTEGER DEFAULT 0
  );
`);

function ensureUser(discordId) {
  db.prepare(
    'INSERT OR IGNORE INTO users (discord_user_id) VALUES (?)'
  ).run(discordId);
}

function getUser(discordId) {
  ensureUser(discordId);
  return db.prepare(
    'SELECT * FROM users WHERE discord_user_id = ?'
  ).get(discordId);
}

function addReferral(discordId) {
  ensureUser(discordId);
  db.prepare(
    'UPDATE users SET referrals = referrals + 1 WHERE discord_user_id = ?'
  ).run(discordId);
  return getUser(discordId);
}

function markRewarded(discordId) {
  db.prepare(
    'UPDATE users SET rewarded = 1 WHERE discord_user_id = ?'
  ).run(discordId);
}

module.exports = {
  getUser,
  addReferral,
  markRewarded,
};
