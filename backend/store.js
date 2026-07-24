'use strict';

const fs = require('fs');
const path = require('path');

// DB_FILE env lets a hosted deploy point at a mounted persistent disk
// (e.g. Render Disk -> DB_FILE=/var/data/db.json). Defaults to the repo path.
const DB_FILE = process.env.DB_FILE || path.join(__dirname, 'data', 'db.json');
const DATA_DIR = path.dirname(DB_FILE);

const DEFAULT_DB = {
  users: {},   // id -> user
  matches: [], // recent match records (capped)
  season: { number: 1, startedAt: Date.now() },
  seasonHistory: [], // past season snapshots (capped)
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
    if (!db.season) db.season = { number: 1, startedAt: Date.now() };
    if (!db.seasonHistory) db.seasonHistory = [];
    // per-user migration guard: accounts created before a field existed
    // (complaints/transferRequests/devotion/mailbox all postdate the
    // original schema) would otherwise be missing it entirely — and an
    // unguarded consumer like the cron sweep in devotion.js reading
    // `.length` off `undefined` takes the whole process down, repeatedly,
    // every tick, until the record is fixed. Patch every loaded user once
    // here instead of relying on every call site to defend for itself.
    Object.values(db.users).forEach((u) => {
      if (!Array.isArray(u.complaints)) u.complaints = [];
      if (!Array.isArray(u.transferRequests)) u.transferRequests = [];
      if (!u.devotion || typeof u.devotion !== 'object') u.devotion = {};
      if (!Array.isArray(u.mailbox)) u.mailbox = [];
      if (typeof u.lastComplaintCheck !== 'number') u.lastComplaintCheck = 0;
      if (typeof u.lastTransferCheck !== 'number') u.lastTransferCheck = 0;
    });
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
  if (u.squad.captain === undefined) u.squad.captain = null;
  if (u.squad.viceCaptain === undefined) u.squad.viceCaptain = null;
  if (!u.squad.roles || typeof u.squad.roles !== 'object') u.squad.roles = {}; // id -> role
  if (!u.pvpSquad) {
    u.pvpSquad = {
      formation: u.squad.formation,
      starters: new Array(11).fill(null),
      tactic: 'balanced',
      captain: null,
      viceCaptain: null,
      roles: {},
    };
  }
  if (u.pvpSquad.captain === undefined) u.pvpSquad.captain = null;
  if (u.pvpSquad.viceCaptain === undefined) u.pvpSquad.viceCaptain = null;
  if (!u.pvpSquad.roles || typeof u.pvpSquad.roles !== 'object') u.pvpSquad.roles = {};

  if (!u.playerStats || typeof u.playerStats !== 'object') u.playerStats = {}; // id -> {goals, assists}
  if (!u.devotion || typeof u.devotion !== 'object') u.devotion = {}; // id -> 0..100 (헌신도)
  if (!Array.isArray(u.complaints)) u.complaints = u.complaint ? [u.complaint] : []; // 여러 건 누적되는 pending 선수 불만
  delete u.complaint;
  if (!u.lastComplaintCheck) u.lastComplaintCheck = 0;
  if (!Array.isArray(u.transferRequests)) u.transferRequests = [];
  if (!u.lastTransferCheck) u.lastTransferCheck = 0;
  if (!Array.isArray(u.mailbox)) u.mailbox = []; // 관리자 보상 우편함
  return u;
}

// Increment a per-player cumulative stat (goals/assists/appearances) on a
// user, creating the entry if this is the player's first recorded stat.
function bumpPlayerStat(user, playerId, field) {
  if (!playerId) return;
  if (!user.playerStats[playerId]) user.playerStats[playerId] = { goals: 0, assists: 0, appearances: 0 };
  if (typeof user.playerStats[playerId][field] !== 'number') user.playerStats[playerId][field] = 0;
  user.playerStats[playerId][field]++;
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

function getMatchById(id) {
  return load().matches.find((m) => m.id === id) || null;
}

// Unfiltered, for the news feed — every match across every user.
function recentMatches(limit = 30) {
  return load().matches.slice(0, limit);
}

// ---- season --------------------------------------------------------------

function getSeason() {
  return load().season;
}

function saveSeason(season) {
  load().season = season;
  save();
  return season;
}

function getSeasonHistory() {
  return load().seasonHistory;
}

function pushSeasonHistory(entry) {
  const d = load();
  d.seasonHistory.unshift(entry);
  if (d.seasonHistory.length > 20) d.seasonHistory.length = 20;
  save();
  return entry;
}

function allUsers() {
  return Object.values(load().users);
}

module.exports = {
  DB_FILE,
  get,
  getUser,
  findUserByName,
  putUser,
  addMatch,
  matchesForUser,
  getMatchById,
  recentMatches,
  bumpPlayerStat,
  getSeason,
  saveSeason,
  getSeasonHistory,
  pushSeasonHistory,
  allUsers,
  save,
  flushNow,
};
