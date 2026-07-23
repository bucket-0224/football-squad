import type { Team } from '../types';

// Curated (pre-loaded) teams for a league, plus any dynamically-fetched real
// clubs not already in the curated list (dupes dropped by name).
export function teamsInLeague(leagueId: string, teams: Team[], leagueTeams: Team[] | null): Team[] {
  const curated = teams.filter((t) =>
    leagueId === 'national' ? t.type === 'national' : t.league === leagueId
  );
  if (leagueId === 'national') return curated;
  const known = new Set(teams.map((t) => t.name));
  const extra = (leagueTeams || [])
    .filter((t) => t.league === leagueId && !known.has(t.name))
    .map((t) => ({ ...t, type: 'club' as const, dyn: true }))
    .sort((a, b) => a.name.localeCompare(b.name));
  return [...curated, ...extra];
}
