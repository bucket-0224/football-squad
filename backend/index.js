'use strict';

const express = require('express');
const http = require('http');
const crypto = require('crypto');

const store = require('./store');
const auth = require('./auth');
const players = require('./data/players');
const { FORMATIONS, DEFAULT_FORMATION, LINE, posPenalty } = require('./game/formations');
const { computeRatings, TACTICS, ROLE_DEFS, defaultRoleIdFor } = require('./game/simulate');
const { slotPositionLabel, roleLookupLabel, coordFor } = require('./game/bands');
const matchmaking = require('./matchmaking');
const transfer = require('./transfer');
const predictions = require('./predictions');
const dynteams = require('./data/dynteams');
const season = require('./season');
const devotion = require('./devotion');
const mailbox = require('./mailbox');
const account = require('./account');
const event = require('./event');
const sbc = require('./game/sbc');
const social = require('./social');
const guild = require('./guild');

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
// 자동 시뮬레이션권(상점 기타 탭): AI전/컵 경기를 애니메이션 없이 즉시
// 결과로 건너뛰는 소모품. 10장 단위 묶음으로만 판매하며 묶음이 클수록
// 장당 단가가 싸다. 사용(차감)은 matchmaking.js의 'skip' 핸들러가 담당.
const SIM_TICKET_BUNDLES = [
  { count: 10, price: 300 },
  { count: 20, price: 400 },
  { count: 30, price: 500 },
];

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

// 프로필 사진은 계정 설정에서 언제든 새로 올라오는 진짜 런타임 데이터라,
// 마지막 배포 시점의 스냅샷인 프론트엔드 정적 빌드(frontend/dist)로는
// 다음 배포 전까지 절대 반영되지 않는다(깨진 이미지로 보이던 원인) —
// 항상 떠 있는 백엔드가 이 폴더를 직접 서빙해 업로드 즉시 보이게 한다.
app.use('/img/avatars', express.static(account.AVATAR_DIR));

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

