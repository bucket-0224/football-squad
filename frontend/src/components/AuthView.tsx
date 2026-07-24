import { useEffect, useMemo, useState } from 'react';
import { useAppStore } from '../store/useAppStore';
import { teamsInLeague } from '../game/teams';
import TeamCard from './TeamCard';
import type { League, Team } from '../types';

const EMPTY_TEAMS: Team[] = [];
const EMPTY_LEAGUES: League[] = [];

export default function AuthView() {
  const { authMode, setAuthMode, bootstrap, leagueTeams, loadLeagueTeams, login, register } =
    useAppStore();

  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [clubName, setClubName] = useState('');
  const [pickedLeague, setPickedLeague] = useState('EPL');
  const [pickedTeam, setPickedTeam] = useState<string | null>(null);
  const [pickedDyn, setPickedDyn] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (authMode === 'register') loadLeagueTeams();
  }, [authMode, loadLeagueTeams]);

  const teams = bootstrap?.teams ?? EMPTY_TEAMS;
  const leagues = bootstrap?.leagues ?? EMPTY_LEAGUES;
  const visibleTeams = useMemo(
    () => teamsInLeague(pickedLeague, teams, leagueTeams),
    [pickedLeague, teams, leagueTeams]
  );

  const switchMode = (mode: 'login' | 'register') => {
    setAuthMode(mode);
    setError('');
  };

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      if (authMode === 'login') {
        await login(username.trim(), password);
      } else {
        if (!pickedTeam) throw new Error('시작 팀을 선택해 주세요.');
        await register({
          username: username.trim(),
          password,
          clubName: clubName.trim(),
          team: pickedTeam,
          dyn: pickedDyn,
        });
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section id="view-auth" className="view">
      <div className="auth-card">
        <h1>⚽ 풋볼 스쿼드</h1>
        <p className="tagline">나만의 스쿼드를 만들어 실시간 대전에서 승리하세요</p>
        <div className="auth-tabs">
          <button type="button" className={authMode === 'login' ? 'active' : ''} onClick={() => switchMode('login')}>
            로그인
          </button>
          <button type="button" className={authMode === 'register' ? 'active' : ''} onClick={() => switchMode('register')}>
            회원가입
          </button>
        </div>
        <form id="auth-form" onSubmit={onSubmit} autoComplete="off">
          <input
            placeholder="아이디 (2~16자)"
            maxLength={16}
            value={username}
            onChange={(e) => setUsername(e.target.value)}
          />
          <input
            type="password"
            placeholder="비밀번호 (4자 이상)"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          {authMode === 'register' && (
            <div>
              <input
                placeholder="구단 이름 (예: 동현 FC)"
                maxLength={20}
                value={clubName}
                onChange={(e) => setClubName(e.target.value)}
              />
              <div className="pick-label">
                시작 팀 선택 <span className="pick-hint">— 선택한 팀 선수단(14명)으로 시작합니다</span>
              </div>
              <select
                className="league-select"
                value={pickedLeague}
                onChange={(e) => {
                  setPickedLeague(e.target.value);
                  setPickedTeam(null);
                }}
              >
                {leagues.map((lg) => (
                  <option key={lg.id} value={lg.id}>
                    {lg.label}
                  </option>
                ))}
              </select>
              <div id="team-grid">
                {visibleTeams.map((t) => (
                  <TeamCard
                    key={t.name}
                    team={t}
                    selected={pickedTeam === t.name}
                    onClick={() => {
                      setPickedTeam(t.name);
                      setPickedDyn(!!t.dyn);
                    }}
                  />
                ))}
              </div>
            </div>
          )}
          <button type="submit" className="btn primary" disabled={busy}>
            {authMode === 'login' ? '로그인' : '회원가입'}
          </button>
          <div className="error-msg">{error}</div>
        </form>
      </div>
    </section>
  );
}
