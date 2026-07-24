// Shared API types. Grown incrementally as each tab is ported — only
// fields actually consumed so far are typed; expand alongside new features
// rather than speculatively modeling the whole backend up front.

export interface Ratings {
  formation: string;
  ATT: number;
  MID: number;
  DEF: number;
  GK: number;
  OVR: number;
  chemistry: number;
}

export interface Squad {
  formation: string;
  starters: (string | null)[];
  tactic: string;
  captain: string | null;
  viceCaptain: string | null;
  roles: Record<string, string>;
}

export interface MailItem {
  id: string;
  coins?: number;
  message?: string;
  createdAt: number;
  claimed: boolean;
}

export interface ComplaintChoice {
  id: string;
  label: string;
  costCoins: number;
}

export interface Complaint {
  id: string;
  playerId: string;
  createdAt: number;
  prompt: string;
  choices: ComplaintChoice[];
}

export interface TransferRequest {
  id: string;
  playerId: string;
  createdAt: number;
}

export interface User {
  id: string;
  username: string;
  avatarUrl?: string | null;
  clubName: string;
  baseTeam: string;
  coins: number;
  points: number;
  record: { w: number; d: number; l: number };
  owned: string[];
  drawn: string[];
  upgrades: Record<string, number>;
  playerStats: Record<string, { goals: number; assists: number }>;
  devotion: Record<string, number>;
  complaints: Complaint[];
  transferRequests: TransferRequest[];
  mailbox: MailItem[];
  squad: Squad;
  pvpSquad: Squad;
  ratings: Ratings;
  pvpRatings: Ratings;
}

export interface Team {
  name: string;
  type: 'club' | 'national';
  league?: string;
  ovr?: number;
  logo?: string | null;
  color?: string;
  dyn?: boolean;
}

export interface League {
  id: string;
  label: string;
}

export interface Role {
  label: string;
  pos: string[];
  isDefault?: boolean;
}

export interface PlayerAttrs {
  pace: number;
  shooting: number;
  passing: number;
  dribbling: number;
  defending: number;
  physical: number;
}

export interface CatalogPlayer {
  id: string;
  name: string;
  pos: string;
  line: 'GK' | 'DEF' | 'MID' | 'ATT';
  ovr: number;
  img: string | null;
  teamLogo?: string | null;
  team: string | null;
  flag?: string | null;
  price: number | null;
  enhanced?: boolean;
  up?: number;
  attrs?: PlayerAttrs;
  youth?: boolean;
  height?: number; // cm
  weight?: number; // kg
  leadership?: boolean;
}

export interface Bootstrap {
  teams: Team[];
  leagues: League[];
  clubChangeCost: number;
  formations: Record<string, string[]>;
  tactics: Record<string, string>; // tacticId -> Korean display label
  market: CatalogPlayer[];
  packs: unknown[];
  enhance: { maxLevel: number; rates: number[]; costRate: number };
  roles: Record<string, Role>;
}

// ---- predictions (실제 경기 예측) ----

export type Pick = 'home' | 'draw' | 'away';

export interface Bet {
  pick: Pick;
  score: { home: number; away: number } | null;
  reward?: number;
}

export interface FixtureResult {
  score: { home: number; away: number };
  outcome: Pick;
}

export interface Fixture {
  id: string;
  leagueLabel: string;
  home: string;
  away: string;
  homeLogo?: string | null;
  awayLogo?: string | null;
  status: 'open' | 'live' | 'done';
  kickoffAt: number;
  live?: { home: number; away: number } | null;
  elapsedMin?: number | null;
  result?: FixtureResult | null;
  myBet?: Bet | null;
}

// ---- rank / records ----

export interface LeaderboardRow {
  username: string;
  clubName: string;
  points: number;
  record: { w: number; d: number; l: number };
  ovr: number;
}

export interface MatchLineupPlayer {
  id: string | null;
  name: string;
  pos: string;
  ovr: number;
  youth?: boolean;
}

export interface MatchTimelineEvent {
  minute: number;
  type: string;
  team: 'home' | 'away';
  player?: string | null;
  playerId?: string | null;
  assist?: string | null;
  assistId?: string | null;
  via?: string | null;
}

export interface MatchRecord {
  id: string;
  at: string;
  mode: 'ai' | 'pvp' | string;
  homeUserId: string | null;
  awayUserId: string | null;
  homeName: string;
  awayName: string;
  score: { home: number; away: number };
  possession?: { home: number; away: number };
  xg?: { home: number; away: number };
  homeFormation?: string;
  awayFormation?: string;
  homeLineup?: MatchLineupPlayer[];
  awayLineup?: MatchLineupPlayer[];
  timeline?: MatchTimelineEvent[];
}

export interface MatchContribution {
  id: string | null;
  name: string;
  pos: string;
  ovr: number;
  slot: number;
  youth: boolean;
  goals: number;
  assists: number;
  score: number;
}

export interface MatchDetail {
  match: MatchRecord;
  contributions: { home: MatchContribution[]; away: MatchContribution[] };
}

export interface SeasonStatus {
  number: number;
  startedAt: number;
  endsAt: number;
  daysRemaining: number;
}

export interface SeasonHistoryEntry {
  top: { clubName: string; username: string; points: number }[];
}

export interface OpponentSquadView {
  username: string;
  clubName: string;
  formation: string;
  tactic: string;
  roles: Record<string, string>;
  starters: (string | null)[];
  starterDetails: (CatalogPlayer | null)[];
  captain: string | null;
  viceCaptain: string | null;
  ratings: Ratings;
}
