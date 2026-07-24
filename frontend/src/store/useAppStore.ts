import { create } from 'zustand';
import { api, getToken, setToken } from '../api/client';
import { activeSquad } from '../game/cards';
import { toast } from './useToastStore';
import type { Bootstrap, CatalogPlayer, Team, User } from '../types';

export type AuthMode = 'login' | 'register';
export type SquadMode = 'main' | 'pvp';

interface RegisterPayload {
  username: string;
  password: string;
  clubName: string;
  team: string;
  dyn: boolean; // team came from the live league-teams fetch, not the curated list
}

export interface SquadPatch {
  formation?: string;
  starters?: (string | null)[];
  tactic?: string;
  captain?: string | null;
  viceCaptain?: string | null;
  roles?: Record<string, string>;
}

export interface EnhanceResult {
  success: boolean;
  level: number;
  cost: number;
}

interface AppState {
  // session
  token: string | null;
  me: User | null;
  booting: boolean;

  // bootstrap/catalog data (formations, tactics labels, market, roles, ...)
  bootstrap: Bootstrap | null;
  catalog: Map<string, CatalogPlayer>;

  // register-flow team picker (lazily fetched real-club rosters)
  leagueTeams: Team[] | null;

  authMode: AuthMode;
  squadMode: SquadMode;

  setAuthMode: (mode: AuthMode) => void;
  setSquadMode: (mode: SquadMode) => void;
  loadBootstrap: () => Promise<void>;
  loadLeagueTeams: () => Promise<void>;
  boot: () => Promise<void>;
  login: (username: string, password: string) => Promise<void>;
  register: (payload: RegisterPayload) => Promise<void>;
  logout: () => void;
  setMe: (user: User) => void;
  saveSquad: (patch: SquadPatch) => Promise<void>;
  autoPlaceSquad: () => Promise<void>;
  enhancePlayer: (playerId: string) => Promise<EnhanceResult>;
  sellPlayer: (playerId: string) => Promise<{ coinsGained: number; perfBonusPct: number }>;
  searchRemotePlayers: (q: string) => Promise<{ found: number; added: number }>;
  claimMail: (mailId: string) => Promise<void>;
  resolveComplaint: (
    complaintId: string,
    choiceId: string
  ) => Promise<{ satisfied: boolean; devotion: number }>;
  resolveTransferRequest: (
    requestId: string,
    choice: 'keep' | 'release'
  ) => Promise<{ released: boolean; devotion?: number }>;
  changePassword: (currentPassword: string, newPassword: string) => Promise<void>;
  setAvatar: (imageDataUrl: string) => Promise<void>;
  clearAvatar: () => Promise<void>;
}

