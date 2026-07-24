'use strict';

const express = require('express');
const http = require('http');
const crypto = require('crypto');

const store = require('./store');
const auth = require('./auth');
const players = require('./data/players');
const { FORMATIONS, DEFAULT_FORMATION, LINE, posPenalty } = require('./game/formations');
const { computeRatings, TACTICS, ROLE_DEFS } = require('./game/simulate');
const matchmaking = require('./matchmaking');
const transfer = require('./transfer');
const predictions = require('./predictions');
const dynteams = require('./data/dynteams');
const season = require('./season');
const devotion = require('./devotion');
const mailbox = require('./mailbox');
const account = require('./account');

// rebuild dynamically fetched clubs so persisted player ids keep resolving,
// then fill in team badges + re-fetch pre-v2 rosters in the background
// (one-time, rate-limit friendly)
dynteams.restore();
dynteams.warmBadges();
dynteams
  .refreshRosters()
  .then(() => dynteams.warmAllRosters()) // Saudi PL clubs + curated national teams, so their players are in the market even if no user has picked them as a starting club
  .then(() => dynteams.warmDynImages()) // then hunt down missing player images
  .catch((err) => console.error('[dynteams] refresh pass failed:', err));

season.init();
devotion.init();
predictions.init();

const PORT = process.env.PORT || 3000;
const STARTING_COINS = 1500;
const SELL_RATE = 0.55;
const CLUB_CHANGE_COST = 50; // 승점

const LEAGUES = [
  { id: 'EPL', label: 'EPL' },
  { id: 'LaLiga', label: '라리가' },
  { id: 'Bundesliga', label: '분데스리가' },
  { id: 'SerieA', label: '세리에 A' },
  { id: 'Ligue1', label: '리그 1' },
  { id: 'MLS', label: 'MLS' },
  { id: 'Saudi', label: '사우디 리그' },
  { id: 'BrasilA', label: '브라질레이랑' },
  { id: 'KLeague', label: 'K리그 1' },
  { id: 'national', label: '국가대표' },
];

// Resolve a start/change team request: curated club name, or any league team
// whose real roster is fetched and registered on first use.
async function resolveTeam(team) {
  if (!team) return null;
  if (players.TEAMS[team]) return team;
  return dynteams.ensureRoster(String(team));
}

const app = express();
// default 100kb is too small for a base64-encoded avatar upload; 5mb
// comfortably covers the 3MB (pre-base64) cap account.js enforces
app.use(express.json({ limit: '5mb' }));

// Frontend is served separately (its own folder/process), so allow
// cross-origin requests. Restrict via CORS_ORIGIN in production
// (e.g. CORS_ORIGIN=http://your-ec2-host:8080).
const CORS_ORIGIN = process.env.CORS_ORIGIN || '*';
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', CORS_ORIGIN);
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// ---- helpers ---------------------------------------------------------------

function ratingSummary(squad) {
  const r = computeRatings(squad);
  return {
    formation: r.formation,
    ATT: r.ATT,
    MID: r.MID,
    DEF: r.DEF,
    GK: r.GK,
    OVR: r.OVR,
    chemistry: r.chemistry,
  };
}

// Squad + the user's 강화 levels/헌신도, so ratings reflect enhanced cards
// and player mood (captain/vice-captain/roles already live on the squad object).
function withUpgrades(u, squad) {
  return { ...squad, upgrades: u.upgrades || {}, devotion: u.devotion || {} };
}

function sanitizeUser(u) {
  return {
    id: u.id,
    username: u.username,
    avatarUrl: u.avatarUrl || null,
    clubName: u.clubName,
    baseTeam: u.baseTeam,
    coins: u.coins,
    points: u.points,
    record: u.record,
    owned: u.owned,
    drawn: u.drawn,
    upgrades: u.upgrades || {},
    playerStats: u.playerStats || {},
    devotion: u.devotion || {},
    complaints: devotion.publicComplaints(u),
    transferRequests: u.transferRequests || [],
    mailbox: u.mailbox || [],
    preferredFormation: u.preferredFormation,
    preferredTactic: u.preferredTactic,
    squad: u.squad,
    pvpSquad: u.pvpSquad,
    ratings: ratingSummary(withUpgrades(u, u.squad)),
    pvpRatings: ratingSummary(withUpgrades(u, u.pvpSquad)),
  };
}

function bad(res, status, message) {
  return res.status(status).json({ error: message });
}

