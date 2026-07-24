'use strict';

const { FORMATIONS, DEFAULT_FORMATION, LINE } = require('./formations');
const players = require('../data/players');

// --- helpers ---------------------------------------------------------------

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

function poisson(lambda) {
  const L = Math.exp(-lambda);
  let k = 0;
  let p = 1;
  do {
    k++;
    p *= Math.random();
  } while (p > L);
  return Math.min(k - 1, 7);
}

function pickWeighted(items, weightFn) {
  const total = items.reduce((s, it) => s + Math.max(0, weightFn(it)), 0);
  if (total <= 0) return items[Math.floor(Math.random() * items.length)];
  let r = Math.random() * total;
  for (const it of items) {
    r -= Math.max(0, weightFn(it));
    if (r <= 0) return it;
  }
  return items[items.length - 1];
}

// Chemistry: how well a player fits the slot they were placed in.
function chemistry(playerLine, slotLine) {
  if (slotLine === 'GK') return playerLine === 'GK' ? 1 : 0.55;
  if (playerLine === 'GK') return 0.6; // outfield GK
  if (playerLine === slotLine) return 1;
  const adj =
    (playerLine === 'DEF' && slotLine === 'MID') ||
    (playerLine === 'MID' && slotLine === 'DEF') ||
    (playerLine === 'MID' && slotLine === 'ATT') ||
    (playerLine === 'ATT' && slotLine === 'MID');
  return adj ? 0.92 : 0.82;
}

function roleScore(a, slotLine) {
  switch (slotLine) {
    case 'DEF':
      return a.defending * 0.5 + a.physical * 0.25 + a.pace * 0.15 + a.passing * 0.1;
    case 'MID':
      return a.passing * 0.33 + a.dribbling * 0.24 + a.physical * 0.18 + a.defending * 0.13 + a.pace * 0.12;
    case 'ATT':
      return a.shooting * 0.4 + a.pace * 0.24 + a.dribbling * 0.26 + a.physical * 0.1;
    case 'GK':
    default:
      // GK strength blends reflex-ish attrs; buildAttributes gives GKs high defending.
      return a.defending * 0.45 + a.physical * 0.2 + a.passing * 0.15 + a.pace * 0.2;
  }
}

