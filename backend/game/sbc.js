'use strict';

// 스쿼드 빌딩 챌린지(SBC): 보유 카드를 "소모하지 않고" 조건에 맞는 11명을
// 임시로 배치해 제출하면 보상을 준다 — 실제 메인/실전 스쿼드는 건드리지
// 않는다. 하루 3개, 별도 로테이션 크론 없이 날짜 문자열을 시드로 결정적
// 선택(모든 유저가 같은 날 같은 3개를 보되 완료 여부는 유저별로 갈림) —
// 완료 키가 `${dateKey}:${templateId}`라 자정이 지나면 자연히 새 챌린지가
// 된다(backend/store.js normalizeUser의 user.sbc.completed 참고).

const players = require('../data/players');
const { LINE, FORMATIONS, DEFAULT_FORMATION } = require('./formations');

// 자유 포지션 편집 없이 단순 11슬롯 그리드로 보여주기 위해 포메이션을
// 하나로 고정한다(기본 포메이션과 동일한 4-3-3).
const SBC_FORMATION = DEFAULT_FORMATION;
const SBC_SLOTS = FORMATIONS[SBC_FORMATION];

function resolvePlayer(user, id) {
  const p = players.getPlayer(id);
  if (!p) return null;
  const ultra = !!(user.ultra || []).includes(id);
  const level = (user.upgrades && user.upgrades[id]) || null;
  return level || ultra ? players.upgraded(p, level, ultra) : p;
}

function leagueOf(p) {
  const t = p.team && players.TEAMS[p.team];
  return (t && t.league) || null;
}

function countBy(items, keyFn) {
  const counts = new Map();
  items.forEach((it) => {
    const k = keyFn(it);
    if (k == null) return;
    counts.set(k, (counts.get(k) || 0) + 1);
  });
  return counts;
}

function maxCount(counts) {
  let max = 0;
  counts.forEach((v) => {
    if (v > max) max = v;
  });
  return max;
}

function lineAvgCheck(ps, line, threshold, cmp) {
  const inLine = ps.filter((p) => LINE[p.slotPos] === line);
  if (!inLine.length) return { ok: false, detail: '해당 라인에 배치된 선수 없음' };
  const avg = inLine.reduce((s, p) => s + p.ovr, 0) / inLine.length;
  return { ok: cmp(avg, threshold), detail: `현재 평균 ${avg.toFixed(1)}` };
}

// 요구조건 fn(resolvedPlayers: {..player, slotPos}[]) -> {ok, detail}
const CHALLENGE_TEMPLATES = [
  {
    id: 'sameLeague4',
    label: '리그 올스타',
    desc: '같은 리그 소속 선수 4명 이상',
    reward: { coins: 220 },
    check: (ps) => {
      const n = maxCount(countBy(ps, leagueOf));
      return { ok: n >= 4, detail: `현재 ${n}/4명` };
    },
  },
  {
    id: 'sameTeam3',
    label: '원클럽맨',
    desc: '같은 클럽 소속 선수 3명 이상',
    reward: { coins: 220 },
    check: (ps) => {
      const n = maxCount(countBy(ps, (p) => p.team));
      return { ok: n >= 3, detail: `현재 ${n}/3명` };
    },
  },
  {
    id: 'sameNation4',
    label: '국가대표 라인업',
    desc: '같은 국적 선수 4명 이상',
    reward: { coins: 220 },
    check: (ps) => {
      const n = maxCount(countBy(ps, (p) => p.nation));
      return { ok: n >= 4, detail: `현재 ${n}/4명` };
    },
  },
  {
    id: 'avgOvr82',
    label: '평균 OVR 82+',
    desc: '11명 평균 OVR 82 이상',
    reward: { coins: 320 },
    check: (ps) => {
      const avg = ps.reduce((s, p) => s + p.ovr, 0) / ps.length;
      return { ok: avg >= 82, detail: `현재 평균 ${avg.toFixed(1)}` };
    },
  },
  {
    id: 'avgOvrUnder75',
    label: '저비용 스쿼드',
    desc: '11명 평균 OVR 75 이하 (활용도 낮은 카드 재활용)',
    reward: { coins: 260 },
    check: (ps) => {
      const avg = ps.reduce((s, p) => s + p.ovr, 0) / ps.length;
      return { ok: avg <= 75, detail: `현재 평균 ${avg.toFixed(1)}` };
    },
  },
  {
    id: 'attLine84',
    label: '공격 라인 강화',
    desc: '공격 라인(ST/WG 등) 평균 OVR 84 이상',
    reward: { coins: 260 },
    check: (ps) => lineAvgCheck(ps, 'ATT', 84, (a, t) => a >= t),
  },
  {
    id: 'defLine82',
    label: '수비 라인 강화',
    desc: '수비 라인(CB/SB 등) 평균 OVR 82 이상',
    reward: { coins: 260 },
    check: (ps) => lineAvgCheck(ps, 'DEF', 82, (a, t) => a >= t),
  },
];

// 문자열 해시 -> 시드 정수 (날짜 문자열을 결정적으로 3개 인덱스로 매핑).
function hashSeed(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) >>> 0;
  return h;
}

function todaysChallenges(dateKey) {
  const n = CHALLENGE_TEMPLATES.length;
  const count = Math.min(3, n);
  const used = new Set();
  let x = hashSeed(dateKey) || 1;
  while (used.size < count) {
    x = (x * 1103515245 + 12345) >>> 0;
    used.add(x % n);
  }
  return [...used].map((idx) => {
    const t = CHALLENGE_TEMPLATES[idx];
    return { id: `${dateKey}:${t.id}`, templateId: t.id, label: t.label, desc: t.desc, reward: t.reward };
  });
}

function findTemplate(templateId) {
  return CHALLENGE_TEMPLATES.find((t) => t.id === templateId) || null;
}

// user: 소유권/강화 반영에 필요. starters: 11개 playerId(빈 슬롯 불가, 중복 불가).
// 서버가 최종 검증하는 지점이라 클라이언트 미리보기와 별개로 여기서 다시
// 소유권부터 확인한다.
function evaluate(user, templateId, starters) {
  const template = findTemplate(templateId);
  if (!template) return { ok: false, error: '존재하지 않는 챌린지입니다.' };
  if (!Array.isArray(starters) || starters.length !== 11 || starters.some((id) => !id)) {
    return { ok: false, error: '11명을 모두 배치해야 합니다.' };
  }
  const owned = new Set(user.owned || []);
  const seen = new Set();
  const resolved = [];
  for (let i = 0; i < 11; i++) {
    const id = starters[i];
    if (!owned.has(id)) return { ok: false, error: '보유하지 않은 선수가 포함되어 있습니다.' };
    if (seen.has(id)) return { ok: false, error: '같은 선수를 두 슬롯에 배치할 수 없습니다.' };
    seen.add(id);
    const p = resolvePlayer(user, id);
    if (!p) return { ok: false, error: '선수 정보를 찾을 수 없습니다.' };
    resolved.push({ ...p, slotPos: SBC_SLOTS[i] });
  }
  const { ok, detail } = template.check(resolved);
  return { ok, detail, template };
}

module.exports = {
  SBC_FORMATION,
  SBC_SLOTS,
  CHALLENGE_TEMPLATES,
  todaysChallenges,
  findTemplate,
  evaluate,
};