// Best-XI with position fit first: every exact-position assignment is made
// before any converted one (같은 라인 -> 인접 라인 순), OVR breaks ties. Used
// for the auto-place endpoint and for fresh squads on register/club change.
function bestStarters(poolIds, formation) {
  const slots = FORMATIONS[formation];
  const pool = poolIds.map((id) => players.getPlayer(id)).filter(Boolean);
  const pairs = [];
  slots.forEach((slotPos, i) => {
    const slotLine = LINE[slotPos];
    pool.forEach((p) => {
      // GK is a hard constraint both ways.
      if (slotLine === 'GK' ? p.line !== 'GK' : p.line === 'GK') return;
      pairs.push({ i, p, pen: posPenalty(p.pos, slotPos) });
    });
  });
  pairs.sort((a, b) => a.pen - b.pen || b.p.ovr - a.p.ovr);
  const starters = new Array(slots.length).fill(null);
  const used = new Set();
  for (const { i, p } of pairs) {
    if (starters[i] || used.has(p.id)) continue;
    starters[i] = p.id;
    used.add(p.id);
  }
  return starters;
}

// ---- auth ------------------------------------------------------------------

app.post('/api/register', async (req, res) => {
  const { username, password, clubName, team, preferredFormation, preferredTactic } = req.body || {};
  if (typeof username !== 'string' || username.trim().length < 2 || username.trim().length > 16) {
    return bad(res, 400, '아이디는 2~16자로 입력해 주세요.');
  }
  if (typeof password !== 'string' || password.length < 4) {
    return bad(res, 400, '비밀번호는 4자 이상이어야 합니다.');
  }
  // 감독 스타일: 선호 포메이션/전술 — 미지정 시 기본값, 잘못된 값이면 거부.
  const formation = preferredFormation !== undefined ? preferredFormation : DEFAULT_FORMATION;
  if (!FORMATIONS[formation]) return bad(res, 400, '알 수 없는 선호 포메이션입니다.');
  const tactic = preferredTactic !== undefined ? preferredTactic : 'balanced';
  if (!TACTICS[tactic]) return bad(res, 400, '알 수 없는 선호 전술입니다.');
  let teamName;
  try {
    teamName = await resolveTeam(team);
  } catch (err) {
    console.error('[register] roster fetch failed:', err.message);
    return bad(res, 502, '팀 선수단을 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.');
  }
  if (!teamName || !players.TEAMS[teamName]) {
    return bad(res, 400, '시작 팀을 선택해 주세요.');
  }
  const name = username.trim();
  if (store.findUserByName(name)) {
    return bad(res, 409, '이미 사용 중인 아이디입니다.');
  }

  const roster = players.TEAMS[teamName].playerIds;
  const user = {
    id: 'u' + crypto.randomBytes(8).toString('hex'),
    username: name,
    passwordHash: auth.hashPassword(password),
    avatarUrl: null,
    createdAt: new Date().toISOString(),
    clubName: (typeof clubName === 'string' && clubName.trim().slice(0, 20)) || `${name} FC`,
    baseTeam: teamName,
    coins: STARTING_COINS,
    points: Number(process.env.STARTING_POINTS) || 0, // env override for tests

    record: { w: 0, d: 0, l: 0 },
    owned: [...roster],
    drawn: [],
    upgrades: {},
    playerStats: {}, // id -> {goals, assists}
    devotion: {}, // id -> 0..100 (헌신도)
    complaints: [], // 여러 건 누적되는 pending 선수 불만
    transferRequests: [], // 헌신도가 바닥난 선수의 이적 요청
    lastComplaintCheck: 0,
    // 감독 스타일(가입 시 지정) — 이 포메이션/전술을 벗어나면 선수들이
    // 낯설어하며 불만을 표한다 (devotion.js의 'formation' 이슈 참고).
    preferredFormation: formation,
    preferredTactic: tactic,
    // start with the best XI already placed (fit-first, GK guaranteed)
    squad: {
      formation,
      starters: bestStarters(roster, formation),
      tactic,
      captain: null,
      viceCaptain: null,
      roles: {},
    },
    pvpSquad: {
      formation,
      starters: new Array(11).fill(null),
      tactic,
      captain: null,
      viceCaptain: null,
      roles: {},
    },
  };
  store.putUser(user);
  const token = auth.issueToken(user.id);
  res.json({ token, user: sanitizeUser(user) });
});

app.post('/api/login', (req, res) => {
  const { username, password } = req.body || {};
  const user = username && store.findUserByName(String(username).trim());
  if (!user || !auth.verifyPassword(String(password || ''), user.passwordHash)) {
    return bad(res, 401, '아이디 또는 비밀번호가 올바르지 않습니다.');
  }
  const token = auth.issueToken(user.id);
  res.json({ token, user: sanitizeUser(user) });
});

app.post('/api/logout', auth.authMiddleware, (req, res) => {
  auth.revoke(req.token);
  res.json({ ok: true });
});