// FM 스타일 선수 유형(포지션별 역할): 라인 기본 공식과 별개로, 같은 포지션
// 안에서도 어떤 능력치를 더 중시할지 선택할 수 있게 한다. 각 라인의 "기본"
// 역할은 roleScore와 동일한 공식이라 역할을 지정하지 않은 선수는 기존과
// 완전히 동일하게 동작한다 (하위 호환).
const ROLE_DEFS = {
  poacher: { label: '기본(포처)', pos: ['ST', 'CF'], isDefault: true, score: (a) => a.shooting * 0.4 + a.pace * 0.24 + a.dribbling * 0.26 + a.physical * 0.1 },
  target: { label: '타겟맨', pos: ['ST', 'CF'], score: (a) => a.shooting * 0.32 + a.physical * 0.34 + a.dribbling * 0.14 + a.passing * 0.1 + a.pace * 0.1 },
  deepForward: { label: '딥라잉 포워드', pos: ['ST', 'CF'], score: (a) => a.shooting * 0.28 + a.passing * 0.28 + a.dribbling * 0.28 + a.pace * 0.16 },
  advancedForward: { label: '어드밴스드 포워드', pos: ['ST', 'CF'], score: (a) => a.pace * 0.32 + a.shooting * 0.3 + a.physical * 0.2 + a.dribbling * 0.18 },
  falseNine: { label: '가짜 9번', pos: ['ST', 'CF'], score: (a) => a.passing * 0.34 + a.dribbling * 0.3 + a.shooting * 0.2 + a.pace * 0.16 },
  completeForward: { label: '컴플리트 포워드', pos: ['ST', 'CF'], score: (a) => a.shooting * 0.26 + a.dribbling * 0.24 + a.passing * 0.2 + a.pace * 0.18 + a.physical * 0.12 },

  winger: { label: '기본(윙어)', pos: ['LW', 'RW'], isDefault: true, score: (a) => a.shooting * 0.4 + a.pace * 0.24 + a.dribbling * 0.26 + a.physical * 0.1 },
  invertedWinger: { label: '인버티드 윙어', pos: ['LW', 'RW'], score: (a) => a.shooting * 0.34 + a.passing * 0.26 + a.dribbling * 0.28 + a.pace * 0.12 },
  widePlaymaker: { label: '와이드 플레이메이커', pos: ['LW', 'RW'], score: (a) => a.passing * 0.38 + a.dribbling * 0.28 + a.pace * 0.2 + a.shooting * 0.14 },
  raumdeuter: { label: '라움도이터', pos: ['LW', 'RW'], score: (a) => a.pace * 0.34 + a.shooting * 0.32 + a.dribbling * 0.22 + a.physical * 0.12 },

  playmaker: { label: '기본(공격형 미드필더)', pos: ['CAM'], isDefault: true, score: (a) => a.passing * 0.33 + a.dribbling * 0.24 + a.physical * 0.18 + a.defending * 0.13 + a.pace * 0.12 },
  shadowStriker: { label: '섀도우 스트라이커', pos: ['CAM'], score: (a) => a.shooting * 0.32 + a.dribbling * 0.28 + a.pace * 0.22 + a.passing * 0.18 },
  advancedPlaymaker: { label: '어드밴스드 플레이메이커', pos: ['CAM'], score: (a) => a.passing * 0.42 + a.dribbling * 0.26 + a.pace * 0.16 + a.defending * 0.16 },
  enganche: { label: '엔간체', pos: ['CAM'], score: (a) => a.dribbling * 0.34 + a.passing * 0.34 + a.shooting * 0.2 + a.pace * 0.12 },

  box2box: { label: '기본(박스투박스)', pos: ['CM', 'LM', 'RM'], isDefault: true, score: (a) => a.passing * 0.33 + a.dribbling * 0.24 + a.physical * 0.18 + a.defending * 0.13 + a.pace * 0.12 },
  deepLyingPM: { label: '딥라잉 플레이메이커', pos: ['CM', 'LM', 'RM'], score: (a) => a.passing * 0.42 + a.dribbling * 0.2 + a.defending * 0.18 + a.pace * 0.1 + a.physical * 0.1 },
  mezzala: { label: '메찰라', pos: ['CM', 'LM', 'RM'], score: (a) => a.dribbling * 0.3 + a.passing * 0.28 + a.pace * 0.24 + a.physical * 0.18 },
  roamingPM: { label: '로밍 플레이메이커', pos: ['CM', 'LM', 'RM'], score: (a) => a.passing * 0.36 + a.dribbling * 0.26 + a.defending * 0.2 + a.pace * 0.18 },

  anchor: { label: '기본(수비형 미드필더)', pos: ['CDM'], isDefault: true, score: (a) => a.passing * 0.33 + a.dribbling * 0.24 + a.physical * 0.18 + a.defending * 0.13 + a.pace * 0.12 },
  ballPlayingMid: { label: '볼 플레잉 미드필더', pos: ['CDM'], score: (a) => a.passing * 0.38 + a.dribbling * 0.22 + a.defending * 0.24 + a.pace * 0.16 },
  regista: { label: '레지스타', pos: ['CDM'], score: (a) => a.passing * 0.46 + a.dribbling * 0.22 + a.defending * 0.2 + a.pace * 0.12 },
  halfBack: { label: '하프백', pos: ['CDM'], score: (a) => a.defending * 0.42 + a.physical * 0.26 + a.passing * 0.2 + a.pace * 0.12 },

  fullback: { label: '기본(풀백)', pos: ['LB', 'RB'], isDefault: true, score: (a) => a.defending * 0.5 + a.physical * 0.25 + a.pace * 0.15 + a.passing * 0.1 },
  wingback: { label: '윙백', pos: ['LB', 'RB', 'LWB', 'RWB'], score: (a) => a.pace * 0.3 + a.defending * 0.28 + a.physical * 0.24 + a.passing * 0.18 },
  invertedFullback: { label: '인버티드 풀백', pos: ['LB', 'RB'], score: (a) => a.defending * 0.36 + a.passing * 0.34 + a.physical * 0.16 + a.pace * 0.14 },
  completeWingback: { label: '컴플리트 윙백', pos: ['LB', 'RB', 'LWB', 'RWB'], score: (a) => a.pace * 0.26 + a.defending * 0.26 + a.passing * 0.26 + a.physical * 0.22 },

  stopper: { label: '기본(센터백)', pos: ['CB'], isDefault: true, score: (a) => a.defending * 0.5 + a.physical * 0.25 + a.pace * 0.15 + a.passing * 0.1 },
  ballPlayingCB: { label: '볼 플레잉 센터백', pos: ['CB'], score: (a) => a.defending * 0.4 + a.passing * 0.3 + a.physical * 0.18 + a.pace * 0.12 },
  coverCB: { label: '커버링 센터백', pos: ['CB'], score: (a) => a.pace * 0.32 + a.defending * 0.4 + a.physical * 0.16 + a.passing * 0.12 },
  noNonsenseCB: { label: '노난센스 센터백', pos: ['CB'], score: (a) => a.defending * 0.52 + a.physical * 0.36 + a.pace * 0.12 },
};

// shooting/passing coefficients hand-copied from each ROLE_DEFS entry's score
// formula above, for scorerFor/assistFor to nudge WHO scores/assists by role
// (computeRatings's OVR path doesn't need these — it already calls
// role.score() directly). Keep in sync with ROLE_DEFS if a formula changes.
// GK has no roles (goalkeeping isn't role-differentiated) and is filtered
// out of both scorerFor/assistFor anyway, so it's omitted here.
const ROLE_EMPHASIS = {
  poacher: { shooting: 0.4, passing: 0 },
  target: { shooting: 0.32, passing: 0.1 },
  deepForward: { shooting: 0.28, passing: 0.28 },
  advancedForward: { shooting: 0.3, passing: 0 },
  falseNine: { shooting: 0.2, passing: 0.34 },
  completeForward: { shooting: 0.26, passing: 0.2 },
  winger: { shooting: 0.4, passing: 0 },
  invertedWinger: { shooting: 0.34, passing: 0.26 },
  widePlaymaker: { shooting: 0.14, passing: 0.38 },
  raumdeuter: { shooting: 0.32, passing: 0 },
  playmaker: { shooting: 0, passing: 0.33 },
  shadowStriker: { shooting: 0.32, passing: 0.18 },
  advancedPlaymaker: { shooting: 0, passing: 0.42 },
  enganche: { shooting: 0.2, passing: 0.34 },
  box2box: { shooting: 0, passing: 0.33 },
  deepLyingPM: { shooting: 0, passing: 0.42 },
  mezzala: { shooting: 0, passing: 0.28 },
  roamingPM: { shooting: 0, passing: 0.36 },
  anchor: { shooting: 0, passing: 0.33 },
  ballPlayingMid: { shooting: 0, passing: 0.38 },
  regista: { shooting: 0, passing: 0.46 },
  halfBack: { shooting: 0, passing: 0.2 },
  fullback: { shooting: 0, passing: 0.1 },
  wingback: { shooting: 0, passing: 0.18 },
  invertedFullback: { shooting: 0, passing: 0.34 },
  completeWingback: { shooting: 0, passing: 0.26 },
  stopper: { shooting: 0, passing: 0.1 },
  ballPlayingCB: { shooting: 0, passing: 0.3 },
  coverCB: { shooting: 0, passing: 0.12 },
  noNonsenseCB: { shooting: 0, passing: 0 },
};

