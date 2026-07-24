import { useEffect, useRef, useState } from 'react';
import { useAppStore } from '../../store/useAppStore';
import { toast } from '../../store/useToastStore';
import { api } from '../../api/client';
import { socket, type WsMessage } from '../../ws/socket';
import { LiveMatchEngine, type MatchEvent, type MatchStartMsg, type ResultMsg } from '../../game/liveMatchEngine';
import { upgradedCard } from '../../game/cards';
import type { CatalogPlayer, User } from '../../types';

interface SpectateRow {
  id: string;
  mode: string;
  home: string;
  away: string;
  score: { home: number; away: number };
  display: string;
}

interface FeedLine {
  id: number;
  minute: string;
  text: string;
  type: string;
}

let feedSeq = 0;

const RESULT_LABELS: Record<'win' | 'loss' | 'draw', string> = {
  win: '🎉 승리!',
  loss: '😢 패배',
  draw: '🤝 무승부',
};

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
  const [queued, setQueued] = useState(false);
  const [matchError, setMatchError] = useState('');
  const [spectateList, setSpectateList] = useState<SpectateRow[]>([]);
  const [spectating, setSpectating] = useState(false);
  const [mySide, setMySide] = useState<'home' | 'away'>('home');

  const [homeName, setHomeName] = useState('');
  const [awayName, setAwayName] = useState('');
  const [homeOvrLine, setHomeOvrLine] = useState('');
  const [awayOvrLine, setAwayOvrLine] = useState('');
  const [minuteLabel, setMinuteLabel] = useState("0'");
  const [score, setScore] = useState({ home: 0, away: 0 });
  const [possHomePct, setPossHomePct] = useState(50);
  const [feed, setFeed] = useState<FeedLine[]>([]);
  const [banner, setBanner] = useState<{ text: string; kind: string; token: number } | null>(null);
  const [pausesLeft, setPausesLeft] = useState(2);
  const [pauseDisabled, setPauseDisabled] = useState(false);
  const [pauseStatus, setPauseStatus] = useState('');
  const [pausePanelOpen, setPausePanelOpen] = useState(false);
  const [resultMsg, setResultMsg] = useState<ResultMsg | null>(null);

  const [pauseFormation, setPauseFormation] = useState('4-3-3');
  const [pauseStarters, setPauseStarters] = useState<(string | null)[]>([]);
  const [poolKind, setPoolKind] = useState<'owned' | 'drawn'>('owned');
  const [pauseSel, setPauseSel] = useState<number | null>(null);

  const feedRef = useRef<HTMLDivElement>(null);
  const bannerTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const matchTacticNamesRef = useRef({ home: '', away: '' });

  const engineRef = useRef<LiveMatchEngine | null>(null);
  if (!engineRef.current) {
    engineRef.current = new LiveMatchEngine({
      onMinute: (label) => setMinuteLabel(label),
      onScore: (h, a) => setScore({ home: h, away: a }),
      onPossession: (homePct) => setPossHomePct(homePct),
      onFeedItem: (minute, text, type) => {
        feedSeq++;
        setFeed((f) => [...f, { id: feedSeq, minute, text, type }]);
      },
      onBanner: (text, kind, ms) => {
        if (bannerTimerRef.current) clearTimeout(bannerTimerRef.current);
        setBanner({ text, kind, token: Date.now() });
        bannerTimerRef.current = setTimeout(() => setBanner(null), ms || 2600);
      },
      onResult: (msg) => handleResult(msg),
    });
  }
  const engine = engineRef.current;

  useEffect(() => {
    if (feedRef.current) feedRef.current.scrollTop = feedRef.current.scrollHeight;
  }, [feed]);

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
        case 'match_start':
          startLiveMatch(msg as unknown as MatchStartAll);
          break;
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
            engine.onEvent({
              minute: 0,
              type: 'phase',
              team: 'home',
              text: `🔁 ${side === 'home' ? '홈' : '원정'} 팀 스쿼드 변경`,
            });
            feedSeq++;
            setFeed((f) => [
              ...f,
              { id: feedSeq, minute: '', text: `🔁 ${side === 'home' ? '홈' : '원정'} 팀 스쿼드 변경`, type: 'phase' },
            ]);
          } else {
            feedSeq++;
            setFeed((f) => [...f, { id: feedSeq, minute: '', text: '🔁 상대 팀이 스쿼드를 변경했습니다', type: 'phase' }]);
          }
          break;
        }
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
    matchTacticNamesRef.current = { home: msg.home.tacticName || '', away: msg.away.tacticName || '' };
    setQueued(false);
    setView('live');
    setResultMsg(null);
    setFeed([]);
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

    feedSeq++;
    if (msg.spectate) {
      setFeed([{ id: feedSeq, minute: '', text: `👀 관전 시작 — ${msg.home.name} vs ${msg.away.name} (${msg.display || "0'"})`, type: 'phase' }]);
    } else {
      setFeed([{ id: feedSeq, minute: '', text: `📣 경기 시작! ${msg.home.name} vs ${msg.away.name}`, type: 'phase' }]);
    }
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
      <div id="match-lobby" className={view === 'lobby' ? '' : 'hidden'}>
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
        <div className="lobby-card spectate-card">
          <h2>👀 관전</h2>
          <p className="dim small-text">진행 중인 다른 경기를 실시간으로 지켜볼 수 있습니다.</p>
          <div id="spectate-list">
            {!spectateList.length ? (
              <p className="dim small-text">진행 중인 경기가 없습니다.</p>
            ) : (
              spectateList.map((m) => (
                <div className="spec-row" key={m.id}>
                  <span className="spec-mode">{m.mode === 'pvp' ? '랭크' : 'AI전'}</span>
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
        <div className="pause-bar" style={{ display: spectating ? 'none' : undefined }}>
          <button type="button" className="btn small" disabled={pauseDisabled} onClick={() => sendWs({ type: 'pause' })}>
            ⏸ 작전 타임 (<span>{pausesLeft}</span>)
          </button>
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
            <div id="event-banner" key={banner?.token} className={banner ? `eb-${banner.kind} show` : ''}>
              {banner?.text}
            </div>
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
        <div id="match-feed" ref={feedRef}>
          {feed.map((f) => (
            <div className={'feed-item ' + f.type} key={f.id}>
              <span className="fi-min">{f.minute}</span>
              <span>{f.text}</span>
            </div>
          ))}
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