// ---- 계정 설정 (비밀번호 변경 / 프로필 사진) --------------------------------------

app.put('/api/account/password', auth.authMiddleware, (req, res) => {
  const { currentPassword, newPassword } = req.body || {};
  const r = account.changePassword(req.user, currentPassword, newPassword);
  if (r.error) return bad(res, r.status, r.error);
  res.json({ ok: true });
});

app.put('/api/account/avatar', auth.authMiddleware, (req, res) => {
  const { imageDataUrl } = req.body || {};
  const r = account.setAvatar(req.user, imageDataUrl);
  if (r.error) return bad(res, r.status, r.error);
  res.json({ user: sanitizeUser(req.user) });
});

app.delete('/api/account/avatar', auth.authMiddleware, (req, res) => {
  account.clearAvatar(req.user);
  res.json({ user: sanitizeUser(req.user) });
});

// ---- public bootstrap data -------------------------------------------------

app.get('/api/bootstrap', (req, res) => {
  res.json({
    teams: players.teamList(),
    leagues: LEAGUES,
    clubChangeCost: CLUB_CHANGE_COST,
    formations: FORMATIONS,
    tactics: Object.fromEntries(
      Object.entries(TACTICS).map(([id, t]) => [id, t.name])
    ),
    market: players.marketList(),
    packs: transfer.packList(),
    enhance: players.ENHANCE,
    roles: Object.fromEntries(
      Object.entries(ROLE_DEFS).map(([id, r]) => [id, { label: r.label, pos: r.pos, isDefault: !!r.isDefault }])
    ),
  });
});

// Every selectable club of the tracked leagues (curated clubs are served
// from /api/bootstrap and excluded here).
app.get('/api/leagueteams', (req, res) => {
  res.json({ teams: dynteams.listSelectable() });
});

// ---- me / squad ------------------------------------------------------------

app.get('/api/me', auth.authMiddleware, (req, res) => {
  res.json({ user: sanitizeUser(req.user) });
});

// kind: 'main' (클럽 스쿼드) or 'pvp' (실전 스쿼드 — 뽑은 카드만 배치 가능).
// 선수 배치 좌표(%, 피치 기준 left/bottom)를 [0,100] 범위 안으로 눌러 담는다 —
// 잘못된 값이 카드가 피치 밖으로 나가거나 저장이 깨지는 걸 막는 최소한의 안전장치.
function clampSlotCoord(c) {
  if (!Array.isArray(c) || c.length !== 2) return null;
  const x = Number(c[0]);
  const y = Number(c[1]);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return [Math.max(3, Math.min(97, x)), Math.max(2, Math.min(92, y))];
}