// Only apply a role if it's actually valid for the card's real position —
// stale role assignments after a position swap silently fall back to the
// slot's default line formula instead of producing nonsense ratings.
function roleAwareScore(player, slotLine, roleId) {
  const role = roleId && ROLE_DEFS[roleId];
  if (role && role.pos.includes(player.pos)) return role.score(player.attrs);
  return roleScore(player.attrs, slotLine);
}

// The role id an unassigned/invalid-role player effectively plays as — the
// position's isDefault entry, so "no role" reads the same ROLE_EMPHASIS
// nudge as explicitly picking the default (matching roleAwareScore's own
// "unassigned behaves identically to the default role" contract above,
// which scorerFor/assistFor need too instead of silently falling back to a
// flat no-bonus multiplier for every unassigned player).
function defaultRoleIdFor(pos) {
  const found = Object.entries(ROLE_DEFS).find(([, r]) => r.isDefault && r.pos.includes(pos));
  return found ? found[0] : null;
}

// --- ratings ---------------------------------------------------------------

// Devotion (헌신도, 0..100) nudges tactic execution: a dissatisfied player
// (low devotion) underperforms their raw attrs slightly, a devoted one
// overperforms slightly. Missing entries default to a neutral 60.
function devotionFactor(dev) {
  const d = clamp(dev == null ? 60 : dev, 0, 100);
  return 0.94 + (d / 100) * 0.12;
}

// Compute the four sectional ratings (0..100) + overall from a squad lineup.
// squad.upgrades (id -> 강화 level) boosts a card's OVR/attrs when present.
// squad.ultra (id[]) adds the Ultra 진화 bonus on top for cards that finished
// it (backend/data/players.js의 ULTRA_BONUS 참고). squad.devotion (id ->
// 0..100) and squad.captain/viceCaptain feed a small per-player execution
// multiplier alongside position chemistry.
function computeRatings(squad) {
  const formation = FORMATIONS[squad.formation] ? squad.formation : DEFAULT_FORMATION;
  const slots = FORMATIONS[formation];
  const up = squad.upgrades || null;
  const ultraSet = new Set(squad.ultra || []);
  const devotionMap = squad.devotion || null;
  const captainId = squad.captain || null;
  const viceCaptainId = squad.viceCaptain || null;
  const roleMap = squad.roles || null;
  const lines = { GK: [], DEF: [], MID: [], ATT: [] };
  const roster = [];

  slots.forEach((slotPos, i) => {
    const id = squad.starters[i];
    let p = players.getPlayer(id);
    if (p && ((up && up[id]) || ultraSet.has(id))) p = players.upgraded(p, up && up[id], ultraSet.has(id));
    const slotLine = LINE[slotPos];
    if (!p) {
      // empty slot -> the youth stand-in (matches the OVR 40 shown on pitch)
      lines[slotLine].push(40);
      return;
    }
    const chem = chemistry(p.line, slotLine);
    let mult = chem * devotionFactor(devotionMap ? devotionMap[id] : null);
    if (captainId && id === captainId) mult *= 1.05;
    else if (viceCaptainId && id === viceCaptainId) mult *= 1.025;
    const roleId = roleMap ? roleMap[id] : null;
    const role = roleId && ROLE_DEFS[roleId];
    const effectiveRoleId = role && role.pos.includes(p.pos) ? roleId : defaultRoleIdFor(p.pos);
    const score = roleAwareScore(p, slotLine, roleId) * mult;
    lines[slotLine].push(score);
    roster.push({ player: p, slotPos, slotLine, chem, score, roleId: effectiveRoleId });
  });

  const avg = (arr) => (arr.length ? arr.reduce((s, v) => s + v, 0) / arr.length : 40);
  const ATT = avg(lines.ATT);
  const MID = avg(lines.MID);
  const DEF = avg(lines.DEF);
  const GK = avg(lines.GK);
  const OVR = ATT * 0.3 + MID * 0.3 + DEF * 0.28 + GK * 0.12;
  const chemAll = roster.length
    ? Math.round((roster.reduce((s, r) => s + r.chem, 0) / roster.length) * 100)
    : 0;

  return {
    formation,
    ATT: Math.round(ATT),
    MID: Math.round(MID),
    DEF: Math.round(DEF),
    GK: Math.round(GK),
    OVR: Math.round(OVR),
    chemistry: chemAll,
    roster,
  };
}

// --- tactics ---------------------------------------------------------------

// atk multiplies own xG, def divides opponent xG, poss shifts possession.
// 'counter' gets a bonus against an attacking opponent.
const TACTICS = {
  attacking: { name: '공격적', atk: 1.18, def: 0.9, poss: 0.03 },
  balanced: { name: '균형', atk: 1.0, def: 1.0, poss: 0 },
  defensive: { name: '수비적', atk: 0.82, def: 1.14, poss: -0.04 },
  counter: { name: '역습', atk: 0.95, def: 1.04, poss: -0.02, vsAttacking: 1.22 },
};

