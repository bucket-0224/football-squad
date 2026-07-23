import { useEffect, useState } from 'react';
import { useAppStore } from '../store/useAppStore';
import { toast } from '../store/useToastStore';
import { api } from '../api/client';
import { teamsInLeague } from '../game/teams';
import TeamCard from './TeamCard';
import type { User } from '../types';

export default function ClubChangeModal({ onClose }: { onClose: () => void }) {
  const { me, bootstrap, leagueTeams, loadLeagueTeams, loadBootstrap, setMe } = useAppStore();
  const [league, setLeague] = useState(
    () => bootstrap?.teams.find((t) => t.name === me?.baseTeam)?.league || 'EPL'
  );

  useEffect(() => {
    loadLeagueTeams();
  }, [loadLeagueTeams]);

  if (!me || !bootstrap) return null;

  const clubs = teamsInLeague(league, bootstrap.teams, leagueTeams).filter((t) => t.type === 'club');

  const pick = async (name: string, dyn: boolean | undefined) => {
    if (name === me.baseTeam) return;
    if (
      !confirm(
        `${name}(으)로 클럽을 변경할까요?\n승점 ${bootstrap.clubChangeCost}이 차감되고 기존 클럽 선수단은 떠납니다. (뽑은 카드·영입 선수는 유지)`
      )
    )
      return;
    try {
      if (dyn) toast('실제 선수단을 불러오는 중입니다…');
      const { user } = await api.post<{ user: User }>('/api/club/change', { team: name });
      if (dyn) await loadBootstrap();
      setMe(user);
      onClose();
      toast(`${name}(으)로 클럽을 변경했습니다!`);
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div
      id="club-overlay"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="picker-modal">
        <div className="picker-head">
          <span>
            클럽 변경{' '}
            <span className="mode-hint">
              승점 {bootstrap.clubChangeCost} 차감 · 기존 클럽 선수단은 떠납니다 (뽑은 카드는 유지)
            </span>
          </span>
          <button type="button" className="btn ghost small" onClick={onClose}>
            ✕
          </button>
        </div>
        <select className="league-select" value={league} onChange={(e) => setLeague(e.target.value)}>
          {bootstrap.leagues
            .filter((lg) => lg.id !== 'national')
            .map((lg) => (
              <option key={lg.id} value={lg.id}>
                {lg.label}
              </option>
            ))}
        </select>
        <div id="club-grid">
          {clubs.map((t) => (
            <TeamCard
              key={t.name}
              team={t}
              selected={t.name === me.baseTeam}
              extraTag={t.name === me.baseTeam ? '현재 클럽' : undefined}
              onClick={() => pick(t.name, t.dyn)}
            />
          ))}
        </div>
      </div>
    </div>
  );
}