app.put('/api/squad', auth.authMiddleware, (req, res) => {
  const { formation, starters, tactic, kind, captain, viceCaptain, roles, slotCoords } = req.body || {};
  const isPvp = kind === 'pvp';
  if (!FORMATIONS[formation]) return bad(res, 400, '알 수 없는 포메이션입니다.');
  if (!Array.isArray(starters) || starters.length !== 11) {
    return bad(res, 400, '선발 명단은 11개 슬롯이어야 합니다.');
  }
  if (tactic !== undefined && !TACTICS[tactic]) {
    return bad(res, 400, '알 수 없는 전술입니다.');
  }
  const owned = new Set(req.user.owned);
  const drawn = new Set(req.user.drawn);
  const slots = FORMATIONS[formation];
  const seen = new Set();
  // 태업(work-to-rule): devotion this low refuses to be selected outright —
  // keep in sync with STROP_DEVOTION_THRESHOLD in game/simulate.js, which
  // rolls the matching mid-match strop event for a starter already this low
  // at kickoff (defense-in-depth in case a live squad change slips one in).
  const STROP_DEVOTION_THRESHOLD = 20;
  for (let i = 0; i < starters.length; i++) {
    const id = starters[i];
    if (id === null) continue;
    const p = players.getPlayer(id);
    if (!p || !owned.has(id)) return bad(res, 400, '보유하지 않은 선수가 포함되어 있습니다.');
    if (isPvp && !drawn.has(id)) {
      return bad(res, 400, '실전 스쿼드에는 뽑기로 획득한 카드만 배치할 수 있습니다.');
    }
    if ((req.user.devotion[id] ?? 60) < STROP_DEVOTION_THRESHOLD) {
      return bad(res, 400, `${p.name} 선수가 태업 중이라 선발 명단에 포함할 수 없습니다. (헌신도 ${req.user.devotion[id]})`);
    }
    if (seen.has(id)) return bad(res, 400, '같은 선수를 두 슬롯에 배치할 수 없습니다.');
    const slotLine = LINE[slots[i]];
    if (slotLine === 'GK' && p.line !== 'GK') {
      return bad(res, 400, '골키퍼 슬롯에는 골키퍼만 배치할 수 있습니다.');
    }
    if (p.line === 'GK' && slotLine !== 'GK') {
      return bad(res, 400, '골키퍼는 골키퍼 슬롯에만 배치할 수 있습니다.');
    }
    seen.add(id);
  }
  const target = isPvp ? 'pvpSquad' : 'squad';
  const prev = req.user[target];
  const nextCaptain = captain !== undefined ? captain : prev.captain || null;
  const nextVice = viceCaptain !== undefined ? viceCaptain : prev.viceCaptain || null;
  if (nextCaptain && !starters.includes(nextCaptain)) {
    return bad(res, 400, '주장은 선발 명단에 포함된 선수여야 합니다.');
  }
  if (nextVice && !starters.includes(nextVice)) {
    return bad(res, 400, '부주장은 선발 명단에 포함된 선수여야 합니다.');
  }
  if (nextCaptain && nextVice && nextCaptain === nextVice) {
    return bad(res, 400, '주장과 부주장은 다른 선수여야 합니다.');
  }
  const nextRoles = {};
  const rolesSrc = roles !== undefined ? roles : prev.roles || {};
  for (const [pid, roleId] of Object.entries(rolesSrc || {})) {
    if (!starters.includes(pid)) continue; // stale entry for a benched player
    const role = ROLE_DEFS[roleId];
    if (!role) return bad(res, 400, '알 수 없는 선수 유형입니다.');
    const p = players.getPlayer(pid);
    if (!p || !role.pos.includes(p.pos)) {
      return bad(res, 400, `${p ? p.name : '선수'}에게는 적용할 수 없는 유형입니다.`);
    }
    nextRoles[pid] = roleId;
  }
  // 요청에 slotCoords가 명시되면 그 값을 그대로 반영(같은 요청에서 포메이션이
  // 함께 바뀌어도 사용자가 새 포메이션 기준으로 넘긴 좌표를 우선한다). 명시되지
  // 않았는데 포메이션만 바뀌면 슬롯 배치 자체(라인/역할)가 달라지므로 이전
  // 커스텀 좌표는 더 이상 의미가 없어 초기화하고, 포메이션이 그대로면 유지.
  let nextSlotCoords;
  if (slotCoords !== undefined) {
    if (slotCoords === null) {
      nextSlotCoords = null;
    } else {
      if (!Array.isArray(slotCoords) || slotCoords.length !== starters.length) {
        return bad(res, 400, '선수 배치 좌표 형식이 올바르지 않습니다.');
      }
      nextSlotCoords = slotCoords.map(clampSlotCoord);
    }
  } else if (formation !== prev.formation) {
    nextSlotCoords = null;
  } else {
    nextSlotCoords = prev.slotCoords || null;
  }
  req.user[target] = {
    formation,
    starters,
    tactic: tactic || prev.tactic || 'balanced',
    captain: nextCaptain,
    viceCaptain: nextVice,
    roles: nextRoles,
    slotCoords: nextSlotCoords,
  };
  store.putUser(req.user);
  res.json({ user: sanitizeUser(req.user) });
});

// "베스트 XI 추천" — bestStarters()로 보유/뽑기 풀에서 최적의 선발 11명을
// 골라 채워준다. 어떤 선수가 뛰는지만 바꾸고 슬롯의 화면상 위치(좌표)는
// 절대 건드리지 않는다 — 그건 배치 편집(포지션 드래그) 전용 기능이다.
app.post('/api/squad/auto', auth.authMiddleware, (req, res) => {
  const isPvp = (req.body || {}).kind === 'pvp';
  const squad = isPvp ? req.user.pvpSquad : req.user.squad;
  const formation = FORMATIONS[squad.formation] ? squad.formation : DEFAULT_FORMATION;
  const poolIds = isPvp ? req.user.drawn : req.user.owned;
  const starters = bestStarters(poolIds, formation);

  const nextRoles = {};
  Object.entries(squad.roles || {}).forEach(([pid, roleId]) => {
    if (starters.includes(pid)) nextRoles[pid] = roleId;
  });
  const target = isPvp ? 'pvpSquad' : 'squad';
  req.user[target] = {
    formation,
    starters,
    tactic: squad.tactic || 'balanced',
    captain: squad.captain && starters.includes(squad.captain) ? squad.captain : null,
    viceCaptain: squad.viceCaptain && starters.includes(squad.viceCaptain) ? squad.viceCaptain : null,
    roles: nextRoles,
    // 베스트 XI 추천은 이 포메이션 안에서 어떤 선수가 어느 슬롯에 가는지만
    // 바꿀 뿐 formation 자체는 절대 바꾸지 않으므로, 사용자가 드래그로 잡아둔
    // 슬롯의 화면상 커스텀 좌표는 항상 그대로 유지한다.
    slotCoords: squad.slotCoords || null,
  };
  store.putUser(req.user);
  res.json({ user: sanitizeUser(req.user) });
});