// Squad + the user's 강화 levels/헌신도/Ultra 진화 목록, so ratings reflect
// enhanced+evolved cards and player mood (captain/vice-captain/roles already
// live on the squad object).
function withUpgrades(u, squad) {
  return { ...squad, upgrades: u.upgrades || {}, devotion: u.devotion || {}, ultra: u.ultra || [] };
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
    simTickets: u.simTickets || 0, // 자동 시뮬레이션권 보유 수 (기존 유저는 필드가 없어 0)
    record: u.record,
    owned: u.owned,
    drawn: u.drawn,
    upgrades: u.upgrades || {},
    ultra: u.ultra || [],
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
    cup: u.cup,
    sbc: u.sbc,
    friends: u.friends || [],
    friendRequests: u.friendRequests || { incoming: [], outgoing: [] },
    guildId: u.guildId || null,
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
    ultra: [], // Ultra 등급 진화 완료한 playerId 목록
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
    simTicketBundles: SIM_TICKET_BUNDLES,
    enhance: players.ENHANCE,
    ultra: { cost: players.ULTRA_COST, bonus: players.ULTRA_BONUS },
    events: event.listEvents(),
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
  // 요청: "선수가 원치 않는 포지션이나 대표하는 포지션이 아님에도 배치가
  // 된 경우에 원치 않는 유형도 적용이 가능해야해" — 유형은 이제 포지션/
  // 슬롯과 완전히 무관하게 아무 선수에게나 적용할 수 있다(실제 능력치
  // 반영은 simulate.js의 roleAwareScore가 그대로 담당, 거기도 같은
  // 기준으로 고쳤다). roles가 이번 요청에 실제로 들어있을 때만(=유저가
  // 지금 유형을 고르는 중일 때만) 존재하지 않는 roleId를 막고, 그 외엔
  // 전부 허용한다. roles가 없는 저장(주장/전술 변경 등)에서는 이전 값을
  // 그대로 유지 — 예전엔 여기서 슬롯 궁합까지 재검증해 무관한 저장까지
  // 통째로 거부하는 버그가 있었다(별도 커밋으로 수정).
  const strict = roles !== undefined;
  for (const [pid, roleId] of Object.entries(rolesSrc || {})) {
    if (!starters.includes(pid)) continue; // stale entry for a benched player
    if (!ROLE_DEFS[roleId]) {
      if (strict) return bad(res, 400, '알 수 없는 선수 유형입니다.');
      continue;
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

  // 요청: "RB면 RB에 국한되어서 플레이스타일을 지정할 수 있어야하고, 배치가
  // 된 순간부터는 그 포지션에 플레이스타일 중 기본이 선택되어야" — 베스트
  // XI 추천은 슬롯마다 다른 선수를 앉히므로, 기존에 골라둔 유형이 새 슬롯
  // 위치에서 더 이상 맞지 않으면 그 슬롯의 기본 유형으로 되돌린다. 궁합
  // 판정 기준은 computeRatings와 동일하게 실제 배치 좌표(slotCoords, 베스트
  // XI는 좌표 자체는 건드리지 않으므로 기존 slotCoords 그대로) 기반이다.
  const nextRoles = {};
  starters.forEach((pid, i) => {
    if (!pid) return;
    const coord = coordFor(formation, squad.slotCoords, i);
    const placedLabel = roleLookupLabel(slotPositionLabel(coord[0], coord[1]));
    const prevRoleId = (squad.roles || {})[pid];
    const prevRole = prevRoleId && ROLE_DEFS[prevRoleId];
    if (prevRole && prevRole.pos.includes(placedLabel)) {
      nextRoles[pid] = prevRoleId;
    } else {
      const def = defaultRoleIdFor(placedLabel);
      if (def) nextRoles[pid] = def;
    }
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

// Ultra 등급 진화 — 요청: "강화가 5강까지 끝나면 Ultra로 등급 진화 3000크레딧을
// 소모해서 되게 해주고". +5 강화를 이미 완료한 카드에 한해 1회만 가능하며,
// 강화(확률/실패 가능)와 달리 코인만 내면 항상 성공한다 — 이미 5강까지
// 확률을 뚫은 카드에 대한 "확정" 보상 트랙으로 설계했다(사용자가 실제
// 능력치 보너스를 원한다고 확인 — backend/data/players.js의 ULTRA_BONUS).
app.post('/api/players/evolve', auth.authMiddleware, (req, res) => {
  const { playerId } = req.body || {};
  const p = players.getPlayer(playerId);
  if (!p || !req.user.owned.includes(playerId)) {
    return bad(res, 400, '보유하지 않은 선수입니다.');
  }
  const cur = (req.user.upgrades && req.user.upgrades[playerId]) || 0;
  if (cur < players.ENHANCE.maxLevel) {
    return bad(res, 400, `+${players.ENHANCE.maxLevel} 강화를 먼저 완료해야 합니다.`);
  }
  if (!Array.isArray(req.user.ultra)) req.user.ultra = [];
  if (req.user.ultra.includes(playerId)) {
    return bad(res, 400, '이미 Ultra로 진화한 선수입니다.');
  }
  if (req.user.coins < players.ULTRA_COST) {
    return bad(res, 400, `코인이 부족합니다. (필요: ${players.ULTRA_COST}, 보유: ${req.user.coins})`);
  }
  req.user.coins -= players.ULTRA_COST;
  req.user.ultra.push(playerId);
  store.putUser(req.user);
  res.json({
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

// ---- 상점 기타: 자동 시뮬레이션권 -------------------------------------------
// AI전/컵 경기를 즉시 결과로 건너뛰는 소모품 묶음 구매. 정의된 묶음
// (SIM_TICKET_BUNDLES)만 판매하고, 사용은 matchmaking.js 'skip'이 처리한다.
app.post('/api/shop/sim-tickets', auth.authMiddleware, (req, res) => {
  const { count } = req.body || {};
  const bundle = SIM_TICKET_BUNDLES.find((b) => b.count === Number(count));
  if (!bundle) return bad(res, 400, '판매하지 않는 묶음입니다.');
  if (req.user.coins < bundle.price) {
    return bad(res, 400, `코인이 부족합니다. (필요: ${bundle.price}, 보유: ${req.user.coins})`);
  }
  req.user.coins -= bundle.price;
  req.user.simTickets = (req.user.simTickets || 0) + bundle.count;
  store.putUser(req.user);
  res.json({ user: sanitizeUser(req.user), bought: bundle.count });
});

// ---- 이벤트(기간 한정 열쇠 그리드) ------------------------------------------

app.get('/api/event/:eventId/grid', auth.authMiddleware, (req, res) => {
  const grid = event.publicGrid(req.user, req.params.eventId);
  if (!grid) return bad(res, 404, '존재하지 않는 이벤트입니다.');
  res.json({ grid });
});

app.post('/api/event/:eventId/buy-key', auth.authMiddleware, (req, res) => {
  const r = event.buyKey(req.user, req.params.eventId, (req.body || {}).count);
  if (r.error) return bad(res, r.status, r.error);
  res.json({ keys: r.keys, user: sanitizeUser(req.user) });
});

// 칸을 연다 — 보상은 즉시 지급되지 않고 우편함으로 간다(요청: "우편으로
// 열면 바로 팝업이 떠서 어떤 카드, 혹은 크레딧이 받아지는지 확인"). 여기서는
// "무슨 등급이 나왔는지"와 갱신된 그리드만 돌려주고, 실제 카드/코인 확인은
// /api/mailbox/claim에서 이뤄진다.
app.post('/api/event/:eventId/open-cell', auth.authMiddleware, (req, res) => {
  const r = event.openCell(req.user, req.params.eventId, (req.body || {}).cellIndex, mailbox.sendMail);
  if (r.error) return bad(res, r.status, r.error);
  res.json({ grade: r.grade, grid: r.grid, reset: r.reset, user: sanitizeUser(req.user) });
});

app.post('/api/market/sell', auth.authMiddleware, (req, res) => {
  const { playerId } = req.body || {};
  if (!req.user.owned.includes(playerId)) {
    return bad(res, 400, '보유하지 않은 선수입니다.');
  }
  // Ultra 진화 카드("이 경우에는 이적시장에 값을 매길 수 없기 때문에, 현재
  // 활약한 금액 + 2000 크레딧으로 이적시장 판매가 가능하게 해줘"): 뽑기로
  // 얻은 비-시장 카드가 많아 getPrice가 null인 경우가 흔하므로, 그럴 땐
  // ultraSellBase로 진화 후 OVR 기준 대체 시세를 만들어 낸다.
  const isUltra = Array.isArray(req.user.ultra) && req.user.ultra.includes(playerId);
  let price;
  if (isUltra) {
    const raw = players.getPlayer(playerId);
    const lvl = (req.user.upgrades && req.user.upgrades[playerId]) || 0;
    const boosted = raw && players.upgraded(raw, lvl, true);
    price = boosted ? players.ultraSellBase(playerId, boosted.ovr) : null;
  } else {
    price = players.getPrice(playerId);
  }
  if (!price) {
    return bad(res, 400, '이 선수는 이적시장에서 판매할 수 없습니다.');
  }
  // a sold player leaves everything: roster, pack unlocks, 강화/Ultra and both lineups
  req.user.owned = req.user.owned.filter((id) => id !== playerId);
  req.user.drawn = req.user.drawn.filter((id) => id !== playerId);
  if (req.user.upgrades) delete req.user.upgrades[playerId];
  if (Array.isArray(req.user.ultra)) req.user.ultra = req.user.ultra.filter((id) => id !== playerId);
  req.user.squad.starters = req.user.squad.starters.map((id) => (id === playerId ? null : id));
  req.user.pvpSquad.starters = req.user.pvpSquad.starters.map((id) =>
    id === playerId ? null : id
  );
  // 실적(득점/어시스트) 좋은 카드는 시장가보다 비싸게 팔린다 — "현재 활약한
  // 금액"이 가리키는 바로 이 공식. Ultra는 여기에 진화 비용을 일부
  // 보전해주는 의미로 +2000을 더한다(요청 그대로).
  const st = req.user.playerStats[playerId] || { goals: 0, assists: 0 };
  const perf = Math.min(0.5, st.goals * 0.03 + st.assists * 0.02);
  const coinsGained = Math.round(price * SELL_RATE * (1 + perf)) + (isUltra ? 2000 : 0);
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
  if (Array.isArray(req.user.ultra)) {
    req.user.ultra = req.user.ultra.filter((id) => nowOwned.has(id));
  }
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

// 요청: "우편으로 열면 바로 팝업이 떠서 어떤 카드, 혹은 크레딧이 받아지는지
// 확인할 수 있게" — 우편에 packs가 실려 있으면(이벤트 열쇠 보상 등) claim
// 시점에 실제로 그 팩들을 개봉해(free:true, 코인 재청구 없음) packResults로
// 돌려준다 — 프론트가 기존 팩 개봉 결과 화면(PackRevealModal)을 그대로
// 재사용해 "무엇을 받았는지" 보여줄 수 있게.
app.post('/api/mailbox/claim', auth.authMiddleware, (req, res) => {
  const { mailId } = req.body || {};
  const r = mailbox.claimMail(req.user, mailId);
  if (r.error) return bad(res, r.status, r.error);
  let packResults = null;
  if (r.mail.packs && r.mail.packs.length) {
    packResults = [];
    r.mail.packs.forEach(({ id, count }) => {
      for (let i = 0; i < count; i++) {
        const pr = transfer.openPack(req.user, id, { free: true });
        if (!pr.error) packResults.push(pr);
      }
    });
  }
  store.putUser(req.user);
  res.json({ user: sanitizeUser(req.user), mail: r.mail, packResults });
});

// ---- SBC(스쿼드 챌린지) -------------------------------------------------------
// 카드 소모 없음: 보유 풀에서 조건을 만족하는 11명을 임시로 배치해 제출하면
// 우편함으로 보상(backend/game/sbc.js 참고) — 실제 메인/실전 스쿼드는 그대로.

app.get('/api/sbc', auth.authMiddleware, (req, res) => {
  const dateKey = new Date().toISOString().slice(0, 10);
  const challenges = sbc.todaysChallenges(dateKey).map((c) => ({
    ...c,
    completed: !!req.user.sbc.completed[c.id],
  }));
  res.json({ challenges, formation: sbc.SBC_FORMATION, slots: sbc.SBC_SLOTS });
});

app.post('/api/sbc/submit', auth.authMiddleware, (req, res) => {
  const { challengeId, starters } = req.body || {};
  const [dateKey, templateId] = String(challengeId || '').split(':');
  if (!dateKey || !templateId) return bad(res, 400, '잘못된 챌린지입니다.');
  const todayKey = new Date().toISOString().slice(0, 10);
  if (dateKey !== todayKey) return bad(res, 400, '오늘의 챌린지가 아닙니다. 새로고침 후 다시 시도해주세요.');
  if (req.user.sbc.completed[challengeId]) return bad(res, 400, '이미 완료한 챌린지입니다.');
  const r = sbc.evaluate(req.user, templateId, starters);
  if (r.error) return bad(res, 400, r.error);
  if (!r.ok) return bad(res, 400, `조건을 아직 만족하지 않습니다. (${r.detail || ''})`);
  const reward = r.template.reward || {};
  const mail = mailbox.sendMail(req.user, {
    coins: reward.coins || 0,
    message: `🎯 SBC 챌린지 완료 — ${r.template.label}`,
  });
  req.user.sbc.completed[challengeId] = Date.now();
  store.putUser(req.user);
  res.json({ user: sanitizeUser(req.user), mail });
});

// ---- 소셜: 친구 ---------------------------------------------------------------

app.get('/api/social/friends', auth.authMiddleware, (req, res) => {
  res.json(social.friendsView(req.user));
});

app.post('/api/social/friend-request', auth.authMiddleware, (req, res) => {
  const r = social.sendFriendRequest(req.user, (req.body || {}).username);
  if (r.error) return bad(res, r.status, r.error);
  res.json(social.friendsView(req.user));
});

app.post('/api/social/friend-accept', auth.authMiddleware, (req, res) => {
  const r = social.acceptFriendRequest(req.user, (req.body || {}).userId);
  if (r.error) return bad(res, r.status, r.error);
  res.json(social.friendsView(req.user));
});

app.post('/api/social/friend-decline', auth.authMiddleware, (req, res) => {
  const r = social.declineFriendRequest(req.user, (req.body || {}).userId);
  if (r.error) return bad(res, r.status, r.error);
  res.json(social.friendsView(req.user));
});

app.post('/api/social/friend-cancel', auth.authMiddleware, (req, res) => {
  const r = social.cancelFriendRequest(req.user, (req.body || {}).userId);
  if (r.error) return bad(res, r.status, r.error);
  res.json(social.friendsView(req.user));
});

app.post('/api/social/friend-remove', auth.authMiddleware, (req, res) => {
  const r = social.removeFriend(req.user, (req.body || {}).userId);
  if (r.error) return bad(res, r.status, r.error);
  res.json(social.friendsView(req.user));
});

// ---- 소셜: 길드 (가입 신청 + 길드장 승인) ---------------------------------------

app.get('/api/guild/mine', auth.authMiddleware, (req, res) => {
  res.json({ guild: req.user.guildId ? guild.guildDetail(req.user.guildId) : null });
});

app.get('/api/guild/list', auth.authMiddleware, (req, res) => {
  res.json({ guilds: guild.guildList() });
});

app.get('/api/guild/leaderboard', auth.authMiddleware, (req, res) => {
  res.json({ leaderboard: guild.guildLeaderboard() });
});

app.post('/api/guild/create', auth.authMiddleware, (req, res) => {
  const { name, tag } = req.body || {};
  const r = guild.createGuild(req.user, name, tag);
  if (r.error) return bad(res, r.status, r.error);
  res.json({ user: sanitizeUser(req.user), guild: r.guild });
});

app.post('/api/guild/request-join', auth.authMiddleware, (req, res) => {
  const r = guild.requestJoin(req.user, (req.body || {}).guildId);
  if (r.error) return bad(res, r.status, r.error);
  res.json({ ok: true });
});

app.post('/api/guild/cancel-join', auth.authMiddleware, (req, res) => {
  const r = guild.cancelJoin(req.user, (req.body || {}).guildId);
  if (r.error) return bad(res, r.status, r.error);
  res.json({ ok: true });
});

app.post('/api/guild/approve', auth.authMiddleware, (req, res) => {
  const r = guild.approveJoin(req.user, (req.body || {}).userId);
  if (r.error) return bad(res, r.status, r.error);
  res.json({ guild: r.guild });
});

app.post('/api/guild/reject', auth.authMiddleware, (req, res) => {
  const r = guild.rejectJoin(req.user, (req.body || {}).userId);
  if (r.error) return bad(res, r.status, r.error);
  res.json({ ok: true });
});

app.post('/api/guild/leave', auth.authMiddleware, (req, res) => {
  const r = guild.leaveGuild(req.user);
  if (r.error) return bad(res, r.status, r.error);
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
  const { username, coins, message, packs } = req.body || {};
  const user = username && store.findUserByName(String(username).trim());
  if (!user) return bad(res, 404, '존재하지 않는 유저입니다.');
  const mail = mailbox.sendMail(user, { coins, message, packs });
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

// 관리자 전용: 이미 정산된("done") 예측 경기를 전부 TheSportsDB에서 다시
// 조회해 실제로 끝났는지/스코어가 맞는지 재확인하고, 틀린 건 지급된
// 코인을 회수한 뒤 live로 되돌려 정상 플로우가 다시 정산하게 한다
// (predictions.js의 auditResolved 참고 — resolveDue의 예전 조기-종료
// 버그로 잘못 정산된 과거 기록을 바로잡기 위한 1회성 도구).
//   curl -X POST $API_BASE/api/admin/predictions/audit \
//     -H "x-admin-key: $ADMIN_KEY"
app.post('/api/admin/predictions/audit', async (req, res) => {
  const adminKey = process.env.ADMIN_KEY;
  if (!adminKey) return bad(res, 503, '관리자 기능이 비활성화되어 있습니다 (ADMIN_KEY 미설정).');
  const provided = req.headers['x-admin-key'];
  if (!provided || !timingSafeEqual(provided, adminKey)) {
    return bad(res, 401, '관리자 인증 실패.');
  }
  try {
    const report = await predictions.auditResolved();
    res.json(report);
  } catch (err) {
    console.error('[admin] predictions audit failed:', err);
    bad(res, 500, '감사 중 오류가 발생했습니다.');
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
    slotCoords: squad.slotCoords || null,
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

// 전체 유저 통틀어 득점/도움 상위 기록 — 개인별(TopPerformersSub, RankTab.tsx)이
// 아니라 서버 전체 기준 "지금 누가 득점왕/도움왕인지"용. 같은 카탈로그
// 선수를 여러 유저가 보유해도 합산하지 않고 (유저, 선수) 조합별로 따로
// 집계한다 — "이 유저의 이 카드가 몇 골 넣었는지"가 실제로 의미 있는 단위라서.
app.get('/api/top-performers', (req, res) => {
  const scorers = [];
  const assisters = [];
  Object.values(store.get().users).forEach((u) => {
    Object.entries(u.playerStats || {}).forEach(([playerId, s]) => {
      if (!players.getPlayer(playerId)) return; // stale entry for a player no longer in the catalog
      if (s.goals) {
        scorers.push({ username: u.username, clubName: u.clubName, playerId, goals: s.goals });
      }
      if (s.assists) {
        assisters.push({ username: u.username, clubName: u.clubName, playerId, assists: s.assists });
      }
    });
  });
  scorers.sort((a, b) => b.goals - a.goals);
  assisters.sort((a, b) => b.assists - a.assists);
  res.json({ scorers: scorers.slice(0, 20), assisters: assisters.slice(0, 20) });
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
