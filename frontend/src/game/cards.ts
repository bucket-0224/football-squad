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

// Owned card with the user's 강화 applied: +1 OVR and +1 per attribute per
// level (mirrors the server's players.upgraded).
export function upgradedCard(me: User, p: CatalogPlayer | undefined): CatalogPlayer | undefined {
  if (!p) return p;
  const lvl = upLevel(me, p.id);
  if (!lvl) return p;
  const attrs = p.attrs
    ? (Object.fromEntries(
        Object.entries(p.attrs).map(([k, v]) => [k, Math.min(99, v + lvl)])
      ) as unknown as PlayerAttrs)
    : undefined;
  return { ...p, ovr: Math.min(99, p.ovr + lvl), attrs, up: lvl };
}

export function tierOf(p: CatalogPlayer): string {
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
