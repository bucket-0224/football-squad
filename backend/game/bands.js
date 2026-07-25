'use strict';

// frontend/src/game/bands.ts와 frontend/src/game/formationCoords.ts의 백엔드
// 포트 — "시뮬레이션에서 스쿼드에서 배치된 포메이션 위주로 플레이되게 해줘"
// 요청에 따라, 시뮬레이션(computeRatings)도 프론트가 화면에 보여주는 것과
// 정확히 같은 좌표 기반 포지션 판정을 쓰도록 두 파일의 로직을 그대로
// 옮겼다 — 원본이 바뀌면 이 파일도 같이 맞춰야 한다.

// Slot coordinates per formation: [x%, y% from bottom]. frontend와 index가
// FORMATIONS[name][i]에 맞춰 동일해야 한다.
const COORDS = {
  '4-3-3': [[50, 4], [84, 22], [63, 17], [37, 17], [16, 22], [72, 46], [50, 42], [28, 46], [80, 72], [50, 80], [20, 72]],
  '4-4-2': [[50, 4], [84, 22], [63, 17], [37, 17], [16, 22], [84, 50], [62, 46], [38, 46], [16, 50], [62, 78], [38, 78]],
  '4-2-3-1': [[50, 4], [84, 22], [63, 17], [37, 17], [16, 22], [62, 38], [38, 38], [50, 58], [82, 64], [50, 82], [18, 64]],
  '3-5-2': [[50, 4], [72, 18], [50, 15], [28, 18], [88, 46], [66, 48], [50, 36], [34, 48], [12, 46], [62, 78], [38, 78]],
  '4-1-4-1': [[50, 4], [84, 22], [63, 17], [37, 17], [16, 22], [50, 34], [84, 54], [62, 50], [38, 50], [16, 54], [50, 80]],
};

const BAND_POSITIONS = {
  1: ['LW', 'RW', 'ST', 'CF'],
  2: ['LW', 'RW', 'LM', 'RM', 'CAM', 'CM'],
  3: ['CDM', 'LWB', 'RWB', 'CM'],
  4: ['LB', 'CB', 'RB'],
  5: ['GK'],
};

function bandOfY(y) {
  if (y < 10) return 5;
  if (y < 30) return 4;
  if (y < 50) return 3;
  if (y < 68) return 2;
  return 1;
}

function homeBands(pos) {
  const homes = [1, 2, 3, 4, 5].filter((b) => BAND_POSITIONS[b].includes(pos));
  return homes.length ? homes : [3];
}

// 밴드 사이 거리 기반 페널티 — 0(그 밴드에 맞음) · 6(한 칸 차이) · 10(두 칸) · 14(그 이상).
function bandPenalty(pos, band) {
  const dist = Math.min(...homeBands(pos).map((h) => Math.abs(h - band)));
  if (dist <= 0) return 0;
  if (dist === 1) return 6;
  if (dist === 2) return 10;
  return 14;
}

const ZONE_LABEL = {
  1: { farLeft: 'LW', left: 'LST', center: 'ST', right: 'RST', farRight: 'RW' },
  2: { farLeft: 'LM', left: 'LCM', center: 'CAM', right: 'RCM', farRight: 'RM' },
  3: { farLeft: 'LWB', left: 'LDM', center: 'CDM', right: 'RDM', farRight: 'RWB' },
  4: { farLeft: 'LB', left: 'LCB', center: 'CB', right: 'RCB', farRight: 'RB' },
};

function xZone(x) {
  if (x < 25) return 'farLeft';
  if (x < 45) return 'left';
  if (x < 55) return 'center';
  if (x < 75) return 'right';
  return 'farRight';
}

function slotPositionLabel(x, y) {
  const band = bandOfY(y);
  if (band === 5) return 'GK';
  return ZONE_LABEL[band][xZone(x)];
}

// slotPositionLabel은 같은 라인에 여러 명이 나란히 설 때(LCB/RCB, LDM/RDM,
// LCM/RCM, LST/RST) 카드 표시용 세분화 라벨을 준다 — 하지만 ROLE_DEFS의
// pos 목록은 이런 좌우 구분 없이 CB/CDM/CM/ST 기본형만 쓴다. 유형 궁합을
// 볼 땐 이 기본형으로 정규화해야 한다(frontend bands.ts의 ROLE_LOOKUP_LABEL과
// 동일).
const ROLE_LOOKUP_LABEL = {
  LST: 'ST', RST: 'ST',
  LCM: 'CM', RCM: 'CM',
  LDM: 'CDM', RDM: 'CDM',
  LCB: 'CB', RCB: 'CB',
};

function roleLookupLabel(label) {
  return ROLE_LOOKUP_LABEL[label] || label;
}

// 슬롯 i의 실제 좌표 — 유저가 배치 편집으로 옮겼으면 그 좌표(slotCoords),
// 아니면 그 포메이션의 기본 좌표(COORDS)를 쓴다.
function coordFor(formation, slotCoords, i) {
  const custom = slotCoords && slotCoords[i];
  if (Array.isArray(custom) && custom.length === 2) return custom;
  const base = COORDS[formation] && COORDS[formation][i];
  return base || [50, 50];
}

module.exports = { COORDS, bandOfY, bandPenalty, slotPositionLabel, roleLookupLabel, coordFor };
