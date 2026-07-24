// 자유 배치(포지션 드래그) 도입 이후, 카드의 OVR 적합도는 더 이상 포메이션이
// 정해준 슬롯 라벨(예: "이 슬롯은 RB다")이 아니라 실제로 피치 위 어디에 놓였는지
// (몇 "선"인지)로 판정한다. 5선 체계 — 5선은 골키퍼 전용이다. 골키퍼 슬롯 자체는
// SquadTab에서 드래그가 막혀 있어 실제로 5선에 서는 건 항상 GK뿐이지만, 판정
// 공식 자체는 GK를 특별 취급하지 않고 다른 포지션과 동일하게 "홈 밴드까지의
// 거리"로 계산한다(아래 bandPenalty 주석 참고).
//
//   1선(최전방): LW, ST, CF, RW
//   2선(공격형 미드필드): LW, RW, LM, RM, CAM, CM
//   3선(수비형 미드필드): CDM, LWB, RWB, CM
//   4선(수비진): LB, CB, RB
//
// 측면 공격수(LW/RW)는 1·2선 모두, 중앙 미드필더(CM)는 2·3선 모두에서 위화감
// 없이 뛸 수 있다고 보고 두 밴드 모두 "적합"으로 처리한다 — 실제 축구에서도
// 윙어와 중앙 미드필더는 그 정도 폭으로 자리를 잡기 때문.
export type Band = 1 | 2 | 3 | 4 | 5;

const BAND_POSITIONS: Record<Band, string[]> = {
  1: ['LW', 'RW', 'ST', 'CF'],
  2: ['LW', 'RW', 'LM', 'RM', 'CAM', 'CM'],
  3: ['CDM', 'LWB', 'RWB', 'CM'],
  4: ['LB', 'CB', 'RB'],
  5: ['GK'],
};

export const BAND_LABEL: Record<Band, string> = {
  1: '1선',
  2: '2선',
  3: '3선',
  4: '4선',
  5: '5선',
};

// y%(피치 style의 bottom 기준, 0=자기 진영 골문 쪽 ~ 100=상대 골문 쪽)를
// 5개 밴드로 나눈다. 경계값은 각 포메이션 프리셋 좌표의 실측 분포에서 뽑았다.
export function bandOfY(y: number): Band {
  if (y < 10) return 5;
  if (y < 30) return 4;
  if (y < 50) return 3;
  if (y < 68) return 2;
  return 1;
}

function homeBands(pos: string): Band[] {
  const homes = ([1, 2, 3, 4, 5] as const).filter((b) => BAND_POSITIONS[b].includes(pos));
  return homes.length ? homes : [3]; // 알 수 없는 포지션 코드는 중간대로 취급(안전장치)
}

// 밴드 사이 거리 기반 페널티 — 0(그 밴드에 맞음) · 6(한 칸 차이) · 10(두 칸) · 14(그 이상).
// GK를 특별 취급하지 않는다 — GK의 홈 밴드는 5뿐이라 이 공식만으로 이미
// 정확히 처리된다. 예전엔 "band===5면 무조건 0"으로 예외 처리했는데, 그러면
// 골키퍼가 아닌 선수를 5선(y<10) 깊숙이 끌어놔도 페널티가 전혀 안 붙는 버그가
// 있었다 — 골키퍼 슬롯 자체는 어차피 드래그로 못 옮기니 5선에 실제로 서는
// 건 항상 GK뿐이고, 다른 포지션이 거기 놓이면 정상적으로 큰 페널티가 붙어야 한다.
export function bandPenalty(pos: string, band: Band): number {
  const dist = Math.min(...homeBands(pos).map((h) => Math.abs(h - band)));
  if (dist <= 0) return 0;
  if (dist === 1) return 6;
  if (dist === 2) return 10;
  return 14;
}

export function fitByBand(pos: string, band: Band): [string, string] {
  const pen = bandPenalty(pos, band);
  if (pen === 0) return ['fit-good', '적합'];
  if (pen <= 6) return ['fit-ok', '보통'];
  return ['fit-bad', '부적합'];
}

// 밴드에 맞지 않으면 OVR만 깎는다 — 기존 convertedCard와 달리 카드의 포지션
// 표기(pos)는 슬롯 라벨로 바꿔치지 않고 선수 본인의 실제 포지션 그대로 둔다.
export function convertedCardByBand<T extends { pos: string; ovr: number }>(p: T, band: Band): T {
  const pen = bandPenalty(p.pos, band);
  if (!pen) return p;
  return { ...p, ovr: Math.max(30, p.ovr - pen) };
}