// Search the live player DB for names missing from the local catalog (e.g.
// recent transfers). Found players are registered and become purchasable.
app.get('/api/players/search', auth.authMiddleware, (req, res) => {
  const q = String(req.query.q || '').trim();
  if (q.length < 2) return bad(res, 400, '검색어는 2자 이상 입력해 주세요.');
  dynteams
    .searchPlayersRemote(q)
    .then((found) => res.json({ players: found }))
    .catch((err) => {
      console.error('[players/search]', err);
      bad(res, 502, '선수 DB 검색에 실패했습니다. 잠시 후 다시 시도해 주세요.');
    });
});

// ---- enhancement (선수 강화) --------------------------------------------------

// One attempt to raise an owned card's 강화 level by 1 (+1 OVR/attrs per
// level). The cost is always spent; on failure the level simply stays.
app.post('/api/players/enhance', auth.authMiddleware, (req, res) => {
  const { playerId } = req.body || {};
  const p = players.getPlayer(playerId);
  if (!p || !req.user.owned.includes(playerId)) {
    return bad(res, 400, '보유하지 않은 선수입니다.');
  }
  const cur = (req.user.upgrades && req.user.upgrades[playerId]) || 0;
  if (cur >= players.ENHANCE.maxLevel) {
    return bad(res, 400, '이미 최대 강화 단계입니다.');
  }
  const next = cur + 1;
  const cost = players.enhanceCost(playerId, next);
  if (req.user.coins < cost) {
    return bad(res, 400, `코인이 부족합니다. (필요: ${cost}, 보유: ${req.user.coins})`);
  }
  req.user.coins -= cost;
  const success = Math.random() < players.ENHANCE.rates[next - 1];
  if (!req.user.upgrades) req.user.upgrades = {};
  if (success) req.user.upgrades[playerId] = next;
  store.putUser(req.user);
  res.json({
    success,
    level: success ? next : cur,
    cost,
    player: players.publicPlayer(playerId),
    user: sanitizeUser(req.user),
  });
});

// ---- market ----------------------------------------------------------------

// Signing a player is a negotiation: club stage (transfer fee), then
// personal stage (signing bonus). See ./transfer.js.
app.post('/api/transfer/start', auth.authMiddleware, (req, res) => {
  const r = transfer.start(req.user, (req.body || {}).playerId);
  if (r.error) return bad(res, r.status, r.error);
  res.json(r);
});

app.post('/api/transfer/offer', auth.authMiddleware, (req, res) => {
  const r = transfer.offer(req.user, (req.body || {}).amount);
  if (r.error) return bad(res, r.status, r.error);
  if (r.result === 'signed') r.user = sanitizeUser(req.user);
  res.json(r);
});

app.post('/api/transfer/persuade', auth.authMiddleware, (req, res) => {
  const r = transfer.persuade(req.user, (req.body || {}).angleId);
  if (r.error) return bad(res, r.status, r.error);
  res.json(r);
});

app.post('/api/transfer/cancel', auth.authMiddleware, (req, res) => {
  res.json(transfer.cancel(req.user));
});

app.get('/api/transfer/current', auth.authMiddleware, (req, res) => {
  res.json({ negotiation: transfer.current(req.user) });
});

// ---- packs (선수 뽑기) -------------------------------------------------------

// count 1 or 5 (5연속 뽑기). A multi-draw stops early if coins run out and
// returns whatever was drawn up to that point.
app.post('/api/packs/open', auth.authMiddleware, (req, res) => {
  const { pack, count } = req.body || {};
  const n = Number(count) === 5 ? 5 : 1;
  const results = [];
  for (let i = 0; i < n; i++) {
    const r = transfer.openPack(req.user, pack);
    if (r.error) {
      if (!results.length) return bad(res, r.status, r.error);
      break;
    }
    results.push(r);
  }
  const out = { results, user: sanitizeUser(req.user) };
  if (results.length === 1) Object.assign(out, results[0]); // single-draw shape
  res.json(out);
});

