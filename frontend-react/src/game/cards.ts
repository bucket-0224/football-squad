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

export function slotLineOf(pos: string): Line {
  if (pos === 'GK') return 'GK';
  if (['CB', 'LB', 'RB', 'LWB', 'RWB'].includes(pos)) return 'DEF';
  if (['CDM', 'CM', 'CAM', 'LM', 'RM'].includes(pos)) return 'MID';
  return 'ATT';
}

// Out-of-position OVR penalty (mirrors the server): exact 0 · same line 2 ·
// adjacent line 6 · opposite line 10. The card converts to the slot position.
export function posPenalty(p: CatalogPlayer, slotPos: string): number {
  if (p.pos === slotPos) return 0;
  const a = p.line;
  const b = slotLineOf(slotPos);
  if (a === b) return 2;
  const adj =
    (a === 'DEF' && b === 'MID') ||
    (a === 'MID' && b === 'DEF') ||
    (a === 'MID' && b === 'ATT') ||
    (a === 'ATT' && b === 'MID');
  return adj ? 6 : 10;
}

export function convertedCard(p: CatalogPlayer, slotPos: string): CatalogPlayer {
  const pen = posPenalty(p, slotPos);
  if (!pen) return p;
  return { ...p, pos: slotPos, ovr: Math.max(30, p.ovr - pen) };
}

export function fitClass(playerLine: string, slotLine: string): [string, string] {
  if (playerLine === slotLine) return ['fit-good', '적합'];
  if (playerLine === 'GK' || slotLine === 'GK') return ['fit-bad', '부적합'];
  const adj =
    (playerLine === 'DEF' && slotLine === 'MID') ||
    (playerLine === 'MID' && slotLine === 'DEF') ||
    (playerLine === 'MID' && slotLine === 'ATT') ||
    (playerLine === 'ATT' && slotLine === 'MID');
  return adj ? ['fit-ok', '보통'] : ['fit-bad', '부적합'];
}
