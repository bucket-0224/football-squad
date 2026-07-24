import { useEffect, useMemo, useState } from 'react';
import { useAppStore } from '../store/useAppStore';
import { teamsInLeague } from '../game/teams';
import TeamCard from './TeamCard';
import type { League, Team } from '../types';

const EMPTY_TEAMS: Team[] = [];
const EMPTY_LEAGUES: League[] = [];

type RegisterStep = 'credentials' | 'clubname' | 'team' | 'style' | 'preparing';
const REGISTER_STEPS: RegisterStep[] = ['credentials', 'clubname', 'team', 'style'];

const TIPS = [
  '스쿼드 탭의 "배치 편집"에서 선수 카드를 드래그하면, 포메이션 틀에 얽매이지 않고 자유롭게 전술 위치를 조정할 수 있어요.',
  '감독 스타일(선호 포메이션·전술)과 다른 방식으로 경기를 치르면, 그 방식에 익숙하지 않은 선수들이 불만을 표할 수 있어요.',
  '"베스트 XI 추천"은 지금 배치된 위치는 그대로 두고, 어떤 선수가 뛸지만 최적으로 골라줘요.',
  '이적시장에서는 바이아웃 협상으로 원하는 선수를 직접 영입할 수 있어요.',
  '뽑기로 획득한 카드는 실전 스쿼드에만 배치할 수 있어요 — 랭크 매치는 실전 스쿼드로 진행됩니다.',
  '승부 예측을 맞히면 포인트를 받을 수 있어요.',
  '선수 카드를 강화하면 능력치와 OVR이 함께 올라가요.',
  '선수의 불만을 오래 방치하면 이적을 요청할 수도 있어요 — 면담으로 헌신도를 관리해 주세요.',
  '실제 축구 선수를 배치할 때는 그 선수가 익숙한 위치(선)에 놓아야 OVR이 온전히 유지돼요.',
];

function randomTip() {
  return TIPS[Math.floor(Math.random() * TIPS.length)];
}