app.post('/api/market/sell', auth.authMiddleware, (req, res) => {
  const { playerId } = req.body || {};
  const price = players.getPrice(playerId);
  if (!price || !req.user.owned.includes(playerId)) {
    return bad(res, 400, '보유하지 않은 선수입니다.');
  }
  // a sold player leaves everything: roster, pack unlocks, 강화 and both lineups
  req.user.owned = req.user.owned.filter((id) => id !== playerId);
  req.user.drawn = req.user.drawn.filter((id) => id !== playerId);
  if (req.user.upgrades) delete req.user.upgrades[playerId];
  req.user.squad.starters = req.user.squad.starters.map((id) => (id === playerId ? null : id));
  req.user.pvpSquad.starters = req.user.pvpSquad.starters.map((id) =>
    id === playerId ? null : id
  );
  // 실적(득점/어시스트) 좋은 카드는 시장가보다 비싸게 팔린다.
  const st = req.user.playerStats[playerId] || { goals: 0, assists: 0 };
  const perf = Math.min(0.5, st.goals * 0.03 + st.assists * 0.02);
  const coinsGained = Math.round(price * SELL_RATE * (1 + perf));
  req.user.coins += coinsGained;
  delete req.user.playerStats[playerId];
  store.putUser(req.user);
  res.json({ user: sanitizeUser(req.user), coinsGained, perfBonusPct: Math.round(perf * 100) });
});

// ---- club change -----------------------------------------------------------

// Swap the base club (costs points). Old base-club players leave the roster
// unless they've been unlocked via packs; bought/drawn players stay.
app.post('/api/club/change', auth.authMiddleware, async (req, res) => {
  const { team } = req.body || {};
  let teamName;
  try {
    teamName = await resolveTeam(team);
  } catch (err) {
    console.error('[club/change] roster fetch failed:', err.message);
    return bad(res, 502, '팀 선수단을 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.');
  }
  const t = teamName && players.TEAMS[teamName];
  if (!t || t.type !== 'club') return bad(res, 400, '존재하지 않는 클럽입니다.');
  if (teamName === req.user.baseTeam) return bad(res, 400, '이미 해당 클럽 소속입니다.');
  if (req.user.points < CLUB_CHANGE_COST) {
    return bad(res, 400, `승점이 부족합니다. (필요: ${CLUB_CHANGE_COST}, 보유: ${req.user.points})`);
  }
  const old = players.TEAMS[req.user.baseTeam];
  const oldIds = new Set(old ? old.playerIds : []);
  const drawn = new Set(req.user.drawn);
  req.user.owned = req.user.owned.filter((id) => !oldIds.has(id) || drawn.has(id));
  const ownedSet = new Set(req.user.owned);
  t.playerIds.forEach((id) => {
    if (!ownedSet.has(id)) req.user.owned.push(id);
  });
  req.user.baseTeam = teamName;
  req.user.points -= CLUB_CHANGE_COST;
  req.user.squad = {
    formation: DEFAULT_FORMATION,
    starters: bestStarters(t.playerIds, DEFAULT_FORMATION),
    tactic: req.user.squad.tactic || 'balanced',
    captain: null,
    viceCaptain: null,
    roles: {},
    slotCoords: null,
  };
  const nowOwned = new Set(req.user.owned);
  req.user.pvpSquad.starters = req.user.pvpSquad.starters.map((id) =>
    nowOwned.has(id) ? id : null
  );
  if (req.user.pvpSquad.roles) {
    const pvpStarters = new Set(req.user.pvpSquad.starters);
    Object.keys(req.user.pvpSquad.roles).forEach((id) => {
      if (!pvpStarters.has(id)) delete req.user.pvpSquad.roles[id];
    });
  }
  // 강화 levels of departed players go with them
  Object.keys(req.user.upgrades || {}).forEach((id) => {
    if (!nowOwned.has(id)) delete req.user.upgrades[id];
  });
  store.putUser(req.user);
  res.json({ user: sanitizeUser(req.user) });
});

// ---- predictions (승부 예측) --------------------------------------------------

app.get('/api/predictions', auth.authMiddleware, (req, res) => {
  predictions
    .getRounds(req.user.id)
    .then((r) => res.json(r))
    .catch((err) => {
      console.error('[predictions]', err);
      bad(res, 500, '경기 정보를 불러오지 못했습니다.');
    });
});

app.post('/api/predictions/bet', auth.authMiddleware, (req, res) => {
  const { fixtureId, pick, score } = req.body || {};
  const r = predictions.placeBet(req.user, fixtureId, pick, score);
  if (r.error) return bad(res, r.status, r.error);
  res.json(r);
});

// ---- 선수 불만 / 헌신도 -------------------------------------------------------

