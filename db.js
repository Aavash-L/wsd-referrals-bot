// db.js (Postgres-backed, persistent)
// Keeps same public API you already use:
// getUser, addReferral, markRewarded, getOrCreateRefCode, lookupDiscordIdByRefCode,
// isEventCounted, markEventCounted, manualAddReferral, setReferrals

const { Pool } = require("pg");

const DATABASE_URL = process.env.DATABASE_URL;

if (!DATABASE_URL) {
  console.error("❌ Missing DATABASE_URL. Add it from Railway Postgres -> service variable reference.");
  // fail fast so you don't think it's "working" while still using ephemeral sqlite
  process.exit(1);
}

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: process.env.PGSSLMODE === "disable" ? false : { rejectUnauthorized: false },
});

let _initialized = false;

async function init() {
  if (_initialized) return;
  _initialized = true;

  // Tables (same logical schema as your sqlite)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      discord_user_id TEXT PRIMARY KEY,
      referrals INTEGER DEFAULT 0,
      rewarded INTEGER DEFAULT 0
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS ref_codes (
      code TEXT PRIMARY KEY,
      discord_user_id TEXT NOT NULL REFERENCES users(discord_user_id) ON DELETE CASCADE,
      created_at BIGINT DEFAULT (EXTRACT(EPOCH FROM NOW())::BIGINT)
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS counted_events (
      event_id TEXT PRIMARY KEY,
      created_at BIGINT DEFAULT (EXTRACT(EPOCH FROM NOW())::BIGINT)
    );
  `);

  // Helpful indexes
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_ref_codes_user ON ref_codes(discord_user_id);`);
}

async function ensureUser(discordId) {
  await init();
  await pool.query(
    `INSERT INTO users (discord_user_id) VALUES ($1)
     ON CONFLICT (discord_user_id) DO NOTHING`,
    [discordId]
  );
}

async function getUser(discordId) {
  await ensureUser(discordId);
  const { rows } = await pool.query(`SELECT * FROM users WHERE discord_user_id = $1`, [discordId]);
  return rows[0] || null;
}

async function markRewarded(discordId) {
  await ensureUser(discordId);
  await pool.query(`UPDATE users SET rewarded = 1 WHERE discord_user_id = $1`, [discordId]);
}

async function addReferral(discordId) {
  await ensureUser(discordId);
  await pool.query(`UPDATE users SET referrals = referrals + 1 WHERE discord_user_id = $1`, [discordId]);
  return await getUser(discordId);
}

async function manualAddReferral(discordId, count = 1) {
  await ensureUser(discordId);
  await pool.query(
    `UPDATE users SET referrals = referrals + $1 WHERE discord_user_id = $2`,
    [count, discordId]
  );
  return await getUser(discordId);
}

// NEW: Set exact referrals and rewarded values (for admin endpoint)
async function setReferrals(discordId, referrals = 0, rewarded = 0) {
  await ensureUser(discordId);
  await pool.query(
    `UPDATE users SET referrals = $1, rewarded = $2 WHERE discord_user_id = $3`,
    [referrals, rewarded, discordId]
  );
  return await getUser(discordId);
}

// stable referral code per user (same idea as your sqlite version)
async function getOrCreateRefCode(discordId) {
  await ensureUser(discordId);

  const existing = await pool.query(
    `SELECT code FROM ref_codes
     WHERE discord_user_id = $1
     ORDER BY created_at DESC
     LIMIT 1`,
    [discordId]
  );

  if (existing.rows?.[0]?.code) return existing.rows[0].code;

  const rand = Math.random().toString(36).slice(2, 8);
  const code = `${discordId}-${rand}`.slice(0, 48);

  await pool.query(
    `INSERT INTO ref_codes (code, discord_user_id) VALUES ($1, $2)`,
    [code, discordId]
  );

  return code;
}

async function lookupDiscordIdByRefCode(code) {
  await init();
  const { rows } = await pool.query(`SELECT discord_user_id FROM ref_codes WHERE code = $1`, [code]);
  return rows?.[0]?.discord_user_id || null;
}

// Deduping (never count same invoice twice)
async function isEventCounted(eventId) {
  await init();
  if (!eventId) return false;
  const { rows } = await pool.query(`SELECT event_id FROM counted_events WHERE event_id = $1`, [eventId]);
  return !!rows?.[0];
}

async function markEventCounted(eventId) {
  await init();
  if (!eventId) return;
  await pool.query(
    `INSERT INTO counted_events (event_id) VALUES ($1)
     ON CONFLICT (event_id) DO NOTHING`,
    [eventId]
  );
}

module.exports = {
  getUser,
  addReferral,
  markRewarded,
  getOrCreateRefCode,
  lookupDiscordIdByRefCode,
  isEventCounted,
  markEventCounted,
  manualAddReferral,
  setReferrals,
};