function tacticOf(squad) {
  return squad && TACTICS[squad.tactic] ? squad.tactic : 'balanced';
}

// ===== 오프사이드(실제 라인 기반 판정) =====
// 요청: "만약 현재 랜덤 오프사이드 선언이면, 하프 라인 이후에 우리팀 선수가
// 상대팀 최종 수비수보다 뒤에 있다면 오프사이드 선언 및 VAR 역시 동일한
// 기준 적용... 상대팀도 동일한 기준을 적용" — 예전엔 정확히 이 "랜덤"이었다
// (addGoals와 완전히 분리된 별도 함수가 xG에 비례한 18% 고정 확률로 그냥
// "취소된 골" 이벤트를 얹었을 뿐, 실제로 어떤 골 시도와도 연결되지 않았다).
// 다만 이 백엔드 시뮬레이션 자체가 분 단위 확률 이벤트만 계산할 뿐 실제
// x/y 좌표를 전혀 추적하지 않는다(좌표 기반 오프사이드는 프론트
// liveMatchEngine.ts의 offsideCheck가 이미 하고 있지만, 그건 이벤트 사이를
// 채우는 장식용 앰비언트 패스에만 적용되고 실제 득점 여부를 좌우하지
//않는다 — 백엔드가 이미 확정한 결과를 보여줄 뿐이라 좌표를 몰라도 된다).
// 그래서 여기서는 "완전한 좌표 시뮬레이션"이 아니라, 팀의 라인 높이(전술)와
// 그 라인을 다루는 능력치(수비 DEF ↔ 침투하는 공격진 ATT)를 견주는 방식으로
// "그 순간 마지막 수비수보다 앞서 있었는가"를 판정한다 — 수비 라인이
// 높을수록(압박 전술) 오프사이드 트랩이 성립할 상황 자체가 많아지고, 공격이
// 침투 지향적일수록(공격적/역습) 그 라인 뒤 위험한 타이밍의 패스를 더 자주
// 시도한다. 이제 이 판정은 addGoals 안에서 실제로 만들어지려던 골 하나하나에
// 대해 이뤄지므로(아래 addGoals 참고), "그 골이 진짜 오프사이드였는지"를
// 판정하는 것이지 별개로 얹는 장식이 아니다 — 홈/원정 양쪽에 완전히 동일한
// 함수로 적용되어 편파적이지 않다.
const LINE_HEIGHT = { attacking: 70, balanced: 0, defensive: -60, counter: -40 };
function isOffsideRun(atkTactic, defTactic, atkRatings, defRatings) {
  const atkLine = LINE_HEIGHT[atkTactic] ?? 0;
  const defLine = LINE_HEIGHT[defTactic] ?? 0;
  let p = 0.05 + Math.max(0, defLine - atkLine + 60) / 700;
  p += (defRatings.DEF - atkRatings.ATT) / 900;
  return Math.random() < clamp(p, 0.02, 0.32);
}

// --- match simulation ------------------------------------------------------

function scorerFor(ratings, excludeId, opts = {}) {
  const candidates = ratings.roster.filter((r) => r.slotLine !== 'GK' && r.player.id !== excludeId);
  const r = pickWeighted(candidates, (c) => {
    const lineW = c.slotLine === 'ATT' ? 3.2 : c.slotLine === 'MID' ? 1.4 : 0.35;
    // role nudge: a shooting-heavy role (e.g. poacher) scores more than a
    // passing-heavy one in the same line/position, on top of the existing
    // shooting+ovr baseline — clamped so a future role can't blow it up.
    const emphasis = ROLE_EMPHASIS[c.roleId];
    const roleShoot = Math.min(1.5, 1 + (emphasis ? emphasis.shooting : 0));
    let w = lineW * roleShoot * (c.player.attrs.shooting + c.player.ovr) / 2;
    // corners are won in the air — tall, physical players out-jump their
    // marker far more often than raw shooting/ovr alone would predict.
    if (opts.aerial) {
      const heightBonus = 1 + Math.max(0, ((c.player.height || 180) - 180) / 60);
      const physBonus = 1 + (c.player.attrs.physical - 50) / 150;
      w *= heightBonus * physBonus;
    }
    return w;
  });
  return r ? { id: r.player.id, name: r.player.name } : { id: null, name: '알 수 없는 선수' };
}

// Average height of a team's tallest 3 non-GK outfielders — a stand-in for
// "how dangerous this team is in the air", used to bias how often corners
// convert to goals. ~186cm baseline mirrors a typical XI's 2 CBs + a striker.
const AERIAL_BASELINE_CM = 186;
function aerialStrength(ratings) {
  const heights = ratings.roster
    .filter((r) => r.slotLine !== 'GK')
    .map((r) => r.player.height || 180)
    .sort((a, b) => b - a)
    .slice(0, 3);
  if (!heights.length) return AERIAL_BASELINE_CM;
  return heights.reduce((s, h) => s + h, 0) / heights.length;
}

// Pick a teammate (excluding the scorer) to credit with the assist, weighted
// toward playmaking attrs. Callers skip this entirely for penalties.
function assistFor(ratings, scorerId, excludeId) {
  const candidates = ratings.roster.filter(
    (r) => r.slotLine !== 'GK' && r.player.id !== scorerId && r.player.id !== excludeId
  );
  const r = pickWeighted(candidates, (c) => {
    const lineW = c.slotLine === 'ATT' ? 2.4 : c.slotLine === 'MID' ? 3 : 0.5;
    const emphasis = ROLE_EMPHASIS[c.roleId];
    const roleAssist = Math.min(1.5, 1 + (emphasis ? emphasis.passing : 0));
    return lineW * roleAssist * (c.player.attrs.passing + c.player.attrs.dribbling) / 2;
  });
  return r ? { id: r.player.id, name: r.player.name } : null;
}

