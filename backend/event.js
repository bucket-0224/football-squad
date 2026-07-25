'use strict';

const store = require('./store');

// ---------------------------------------------------------------------------
// 시즌/기간 한정 이벤트. 요청: "열쇠를 이벤트 한정 아이템(26년 8월 7일까지
// 판매, 이후에는 상점에서 구매가 불가능하게 막아주고, 이런건 유동적으로
// 변경될 것으로 비활성화 시키기)" — 지금은 이벤트가 하나뿐이지만 나중에
// 다른 시즌 이벤트가 추가/교체될 걸 대비해 이벤트 하나를 통째로 이 객체로
// 표현한다. active를 false로 두면 endsAt과 무관하게 즉시 판매 중단(수동
// 킬 스위치), endsAt이 지나면 배포 없이 시간만 지나도 자동 만료된다.
//
// 그리드(열쇠로 여는 바둑판) 등급 구성은 5x5=25칸: SSS1·SS2·S3·A5·B7·C7.
const EVENTS = {
  summer2026: {
    id: 'summer2026',
    name: '서머 이벤트',
    active: true,
    endsAt: new Date('2026-08-07T23:59:59+09:00').getTime(),
    keyPrice: 500, // 코인
    grid: {
      rows: 5,
      cols: 5,
      grades: [
        'SSS',
        'SS', 'SS',
        'S', 'S', 'S',
        'A', 'A', 'A', 'A', 'A',
        'B', 'B', 'B', 'B', 'B', 'B', 'B',
        'C', 'C', 'C', 'C', 'C', 'C', 'C',
      ],
    },
  },
};

// 등급 -> 실제 보상. "프리미엄팩"은 카탈로그에 없는 이름이라 기존
// PACKS(backend/transfer.js)의 가장 가까운 등가물인 special(OVR 86+)에
// 대응시켰다 — "골드팩"/"아이콘 팩"은 기존 PACKS 키(gold/icon)와 이름이
// 그대로 일치한다.
const GRADE_REWARDS = {
  SSS: { packs: [{ id: 'icon', count: 5 }] },
  SS: { packs: [{ id: 'icon', count: 1 }] },
  S: { packs: [{ id: 'special', count: 1 }] },
  A: { packs: [{ id: 'gold', count: 1 }] },
  B: { coins: 1000 },
  C: { coins: 500 },
};

function isEventActive(ev) {
  return !!ev && ev.active && Date.now() < ev.endsAt;
}

function getEvent(eventId) {
  return EVENTS[eventId] || null;
}

// 부트스트랩에 실어 보낼 이벤트 목록 — active 여부와 무관하게 존재하는
// 이벤트는 그대로 노출하고(종료된 이벤트 배지 등은 프론트가 active로 판단),
// grid의 등급 배열 원본은 굳이 안 보낸다(칸 수/행렬만 필요).
function listEvents() {
  return Object.values(EVENTS).map((ev) => ({
    id: ev.id,
    name: ev.name,
    active: isEventActive(ev),
    endsAt: ev.endsAt,
    keyPrice: ev.keyPrice,
    rows: ev.grid.rows,
    cols: ev.grid.cols,
    cellCount: ev.grid.grades.length,
  }));
}

// 유저별 칸-등급 배치를 최초 접근 시 한 번만 섞어서 고정한다(Fisher-Yates)
// — user.eventGrid[eventId] = { layout: string[], opened: number[] }.
// 이후 재접속해도 같은 배치가 유지되고, 연 칸만 늘어난다.
function shuffledGrades(ev) {
  const layout = [...ev.grid.grades];
  for (let i = layout.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [layout[i], layout[j]] = [layout[j], layout[i]];
  }
  return layout;
}

function ensureLayout(user, ev) {
  if (!user.eventGrid || typeof user.eventGrid !== 'object') user.eventGrid = {};
  let state = user.eventGrid[ev.id];
  if (!state || !Array.isArray(state.layout) || state.layout.length !== ev.grid.grades.length) {
    state = { layout: shuffledGrades(ev), opened: [] };
    user.eventGrid[ev.id] = state;
  }
  return state;
}

// 프론트에 보여줄 그리드 상태 — 아직 안 연 칸은 등급을 숨긴다(grade:null).
function publicGrid(user, eventId) {
  const ev = getEvent(eventId);
  if (!ev) return null;
  const state = ensureLayout(user, ev);
  return {
    eventId: ev.id,
    cells: state.layout.map((grade, i) => ({
      index: i,
      opened: state.opened.includes(i),
      grade: state.opened.includes(i) ? grade : null,
    })),
    keys: (user.keys && user.keys[ev.id]) || 0,
  };
}

function buyKey(user, eventId, count) {
  const ev = getEvent(eventId);
  if (!isEventActive(ev)) return { error: '진행 중인 이벤트가 아닙니다.', status: 400 };
  const n = Math.max(1, Math.min(20, Math.floor(Number(count)) || 1));
  const cost = ev.keyPrice * n;
  if (user.coins < cost) {
    return { error: `코인이 부족합니다. (필요: ${cost}, 보유: ${user.coins})`, status: 400 };
  }
  user.coins -= cost;
  if (!user.keys || typeof user.keys !== 'object') user.keys = {};
  user.keys[eventId] = (user.keys[eventId] || 0) + n;
  store.putUser(user);
  return { keys: user.keys[eventId] };
}

// 칸 하나를 연다 — 열쇠 1개 소모, 보상은 즉시 지급하지 않고 우편함으로
// 보낸다(요청: "우편으로 주고, 우편으로 열면 바로 팝업이 떠서..."). 실제
// 팩 개봉(카드 뽑기)은 우편 claim 시점에 index.js가 처리한다.
function openCell(user, eventId, cellIndex, sendMailFn) {
  const ev = getEvent(eventId);
  if (!isEventActive(ev)) return { error: '진행 중인 이벤트가 아닙니다.', status: 400 };
  const state = ensureLayout(user, ev);
  const idx = Number(cellIndex);
  if (!Number.isInteger(idx) || idx < 0 || idx >= state.layout.length) {
    return { error: '잘못된 칸입니다.', status: 400 };
  }
  if (state.opened.includes(idx)) return { error: '이미 연 칸입니다.', status: 400 };
  const keys = (user.keys && user.keys[eventId]) || 0;
  if (keys < 1) return { error: '열쇠가 부족합니다.', status: 400 };

  user.keys[eventId] = keys - 1;
  state.opened.push(idx);
  const grade = state.layout[idx];
  const reward = GRADE_REWARDS[grade];
  const mail = sendMailFn(user, {
    coins: reward.coins || 0,
    message: `🔑 ${ev.name} — ${grade}급 보상`,
    packs: reward.packs || null,
  });

  // 요청: "SSS 보상이 뜨면 초기화가 자동으로 되게 해줘(바둑판이)" — SSS는
  // 그리드에 1칸뿐이라 누군가 뽑는 순간 나머지 칸은 다시 열 이유가 없어지므로,
  // 즉시 새로 섞어 전체 칸을 다시 가린다. 프론트가 안내 토스트를 띄울 수
  // 있도록 reset:true를 함께 내려준다.
  let reset = false;
  if (grade === 'SSS') {
    state.layout = shuffledGrades(ev);
    state.opened = [];
    reset = true;
  }

  store.putUser(user);
  return { grade, mail, reset, grid: publicGrid(user, eventId) };
}

module.exports = { EVENTS, GRADE_REWARDS, isEventActive, getEvent, listEvents, publicGrid, buyKey, openCell };
