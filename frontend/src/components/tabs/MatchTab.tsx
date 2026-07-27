import { useEffect, useRef, useState } from 'react';
import { useAppStore } from '../../store/useAppStore';
import { toast } from '../../store/useToastStore';
import { api } from '../../api/client';
import { socket, type WsMessage } from '../../ws/socket';
import { LiveMatchEngine, type MatchEvent, type MatchStartMsg, type ResultMsg } from '../../game/liveMatchEngine';
import { upgradedCard } from '../../game/cards';
import type { CatalogPlayer, CupState, User } from '../../types';

interface SpectateRow {
  id: string;
  mode: string;
  home: string;
  away: string;
  score: { home: number; away: number };
  display: string;
}

const RESULT_LABELS: Record<'win' | 'loss' | 'draw', string> = {
  win: '🎉 승리!',
  loss: '😢 패배',
  draw: '🤝 무승부',
};

// 채팅 목록 대신 단일 라인 토스트(이벤트 배너)로 매 이벤트를 흘려보낸다 —
// 타입별로 색을 다르게 줘서 계속 바뀌는 느낌을 준다. 골/레드카드/옐로카드/
// 오프사이드/부상/태업처럼 이미 자체 색상으로 onBanner를 직접 호출하는
// 이벤트는 이 매핑을 거치지 않고 그 색이 그대로 우선한다.
const FEED_KIND: Record<string, string> = {
  save: 'save',
  miss: 'miss',
  corner: 'corner',
  foul: 'foul',
  throwin: 'throwin',
  card: 'yellow',
  phase: 'phase',
  live: 'info',
};

const CUP_ROUND_LABELS = ['8강', '4강', '결승'];

// 컵대회 우승 리빌 파티클 — PacksTab의 팩 개봉 리빌(#cere-sparks/.cere-spark,
// index.css)과 같은 CSS 애니메이션을 재사용해, 개봉 단계 로직 없이 트로피
// 주위에 한 번만 터뜨린다.
function cupSparks(n = 14) {
  return Array.from({ length: n }, (_, i) => {
    const angle = (i / n) * Math.PI * 2;
    const dist = 60 + Math.random() * 36;
    return {
      dx: Math.cos(angle) * dist,
      dy: Math.sin(angle) * dist,
      delay: `${(i % 5) * 0.08}s`,
      color: i % 2 ? '#e3b341' : '#fff3c4',
    };
  });
}

// 컵대회 로비 — 대전 탭 내부 서브 뷰(새 최상위 탭이 아님). 진행 상태는
// me.cup(백엔드가 sanitizeUser로 노출)을 그대로 읽는다: 매치 결과 팝업이
// 닫힐 때마다 handleResult가 /api/me를 다시 불러오므로 별도 폴링이 필요
// 없다.
function CupBracket({
  cup,
  onStart,
  disabled,
  error,
}: {
  cup: CupState;
  onStart: () => void;
  disabled: boolean;
  error: string;
}) {
  const today = new Date().toISOString().slice(0, 10);
  const inProgress = cup.status === 'in_progress';
  const canStartFresh = cup.lastRunDate !== today;
  const startDisabled = disabled || (!inProgress && !canStartFresh);

  let statusLine = '8강부터 결승까지 3연승하면 우승 — 하루 1회 새로 도전할 수 있습니다.';
  if (inProgress) statusLine = `${CUP_ROUND_LABELS[cup.round]} 진출 — 다음 경기를 시작하세요.`;
  else if (cup.status === 'won') statusLine = '🏆 지난 컵대회 우승! ' + (canStartFresh ? '오늘 다시 도전할 수 있습니다.' : '내일 다시 도전할 수 있습니다.');
  else if (cup.status === 'eliminated') statusLine = `${CUP_ROUND_LABELS[cup.round]}에서 탈락했습니다. ` + (canStartFresh ? '오늘 다시 도전할 수 있습니다.' : '내일 다시 도전할 수 있습니다.');

  return (
    <div className="lobby-card cup-lobby-card">
      <h2>🏆 컵대회</h2>
      <p className="dim small-text">{statusLine}</p>
      <div className="cup-bracket">
        {CUP_ROUND_LABELS.map((label, i) => {
          const opp = cup.opponents[i];
          let state: 'win' | 'current' | 'lost' | 'upcoming' = 'upcoming';
          if (i < cup.round) state = 'win';
          else if (i === cup.round && cup.status === 'eliminated') state = 'lost';
          else if (i === cup.round && inProgress) state = 'current';
          return (
            <div key={label} className={`cup-node cup-node-${state}`}>
              <div className="cup-node-round">{label}</div>
              {opp ? (
                <div className="cup-node-opp">
                  {opp.logo ? <img src={opp.logo} alt="" /> : <span className="cup-node-opp-fallback">⚽</span>}
                  <span className="cup-node-opp-name">{opp.name}</span>
                  <span className="cup-node-opp-ovr">OVR {opp.ovr}</span>
                </div>
              ) : (
                <div className="cup-node-opp dim small-text">미정</div>
              )}
            </div>
          );
        })}
      </div>
      <button type="button" className="btn primary big" disabled={startDisabled} onClick={onStart}>
        {inProgress ? `${CUP_ROUND_LABELS[cup.round]} 경기 시작` : '컵대회 도전 시작'}
      </button>
      <div className="error-msg">{error}</div>
    </div>
  );
}