function uniqueMinutes(n, from = 1) {
  const span = Math.max(1, 91 - from);
  const set = new Set();
  let guard = 0;
  while (set.size < Math.min(n, span) && guard < 400) {
    guard++;
    set.add(from + Math.floor(Math.random() * span));
  }
  return [...set];
}

// Simulate a full match. Returns ratings, possession, score and a sorted
// event timeline that the matchmaking layer streams out minute by minute.
// opts.fromMinute/baseScore simulate only the remainder (작전 타임 교체 후
// 남은 경기를 새 스쿼드로 다시 굴릴 때 사용).
function simulateMatch(homeSquad, awaySquad, homeName, awayName, opts = {}) {
  const fromMinute = opts.fromMinute || 0;
  const base = opts.baseScore || { home: 0, away: 0 };
  const frac = Math.max(0, (90 - fromMinute) / 90);
  // 경기 전 프리뷰에서 고른 심판 성향 — 1.0이 기준, 엄격할수록 카드가
  // 늘고 관대할수록 준다. 파울/카드 관련 확률에만 곱한다.
  const cardBias = opts.cardBias || 1;
  const home = computeRatings(homeSquad);
  const away = computeRatings(awaySquad);

  const tacHome = tacticOf(homeSquad);
  const tacAway = tacticOf(awaySquad);
  const tHome = TACTICS[tacHome];
  const tAway = TACTICS[tacAway];

  const midSum = home.MID + away.MID || 1;
  const possHome = clamp(
    home.MID / midSum + (tHome.poss || 0) - (tAway.poss || 0),
    0.25,
    0.75
  );
  const possAway = 1 - possHome;

  const xg = (att, oppDEF, oppGK, poss) => {
    const resist = oppDEF * 0.68 + oppGK * 0.32;
    const diff = att - resist;
    return clamp(1.15 + diff / 15, 0.2, 4.5) * (0.7 + poss * 0.6);
  };

  const counterBonus = (t, oppTac) =>
    t.vsAttacking && oppTac === 'attacking' ? t.vsAttacking : 1;

  const xgHome =
    (xg(home.ATT, away.DEF, away.GK, possHome) * tHome.atk * counterBonus(tHome, tacAway)) /
    tAway.def;
  const xgAway =
    (xg(away.ATT, home.DEF, home.GK, possAway) * tAway.atk * counterBonus(tAway, tacHome)) /
    tHome.def;

  // Build event timeline. Flavor events come first: bookings must be known
  // before goals so a sending-off can tilt the expected goals for the rest
  // of the match.
  const events = [];

  // Flavor (non-goal) events, roughly proportional to attacking output.
  const addFlavor = (side, ratings, oppGKrating, xgVal) => {
    const n = Math.round((xgVal * 2 + 1 + Math.random() * 3) * frac);
    uniqueMinutes(n, fromMinute + 1).forEach((minute) => {
      const roll = Math.random();
      let type;
      let text;
      let via = null;
      const whoC = pickWeighted(
        ratings.roster.filter((c) => c.slotLine !== 'GK'),
        (c) => (c.slotLine === 'ATT' ? 3 : c.slotLine === 'MID' ? 2 : 0.4)
      );
      const who = whoC ? whoC.player.name : '선수';
      const whoId = whoC ? whoC.player.id : null;
      if (roll < 0.26) {
        type = 'save';
        text = `${who}의 슈팅 — 골키퍼 선방!`;
      } else if (roll < 0.46) {
        type = 'miss';
        text = `${who}의 슈팅이 골문을 벗어남`;
      } else if (roll < 0.58) {
        type = 'corner';
        text = `코너킥 기회`;
      } else if (roll < 0.72) {
        type = 'foul';
        text =
          Math.random() < 0.15
            ? `핸드볼 반칙 — ${who}의 팀이 프리킥을 얻습니다`
            : `파울! ${who}에게 프리킥이 주어집니다`;
        // 약한 태클이라도 심판 재량으로 낮은 확률에 옐로카드가 나올 수
        // 있다 — 반칙을 저지른 쪽(상대팀)에서 별도 'card' 이벤트로 추가
        // 발생시킨다(같은 선수가 이미 한 장 있으면 기존 퇴장 로직이 알아서
        // 두 번째 경고=퇴장으로 승격시킨다).
        if (Math.random() < 0.1 * cardBias) {
          const oppRatings = side === 'home' ? away : home;
          const oppSide = side === 'home' ? 'away' : 'home';
          const culpritC = pickWeighted(oppRatings.roster.filter((c) => c.slotLine !== 'GK'), () => 1);
          if (culpritC) {
            events.push({
              minute,
              type: 'card',
              team: oppSide,
              player: culpritC.player.name,
              playerId: culpritC.player.id,
              text: `${culpritC.player.name} 경고 — 약한 태클이었지만 심판 재량으로 옐로카드`,
              via: null,
              awardedTeam: side,
            });
          }
        }
      } else if (roll < 0.82) {
        type = 'throwin';
        text = `볼이 터치라인을 벗어남 — 스로인`;
      } else if (roll < 0.88) {
        via = 'freekick';
        type = Math.random() < 0.5 ? 'save' : 'miss';
        text =
          type === 'save'
            ? `${who}의 프리킥 슈팅 — 골키퍼 선방!`
            : `${who}의 프리킥이 골문을 벗어남`;
      } else if (roll < 0.89) {
        // failed penalties are rare (EPL conversion ≈ 78% — most penalty
        // events in a match are the scored ones on the goal timeline)
        via = 'penalty';
        type = Math.random() < 0.65 ? 'save' : 'miss';
        text =
          type === 'save'
            ? `페널티킥! ${who}의 슛을 골키퍼가 막아냅니다!`
            : `페널티킥! ${who}의 슛이 골문을 벗어납니다 (실축)`;
      } else {
        type = 'card';
        text = `${who} 경고 (옐로카드)`;
      }
      // 심판 성향(cardBias)을 기본 카드 밴드에도 반영한다 — 밴드 경계값을
      // 직접 옮기면 옆 밴드(페널티 등)와 겹치니, 대신 확률적으로 카드 쪽
      // 으로/에서 변환한다: 엄격한 심판은 애매한 상황(슈팅/스로인류)도 가끔
      // 카드로 잡고, 관대한 심판은 원래 카드였을 상황을 가끔 봐준다.
      if (cardBias > 1 && type !== 'card' && type !== 'foul' && via == null) {
        if (Math.random() < (cardBias - 1) * 0.05) {
          type = 'card';
          text = `${who} 경고 (옐로카드)`;
        }
      } else if (type === 'card' && cardBias < 1 && Math.random() > cardBias) {
        type = 'miss';
        text = `${who}의 슈팅이 골문을 벗어남`;
      }
      // "누가 프리킥을 얻는 팀인지"는 이벤트 타입마다 의미가 다르다 —
      // foul은 team이 이미 그 수혜팀(파울당한 쪽)이지만, card는 team이
      // 카드를 받는(반칙을 저지른) 쪽이라 프리킥은 반대 팀 몫이다. 프론트가
      // 그때그때 타입을 보고 뒤집어 계산하지 않도록 여기서 명시적으로
      // 계산해 보낸다 — 나중에 타입 하나가 바뀌어도 이 필드만 보면 된다.
      const opp = side === 'home' ? 'away' : 'home';
      const awardedTeam = type === 'card' ? opp : side;
      events.push({ minute, type, team: side, player: who, playerId: whoId, text, via, awardedTeam });
    });
  };
  addFlavor('home', home, away.GK, xgHome);
  addFlavor('away', away, home.GK, xgAway);

  // 부상(injury) / 태업(work-to-rule strop): low-probability, independent of
  // attacking output — at most one of each per side per match. Reuses the
  // same ".off" unavailability mechanism as a red card downstream (backend
  // just emits the event; matchmaking.js/liveMatchEngine.ts do the rest).
  // STROP_DEVOTION_THRESHOLD mirrors backend/index.js and matchmaking.js.
  const INJURY_CHANCE = 0.08;
  const STROP_CHANCE = 0.25;
  const STROP_DEVOTION_THRESHOLD = 20;
  const addUnavailability = (side, ratings, squad) => {
    const outfield = ratings.roster.filter((r) => r.slotLine !== 'GK');
    if (!outfield.length || !frac) return;
    const randMinute = () => fromMinute + 1 + Math.floor(Math.random() * Math.max(1, 90 - fromMinute));

    if (Math.random() < INJURY_CHANCE * frac) {
      const victim = outfield[Math.floor(Math.random() * outfield.length)].player;
      // 부상 경중도: 경미(65%)는 잠깐 빠졌다 같은 자리로 복귀, 중상(35%)만
      // 실제로 못 뛰게 되어 강제 교체(medical timeout)로 이어진다.
      const severity = Math.random() < 0.65 ? 'minor' : 'major';
      events.push({
        minute: randMinute(),
        type: 'injury',
        team: side,
        player: victim.name,
        playerId: victim.id,
        severity,
        text:
          severity === 'minor'
            ? `🚑 ${victim.name}, 충돌로 그라운드에 쓰러졌지만 곧 다시 일어섭니다`
            : `🚑 ${victim.name}, 부상으로 그라운드에 쓰러집니다 — 교체가 불가피해 보입니다`,
      });
    }

    const devotionMap = (squad && squad.devotion) || {};
    const stropCandidates = outfield.filter((r) => (devotionMap[r.player.id] ?? 60) < STROP_DEVOTION_THRESHOLD);
    if (stropCandidates.length && Math.random() < STROP_CHANCE * frac) {
      const victim = stropCandidates[Math.floor(Math.random() * stropCandidates.length)].player;
      events.push({
        minute: randMinute(),
        type: 'strop',
        team: side,
        player: victim.name,
        playerId: victim.id,
        text: `😤 ${victim.name}, 불만을 참지 못하고 경기를 거부합니다 — 태업!`,
      });
    }
  };
  addUnavailability('home', home, homeSquad);
  addUnavailability('away', away, awaySquad);

  // 경고 누적 퇴장: walk the bookings chronologically; a repeat offender's
  // second yellow becomes a red (at most one per side). A sending-off tilts
  // the remaining expected goals: 10 men score less, concede more.
  const redAdj = { home: 1, away: 1 };
  // Player actually sent off this match, if any (at most one per side here —
  // used downstream so a dismissed player can no longer score/assist/appear
  // in later events on the same side).
  const dismissed = { home: null, away: null };
  {
    const booked = { home: new Map(), away: new Map() }; // name -> id
    const redDone = { home: false, away: false };
    events
      .filter((e) => e.type === 'card')
      .sort((a, b) => a.minute - b.minute)
      .forEach((e) => {
        const side = e.team;
        if (redDone[side]) return;
        const sendOff = (text) => {
          e.red = true;
          e.text = text;
          redDone[side] = true;
          dismissed[side] = { id: e.playerId, minute: e.minute };
          const rem = Math.max(0, 90 - e.minute) / 90;
          const opp = side === 'home' ? 'away' : 'home';
          redAdj[side] *= 1 - 0.35 * rem;
          redAdj[opp] *= 1 + 0.25 * rem;
        };
        // 스트레이트 레드: 심각한 반칙은 경고 없이 즉시 퇴장 (실제 레드의
        // 절반 이상이 이 유형) — VAR 판독을 거쳐 확정되는 것으로 서사를
        // 붙인다(프론트가 이 문구를 감지해 VAR 배너를 띄운다).
        if (Math.random() < 0.08 * cardBias) {
          sendOff(`🟥 ${e.player} 퇴장! (심각한 반칙 — VAR 판독 후 확정)`);
          return;
        }
        const names = [...booked[side].keys()];
        // repeat-offender bias: a booked player keeps fouling sometimes —
        // reassign both name and id together so they never drift apart
        if (names.length && !booked[side].has(e.player) && Math.random() < 0.35) {
          e.player = names[Math.floor(Math.random() * names.length)];
          e.playerId = booked[side].get(e.player);
        }
        if (booked[side].has(e.player)) {
          sendOff(`🟥 ${e.player} 두 번째 경고 — 퇴장!`);
        } else {
          booked[side].set(e.player, e.playerId);
          e.text = `${e.player} 경고 (옐로카드)`;
        }
      });
  }

  // 작전타임 재시뮬: 이미 퇴장이 나온 상태로 남은 경기를 굴릴 때의 수적 열세
  const sentOff = opts.sentOff || { home: 0, away: 0 };
  const xgHomeAdj =
    xgHome * redAdj.home * Math.pow(0.7, sentOff.home) * Math.pow(1.2, sentOff.away);
  const xgAwayAdj =
    xgAway * redAdj.away * Math.pow(0.7, sentOff.away) * Math.pow(1.2, sentOff.home);

  const goalsHome = poisson(xgHomeAdj * frac);
  const goalsAway = poisson(xgAwayAdj * frac);

  // A dismissed player can't be picked as scorer/assist/etc. for any event
  // at or after their sending-off minute — they've left the pitch.
  const excludeAt = (side, minute) => {
    const d = dismissed[side];
    return d && minute >= d.minute ? d.id : null;
  };

  // 실제 EPL 기준 전체 득점의 2~3% 정도가 자책골이다.
  const OWN_GOAL_RATE = 0.025;
  const addGoals = (count, side, ratings, oppSide, oppRatings) => {
    // corner share scales with the team's aerial strength (tallest-3 outfield
    // avg vs a ~186cm baseline, ±1%/cm) so tall/physical XIs actually convert
    // more corners, clamped to a realistic 5-16% band around the ~10% base —
    // this models "share of goals originating from a corner", not the much
    // lower raw corner-to-shot conversion rate (a different, smaller stat).
    const cornerShare = clamp(0.1 * (1 + (aerialStrength(ratings) - AERIAL_BASELINE_CM) / 100), 0.05, 0.16);
    uniqueMinutes(count, fromMinute + 1).forEach((minute) => {
      // set-piece share tuned to EPL rates: ~12% of goals are penalties,
      // ~6% direct free kicks; the rest are worked through open play
      const r = Math.random();
      const via = r < 0.12 ? 'penalty' : r < 0.18 ? 'freekick' : r < 0.18 + cornerShare ? 'corner' : null;
      const excludeId = excludeAt(side, minute);

      // 오프사이드(VAR 취소) — 페널티킥은 오프사이드 규정 대상이 아니고,
      // 코너킥도 IFAB 규정상 코너킥으로 직접 득점 시 오프사이드가 성립하지
      // 않는다. isOffsideRun은 위에서 정의한, 라인 높이(전술) + 관련
      // 능력치(수비 DEF ↔ 공격 ATT) 기반의 실제 판정 — 이 골 시도 자체가
      // "그 순간 마지막 수비수보다 앞서 있었는가"로 취소되는 것이지, 이
      // 시도와 무관한 별도 확률이 아니다. 취소되면 이 골은 스코어에 전혀
      // 반영되지 않고(아래 return으로 이번 시도 전체를 여기서 끝냄) 'goal'이
      // 아닌 'disallowed' 이벤트만 남는다.
      const defTactic = side === 'home' ? tacAway : tacHome;
      const atkTactic = side === 'home' ? tacHome : tacAway;
      if (via !== 'penalty' && via !== 'corner' && isOffsideRun(atkTactic, defTactic, ratings, oppRatings)) {
        const scorer = scorerFor(ratings, excludeId);
        events.push({
          minute,
          type: 'disallowed',
          team: side,
          player: scorer.name,
          playerId: scorer.id,
          assist: null,
          assistId: null,
          via: null,
          text: `${scorer.name}의 골... VAR 판독 결과 오프사이드 — 득점 취소!`,
        });
        return;
      }

      // 자책골: 페널티는 대상에서 제외(키커가 직접 넣는 상황이라 자책골이
      // 나올 수 없다). 득점은 side(수혜팀) 스코어보드에 그대로 붙지만,
      // playerId는 일부러 비워서(스탯 집계는 store.bumpPlayerStat이
      // playerId가 없으면 스킵) 상대 수비수 개인 득점 기록으로 잡히지
      //않게 한다 — 실제 자책골도 득점자 개인 기록에는 안 들어간다.
      // 상대 진영/스프라이트 매칭용으로 ownGoalPlayerId는 따로 둔다.
      if (via !== 'penalty' && oppRatings && Math.random() < OWN_GOAL_RATE) {
        const oppExcludeId = excludeAt(oppSide, minute);
        const defenders = oppRatings.roster.filter(
          (r2) => r2.slotLine === 'DEF' && r2.player.id !== oppExcludeId
        );
        const pool = defenders.length
          ? defenders
          : oppRatings.roster.filter((r2) => r2.slotLine !== 'GK' && r2.player.id !== oppExcludeId);
        if (pool.length) {
          const culprit = pool[Math.floor(Math.random() * pool.length)].player;
          events.push({
            minute,
            type: 'goal',
            team: side,
            ownGoal: true,
            player: culprit.name,
            playerId: null,
            ownGoalPlayerId: culprit.id,
            ownGoalTeam: oppSide,
            assist: null,
            assistId: null,
            via: null,
          });
          return;
        }
      }

      const scorer = scorerFor(ratings, excludeId, { aerial: via === 'corner' });
      // penalties are one-on-one — no assist; corners are always credited to
      // whoever delivered the ball in; open play/free kicks usually do (~75%)
      const assist =
        via === 'penalty'
          ? null
          : via === 'corner' || Math.random() < 0.75
          ? assistFor(ratings, scorer.id, excludeId)
          : null;
      events.push({
        minute,
        type: 'goal',
        team: side,
        player: scorer.name,
        playerId: scorer.id,
        assist: assist ? assist.name : null,
        assistId: assist ? assist.id : null,
        via,
      });
    });
  };
  addGoals(goalsHome, 'home', home, 'away', away);
  addGoals(goalsAway, 'away', away, 'home', home);
  // 오프사이드(VAR 취소)는 이제 addGoals 안에서 골 시도 하나하나에 대해
  // isOffsideRun으로 직접 판정된다(위 addGoals 내부 주석 참고) — 예전엔
  // 여기 별도의 addOffsides(xG 비례 고정 확률)가 실제 골 시도와 무관하게
  // "취소된 골" 이벤트를 얹었는데, 그게 정확히 사용자가 지적한 "랜덤 오프
  // 사이드"였다. goalsHome/goalsAway 중 몇 개가 실제로 오프사이드로
  // 취소됐는지는 이 시점에 알 수 없으므로(콜백 내부에서 결정됨), 최종
  // 스코어는 더 이상 goalsHome/goalsAway를 그대로 쓰지 않고 아래 timeline
  // 순회에서 실제로 집계된 sh/sa를 쓴다.

  events.sort((a, b) => a.minute - b.minute || (a.type === 'goal' ? -1 : 1));

  // Running score annotations (continue from the base score when
  // re-simulating a remainder).
  let sh = base.home;
  let sa = base.away;
  const timeline = events.map((e) => {
    if (e.type === 'goal') {
      if (e.team === 'home') sh++;
      else sa++;
    }
    let text = e.text;
    if (e.type === 'goal') {
      const scorerTeam = e.team === 'home' ? homeName : awayName;
      if (e.ownGoal) {
        text = `⚽ 자책골! ${e.player} — 본인 골문에 공을 넣고 맙니다 (${scorerTeam} 득점)`;
      } else {
        const suffix =
          e.via === 'penalty' ? ' (페널티킥)' : e.via === 'freekick' ? ' (프리킥)' : e.via === 'corner' ? ' (코너킥)' : '';
        const assistText = e.assist ? ` (어시스트: ${e.assist})` : '';
        text = `⚽ ${e.player} 골!${suffix}${assistText} (${scorerTeam})`;
      }
    }
    return {
      minute: e.minute,
      type: e.type,
      team: e.team,
      player: e.player,
      playerId: e.playerId || null,
      assist: e.assist || null,
      assistId: e.assistId || null,
      via: e.via || null,
      red: e.red || null, // 경고 누적 퇴장
      severity: e.severity || null,
      ownGoal: e.ownGoal || null,
      ownGoalPlayerId: e.ownGoalPlayerId || null,
      ownGoalTeam: e.ownGoalTeam || null,
      awardedTeam: e.awardedTeam || null,
      text,
      score: { home: sh, away: sa },
    };
  });

  return {
    ratings: { home, away },
    tactics: { home: tacHome, away: tacAway },
    possession: { home: Math.round(possHome * 100), away: Math.round(possAway * 100) },
    xg: { home: Number(xgHomeAdj.toFixed(2)), away: Number(xgAwayAdj.toFixed(2)) },
    // sh/sa(위 timeline 순회에서 실제 'goal' 이벤트만 센 값)를 최종 스코어로
    // 쓴다 — base.home + goalsHome처럼 Poisson으로 뽑힌 "시도 횟수"를 그대로
    // 쓰면 addGoals 안에서 오프사이드로 취소된 시도까지 득점으로 잡혀
    // 스코어보드와 타임라인이 서로 어긋난다.
    score: { home: sh, away: sa },
    timeline,
  };
}

// Re-simulate the rest of a running match after a live squad change.
// opts.sentOff carries reds that already happened (수적 열세 유지).
function simulateRemainder(homeSquad, awaySquad, fromMinute, baseScore, homeName, awayName, opts = {}) {
  return simulateMatch(homeSquad, awaySquad, homeName, awayName, { ...opts, fromMinute, baseScore });
}

module.exports = { computeRatings, simulateMatch, simulateRemainder, TACTICS, ROLE_DEFS };