export default function AuthView() {
  const { authMode, setAuthMode, bootstrap, leagueTeams, loadLeagueTeams, login, register } =
    useAppStore();

  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [clubName, setClubName] = useState('');
  const [pickedLeague, setPickedLeague] = useState('EPL');
  const [pickedTeam, setPickedTeam] = useState<string | null>(null);
  const [pickedDyn, setPickedDyn] = useState(false);
  const [preferredFormation, setPreferredFormation] = useState('4-3-3');
  const [preferredTactic, setPreferredTactic] = useState('balanced');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [step, setStep] = useState<RegisterStep>('credentials');
  const [tip, setTip] = useState(randomTip());

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
    setStep('credentials');
    setError('');
  };

  const onLoginSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      await login(username.trim(), password);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  // 최소 이 정도는 "준비 중" 화면이 보이게 해서 팁을 읽을 시간을 준다 —
  // 큐레이션 팀은 로스터가 이미 있어 등록이 순식간에 끝나버리기 때문.
  const MIN_PREPARE_MS = 1400;

  const finishRegistration = async () => {
    setError('');
    setTip(randomTip());
    setStep('preparing');
    const startedAt = Date.now();
    try {
      await register({
        username: username.trim(),
        password,
        clubName: clubName.trim(),
        team: pickedTeam as string,
        dyn: pickedDyn,
        preferredFormation,
        preferredTactic,
      });
      const elapsed = Date.now() - startedAt;
      if (elapsed < MIN_PREPARE_MS) {
        await new Promise((r) => setTimeout(r, MIN_PREPARE_MS - elapsed));
      }
      // 성공하면 store의 me가 채워지고 App.tsx가 알아서 메인 화면으로 넘어간다.
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setStep('credentials');
    }
  };

  const stepIndex = REGISTER_STEPS.indexOf(step);
  const goNext = () => {
    setError('');
    const i = REGISTER_STEPS.indexOf(step);
    if (step === 'team' && !pickedTeam) {
      setError('시작 팀을 선택해 주세요.');
      return;
    }
    if (step === 'style') {
      finishRegistration();
      return;
    }
    if (i >= 0 && i < REGISTER_STEPS.length - 1) setStep(REGISTER_STEPS[i + 1]);
  };
  const goBack = () => {
    setError('');
    const i = REGISTER_STEPS.indexOf(step);
    if (i > 0) setStep(REGISTER_STEPS[i - 1]);
  };

  const credentialsValid = username.trim().length >= 2 && username.trim().length <= 16 && password.length >= 4;

  return (
    <section id="view-auth" className="view">
      <div className={'auth-card' + (authMode === 'register' && step !== 'credentials' ? ' auth-card-wizard' : '')}>
        {authMode === 'login' || step === 'credentials' ? (
          <>
            <h1>⚽ FC Management</h1>
            <p className="tagline">나만의 스쿼드를 만들어 실시간 대전에서 승리하세요</p>
            <div className="auth-tabs">
              <button type="button" className={authMode === 'login' ? 'active' : ''} onClick={() => switchMode('login')}>
                로그인
              </button>
              <button type="button" className={authMode === 'register' ? 'active' : ''} onClick={() => switchMode('register')}>
                회원가입
              </button>
            </div>
          </>
        ) : (
          step !== 'preparing' && (
            <div className="wizard-head">
              <button type="button" className="wizard-back" onClick={goBack} aria-label="이전">
                ‹
              </button>
              <div className="wizard-progress">
                {REGISTER_STEPS.slice(1).map((s, i) => (
                  <span key={s} className={'wizard-dot' + (i <= stepIndex - 1 ? ' done' : '')} />
                ))}
              </div>
            </div>
          )
        )}

        {authMode === 'login' && (
          <form id="auth-form" onSubmit={onLoginSubmit} autoComplete="off">
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
            <button type="submit" className="btn primary" disabled={busy}>
              로그인
            </button>
            <div className="error-msg">{error}</div>
          </form>
        )}

        {authMode === 'register' && step === 'credentials' && (
          <form
            id="auth-form"
            onSubmit={(e) => {
              e.preventDefault();
              if (!credentialsValid) {
                setError('아이디는 2~16자, 비밀번호는 4자 이상으로 입력해 주세요.');
                return;
              }
              setError('');
              setStep('clubname');
            }}
            autoComplete="off"
          >
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
            <button type="submit" className="btn primary" disabled={busy}>
              다음
            </button>
            <div className="error-msg">{error}</div>
          </form>
        )}

        {authMode === 'register' && step === 'clubname' && (
          <div className="wizard-step">
            <h2 className="wizard-question">어떤 구단 이름으로 짓고 싶으세요?</h2>
            <p className="wizard-sub">나중에 언제든 클럽을 변경할 수 있어요.</p>
            <input
              className="wizard-input"
              placeholder="구단 이름 (예: 동현 FC)"
              maxLength={20}
              autoFocus
              value={clubName}
              onChange={(e) => setClubName(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && goNext()}
            />
            <button type="button" className="btn primary wizard-cta" onClick={goNext}>
              다음
            </button>
          </div>
        )}

        {authMode === 'register' && step === 'team' && (
          <div className="wizard-step">
            <h2 className="wizard-question">어떤 구단을 기반으로 팀을 만드실건가요?</h2>
            <p className="wizard-sub">선택한 팀 선수단(14명)으로 시작합니다.</p>
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
            <div className="team-grid-4col">
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
            <button type="button" className="btn primary wizard-cta" onClick={goNext} disabled={!pickedTeam}>
              다음
            </button>
            <div className="error-msg">{error}</div>
          </div>
        )}

        {authMode === 'register' && step === 'style' && (
          <div className="wizard-step wizard-intro">
            <div className="wizard-intro-icon">🎯</div>
            <h2 className="wizard-question">감독 스타일을 정해주세요</h2>
            <p className="wizard-sub">
              선호하는 포메이션과 전술이에요. 이 스타일을 벗어난 경기를 자주 치르면 선수들이 낯설어하며
              불만을 표할 수 있어요.
            </p>
            <div className="manager-style-row">
              <select value={preferredFormation} onChange={(e) => setPreferredFormation(e.target.value)}>
                {Object.keys(bootstrap?.formations ?? { '4-3-3': [] }).map((f) => (
                  <option key={f} value={f}>
                    {f}
                  </option>
                ))}
              </select>
              <select value={preferredTactic} onChange={(e) => setPreferredTactic(e.target.value)}>
                {Object.entries(bootstrap?.tactics ?? { balanced: '균형' }).map(([id, label]) => (
                  <option key={id} value={id}>
                    전술: {label}
                  </option>
                ))}
              </select>
            </div>
            <button type="button" className="btn primary wizard-cta" onClick={goNext}>
              시작하기
            </button>
          </div>
        )}

        {authMode === 'register' && step === 'preparing' && (
          <div className="wizard-step wizard-preparing">
            <div className="wizard-spinner" aria-hidden="true" />
            <h2 className="wizard-question">이제 곧 준비가 마무리될거에요!</h2>
            <p className="wizard-tip">💡 {tip}</p>
          </div>
        )}
      </div>
    </section>
  );
}