// ---- PvP 컵 토너먼트 (3일 주기, 오버롤 시드 브라켓, 몰수승 규정) ----

interface PvpCupInfo {
  status: string;
  cycleId: number;
  fieldSize: number;
  cycleEndsAt: number;
  champion?: { clubName: string; ovr: number } | null;
  round?: string;
  windowStart?: number;
  windowEnd?: number;
  windowOpen?: boolean;
  opponent?: { clubName: string; ovr: number } | null;
  attendedMe?: boolean;
  attendedOpp?: boolean;
  played?: boolean;
  forfeit?: boolean;
  mySeed?: number;
}

function fmtTime(ts?: number) {
  if (!ts) return '';
  return new Date(ts).toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function PvpCupPanel({
  state,
  onEnter,
  onRefresh,
  disabled,
  error,
}: {
  state: PvpCupInfo | null;
  onEnter: () => void;
  onRefresh: () => void;
  disabled: boolean;
  error: string;
}) {
  if (!state) {
    return (
      <div className="lobby-card cup-lobby-card">
        <h2>🏟 PvP 토너먼트</h2>
        <p className="dim small-text">불러오는 중…</p>
      </div>
    );
  }

  let body: React.ReactNode = null;
  switch (state.status) {
    case 'idle':
      body = <p className="dim small-text">참가자가 부족해 이번 주기 토너먼트가 열리지 않았습니다.</p>;
      break;
    case 'not_in_bracket':
      body = (
        <p className="dim small-text">
          이번 주기 브라켓({state.fieldSize}강)에 포함되지 않았습니다. 다음 주기에 자동으로 참가됩니다.
        </p>
      );
      break;
    case 'champion':
      body = <p className="cup-result-note">🏆 이번 주기 우승! 보상이 우편함에 도착했습니다.</p>;
      break;
    case 'eliminated':
      body = (
        <p className="dim small-text">
          {state.round ? `${state.round}에서 탈락했습니다.` : '이번 주기에서 탈락했습니다.'} 다음 초기화:{' '}
          {fmtTime(state.cycleEndsAt)}
        </p>
      );
      break;
    case 'advanced':
      body = (
        <p className="dim small-text">
          ✅ {state.round} 승리 — 다른 경기가 끝나면 다음 라운드 대진이 확정됩니다.
        </p>
      );
      break;
    case 'waiting_bracket':
      body = <p className="dim small-text">다음 라운드 대진 확정을 기다리는 중입니다.</p>;
      break;
    case 'in_round':
      body = (
        <>
          <p className="dim small-text">
            {state.round} · 내 시드 #{state.mySeed} · 상대: <b>{state.opponent?.clubName || '?'}</b> (OVR{' '}
            {state.opponent?.ovr ?? '?'})
          </p>
          <p className="dim small-text">
            입장 가능 시간: {fmtTime(state.windowStart)} ~ {fmtTime(state.windowEnd)}
            {state.windowOpen ? ' (지금 입장 가능!)' : ''}
          </p>
          {state.attendedMe && !state.attendedOpp && (
            <p className="dim small-text">
              ✅ 출석 완료 — 상대가 마감까지 입장하지 않으면 몰수승으로 진출합니다 (상대 승점 -3).
            </p>
          )}
          {!state.attendedMe && (
            <p className="dim small-text">⚠️ 마감까지 입장하지 않으면 몰수패 처리되고 승점이 3점 깎입니다.</p>
          )}
          <button type="button" className="btn primary big" disabled={disabled || !state.windowOpen} onClick={onEnter}>
            {state.windowOpen
              ? state.attendedOpp
                ? '경기 시작 (상대 출석 완료)'
                : state.attendedMe
                  ? '재입장 (상대 대기 중)'
                  : '토너먼트 입장'
              : '입장 시간이 아닙니다'}
          </button>
        </>
      );
      break;
    default:
      body = <p className="dim small-text">상태를 불러오지 못했습니다.</p>;
  }

  return (
    <div className="lobby-card cup-lobby-card">
      <h2>🏟 PvP 토너먼트</h2>
      <p className="dim small-text">
        전체 유저를 오버롤 순으로 집계해 최대 64강 브라켓을 만듭니다(시드 배치 — 결승에서 최강 시드와 만나는
        구조). 3일마다 초기화되며, 라운드 시간에 입장하지 않으면 몰수패와 함께 승점 3점이 깎입니다.
      </p>
      {state.fieldSize > 0 && (
        <p className="dim small-text">
          이번 주기: {state.fieldSize}강 · 초기화 {fmtTime(state.cycleEndsAt)}
          {state.champion ? ` · 우승: ${state.champion.clubName}` : ''}
        </p>
      )}
      {body}
      <button type="button" className="btn ghost small" onClick={onRefresh}>
        새로고침
      </button>
      <div className="error-msg">{error}</div>
    </div>
  );
}

