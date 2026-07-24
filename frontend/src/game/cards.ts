// Pure card/squad helpers shared across the squad, market, and picker UI —
// mirrors the equivalently-named functions in frontend/app.js exactly.
import type { CatalogPlayer, PlayerAttrs, Ratings, Squad, User } from '../types';
import type { SquadMode } from '../store/useAppStore';

export function activeSquad(me: User, squadMode: SquadMode): Squad {
  return squadMode === 'pvp' ? me.pvpSquad : me.squad;
}

export function activeRatings(me: User, squadMode: SquadMode): Ratings {
  return squadMode === 'pvp' ? me.pvpRatings : me.ratings;
}

export function activePoolIds(me: User, squadMode: SquadMode): string[] {
  return squadMode === 'pvp' ? me.drawn.filter((id) => me.owned.includes(id)) : me.owned;
}

export function upLevel(me: User, id: string): number {
  return me.upgrades?.[id] || 0;
}

// Ultra 등급 진화 여부 — backend/data/players.js의 ULTRA_BONUS/ULTRA_COST와
// 짝을 이루는 프론트 상수. +5 강화 위에 얹는 고정 보너스라 서버와 반드시
// 같은 값을 써야 한다(어긋나면 서버 계산 OVR과 프론트 표시가 갈린다).
export const ULTRA_BONUS = 2;
export const ULTRA_COST = 3000;

export function isUltra(me: User, id: string): boolean {
  return me.ultra?.includes(id) || false;
}

// Owned card with the user's 강화(+Ultra 진화) applied: +1 OVR/능력치 per
// level, plus ULTRA_BONUS on top when evolved (mirrors the server's
// players.upgraded).
export function upgradedCard(me: User, p: CatalogPlayer | undefined): CatalogPlayer | undefined {
  if (!p) return p;
  const lvl = upLevel(me, p.id);
  const ultra = isUltra(me, p.id);
  const bonus = lvl + (ultra ? ULTRA_BONUS : 0);
  if (!bonus) return p;
  const attrs = p.attrs
    ? (Object.fromEntries(
        Object.entries(p.attrs).map(([k, v]) => [k, Math.min(99, v + bonus)])
      ) as unknown as PlayerAttrs)
    : undefined;
  return { ...p, ovr: Math.min(99, p.ovr + bonus), attrs, up: lvl, ultra };
}

// backend/data/players.js의 priceFor와 완전히 동일한 곡선 — Ultra 진화
// 카드처럼 getPrice(id)가 null(뽑기로 얻은 비-시장 카드 등)일 때 판매가를
// 표시하기 위한 대체 기준가로 쓴다(서버 ultraSellBase와 반드시 일치해야
// 화면에 보여준 금액과 실제 판매 결과가 어긋나지 않는다).
export function priceForOvr(ovr: number): number {
  return Math.round(Math.pow(Math.max(0, ovr - 60), 2.35) * 0.9) + 40;
}

// backend/index.js의 SELL_RATE와 동일한 값 — 판매가 미리보기 표시용.
export const SELL_RATE = 0.55;

// 판매 버튼에 보여줄 예상 금액. 실적(득점/어시스트) 보너스는 그 카드의
// playerStats가 없으면 알 수 없어 미리보기에서는 뺀다(실제 판매 시
// 서버가 재계산해 정확한 금액을 돌려준다 — 기존에도 그랬다). Ultra
// 진화 카드는 가격이 없는 경우가 흔해 priceForOvr로 대체 기준가를
// 만들고, 요청대로 +2000을 더한다.
export function sellPreview(p: CatalogPlayer): number {
  const base = p.price || priceForOvr(p.ovr);
  const amount = Math.round(base * SELL_RATE);
  return p.ultra ? amount + 2000 : amount;
}

export function tierOf(p: CatalogPlayer): string {
  if (p.ultra) return 'tier-ultra';
  if (p.enhanced) return 'tier-special';
  if (p.ovr >= 83) return 'tier-gold';
  if (p.ovr >= 75) return 'tier-silver';
  return 'tier-bronze';
}

export type Line = 'GK' | 'DEF' | 'MID' | 'ATT';

// PickerModal의 GK 필터링(GK 슬롯엔 GK만)에만 쓰인다 — 그 외의 포지션
// 적합도/OVR 페널티는 game/bands.ts의 밴드(몇 선인지) 기준으로 판정한다.
export function slotLineOf(pos: string): Line {
  if (pos === 'GK') return 'GK';
  if (['CB', 'LB', 'RB', 'LWB', 'RWB'].includes(pos)) return 'DEF';
  if (['CDM', 'CM', 'CAM', 'LM', 'RM'].includes(pos)) return 'MID';
  return 'ATT';
}