export const useAppStore = create<AppState>((set, get) => ({
  token: getToken(),
  me: null,
  booting: true,
  bootstrap: null,
  catalog: new Map(),
  leagueTeams: null,
  authMode: 'login',
  squadMode: 'main',

  setAuthMode: (mode) => set({ authMode: mode }),
  setSquadMode: (mode) => set({ squadMode: mode }),

  loadBootstrap: async () => {
    const data = await api.get<Bootstrap>('/api/bootstrap');
    const catalog = new Map(data.market.map((p) => [p.id, p] as const));
    set({ bootstrap: data, catalog });
  },

  loadLeagueTeams: async () => {
    if (get().leagueTeams) return;
    try {
      const { teams } = await api.get<{ teams: Team[] }>('/api/leagueteams');
      set({ leagueTeams: teams || [] });
    } catch {
      set({ leagueTeams: null }); // retry on next open
    }
  },

  boot: async () => {
    await get().loadBootstrap();
    const token = getToken();
    if (token) {
      try {
        const { user } = await api.get<{ user: User }>('/api/me');
        set({ token, me: user, booting: false });
        return;
      } catch {
        setToken(null);
      }
    }
    set({ token: null, me: null, booting: false });
  },

  login: async (username, password) => {
    const data = await api.post<{ token: string; user: User }>('/api/login', {
      username,
      password,
    });
    setToken(data.token);
    set({ token: data.token, me: data.user });
  },

  register: async ({ dyn, ...payload }) => {
    const data = await api.post<{ token: string; user: User }>('/api/register', payload);
    setToken(data.token);
    set({ token: data.token, me: data.user });
    // a dynamically-fetched club's roster adds new players the initial
    // bootstrap didn't know about yet.
    if (dyn) await get().loadBootstrap();
  },

  logout: () => {
    api.post('/api/logout').catch(() => {});
    setToken(null);
    set({ token: null, me: null });
  },

  setMe: (user) => set({ me: user }),

  saveSquad: async (patch) => {
    const me = get().me;
    if (!me) return;
    const squadMode = get().squadMode;
    const squad = activeSquad(me, squadMode);
    const body = {
      kind: squadMode,
      formation: squad.formation,
      starters: squad.starters,
      tactic: squad.tactic || 'balanced',
      ...patch,
    };
    const { user } = await api.put<{ user: User }>('/api/squad', body);
    set({ me: user });
  },

  autoPlaceSquad: async () => {
    const squadMode = get().squadMode;
    const { user } = await api.post<{ user: User }>('/api/squad/auto', { kind: squadMode });
    set({ me: user });
  },

  enhancePlayer: async (playerId) => {
    const r = await api.post<{ user: User } & EnhanceResult>('/api/players/enhance', { playerId });
    set({ me: r.user });
    return { success: r.success, level: r.level, cost: r.cost };
  },

  sellPlayer: async (playerId) => {
    const r = await api.post<{ user: User; coinsGained: number; perfBonusPct: number }>(
      '/api/market/sell',
      { playerId }
    );
    set({ me: r.user });
    return { coinsGained: r.coinsGained, perfBonusPct: r.perfBonusPct };
  },

  // fallback lookup for real-DB players not in the local catalog yet — adds
  // any newly-found ones to both the catalog map and the market list.
  searchRemotePlayers: async (q) => {
    const { bootstrap, catalog } = get();
    if (!bootstrap) return { found: 0, added: 0 };
    const { players: found } = await api.get<{ players: CatalogPlayer[] }>(
      '/api/players/search?q=' + encodeURIComponent(q)
    );
    const nextCatalog = new Map(catalog);
    const nextMarket = [...bootstrap.market];
    let added = 0;
    (found || []).forEach((p) => {
      if (!nextCatalog.has(p.id)) {
        nextCatalog.set(p.id, p);
        nextMarket.push(p);
        added++;
      }
    });
    set({ catalog: nextCatalog, bootstrap: { ...bootstrap, market: nextMarket } });
    return { found: (found || []).length, added };
  },

  claimMail: async (mailId) => {
    const { user } = await api.post<{ user: User }>('/api/mailbox/claim', { mailId });
    set({ me: user });
  },

  resolveComplaint: async (complaintId, choiceId) => {
    const r = await api.post<{ user: User; satisfied: boolean; devotion: number }>(
      '/api/complaint/resolve',
      { complaintId, choiceId }
    );
    set({ me: r.user });
    return { satisfied: r.satisfied, devotion: r.devotion };
  },

  resolveTransferRequest: async (requestId, choice) => {
    const r = await api.post<{ user: User; released: boolean; devotion?: number }>(
      '/api/transfer-request/resolve',
      { requestId, choice }
    );
    set({ me: r.user });
    return { released: r.released, devotion: r.devotion };
  },

  changePassword: async (currentPassword, newPassword) => {
    await api.put('/api/account/password', { currentPassword, newPassword });
  },

  setAvatar: async (imageDataUrl) => {
    const { user } = await api.put<{ user: User }>('/api/account/avatar', { imageDataUrl });
    set({ me: user });
  },

  clearAvatar: async () => {
    const { user } = await api.del<{ user: User }>('/api/account/avatar');
    set({ me: user });
  },
}));

// client.ts fires this on any 401 (token missing/expired/invalidated
// server-side). Dropping `me` here — not just the token — is what actually
// sends the app back to the login screen: App.tsx gates on `me`, and
// clearing only the token left the logged-in shell up with every further
// request failing silently.
window.addEventListener('fs:auth-expired', () => {
  if (!useAppStore.getState().me) return; // already logged out, avoid a duplicate toast
  toast('세션이 만료되어 다시 로그인해주세요.');
  useAppStore.setState({ token: null, me: null });
});