function LiveMatchCanvas({ engine }: { engine: LiveMatchEngine }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    if (canvasRef.current) engine.mount(canvasRef.current);
    return () => engine.unmount();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return <canvas id="pitch2d" ref={canvasRef} width={520} height={860} />;
}

export default function MatchTab({ visible }: { visible: boolean }) {
  const { me, bootstrap, catalog, token } = useAppStore();
  const [view, setView] = useState<'lobby' | 'live'>('lobby');
  const [matchMode, setMatchMode] = useState<'quick' | 'cup' | 'pvpcup'>('quick');
  const [pvpcupState, setPvpcupState] = useState<PvpCupInfo | null>(null);
  const [queued, setQueued] = useState(false);
  const [matchError, setMatchError] = useState('');
  const [spectateList, setSpectateList] = useState<SpectateRow[]>([]);
  const [spectating, setSpectating] = useState(false);
  const [mySide, setMySide] = useState<'home' | 'away'>('home');
  // 지금 뛰는 매치 모드 — 건너뛰기(자동 시뮬레이션권)는 사람 상대가 없는
  // ai/cup에서만 노출한다.
  const [liveMode, setLiveMode] = useState('');

  const [homeName, setHomeName] = useState('');
  const [awayName, setAwayName] = useState('');
  const [homeOvrLine, setHomeOvrLine] = useState('');
  const [awayOvrLine, setAwayOvrLine] = useState('');
  const [minuteLabel, setMinuteLabel] = useState("0'");
  const [score, setScore] = useState({ home: 0, away: 0 });
  const [possHomePct, setPossHomePct] = useState(50);
  const [banner, setBanner] = useState<{ text: string; kind: string; token: number } | null>(null);
  const [pausesLeft, setPausesLeft] = useState(2);
  const [pauseDisabled, setPauseDisabled] = useState(false);
  const [pauseStatus, setPauseStatus] = useState('');
  const [pausePanelOpen, setPausePanelOpen] = useState(false);
  const [resultMsg, setResultMsg] = useState<ResultMsg | null>(null);
  const [previewMsg, setPreviewMsg] = useState<MatchStartAll | null>(null);

  const [pauseFormation, setPauseFormation] = useState('4-3-3');
  const [pauseStarters, setPauseStarters] = useState<(string | null)[]>([]);
  const [poolKind, setPoolKind] = useState<'owned' | 'drawn'>('owned');
  const [pauseSel, setPauseSel] = useState<number | null>(null);

  const matchTacticNamesRef = useRef({ home: '', away: '' });

  // 요청: "필드 아래에... 사라지지 않고 항상 중계 메세지가 새로 갱신되도록" —
  // 예전엔 ms(기본 2200) 뒤 자동으로 setBanner(null)해서 사라졌는데, 그게
  // 골문 앞 혼잡 장면을 가리는 배너가 있다가도 없다가도 하며 화면이
  // 깜빡이는 느낌을 줬다. 이제 배너는 캔버스 "아래"(겹치지 않음)에 항상
  //떠 있고, 다음 메세지가 올 때까지 마지막 내용을 그대로 유지한다 — 엔진이
  // 넘겨주는 ms(대략 이 정도 보여주라는 힌트)는 더 이상 쓰지 않는다.
  const showBanner = (text: string, kind: string) => {
    if (!text) return;
    setBanner({ text, kind, token: Date.now() });
  };

  const engineRef = useRef<LiveMatchEngine | null>(null);
  if (!engineRef.current) {
    engineRef.current = new LiveMatchEngine({
      onMinute: (label) => setMinuteLabel(label),
      onScore: (h, a) => setScore({ home: h, away: a }),
      onPossession: (homePct) => setPossHomePct(homePct),
      // 채팅 목록 대신 매 이벤트를 단일 라인 토스트로 흘려보낸다 (타입별 색상)
      onFeedItem: (minute, text, type) => showBanner((minute ? minute + ' ' : '') + text, FEED_KIND[type] || 'info'),
      onBanner: (text, kind) => showBanner(text, kind),
      onResult: (msg) => handleResult(msg),
    });
  }
  const engine = engineRef.current;

  // ---- WS message dispatch (mirrors handleWsMessage) ----
  useEffect(() => {
    const off = socket.on((msg: WsMessage) => {
      switch (msg.type) {
        case 'queued':
          setQueued(true);
          break;
        case 'cancelled':
          setQueued(false);
          break;
        case 'error':
          setQueued(false);
          setMatchError(String(msg.error));
          toast(String(msg.error));
          break;
        case 'match_start': {
          const startAll = msg as unknown as MatchStartAll;
          if (startAll.spectate) {
            startLiveMatch(startAll);
          } else {
            setPreviewMsg(startAll);
          }
          break;
        }
        case 'spectate_list':
          setSpectateList((msg.matches as SpectateRow[]) || []);
          break;
        case 'tick':
          engine.onTick(msg.minute as number, msg.display as string, msg.score as { home: number; away: number });
          break;
        case 'event':
          engine.onEvent(msg.event as MatchEvent);
          break;
        case 'phase':
          engine.onPhase(msg.text as string, !!msg.half);
          break;
        case 'paused': {
          setPauseDisabled(true);
          const pausesLeftMap = msg.pausesLeft as { home: number; away: number };
          setPausesLeft(pausesLeftMap[mySide] ?? 2);
          setPauseStatus(
            msg.yours ? `작전 타임 — 최대 ${msg.timeoutSec}초 안에 재개됩니다` : '상대 팀 작전 타임 중…'
          );
          engine.setPaused(true);
          if (msg.yours && msg.squad) {
            const squad = msg.squad as { formation: string; starters: (string | null)[] };
            setPauseFormation(squad.formation);
            setPauseStarters([...squad.starters]);
            setPoolKind((msg.poolKind as 'owned' | 'drawn') || 'owned');
            setPauseSel(null);
            setPausePanelOpen(true);
          }
          break;
        }
        case 'medical_timeout': {
          const isStrop = msg.reason === 'strop';
          const label = isStrop ? '태업' : '부상';
          setPauseDisabled(true);
          setPauseStatus(
            msg.yours
              ? `🚑 ${msg.player} — ${label}! 최대 ${msg.timeoutSec}초 안에 교체하세요`
              : `상대팀 ${label} 처리 중…`
          );
          engine.setPaused(true);
          if (msg.yours && msg.squad) {
            const squad = msg.squad as { formation: string; starters: (string | null)[] };
            setPauseFormation(squad.formation);
            setPauseStarters([...squad.starters]);
            setPoolKind((msg.poolKind as 'owned' | 'drawn') || 'owned');
            const injuredIdx = squad.starters.findIndex((id) => id === msg.playerId);
            setPauseSel(injuredIdx >= 0 ? injuredIdx : null);
            setPausePanelOpen(true);
          }
          break;
        }
        case 'resumed': {
          engine.setPaused(false);
          setPausePanelOpen(false);
          setPauseStatus('');
          const pausesLeftMap = msg.pausesLeft as { home: number; away: number };
          const left = pausesLeftMap[mySide] ?? 0;
          setPausesLeft(left);
          setPauseDisabled(left <= 0);
          break;
        }
        case 'squad_updated': {
          const side = msg.side as 'home' | 'away';
          const homeMsg = msg.home as { ratings: { OVR: number; formation: string }; players: CatalogPlayer[] };
          const awayMsg = msg.away as { ratings: { OVR: number; formation: string }; players: CatalogPlayer[] };
          const tn = matchTacticNamesRef.current;
          setHomeOvrLine(`OVR ${homeMsg.ratings.OVR} · ${homeMsg.ratings.formation} · ${tn.home}`);
          setAwayOvrLine(`OVR ${awayMsg.ratings.OVR} · ${awayMsg.ratings.formation} · ${tn.away}`);
          const possession = msg.possession as { home: number; away: number };
          engine.setPossHome(possession.home);
          engine.updateSide('home', homeMsg.ratings.formation, homeMsg.players);
          engine.updateSide('away', awayMsg.ratings.formation, awayMsg.players);
          if (side === mySide) {
            toast('스쿼드 변경 적용! 남은 경기가 새 전력으로 진행됩니다.');
            showBanner(`🔁 ${side === 'home' ? '홈' : '원정'} 팀 스쿼드 변경`, 'phase');
          } else {
            showBanner('🔁 상대 팀이 스쿼드를 변경했습니다', 'phase');
          }
          break;
        }
        case 'pvpcup_waiting':
          toast(String(msg.text || '출석 완료 — 상대의 입장을 기다립니다.'));
          loadPvpCup();
          break;
        case 'skip_ok': {
          const left = Number(msg.simTickets) || 0;
          const cur = useAppStore.getState().me;
          if (cur) useAppStore.getState().setMe({ ...cur, simTickets: left });
          toast(`⏩ 자동 시뮬레이션권 사용 — 남은 ${left}장`);
          break;
        }
        case 'skipped':
          engine.fastForward();
          showBanner('⏩ 자동 시뮬레이션 — 경기 결과로 건너뜁니다', 'phase');
          break;
        case 'result':
          engine.queueResult(msg as unknown as ResultMsg);
          break;
      }
    });
    const offClose = socket.onClose(() => {
      if (view === 'live') {
        toast('서버와의 연결이 끊어졌습니다.');
        backToLobby();
      }
      setQueued(false);
    });
    return () => {
      off();
      offClose();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mySide, view]);

  // ---- spectate polling (only while idle in the lobby, tab visible) ----
  useEffect(() => {
    if (!visible || view !== 'lobby') return;
    const poll = () => {
      if (!token) return;
      socket.send(token, { type: 'spectate_list' }).catch(() => {});
    };
    poll();
    const timer = setInterval(poll, 6000);
    return () => clearInterval(timer);
  }, [visible, view, token]);

  interface MatchStartAll {
    spectate?: boolean;
    youAre?: 'home' | 'away';
    mode?: string;
    referee?: { name: string; trait: string } | null;
    home: MatchStartMsg['home'] & { name: string; tacticName?: string };
    away: MatchStartMsg['away'] & { name: string; tacticName?: string };
    possession: { home: number; away: number };
    minute?: number;
    display?: string;
    score?: { home: number; away: number };
  }

  function startLiveMatch(msg: MatchStartAll) {
    setSpectating(!!msg.spectate);
    setMySide(msg.youAre || 'home');
    setLiveMode(msg.mode || '');
    matchTacticNamesRef.current = { home: msg.home.tacticName || '', away: msg.away.tacticName || '' };
    setQueued(false);
    setView('live');
    setResultMsg(null);
    setPausesLeft(2);
    setPauseDisabled(false);
    setPauseStatus('');
    setPausePanelOpen(false);

    setHomeName(msg.home.name);
    setAwayName(msg.away.name);
    setHomeOvrLine(`OVR ${msg.home.ratings.OVR} · ${msg.home.ratings.formation} · ${msg.home.tacticName || ''}`);
    setAwayOvrLine(`OVR ${msg.away.ratings.OVR} · ${msg.away.ratings.formation} · ${msg.away.tacticName || ''}`);
    setScore({ home: 0, away: 0 });
    setMinuteLabel("0'");
    setPossHomePct(msg.possession.home);

    if (!msg.spectate && me) {
      const kind = msg.mode === 'pvp' ? 'pvpSquad' : 'squad';
      const sq = me[kind] || { formation: '4-3-3', starters: new Array(11).fill(null) };
      setPauseFormation(sq.formation);
      setPauseStarters([...sq.starters]);
      setPoolKind(msg.mode === 'pvp' ? 'drawn' : 'owned');
      setPauseSel(null);
    }

    engine.start(msg as MatchStartMsg);

    if (msg.spectate) {
      showBanner(`👀 관전 시작 — ${msg.home.name} vs ${msg.away.name} (${msg.display || "0'"})`, 'phase');
    } else {
      showBanner(`📣 경기 시작! ${msg.home.name} vs ${msg.away.name}`, 'phase');
    }
  }

  function confirmMatchStart() {
    if (!previewMsg) return;
    const m = previewMsg;
    setPreviewMsg(null);
    startLiveMatch(m);
    sendWs({ type: 'ready' });
  }

  async function handleResult(msg: ResultMsg) {
    setResultMsg(msg);
    try {
      const { user } = await api.get<{ user: User }>('/api/me');
      useAppStore.getState().setMe(user);
    } catch {
      // ignore — header simply won't reflect the post-match reward until next refresh
    }
  }

  function backToLobby() {
    engine.stop();
    setView('lobby');
    setSpectating(false);
    setQueued(false);
    setResultMsg(null);
  }

  async function sendWs(msg: WsMessage) {
    if (!token) return;
    try {
      await socket.send(token, msg);
    } catch (err) {
      setMatchError(err instanceof Error ? err.message : String(err));
    }
  }

  const onQueue = () => {
    if (!me) return;
    const empty = (me.pvpSquad.starters || []).filter((id) => !id).length;
    if (
      empty > 0 &&
      !confirm(`실전 스쿼드에 빈 슬롯이 ${empty}개 있습니다.\n빈 자리는 유스 선수(OVR 40)가 대신 출전합니다. 그래도 참가할까요?`)
    ) {
      return;
    }
    setMatchError('');
    sendWs({ type: 'queue' });
  };

  const onQueueAi = () => {
    setMatchError('');
    sendWs({ type: 'queue_ai' });
  };

  const onQueueCup = () => {
    setMatchError('');
    sendWs({ type: 'queue_cup' });
  };

  const onQueuePvpCup = () => {
    setMatchError('');
    sendWs({ type: 'queue_pvpcup' });
  };

  const loadPvpCup = async () => {
    try {
      const { state } = await api.get<{ state: PvpCupInfo }>('/api/pvpcup');
      setPvpcupState(state);
    } catch {
      setPvpcupState(null);
    }
  };

  // 토너먼트 서브 뷰를 열 때(그리고 경기에서 로비로 돌아올 때) 상태 갱신.
  useEffect(() => {
    if (visible && view === 'lobby' && matchMode === 'pvpcup') loadPvpCup();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, view, matchMode]);

  // ---- pause panel (작전 타임 substitution) ----
  const pauseSlots = bootstrap?.formations[pauseFormation] || [];
  const pausePool = (me?.[poolKind === 'drawn' ? 'drawn' : 'owned'] || []) as string[];
  const pauseInXi = new Set(pauseStarters.filter(Boolean));
  const pauseBench = pausePool
    .filter((id) => !pauseInXi.has(id))
    .map((id) => (me ? upgradedCard(me, catalog.get(id)) : undefined))
    .filter((p): p is CatalogPlayer => !!p)
    .sort((a, b) => b.ovr - a.ovr)
    .slice(0, 40);

  const clickXi = (i: number) => {
    if (pauseSel === null) setPauseSel(i);
    else if (pauseSel === i) setPauseSel(null);
    else {
      const next = [...pauseStarters];
      const t = next[pauseSel];
      next[pauseSel] = next[i];
      next[i] = t;
      setPauseStarters(next);
      setPauseSel(null);
    }
  };

  const clickBench = (playerId: string) => {
    if (pauseSel === null) {
      toast('먼저 교체할 선발 선수를 선택하세요.');
      return;
    }
    const next = [...pauseStarters];
    next[pauseSel] = playerId;
    setPauseStarters(next);
    setPauseSel(null);
  };

  if (!me || !bootstrap) return null;

  return (
    <div id="tab-match" className={'tab-panel' + (visible ? '' : ' hidden')}>
      {previewMsg && (
        <div id="ref-preview-overlay">
          <div className="nego-modal ref-preview-modal">
            <div className="ref-preview-teams">
              <div className="ref-preview-team">
                {previewMsg.home.logo ? (
                  <img className="ref-preview-logo" src={previewMsg.home.logo} alt="" />
                ) : (
                  <div className="ref-preview-logo ref-preview-logo-fallback">⚽</div>
                )}
                <span className="ref-preview-team-name">{previewMsg.home.name}</span>
              </div>
              <span className="ref-preview-vs">VS</span>
              <div className="ref-preview-team">
                {previewMsg.away.logo ? (
                  <img className="ref-preview-logo" src={previewMsg.away.logo} alt="" />
                ) : (
                  <div className="ref-preview-logo ref-preview-logo-fallback">⚽</div>
                )}
                <span className="ref-preview-team-name">{previewMsg.away.name}</span>
              </div>
            </div>
            {previewMsg.referee && (
              <div className="ref-preview-referee">
                <div className="ref-preview-referee-name">🧑‍⚖️ {previewMsg.referee.name}</div>
                <p className="dim small-text ref-preview-referee-trait">{previewMsg.referee.trait}</p>
              </div>
            )}
            <button type="button" className="btn primary big ref-preview-start" onClick={confirmMatchStart}>
              시작
            </button>
          </div>
        </div>
      )}
      <div id="match-lobby" className={view === 'lobby' ? '' : 'hidden'}>
        <div className="sub-tabs match-mode-tabs">
          <button
            type="button"
            className={matchMode === 'quick' ? 'active' : ''}
            onClick={() => setMatchMode('quick')}
          >
            ⚔️ 빠른 대전
          </button>
          <button type="button" className={matchMode === 'cup' ? 'active' : ''} onClick={() => setMatchMode('cup')}>
            🏆 컵대회
          </button>
          <button
            type="button"
            className={matchMode === 'pvpcup' ? 'active' : ''}
            onClick={() => setMatchMode('pvpcup')}
          >
            🏟 토너먼트
          </button>
        </div>
        {matchMode === 'quick' ? (
          <div className="lobby-card">
            <h2>⚔️ 실시간 대전</h2>
            <p className="dim">경기는 스탯 기반으로 시뮬레이션되며, 90분이 탑뷰 실시간 중계로 재생됩니다.</p>
            <div className="lobby-buttons">
              <button type="button" className="btn primary big" disabled={queued} onClick={onQueue}>
                랭크 매치 (유저 대전)
              </button>
              <p className="dim small-text">
                랭크 매치는 <b>실전 스쿼드</b>(뽑기로 획득한 카드)로 진행됩니다.
              </p>
              <button type="button" className="btn big" disabled={queued} onClick={onQueueAi}>
                클럽팀 상대 연습 경기 (AI)
              </button>
              <p className="dim small-text">연습 경기는 클럽 스쿼드로 진행되며, 상대는 무작위 클럽팀입니다.</p>
            </div>
            <div id="queue-status" className={queued ? '' : 'hidden'}>
              <div className="spinner" />
              <span>상대를 찾는 중...</span>
              <button type="button" className="btn ghost small" onClick={() => sendWs({ type: 'cancel' })}>
                취소
              </button>
            </div>
            <div id="match-error" className="error-msg">
              {matchError}
            </div>
          </div>
        ) : matchMode === 'cup' ? (
          me.cup && <CupBracket cup={me.cup} onStart={onQueueCup} disabled={queued} error={matchError} />
        ) : (
          <PvpCupPanel
            state={pvpcupState}
            onEnter={onQueuePvpCup}
            onRefresh={loadPvpCup}
            disabled={queued}
            error={matchError}
          />
        )}
        <div className="lobby-card spectate-card">
          <h2>👀 관전</h2>
          <p className="dim small-text">진행 중인 다른 경기를 실시간으로 지켜볼 수 있습니다.</p>
          <div id="spectate-list">
            {!spectateList.length ? (
              <p className="dim small-text">진행 중인 경기가 없습니다.</p>
            ) : (
              spectateList.map((m) => (
                <div className="spec-row" key={m.id}>
                  <span className="spec-mode">
                    {m.mode === 'pvp' ? '랭크' : m.mode === 'pvpcup' ? '토너먼트' : m.mode === 'cup' ? '컵' : 'AI전'}
                  </span>
                  <span className="spec-names">
                    {m.home} <b>{m.score.home} - {m.score.away}</b> {m.away}
                  </span>
                  <span className="dim small-text">{m.display}</span>
                  <button type="button" className="btn small primary" onClick={() => sendWs({ type: 'spectate', matchId: m.id })}>
                    관전
                  </button>
                </div>
              ))
            )}
          </div>
        </div>
      </div>

      <div id="match-live" className={view === 'live' ? '' : 'hidden'}>
        <div className="scoreboard">
          <div className="sb-team home">
            <div className="sb-name">{homeName}</div>
            <div className="sb-ovr dim">{homeOvrLine}</div>
          </div>
          <div className="sb-center">
            <div id="sb-score">
              {score.home} - {score.away}
            </div>
            <div id="sb-minute" className="sb-minute">
              {minuteLabel}
            </div>
          </div>
          <div className="sb-team away">
            <div className="sb-name">{awayName}</div>
            <div className="sb-ovr dim">{awayOvrLine}</div>
          </div>
        </div>
        <div id="event-banner" key={banner?.token} className={banner ? `eb-${banner.kind}` : 'eb-info'}>
          {banner?.text || ' '}
        </div>
        <div className="pause-bar" style={{ display: spectating ? 'none' : undefined }}>
          <button type="button" className="btn small" disabled={pauseDisabled} onClick={() => sendWs({ type: 'pause' })}>
            ⏸ 작전 타임 (<span>{pausesLeft}</span>)
          </button>
          {liveMode !== 'pvp' && !resultMsg && (
            <button
              type="button"
              className="btn small"
              title="자동 시뮬레이션권 1장을 사용해 경기 결과로 즉시 건너뜁니다"
              onClick={() => {
                if ((me.simTickets || 0) <= 0) {
                  toast('자동 시뮬레이션권이 없습니다. 상점의 기타 탭에서 구매하세요.');
                  return;
                }
                sendWs({ type: 'skip' });
              }}
            >
              ⏩ 건너뛰기 ({me.simTickets || 0})
            </button>
          )}
          <span className="dim small-text">{pauseStatus}</span>
        </div>
        <div id="spectate-bar" className={'pause-bar' + (spectating ? '' : ' hidden')}>
          <span className="spec-tag">👀 관전 중</span>
          <button
            type="button"
            className="btn small"
            onClick={() => {
              sendWs({ type: 'spectate_leave' });
              backToLobby();
            }}
          >
            관전 종료
          </button>
        </div>
        <div className="match-stage">
          <div className="pitch-wrap">
            <LiveMatchCanvas engine={engine} />
          </div>
          <div id="pause-panel" className={pausePanelOpen ? '' : 'disabled'} style={{ display: spectating ? 'none' : undefined }}>
            <div className="pp-head">
              <b>⏸ 작전 타임</b>
              <span className="dim small-text">포지션을 바꾸거나 선수를 교체하세요 — 남은 경기가 새 스쿼드로 진행됩니다</span>
            </div>
            <div className="pp-row">
              <label className="dim small-text">포메이션</label>
              <select
                value={pauseFormation}
                onChange={(e) => {
                  setPauseFormation(e.target.value);
                }}
              >
                {Object.keys(bootstrap.formations).map((f) => (
                  <option key={f} value={f}>
                    {f}
                  </option>
                ))}
              </select>
              <button
                type="button"
                className="btn small primary"
                onClick={() => sendWs({ type: 'update_squad', formation: pauseFormation, starters: pauseStarters })}
              >
                변경 적용
              </button>
              <button type="button" className="btn small" onClick={() => sendWs({ type: 'resume' })}>
                ▶ 경기 재개
              </button>
            </div>
            <div className="pp-cols">
              <div>
                <h4 className="pp-h">
                  선발 XI <span className="dim small-text">(두 명을 눌러 자리 교체)</span>
                </h4>
                <div id="pp-xi">
                  {pauseSlots.map((pos, i) => {
                    const p = pauseStarters[i] ? upgradedCard(me, catalog.get(pauseStarters[i] as string)) : null;
                    return (
                      <button
                        key={i}
                        type="button"
                        className={'pp-list-item' + (pauseSel === i ? ' selected' : '')}
                        onClick={() => clickXi(i)}
                      >
                        <span className="pp-pos">{pos}</span>
                        <span>{p ? p.name : <span className="dim">빈 슬롯</span>}</span>
                        <span className="pp-ovr">{p ? p.ovr : ''}</span>
                      </button>
                    );
                  })}
                </div>
              </div>
              <div>
                <h4 className="pp-h">
                  벤치 <span className="dim small-text">(선발 선택 후 눌러 교체 투입 · 경기당 5명)</span>
                </h4>
                <div id="pp-bench">
                  {!pauseBench.length && <p className="dim small-text">교체 투입할 수 있는 선수가 없습니다.</p>}
                  {pauseBench.map((p) => (
                    <button key={p.id} type="button" className="pp-list-item" onClick={() => clickBench(p.id)}>
                      <span className="pp-pos">{p.pos}</span>
                      <span>{p.name}</span>
                      <span className="pp-ovr">{p.ovr}</span>
                    </button>
                  ))}
                </div>
              </div>
            </div>
          </div>
        </div>
        <div className="poss-wrap">
          <span className="dim small-text">점유율</span>
          <div className="poss-bar">
            <div id="poss-home" className="poss-home" style={{ width: possHomePct + '%' }} />
          </div>
          <div className="poss-nums">
            <span>{homeName} {possHomePct}%</span>
            <span>{100 - possHomePct}% {awayName}</span>
          </div>
        </div>
      </div>

      {resultMsg && (
        <div
          id="result-overlay"
          onClick={(e) => {
            if (e.target === e.currentTarget) backToLobby();
          }}
        >
          <div className="result-modal">
            {resultMsg.cup?.champion && (
              <div className="cup-champion-fx">
                <div className="cup-champion-sparks">
                  {cupSparks().map((s, i) => (
                    <span
                      key={i}
                      className="cere-spark"
                      style={{ '--dx': s.dx + 'px', '--dy': s.dy + 'px', background: s.color, animationDelay: s.delay } as React.CSSProperties}
                    />
                  ))}
                </div>
                <div className="cup-trophy-emoji">🏆</div>
              </div>
            )}
            <div id="result-banner" className={resultMsg.outcome || ''}>
              {(resultMsg.outcome && RESULT_LABELS[resultMsg.outcome]) || '경기 종료'}
            </div>
            <div id="result-score">
              <span>{resultMsg.home}</span>
              <b>
                {resultMsg.score.home} - {resultMsg.score.away}
              </b>
              <span>{resultMsg.away}</span>
            </div>
            <div id="result-detail" className="dim">
              xG {resultMsg.xg.home} : {resultMsg.xg.away} · 점유율 {resultMsg.possession.home}% : {resultMsg.possession.away}%
              {resultMsg.reward && (
                <>
                  <br />
                  보상: 🪙 {resultMsg.reward.coins.toLocaleString()} · 승점 +{resultMsg.reward.points}
                </>
              )}
              {resultMsg.cup && (
                <>
                  <br />
                  <span className="cup-result-note">
                    {resultMsg.cup.champion
                      ? '🏆 컵대회 우승! 골드팩 보상이 우편함에 도착했습니다.'
                      : resultMsg.cup.advanced
                      ? `🏆 ${CUP_ROUND_LABELS[resultMsg.cup.round]} 통과${resultMsg.cup.shootout ? ' (승부차기)' : ''} — 다음 라운드 진출!`
                      : `🏆 ${CUP_ROUND_LABELS[resultMsg.cup.round]}에서 탈락했습니다${resultMsg.cup.shootout ? ' (승부차기 패)' : ''}.`}
                  </span>
                </>
              )}
              {resultMsg.pvpcup && (
                <>
                  <br />
                  <span className="cup-result-note">
                    {resultMsg.pvpcup.winnerSide === mySide
                      ? `🏟 토너먼트 승리${resultMsg.pvpcup.shootout ? ` (승부차기 ${resultMsg.pvpcup.shootout.homeScore}:${resultMsg.pvpcup.shootout.awayScore})` : ''} — 다음 라운드 진출!`
                      : `🏟 토너먼트 탈락${resultMsg.pvpcup.shootout ? ' (승부차기 패)' : ''} — 다음 주기에 다시 도전하세요.`}
                  </span>
                </>
              )}
            </div>
            <button type="button" className="btn primary" onClick={backToLobby}>
              로비로 돌아가기
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
