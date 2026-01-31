const Database = require("better-sqlite3");
const db = new Database("data.db");

// ---------- Tables ----------
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    discord_user_id TEXT PRIMARY KEY,
    referrals INTEGER DEFAULT 0,
    rewarded INTEGER DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS ref_codes (
    code TEXT PRIMARY KEY,
    discord_user_id TEXT NOT NULL,
    created_at INTEGER DEFAULT (strftime('%s','now'))
  );

  CREATE TABLE IF NOT EXISTS counted_events (
    event_id TEXT PRIMARY KEY,
    created_at INTEGER DEFAULT (strftime('%s','now'))
  );
`);

// ---------- Helpers ----------
function ensureUser(discordId) {
  db.prepare(`INSERT OR IGNORE INTO users (discord_user_id) VALUES (?)`).run(discordId);
}

function getUser(discordId) {
  ensureUser(discordId);
  return db.prepare(`SELECT * FROM users WHERE discord_user_id = ?`).get(discordId);
}

function markRewarded(discordId) {
  ensureUser(discordId);
  db.prepare(`UPDATE users SET rewarded = 1 WHERE discord_user_id = ?`).run(discordId);
}

function addReferral(discordId) {
  ensureUser(discordId);
  db.prepare(`UPDATE users SET referrals = referrals + 1 WHERE discord_user_id = ?`).run(discordId);
  return getUser(discordId);
}

// Create or return a stable referral code for a user
function getOrCreateRefCode(discordId) {
  ensureUser(discordId);

  const existing = db
    .prepare(`SELECT code FROM ref_codes WHERE discord_user_id = ? ORDER BY created_at DESC LIMIT 1`)
    .get(discordId);

  if (existing?.code) return existing.code;

  const rand = Math.random().toString(36).slice(2, 8);
  const code = `${discordId}-${rand}`.slice(0, 48);

  db.prepare(`INSERT INTO ref_codes (code, discord_user_id) VALUES (?, ?)`).run(code, discordId);
  return code;
}

function lookupDiscordIdByRefCode(code) {
  const row = db.prepare(`SELECT discord_user_id FROM ref_codes WHERE code = ?`).get(code);
  return row?.discord_user_id || null;
}

// Deduping so same invoice/event never counts twice
function isEventCounted(eventId) {
  if (!eventId) return false;
  const row = db.prepare(`SELECT event_id FROM counted_events WHERE event_id = ?`).get(eventId);
  return !!row;
}

function markEventCounted(eventId) {
  if (!eventId) return;
  db.prepare(`INSERT OR IGNORE INTO counted_events (event_id) VALUES (?)`).run(eventId);
}

module.exports = {
  getUser,
  addReferral,
  markRewarded,
  getOrCreateRefCode,
  lookupDiscordIdByRefCode,
  isEventCounted,
  markEventCounted,
};