app.post('/api/complaint/resolve', auth.authMiddleware, (req, res) => {
  const { complaintId, choiceId } = req.body || {};
  const r = devotion.resolveComplaint(req.user, complaintId, choiceId);
  if (r.error) return bad(res, r.status, r.error);
  store.putUser(req.user);
  res.json({ user: sanitizeUser(req.user), satisfied: r.satisfied, devotion: r.devotion });
});

// ---- 이적 요청 (transfer request) ---------------------------------------------

app.post('/api/transfer-request/resolve', auth.authMiddleware, (req, res) => {
  const { requestId, choice } = req.body || {};
  const r = devotion.resolveTransferRequest(req.user, requestId, choice);
  if (r.error) return bad(res, r.status, r.error);
  store.putUser(req.user);
  res.json({
    user: sanitizeUser(req.user),
    released: r.released,
    devotion: r.devotion,
    coinsGained: r.coinsGained,
  });
});

// ---- 우편함 ------------------------------------------------------------------

app.post('/api/mailbox/claim', auth.authMiddleware, (req, res) => {
  const { mailId } = req.body || {};
  const r = mailbox.claimMail(req.user, mailId);
  if (r.error) return bad(res, r.status, r.error);
  store.putUser(req.user);
  res.json({ user: sanitizeUser(req.user) });
});

