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

  winger: { label: '기본(윙어)', pos: ['LW', 'RW'], isDefault: true, score: (a) => a.shooting * 0.4 + a.pace * 0.24 + a.dribbling * 0.26 + a.physical * 0.1 },
  invertedWinger: { label: '인버티드 윙어', pos: ['LW', 'RW'], score: (a) => a.shooting * 0.34 + a.passing * 0.26 + a.dribbling * 0.28 + a.pace * 0.12 },

  playmaker: { label: '기본(공격형 미드필더)', pos: ['CAM'], isDefault: true, score: (a) => a.passing * 0.33 + a.dribbling * 0.24 + a.physical * 0.18 + a.defending * 0.13 + a.pace * 0.12 },
  shadowStriker: { label: '섀도우 스트라이커', pos: ['CAM'], score: (a) => a.shooting * 0.32 + a.dribbling * 0.28 + a.pace * 0.22 + a.passing * 0.18 },

  box2box: { label: '기본(박스투박스)', pos: ['CM', 'LM', 'RM'], isDefault: true, score: (a) => a.passing * 0.33 + a.dribbling * 0.24 + a.physical * 0.18 + a.defending * 0.13 + a.pace * 0.12 },
  deepLyingPM: { label: '딥라잉 플레이메이커', pos: ['CM', 'LM', 'RM'], score: (a) => a.passing * 0.42 + a.dribbling * 0.2 + a.defending * 0.18 + a.pace * 0.1 + a.physical * 0.1 },

  anchor: { label: '기본(수비형 미드필더)', pos: ['CDM'], isDefault: true, score: (a) => a.passing * 0.33 + a.dribbling * 0.24 + a.physical * 0.18 + a.defending * 0.13 + a.pace * 0.12 },
  ballPlayingMid: { label: '볼 플레잉 미드필더', pos: ['CDM'], score: (a) => a.passing * 0.38 + a.dribbling * 0.22 + a.defending * 0.24 + a.pace * 0.16 },

  fullback: { label: '기본(풀백)', pos: ['LB', 'RB'], isDefault: true, score: (a) => a.defending * 0.5 + a.physical * 0.25 + a.pace * 0.15 + a.passing * 0.1 },
  wingback: { label: '윙백', pos: ['LB', 'RB', 'LWB', 'RWB'], score: (a) => a.pace * 0.3 + a.defending * 0.28 + a.physical * 0.24 + a.passing * 0.18 },
  invertedFullback: { label: '인버티드 풀백', pos: ['LB', 'RB'], score: (a) => a.defending * 0.36 + a.passing * 0.34 + a.physical * 0.16 + a.pace * 0.14 },

  stopper: { label: '기본(센터백)', pos: ['CB'], isDefault: true, score: (a) => a.defending * 0.5 + a.physical * 0.25 + a.pace * 0.15 + a.passing * 0.1 },
  ballPlayingCB: { label: '볼 플레잉 센터백', pos: ['CB'], score: (a) => a.defending * 0.4 + a.passing * 0.3 + a.physical * 0.18 + a.pace * 0.12 },
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
  winger: { shooting: 0.4, passing: 0 },
  invertedWinger: { shooting: 0.34, passing: 0.26 },
  playmaker: { shooting: 0, passing: 0.33 },
  shadowStriker: { shooting: 0.32, passing: 0.18 },
  box2box: { shooting: 0, passing: 0.33 },
  deepLyingPM: { shooting: 0, passing: 0.42 },
  anchor: { shooting: 0, passing: 0.33 },
  ballPlayingMid: { shooting: 0, passing: 0.38 },
  fullback: { shooting: 0, passing: 0.1 },
  wingback: { shooting: 0, passing: 0.18 },
  invertedFullback: { shooting: 0, passing: 0.34 },
  stopper: { shooting: 0, passing: 0.1 },
  ballPlayingCB: { shooting: 0, passing: 0.3 },
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
// squad.devotion (id -> 0..100) and squad.captain/viceCaptain feed a small
// per-player execution multiplier alongside position chemistry.
function computeRatings(squad) {
  const formation = FORMATIONS[squad.formation] ? squad.formation : DEFAULT_FORMATION;
  const slots = FORMATIONS[formation];
  const up = squad.upgrades || null;
  const devotionMap = squad.devotion || null;
  const captainId = squad.captain || null;
  const viceCaptainId = squad.viceCaptain || null;
  const roleMap = squad.roles || null;
  const lines = { GK: [], DEF: [], MID: [], ATT: [] };
  const roster = [];

  slots.forEach((slotPos, i) => {
    const id = squad.starters[i];
    let p = players.getPlayer(id);
    if (p && up && up[id]) p = players.upgraded(p, up[id]);
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

// --- match simulation ------------------------------------------------------

function scorerFor(ratings, excludeId) {
  const candidates = ratings.roster.filter((r) => r.slotLine !== 'GK' && r.player.id !== excludeId);
  const r = pickWeighted(candidates, (c) => {
    const lineW = c.slotLine === 'ATT' ? 3.2 : c.slotLine === 'MID' ? 1.4 : 0.35;
    // role nudge: a shooting-heavy role (e.g. poacher) scores more than a
    // passing-heavy one in the same line/position, on top of the existing
    // shooting+ovr baseline — clamped so a future role can't blow it up.
    const emphasis = ROLE_EMPHASIS[c.roleId];
    const roleShoot = Math.min(1.5, 1 + (emphasis ? emphasis.shooting : 0));
    return lineW * roleShoot * (c.player.attrs.shooting + c.player.ovr) / 2;
  });
  return r ? { id: r.player.id, name: r.player.name } : { id: null, name: '알 수 없는 선수' };
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
      events.push({ minute, type, team: side, player: who, playerId: whoId, text, via });
    });
  };
  addFlavor('home', home, away.GK, xgHome);
  addFlavor('away', away, home.GK, xgAway);

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
        // 절반 이상이 이 유형)
        if (Math.random() < 0.08) {
          sendOff(`🟥 ${e.player} 퇴장! (심각한 반칙)`);
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

  const addGoals = (count, side, ratings) => {
    uniqueMinutes(count, fromMinute + 1).forEach((minute) => {
      // set-piece share tuned to EPL rates: ~12% of goals are penalties,
      // ~6% direct free kicks; the rest are worked through open play
      const r = Math.random();
      const via = r < 0.12 ? 'penalty' : r < 0.18 ? 'freekick' : null;
      const excludeId = excludeAt(side, minute);
      const scorer = scorerFor(ratings, excludeId);
      // penalties are one-on-one — no assist; open play/free kicks usually
      // do (~75%), matching a Poisson-flavored "most goals are assisted" feel
      const assist =
        via !== 'penalty' && Math.random() < 0.75 ? assistFor(ratings, scorer.id, excludeId) : null;
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
  addGoals(goalsHome, 'home', home);
  addGoals(goalsAway, 'away', away);

  // 오프사이드(VAR 취소): 실제 스코어는 그대로 두고, 그 팀의 공격력(xG)에
  // 비례해 "취소된 득점"을 얹는다 — 이전엔 xG와 무관한 4% 고정 확률이라
  // 거의 공격을 못 한 팀에도 뜬금없이 취소골이 떴었다.
  const OFFSIDE_RATE = 0.18;
  const addOffsides = (xgVal, side, ratings) => {
    const usedMinutes = new Set(
      events.filter((e) => e.team === side && e.type === 'goal').map((e) => e.minute)
    );
    const n = poisson(xgVal * frac * OFFSIDE_RATE);
    uniqueMinutes(n, fromMinute + 1)
      .filter((m) => !usedMinutes.has(m))
      .forEach((minute) => {
        const scorer = scorerFor(ratings, excludeAt(side, minute));
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
      });
  };
  addOffsides(xgHomeAdj, 'home', home);
  addOffsides(xgAwayAdj, 'away', away);

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
      const suffix = e.via === 'penalty' ? ' (페널티킥)' : e.via === 'freekick' ? ' (프리킥)' : '';
      const assistText = e.assist ? ` (어시스트: ${e.assist})` : '';
      text = `⚽ ${e.player} 골!${suffix}${assistText} (${scorerTeam})`;
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
      text,
      score: { home: sh, away: sa },
    };
  });

  return {
    ratings: { home, away },
    tactics: { home: tacHome, away: tacAway },
    possession: { home: Math.round(possHome * 100), away: Math.round(possAway * 100) },
    xg: { home: Number(xgHomeAdj.toFixed(2)), away: Number(xgAwayAdj.toFixed(2)) },
    score: { home: base.home + goalsHome, away: base.away + goalsAway },
    timeline,
  };
}

// Re-simulate the rest of a running match after a live squad change.
// opts.sentOff carries reds that already happened (수적 열세 유지).
function simulateRemainder(homeSquad, awaySquad, fromMinute, baseScore, homeName, awayName, opts = {}) {
  return simulateMatch(homeSquad, awaySquad, homeName, awayName, { ...opts, fromMinute, baseScore });
}

module.exports = { computeRatings, simulateMatch, simulateRemainder, TACTICS, ROLE_DEFS };
