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
  guilds: {},  // id -> guild (backend/guild.js)
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
    if (!db.guilds || typeof db.guilds !== 'object') db.guilds = {};
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
      if (!Array.isArray(u.friends)) u.friends = [];
      if (!u.friendRequests || typeof u.friendRequests !== 'object') {
        u.friendRequests = { incoming: [], outgoing: [] };
      }
      if (u.guildId === undefined) u.guildId = null;
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
  if (!Array.isArray(u.ultra)) u.ultra = []; // Ultra 등급 진화 완료한 playerId 목록

  // 감독 스타일(가입 시 지정한 선호 포메이션/전술) — 이 필드가 생기기 전에
  // 만든 계정은 당시 스쿼드 설정을 그대로 선호도로 간주해 역채움한다.
  if (!u.preferredFormation) u.preferredFormation = u.squad.formation;
  if (!u.preferredTactic) u.preferredTactic = u.squad.tactic || 'balanced';

  if (!u.squad.tactic) u.squad.tactic = 'balanced';
  if (u.squad.captain === undefined) u.squad.captain = null;
  if (u.squad.viceCaptain === undefined) u.squad.viceCaptain = null;
  if (!u.squad.roles || typeof u.squad.roles !== 'object') u.squad.roles = {}; // id -> role
  if (u.squad.slotCoords === undefined) u.squad.slotCoords = null; // 사용자가 드래그로 조정한 커스텀 포지션(선택)
  if (!u.pvpSquad) {
    u.pvpSquad = {
      formation: u.squad.formation,
      starters: new Array(11).fill(null),
      tactic: 'balanced',
      captain: null,
      viceCaptain: null,
      roles: {},
      slotCoords: null,
    };
  }
  if (u.pvpSquad.captain === undefined) u.pvpSquad.captain = null;
  if (u.pvpSquad.viceCaptain === undefined) u.pvpSquad.viceCaptain = null;
  if (!u.pvpSquad.roles || typeof u.pvpSquad.roles !== 'object') u.pvpSquad.roles = {};
  if (u.pvpSquad.slotCoords === undefined) u.pvpSquad.slotCoords = null;

  if (!u.playerStats || typeof u.playerStats !== 'object') u.playerStats = {}; // id -> {goals, assists}
  if (!u.devotion || typeof u.devotion !== 'object') u.devotion = {}; // id -> 0..100 (헌신도)
  if (!Array.isArray(u.complaints)) u.complaints = u.complaint ? [u.complaint] : []; // 여러 건 누적되는 pending 선수 불만
  delete u.complaint;
  if (!u.lastComplaintCheck) u.lastComplaintCheck = 0;
  if (!Array.isArray(u.transferRequests)) u.transferRequests = [];
  if (!u.lastTransferCheck) u.lastTransferCheck = 0;
  if (!Array.isArray(u.mailbox)) u.mailbox = []; // 관리자 보상 우편함

  if (!Array.isArray(u.friends)) u.friends = []; // 수락된 친구 userId 목록
  if (!u.friendRequests || typeof u.friendRequests !== 'object') {
    u.friendRequests = { incoming: [], outgoing: [] };
  }
  if (!Array.isArray(u.friendRequests.incoming)) u.friendRequests.incoming = [];
  if (!Array.isArray(u.friendRequests.outgoing)) u.friendRequests.outgoing = [];
  if (u.guildId === undefined) u.guildId = null;

  // 컵대회(단판 토너먼트) 진행 상태 — backend/matchmaking.js의 startCup/finishCupMatch 참고.
  if (!u.cup || typeof u.cup !== 'object') {
    u.cup = { active: false, round: 0, wins: 0, opponents: [], status: 'idle', lastRunDate: null, lastMatchId: null };
  }
  if (!Array.isArray(u.cup.opponents)) u.cup.opponents = [];

  // SBC(스쿼드 챌린지) 완료 기록 — key는 `${dateKey}:${templateId}`라 날짜가 지나면
  // 자연히 새 챌린지가 되므로, 오래된 키만 주기적으로 정리해 무한 증식을 막는다
  // (backend/game/sbc.js 참고).
  if (!u.sbc || typeof u.sbc !== 'object') u.sbc = { completed: {} };
  if (!u.sbc.completed || typeof u.sbc.completed !== 'object') u.sbc.completed = {};
  const completedKeys = Object.keys(u.sbc.completed);
  if (completedKeys.length > 60) {
    completedKeys
      .sort((a, b) => (u.sbc.completed[a] || 0) - (u.sbc.completed[b] || 0))
      .slice(0, completedKeys.length - 60)
      .forEach((k) => delete u.sbc.completed[k]);
  }

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

// 관리자 전용 계정 삭제(테스트 계정 정리 등) — 존재하지 않으면 false.
function deleteUser(username) {
  const d = load();
  const lower = String(username).toLowerCase();
  const entry = Object.entries(d.users).find(([, u]) => u.username.toLowerCase() === lower);
  if (!entry) return false;
  delete d.users[entry[0]];
  save();
  return true;
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

// ---- guilds ----------------------------------------------------------------

function getGuild(id) {
  return (id && load().guilds[id]) || null;
}

function putGuild(guild) {
  load().guilds[guild.id] = guild;
  save();
  return guild;
}

function deleteGuild(id) {
  const d = load();
  if (!d.guilds[id]) return false;
  delete d.guilds[id];
  save();
  return true;
}

function allGuilds() {
  return Object.values(load().guilds);
}

module.exports = {
  DB_FILE,
  get,
  getUser,
  findUserByName,
  putUser,
  deleteUser,
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
  getGuild,
  putGuild,
  deleteGuild,
  allGuilds,
  save,
  flushNow,
};