function timingSafeEqual(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

// Admin-only: grant a reward mail to a user by username. Protected by the
// ADMIN_KEY env var (unset = endpoint disabled). No admin UI yet — call
// with curl, e.g.:
//   curl -X POST $API_BASE/api/admin/mail -H "x-admin-key: $ADMIN_KEY" \
//     -H "Content-Type: application/json" \
//     -d '{"username":"lover938","coins":5000,"message":"보상입니다"}'
app.post('/api/admin/mail', (req, res) => {
  const adminKey = process.env.ADMIN_KEY;
  if (!adminKey) return bad(res, 503, '관리자 기능이 비활성화되어 있습니다 (ADMIN_KEY 미설정).');
  const provided = req.headers['x-admin-key'];
  if (!provided || !timingSafeEqual(provided, adminKey)) {
    return bad(res, 401, '관리자 인증 실패.');
  }
  const { username, coins, message } = req.body || {};
  const user = username && store.findUserByName(String(username).trim());
  if (!user) return bad(res, 404, '존재하지 않는 유저입니다.');
  const mail = mailbox.sendMail(user, { coins, message });
  store.putUser(user);
  res.json({ ok: true, mail });
});

// Admin-only: permanently delete a user by username (test-account cleanup).
// Same protection/call shape as /api/admin/mail:
//   curl -X POST $API_BASE/api/admin/delete-user -H "x-admin-key: $ADMIN_KEY" \
//     -H "Content-Type: application/json" -d '{"username":"seed_test1"}'
app.post('/api/admin/delete-user', (req, res) => {
  const adminKey = process.env.ADMIN_KEY;
  if (!adminKey) return bad(res, 503, '관리자 기능이 비활성화되어 있습니다 (ADMIN_KEY 미설정).');
  const provided = req.headers['x-admin-key'];
  if (!provided || !timingSafeEqual(provided, adminKey)) {
    return bad(res, 401, '관리자 인증 실패.');
  }
  const { username } = req.body || {};
  if (!username || typeof username !== 'string') return bad(res, 400, '삭제할 아이디를 입력해 주세요.');
  const ok = store.deleteUser(username.trim());
  if (!ok) return bad(res, 404, '존재하지 않는 유저입니다.');
  res.json({ ok: true, username: username.trim() });
});

// Admin-only: fetch+cache a dynamic team's roster (so its OVR shows up in
// /api/leagueteams) without creating a throwaway user account for it.
// Same protection/call shape as the other /api/admin/* routes:
//   curl -X POST $API_BASE/api/admin/warm-team -H "x-admin-key: $ADMIN_KEY" \
//     -H "Content-Type: application/json" -d '{"team":"Aston Villa"}'
app.post('/api/admin/warm-team', async (req, res) => {
  const adminKey = process.env.ADMIN_KEY;
  if (!adminKey) return bad(res, 503, '관리자 기능이 비활성화되어 있습니다 (ADMIN_KEY 미설정).');
  const provided = req.headers['x-admin-key'];
  if (!provided || !timingSafeEqual(provided, adminKey)) {
    return bad(res, 401, '관리자 인증 실패.');
  }
  const { team } = req.body || {};
  if (!team || typeof team !== 'string') return bad(res, 400, '팀 이름을 입력해 주세요.');
  try {
    const name = await dynteams.ensureRoster(team.trim());
    res.json({ ok: true, team: name });
  } catch (err) {
    bad(res, 502, err.message);
  }
});

// ---- 시즌 --------------------------------------------------------------------

app.get('/api/season', (req, res) => {
  res.json({ season: season.getSeasonStatus(), history: store.getSeasonHistory() });
});

// ---- 뉴스 (최근 전체 유저 경기 결과) --------------------------------------------

app.get('/api/news', (req, res) => {
  res.json({ matches: store.recentMatches(30) });
});

// ---- records ---------------------------------------------------------------

app.get('/api/matches', auth.authMiddleware, (req, res) => {
  res.json({ matches: store.matchesForUser(req.user.id, 20) });
});

// 경기 상세보기: 실제 그 경기에 뛴 라인업 + 이벤트 타임라인을 바탕으로 선수별
// 기여도 점수를 계산한다 (히트맵은 프론트에서 이 라인업의 slot 좌표를 이용해
// 그린다 — 별도 위치 로그를 남기지 않으므로 fabricate 하지 않는 선에서
// 실제 이번 경기 데이터(포메이션 슬롯 · 점유율 · 득점/도움)만 사용).
function computeContributions(lineup, timeline, team, cleanSheet) {
  return (lineup || [])
    .map((p, slot) => {
      const goals = p.id ? timeline.filter((e) => e.type === 'goal' && e.team === team && e.playerId === p.id).length : 0;
      const assists = p.id
        ? timeline.filter((e) => e.type === 'goal' && e.team === team && e.assistId === p.id).length
        : 0;
      let score = Math.round(((p.ovr - 40) / 60) * 40) + goals * 20 + assists * 12;
      if (cleanSheet && (p.pos === 'GK' || LINE[p.pos] === 'DEF')) score += 15;
      return { id: p.id, name: p.name, pos: p.pos, ovr: p.ovr, slot, youth: !!p.youth, goals, assists, score: Math.max(5, Math.min(100, score)) };
    })
    .sort((a, b) => b.score - a.score);
}

app.get('/api/matches/:id', auth.authMiddleware, (req, res) => {
  const m = store.getMatchById(req.params.id);
  if (!m) return bad(res, 404, '경기 기록을 찾을 수 없습니다.');
  const timeline = m.timeline || [];
  const homeCleanSheet = m.score.away === 0;
  const awayCleanSheet = m.score.home === 0;
  res.json({
    match: m,
    contributions: {
      home: computeContributions(m.homeLineup, timeline, 'home', homeCleanSheet),
      away: computeContributions(m.awayLineup, timeline, 'away', awayCleanSheet),
    },
  });
});

// Read-only view of another user's squad — for the 랭킹 tab's "스쿼드 보기"
// (scouting/copy-strategy). Never exposes account fields, only squad shape.
app.get('/api/user/:username/squad', auth.authMiddleware, (req, res) => {
  const target = store.findUserByName(req.params.username);
  if (!target) return bad(res, 404, '존재하지 않는 유저입니다.');
  const kind = req.query.kind === 'pvp' ? 'pvp' : 'main';
  const squad = kind === 'pvp' ? target.pvpSquad : target.squad;
  res.json({
    username: target.username,
    clubName: target.clubName,
    formation: squad.formation,
    tactic: squad.tactic || 'balanced',
    roles: squad.roles || {},
    starters: squad.starters,
    starterDetails: squad.starters.map((id) => (id ? players.publicPlayer(id) : null)),
    captain: squad.captain || null,
    viceCaptain: squad.viceCaptain || null,
    ratings: ratingSummary(withUpgrades(target, squad)),
  });
});

app.get('/api/leaderboard', (req, res) => {
  const rows = Object.values(store.get().users)
    .map((u) => {
      const r = computeRatings(withUpgrades(u, u.squad));
      return {
        username: u.username,
        clubName: u.clubName,
        points: u.points,
        record: u.record,
        ovr: r.OVR,
      };
    })
    .sort((a, b) => b.points - a.points || b.record.w - a.record.w || b.ovr - a.ovr)
    .slice(0, 50);
  res.json({ leaderboard: rows });
});

// ---- fallthrough -----------------------------------------------------------

app.use('/api', (req, res) => bad(res, 404, '존재하지 않는 API입니다.'));

app.use((err, req, res, next) => {
  console.error('[http] error:', err);
  bad(res, 500, '서버 오류가 발생했습니다.');
});

// ---- start -----------------------------------------------------------------

const server = http.createServer(app);
matchmaking.attach(server);

server.listen(PORT, () => {
  console.log(`⚽ football-squad server listening on http://localhost:${PORT}`);
});

process.on('SIGINT', () => {
  store.flushNow();
  process.exit(0);
});
process.on('SIGTERM', () => {
  store.flushNow();
  process.exit(0);
});
