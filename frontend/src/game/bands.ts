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

// 밴드(y) 안에서도 가로(x) 어디인지로 구체적인 포지션 라벨을 정한다 — 카드에
// 표시되는 "지금 이 자리가 실제로 무슨 포지션인지"용이며, 적합도/OVR 페널티
// 계산(bandPenalty, 선수 본인의 실제 포지션 기준)과는 완전히 별개다.
//
// 좌/우 끝(farLeft·farRight)은 윙어·풀백처럼 완전히 폭이 넓은 자리(LM/RM,
// LB/RB, LWB/RWB, LW/RW)로 분리하고, 그보다 안쪽(left·right)은 "중앙에
// 두 명이 나란히 서는" 자리(LCM/RCM, LCB/RCB, LDM/RDM, LST/RST)로 잡는다.
// 정중앙(center)은 그 라인에 한 명만 있을 때의 자리(CM 계열은 CAM, 나머지는
// 각 라인의 기본형)다. 실제 포메이션 좌표(예: 4-3-3의 CM 3명 = 72/50/28,
// 4-3-3의 CB 2명 = 63/37)를 기준으로 경계값을 잡아, 프리셋을 그대로 두면
// 항상 "LCM · CM · RCM"처럼 자연스러운 조합이 나오도록 확인했다.
type Zone = 'farLeft' | 'left' | 'center' | 'right' | 'farRight';

const ZONE_LABEL: Record<1 | 2 | 3 | 4, Record<Zone, string>> = {
  1: { farLeft: 'LW', left: 'LST', center: 'ST', right: 'RST', farRight: 'RW' },
  2: { farLeft: 'LM', left: 'LCM', center: 'CAM', right: 'RCM', farRight: 'RM' },
  3: { farLeft: 'LWB', left: 'LDM', center: 'CDM', right: 'RDM', farRight: 'RWB' },
  4: { farLeft: 'LB', left: 'LCB', center: 'CB', right: 'RCB', farRight: 'RB' },
};

function xZone(x: number): Zone {
  if (x < 25) return 'farLeft';
  if (x < 45) return 'left';
  if (x < 55) return 'center';
  if (x < 75) return 'right';
  return 'farRight';
}

export function slotPositionLabel(x: number, y: number): string {
  const band = bandOfY(y);
  if (band === 5) return 'GK';
  return ZONE_LABEL[band][xZone(x)];
}

// 카드에 실제로 보여줄 형태를 만든다 — 포지션 라벨은 지금 놓인 자리(x,y)를
// 그대로 반영하고, OVR은 선수 본인의 실제 포지션이 그 라인에 맞는지에 따라
// 깎인다(맞으면 그대로). 즉 라벨은 "여기 서면 무슨 포지션"이고 OVR은 "이
// 선수가 거기 서면 실력이 얼마나 나오는지" — 서로 다른 걸 나타낸다.
export function convertedCardByBand<T extends { pos: string; ovr: number }>(p: T, x: number, y: number): T {
  const band = bandOfY(y);
  const pen = bandPenalty(p.pos, band);
  return { ...p, pos: slotPositionLabel(x, y), ovr: pen ? Math.max(30, p.ovr - pen) : p.ovr };
}

// 요청: "RB면 RB에 국한되어서 플레이스타일을 지정할 수 있어야해" — 유형
// 궁합을 판정할 "지금 이 자리"는 카드에 실제로 찍히는 라벨과 같은 기준
// (좌표 기반 slotPositionLabel)이어야 사용자가 보는 것과 어긋나지 않는다.
// GK는 드래그가 막혀 있으니 좌표 계산 없이 선수 본인의 pos를 그대로 쓴다.
export function placedLabelFor(p: { pos: string }, coord: [number, number] | undefined): string {
  return p.pos === 'GK' || !coord ? p.pos : slotPositionLabel(coord[0], coord[1]);
}

// slotPositionLabel은 같은 라인에 여러 명이 나란히 설 때 카드 표시용으로
// LCB/RCB, LDM/RDM, LCM/RCM, LST/RST처럼 더 세분화된 라벨을 준다(위 ZONE_LABEL
// 주석 참고) — 하지만 ROLE_DEFS의 pos 목록은 이런 좌우 구분 없이 CB/CDM/CM/ST
// 같은 기본형만 쓴다(넓은 자리인 LW/RW/LB/RB/LM/RM/LWB/RWB는 원래도 좌우
// 구분이 그대로 유형 목록과 일치한다). 유형 궁합을 볼 땐 이 기본형으로
// 정규화해야 "LCB에 서 있는 선수도 CB 유형을 고를 수 있다"가 성립한다.
const ROLE_LOOKUP_LABEL: Record<string, string> = {
  LST: 'ST', RST: 'ST',
  LCM: 'CM', RCM: 'CM',
  LDM: 'CDM', RDM: 'CDM',
  LCB: 'CB', RCB: 'CB',
};

export function roleLookupLabel(label: string): string {
  return ROLE_LOOKUP_LABEL[label] || label;
}

// 요청: "배치가 된 순간부터는 그 포지션에 플레이스타일 중 기본이 선택되어야"
// — 배치(스왑/드래그/좌표 이동 등)가 바뀔 때마다 호출해서, 지금 서 있는
// 자리에서 더 이상 유효하지 않은(= roles[..].pos에 이 라벨이 없는) 유형만
// 그 자리의 기본 유형으로 되돌린다. 여전히 유효한 선수의 커스텀 선택은
// 그대로 둔다 — 매번 전부 초기화하면 무관한 선수의 선택까지 날아가버린다.
export function resetInvalidRoles(
  starters: (string | null)[],
  coords: [number, number][],
  catalog: Map<string, { pos: string }>,
  prevRoles: Record<string, string>,
  rolesCatalog: Record<string, { pos: string[]; isDefault?: boolean }>
): Record<string, string> {
  const next = { ...prevRoles };
  starters.forEach((id, i) => {
    if (!id) return;
    const p = catalog.get(id);
    if (!p) return;
    const label = roleLookupLabel(placedLabelFor(p, coords[i]));
    const cur = next[id];
    const curValid = !!cur && !!rolesCatalog[cur] && rolesCatalog[cur].pos.includes(label);
    if (curValid) return;
    const def = Object.entries(rolesCatalog).find(([, r]) => r.isDefault && r.pos.includes(label));
    if (def) next[id] = def[0];
    else delete next[id];
  });
  return next;
}
