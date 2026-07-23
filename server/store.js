'use strict';

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');

const DEFAULT_DB = {
  users: {},   // id -> user
  matches: [], // recent match records (capped)
};

let db = null;
let writeTimer = null;

function load() {
  if (db) return db;
  try {
    const raw = fs.readFileSync(DB_FILE, 'utf8');
    db = JSON.parse(raw);
    // shallow migration guard
    if (!db.users) db.users = {};
    if (!db.matches) db.matches = [];
  } catch (err) {
    db = JSON.parse(JSON.stringify(DEFAULT_DB));
    flushNow();
  }
  return db;
}

function flushNow() {
  if (!db) return;
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = DB_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
    fs.renameSync(tmp, DB_FILE); // atomic-ish replace
  } catch (err) {
    console.error('[store] failed to persist db:', err.message);
  }
}

// Debounced save so hot paths (matches) don't hammer the disk.
function save() {
  if (writeTimer) return;
  writeTimer = setTimeout(() => {
    writeTimer = null;
    flushNow();
  }, 400);
}

function get() {
  return load();
}

// ---- users -------------------------------------------------------------

// Backfill fields added after a user was created.
function normalizeUser(u) {
  if (!u) return u;
  if (!Array.isArray(u.drawn)) u.drawn = [];
  if (!u.upgrades || typeof u.upgrades !== 'object') u.upgrades = {}; // 강화 단계

  if (!u.squad.tactic) u.squad.tactic = 'balanced';
  if (!u.pvpSquad) {
    u.pvpSquad = {
      formation: u.squad.formation,
      starters: new Array(11).fill(null),
      tactic: 'balanced',
    };
  }
  return u;
}

function getUser(id) {
  return normalizeUser(load().users[id] || null);
}

function findUserByName(username) {
  const users = load().users;
  const lower = String(username).toLowerCase();
  return normalizeUser(
    Object.values(users).find((u) => u.username.toLowerCase() === lower) || null
  );
}

function putUser(user) {
  load().users[user.id] = user;
  save();
  return user;
}

// ---- matches -----------------------------------------------------------

function addMatch(record) {
  const d = load();
  d.matches.unshift(record);
  if (d.matches.length > 500) d.matches.length = 500;
  save();
  return record;
}

function matchesForUser(userId, limit = 20) {
  return load()
    .matches.filter((m) => m.homeUserId === userId || m.awayUserId === userId)
    .slice(0, limit);
}

module.exports = {
  DB_FILE,
  get,
  getUser,
  findUserByName,
  putUser,
  addMatch,
  matchesForUser,
  save,
  flushNow,
};
