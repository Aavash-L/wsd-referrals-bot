const Database = require('better-sqlite3');
const db = new Database('data.db');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    discord_user_id TEXT PRIMARY KEY,
    referrals INTEGER DEFAULT 0,
    rewarded INTEGER DEFAULT 0
  );

  -- Maps a referral code to a Discord user
  CREATE TABLE IF NOT EXISTS ref_codes (
    code TEXT PRIMARY KEY,
    discord_user_id TEXT NOT NULL
  );

  -- Dedupe table so the same Whop event/order doesn't count twice
  CREATE TABLE IF NOT EXISTS ref_purchases (
    purchase_id TEXT PRIMARY KEY,
    code TEXT,
    created_at INTEGER DEFAULT (strftime('%s','now'))
  );
`);

function ensureUser(discordId) {
  db.prepare('INSERT OR IGNORE INTO users (discord_user_id) VALUES (?)').run(discordId);
}

function getUser(discordId) {
  ensureUser(discordId);
  return db.prepare('SELECT * FROM users WHERE discord_user_id = ?').get(discordId);
}

function addReferral(discordId) {
  ensureUser(discordId);
  db.prepare('UPDATE users SET referrals = referrals + 1 WHERE discord_user_id = ?').run(discordId);
  return getUser(discordId);
}

function markRewarded(discordId) {
  db.prepare('UPDATE users SET rewarded = 1 WHERE discord_user_id = ?').run(discordId);
}

function getOrCreateRefCode(discordId) {
  ensureUser(discordId);

  const existing = db
    .prepare('SELECT code FROM ref_codes WHERE discord_user_id = ?')
    .get(discordId);

  if (existing?.code) return existing.code;

  // Simple code: <discordId>-<6 random chars>
  const rand = Math.random().toString(36).slice(2, 8);
  const code = `${discordId}-${rand}`.slice(0, 40);

  db.prepare('INSERT INTO ref_codes (code, discord_user_id) VALUES (?, ?)').run(code, discordId);
  return code;
}

function lookupDiscordIdByCode(code) {
  const row = db.prepare('SELECT discord_user_id FROM ref_codes WHERE code = ?').get(code);
  return row?.discord_user_id || null;
}

function purchaseAlreadyCounted(purchaseId) {
  const row = db.prepare('SELECT purchase_id FROM ref_purchases WHERE purchase_id = ?').get(purchaseId);
  return !!row;
}

function markPurchaseCounted(purchaseId, code) {
  db.prepare('INSERT OR IGNORE INTO ref_purchases (purchase_id, code) VALUES (?, ?)').run(purchaseId, code || null);
}

module.exports = {
  getUser,
  addReferral,
  markRewarded,
  getOrCreateRefCode,
  lookupDiscordIdByCode,
  purchaseAlreadyCounted,
  markPurchaseCounted,
};
