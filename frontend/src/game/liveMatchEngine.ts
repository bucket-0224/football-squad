import { COORDS } from './formationCoords';

// Near-verbatim TypeScript port of the vanilla top-view live-match canvas
// engine (frontend/app.js's `viz` object + `viz*` functions). Deliberately
// NOT rewritten into declarative React state — this is tuned real-time
// physics/AI with no test coverage; rewriting it risks silently changing
// match behavior. The only real change from the original is the I/O
// boundary: direct `$('#foo').textContent = ...` DOM writes become callback
// invocations so a wrapping React component can render the scoreboard,
// possession bar, feed, and banner as normal JSX.

export interface MatchEvent {
  minute: number;
  type: string;
  team: 'home' | 'away';
  player?: string;
  playerId?: string | null;
  assist?: string | null;
  assistId?: string | null;
  via?: string | null;
  red?: boolean | null;
  severity?: 'minor' | 'major' | null;
  ownGoal?: boolean | null;
  ownGoalPlayerId?: string | null;
  ownGoalTeam?: 'home' | 'away' | null;
  awardedTeam?: 'home' | 'away' | null;
  text: string;
  score?: { home: number; away: number };
}

interface SideCard {
  id?: string;
  name?: string;
  attrs?: {
    pace?: number;
    shooting?: number;
    passing?: number;
    dribbling?: number;
    defending?: number;
    physical?: number;
  };
}

interface SideStart {
  name?: string;
  logo?: string | null;
  ratings: { OVR: number; formation: string };
  tactic?: string;
  tacticName?: string;
  players: SideCard[];
}

export interface MatchStartMsg {
  home: SideStart;
  away: SideStart;
  possession: { home: number; away: number };
  youAre?: 'home' | 'away';
  spectate?: boolean;
  minute?: number;
  display?: string;
  score?: { home: number; away: number };
}

export interface ResultMsg {
  score: { home: number; away: number };
  outcome?: 'win' | 'loss' | 'draw';
  home: string;
  away: string;
  xg: { home: number; away: number };
  possession: { home: number; away: number };
  reward?: { coins: number; points: number };
  finalMinute?: number;
}

export interface LiveMatchCallbacks {
  onMinute: (label: string) => void;
  onScore: (home: number, away: number) => void;
  onPossession: (homePct: number) => void;
  onFeedItem: (minute: string, text: string, type: string) => void;
  onBanner: (text: string, kind: string, ms: number) => void;
  onResult: (msg: ResultMsg) => void;
}

type Side = 'home' | 'away';

interface Sprite {
  num: number;
  gk: boolean;
  off: boolean;
  isHome: boolean;
  id: string | null;
  label: string;
  paceMul: number;
  dribMul: number;
  passMul: number;
  defMul: number;
  shotMul: number;
  baseX: number;
  baseY: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  run: { tx: number; ty: number; until: number } | null;
  phase: number;
  speed: number;
  depthOff?: number;
}

interface ScriptStep {
  x: number;
  y: number;
  speed: number;
  wait: number;
  onDone?: () => void;
  track: Sprite | null;
  holdFor: Sprite | null;
  holdT: number;
}

interface AttackState {
  e: MatchEvent;
  hurry: number;
  timeLeft: number;
  phase: 'advance' | 'finish';
  longShot: boolean;
  ceremony?: boolean;
  wall?: Sprite[];
  taker?: Sprite;
}

interface DuelState {
  e: MatchEvent;
  fkSide: Side;
  t: number;
  advantage: boolean;
  chaser?: Sprite | null;
}

interface KickoffState {
  side: Side;
  t: number;
  taker: Sprite;
}

const VIZ = { W: 860, H: 520, M: 34 };
// 전체 재생 시간 상한: 이벤트를 절대 건너뛰지 않되, 큐에 쌓인 백로그(실제
// 시뮬레이션 데이터)로 남은 재생 시간을 추정해 최대 VIZ_TIME_CAP_SEC 안에는
// 경기가 끝나도록 배속을 조절한다 (평소엔 1배속, 밀릴 때만 최대 VIZ_MAX_SPEED).
const VIZ_TIME_CAP_SEC = 180;
const VIZ_MAX_SPEED = 4;
const VIZ_AVG_EVENT_SEC = 2.4;
const BOX_DEPTH = 100;
const BOX_WIDTH = 200;

const VIZ_TACT: Record<string, { line: number; press: number; engage: number; tempo: number; runFreq: number; carrier: number; longShot: number; shootFrom: number }> = {
  attacking: { line: 70, press: 2, engage: 2000, tempo: 1.25, runFreq: 1.7, carrier: 1.15, longShot: 0.2, shootFrom: 185 },
  balanced: { line: 0, press: 1, engage: 520, tempo: 1.0, runFreq: 1.0, carrier: 1.0, longShot: 0.3, shootFrom: 170 },
  defensive: { line: -60, press: 1, engage: 330, tempo: 0.85, runFreq: 0.6, carrier: 0.9, longShot: 0.45, shootFrom: 155 },
  counter: { line: -40, press: 1, engage: 400, tempo: 1.1, runFreq: 1.2, carrier: 1.1, longShot: 0.35, shootFrom: 170 },
};

function vizAttrMul(v: number | undefined): number {
  return 0.8 + ((Math.max(40, Math.min(99, v || 55)) - 40) / 59) * 0.45;
}

function vizShortName(name: string | undefined): string {
  if (!name) return '';
  // enhanced/icon cards carry a literal tier suffix in their name (e.g.
  // "Kane (Ultra)", "Xavi Hernandez (Icon)") — strip it before taking the
  // last token, or the suffix itself becomes the sprite's label/commentary
  // name instead of the player's actual surname.
  const base = String(name).trim().replace(/\s*\([^)]*\)\s*$/, '');
  const last = base.split(/\s+/).pop() || '';
  return last.length > 10 ? last.slice(0, 9) + '…' : last;
}

// Backend event text embeds the player's full catalog name verbatim (e.g.
// "⚽ Kane (Ultra) 골!"), same source as the sprite label bug fixed earlier —
// but that fix only touched the sprite label, not this text. Since `player`/
// `assist` are guaranteed exact substrings of `text` (the backend
// interpolates them directly), swap them for the short form wherever they
// appear so the live toast reads the same name as the pitch sprite.
function shortenEventText(text: string, player?: string | null, assist?: string | null): string {
  let out = text;
  if (player) out = out.split(player).join(vizShortName(player));
  if (assist) out = out.split(assist).join(vizShortName(assist));
  return out;
}

// Vertical editor coords [x%, y% from own goal] -> top view (home attacks →).
function vizSpot(coord: [number, number], isHome: boolean): { x: number; y: number } {
  const [xv, yv] = coord;
  const halfW = VIZ.W / 2 - VIZ.M - 14;
  let x = VIZ.M + (yv / 100) * halfW;
  let y = VIZ.M + (xv / 100) * (VIZ.H - 2 * VIZ.M);
  if (!isHome) {
    x = VIZ.W - x;
    y = VIZ.H - y;
  }
  return { x, y };
}

const ballImg = new Image();
ballImg.src = '/img/ball.png';

export class LiveMatchEngine {
  private cb: LiveMatchCallbacks;
  private canvas: HTMLCanvasElement | null = null;
  private ctx: CanvasRenderingContext2D | null = null;
  private raf: number | null = null;
  private active = false;
  private frameBound = (ts: number) => this.frame(ts);
  private bannerTimer: ReturnType<typeof setTimeout> | null = null;
  private onVisibilityBound = () => {
    if (document.visibilityState === 'visible') this.catchUpAfterHidden();
  };

  // ---- viz state (mirrors the vanilla `viz` object) ----
  private players: Sprite[] = [];
  private ball: { x: number; y: number } = { x: 0, y: 0 };
  private ballAngle = 0;
  private possession: Side = 'home';
  private carrier: Sprite | null = null;
  private script: ScriptStep[] = [];
  private queue: MatchEvent[] = [];
  private attack: AttackState | null = null;
  private runner: Sprite | null = null;
  private pendingResult: ResultMsg | null = null;
  private tactics: Record<Side, string> = { home: 'balanced', away: 'balanced' };
  private line: Record<Side, number> = { home: 140, away: 140 };
  private breakT: Record<Side, number> = { home: 0, away: 0 };
  private passTimer = 0.8;
  private possHome = 50;
  private collect = false;
  private stealCd = 0;
  private chanceCd = 0;
  private offsideCd = 0;
  private goalKick = false;
  private kickoff: KickoffState | null = null;
  private paused = false;
  private flip = false;
  private secondHalf = false;
  private duel: DuelState | null = null;
  private pendingHalf = false;
  private pendingHalfText: string | null = null;
  private names: Record<Side, string> = { home: '', away: '' };
  private srvMin = 0;
  private dispMin = 0;
  private shownMin = -1;
  private matchStartTs = 0;
  private possTime: Record<Side, number> = { home: 0, away: 0 };
  private possUiT = 0;
  private comCd = 0;
  private flash: { text: string; until: number } | null = null;
  private lastTs = 0;
  private now = 0;

  constructor(callbacks: LiveMatchCallbacks) {
    this.cb = callbacks;
  }

  // ---- public lifecycle ----

  mount(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    document.addEventListener('visibilitychange', this.onVisibilityBound);
  }

  unmount() {
    this.stop();
    document.removeEventListener('visibilitychange', this.onVisibilityBound);
    this.canvas = null;
    this.ctx = null;
  }

  // 탭이 백그라운드로 가면 브라우저가 requestAnimationFrame을 거의 멈추거나
  // 크게 늦추지만, 서버 WS 이벤트는 그대로 계속 도착해 queue에 쌓인다. 다시
  // 눈에 보이는 순간 그 밀린 분량을 정상 프레임에서 처리하려 하면 backlogSec이
  // 커져 speedMul이 최대 4배까지 뛰어, 그 몇 초 동안 선수들이 부자연스럽게
  // 빠르게(거의 순간이동처럼 보이게) 움직인다 — "필드 위 선수가 스킵되거나
  // 갑자기 나타난다"는 증상의 실제 원인. 다시 보이는 시점에 밀린 이벤트를
  // 애니메이션 없이 조용히 정리해 정상 배속으로 즉시 복귀시킨다.
  private catchUpAfterHidden() {
    if (!this.active) return;
    while (this.queue.length) {
      const e = this.queue.shift() as MatchEvent;
      if (e.score) this.cb.onScore(e.score.home, e.score.away);
      this.cb.onFeedItem(e.minute + "'", e.text, e.type);
    }
    this.attack = null;
    this.duel = null;
    this.script = [];
    this.carrier = null;
    this.runner = null;
    this.dispMin = this.srvMin;
    this.shownMin = Math.floor(this.dispMin);
    this.cb.onMinute(this.shownMin <= 90 ? `${this.shownMin}'` : `90+${this.shownMin - 90}'`);
    // matchStartTs/lastTs 리셋 — 다음 프레임이 방금 정리한 backlog를 다시
    // "밀린 시간"으로 계산해 speedMul을 또 올리는 걸 막는다.
    this.matchStartTs = 0;
    this.lastTs = 0;
  }

  start(msg: MatchStartMsg) {
    this.stop();
    if (!this.canvas) return;
    this.players = [];
    (['home', 'away'] as Side[]).forEach((side) => {
      const isHome = side === 'home';
      const formation = msg[side].ratings.formation;
      const coords = COORDS[formation] || COORDS['4-3-3'];
      const lineup = msg[side].players || [];
      coords.forEach((c, i) => {
        const base = vizSpot(c, isHome);
        const card = lineup[i];
        const a = (card && card.attrs) || {};
        this.players.push({
          num: i + 1,
          gk: i === 0,
          off: false,
          isHome,
          id: (card && card.id) || null,
          label: vizShortName(card && card.name),
          paceMul: vizAttrMul(a.pace),
          dribMul: vizAttrMul(a.dribbling),
          passMul: vizAttrMul(a.passing),
          defMul: vizAttrMul(a.defending),
          shotMul: vizAttrMul(a.shooting),
          baseX: base.x,
          baseY: base.y,
          x: base.x,
          y: base.y,
          vx: 0,
          vy: 0,
          run: null,
          phase: Math.random() * Math.PI * 2,
          speed: 0.5 + Math.random() * 0.8,
        });
      });
    });
    this.ball = { x: VIZ.W / 2, y: VIZ.H / 2 };
    this.ballAngle = 0;
    this.script = [];
    this.queue = [];
    this.attack = null;
    this.runner = null;
    this.pendingResult = null;
    this.tactics = { home: msg.home.tactic || 'balanced', away: msg.away.tactic || 'balanced' };
    this.line = { home: 140, away: 140 };
    this.breakT = { home: 0, away: 0 };
    this.paused = false;
    this.computeDepthOffsets();
    this.passTimer = 0.6;
    this.possHome = msg.possession.home;
    if (msg.spectate) {
      const possSide: Side = msg.possession.home >= msg.possession.away ? 'home' : 'away';
      const holder = this.midfielder(possSide);
      this.possession = possSide;
      this.carrier = holder;
      this.ball.x = holder.x;
      this.ball.y = holder.y;
      this.passTimer = 0.3;
    } else {
      this.stageKickoff('home');
    }
    this.collect = false;
    this.stealCd = 0;
    this.chanceCd = 0;
    this.offsideCd = 0;
    this.goalKick = false;
    this.flip = msg.youAre === 'away';
    this.secondHalf = false;
    this.duel = null;
    this.pendingHalf = false;
    this.pendingHalfText = null;
    this.names = { home: msg.home.name || '홈', away: msg.away.name || '어웨이' };
    this.srvMin = 0;
    this.dispMin = 0;
    this.shownMin = -1;
    this.possTime = { home: 0, away: 0 };
    this.possUiT = 0;
    this.comCd = 0;
    this.flash = null;
    this.lastTs = 0;
    this.matchStartTs = 0;
    this.active = true;

    if (msg.spectate) {
      this.srvMin = msg.minute || 0;
      this.dispMin = msg.minute || 0;
      this.cb.onMinute(msg.display || `${msg.minute || 0}'`);
      if (msg.score) this.cb.onScore(msg.score.home, msg.score.away);
    }

    this.raf = requestAnimationFrame(this.frameBound);
  }

  stop() {
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = null;
    this.active = false;
    if (this.bannerTimer) clearTimeout(this.bannerTimer);
  }

  // ---- WS message entry points (mirror handleWsMessage's viz-related cases) ----

  onTick(minute: number, display: string, score: { home: number; away: number }) {
    this.srvMin = minute;
    if (!this.raf) {
      this.cb.onMinute(display || minute + "'");
      this.cb.onScore(score.home, score.away);
    }
    this.tickPossessionRoll();
  }

  onEvent(e: MatchEvent) {
    e.text = shortenEventText(e.text, e.player, e.assist);
    if (this.raf) this.queue.push(e);
    else this.cb.onFeedItem(e.minute + "'", e.text, e.type);
  }

  onPhase(text: string, half: boolean) {
    if (half && this.raf) {
      this.pendingHalf = true;
      this.pendingHalfText = text;
    } else {
      this.cb.onFeedItem('', text, 'phase');
      this.cb.onBanner(text, 'phase', 2600);
    }
  }

  setPaused(paused: boolean) {
    this.paused = paused;
  }

  updateSide(side: Side, formation: string, lineup: SideCard[]) {
    if (!this.players.length) return;
    const isHome = side === 'home';
    const coords = COORDS[formation] || COORDS['4-3-3'];
    this.team(side).forEach((p, i) => {
      const base = vizSpot(coords[i] || coords[coords.length - 1], isHome);
      p.baseX = base.x;
      p.baseY = base.y;
      const card = lineup && lineup[i];
      const a = (card && card.attrs) || {};
      // id를 안 바꾸면 라이브 교체 이후 이 슬롯을 가리키는 새 이벤트가
      // findSprite()의 id 매칭에서 실패해(옛 선수 id로 남아있으니) 조용히
      // 엉뚱한 선수를 찾거나 아무도 못 찾는다 — 등번호/이름은 즉시 바뀌어
      // 보였는데 실제로는 옛 선수를 계속 추적하던 원인.
      p.id = (card && card.id) || null;
      p.label = vizShortName(card && card.name);
      p.paceMul = vizAttrMul(a.pace);
      p.dribMul = vizAttrMul(a.dribbling);
      p.passMul = vizAttrMul(a.passing);
      p.defMul = vizAttrMul(a.defending);
      p.shotMul = vizAttrMul(a.shooting);
      // 이 슬롯이 부상/태업으로 off 처리돼 있었더라도, 라이브 교체로 새
      // 선수가 들어왔으면 당연히 뛸 수 있어야 한다 — 안 풀어주면 방금
      // 들어온 교체 선수가 계속 필드 밖 취급을 받는다.
      p.off = false;
    });
    this.computeDepthOffsets();
  }

  setPossHome(pct: number) {
    this.possHome = pct;
  }

  queueResult(msg: ResultMsg) {
    if (this.raf) this.pendingResult = msg;
    else this.deliverResult(msg);
  }

  private deliverResult(msg: ResultMsg) {
    this.cb.onFeedItem('FT', `📣 경기 종료 (${msg.score.home} - ${msg.score.away})`, 'phase');
    this.cb.onResult(msg);
  }

  // ---- internal helpers (ported ~1:1 from the vanilla viz* functions) ----

  private name(p: Sprite | null): string {
    return (p && p.label) || '선수';
  }

  private say(text: string) {
    if (this.comCd > 0) return;
    this.comCd = 1.5;
    this.cb.onFeedItem('', text, 'live');
  }

  private ballDistOwn(side: Side): number {
    return side === 'home' ? this.ball.x - VIZ.M : VIZ.W - VIZ.M - this.ball.x;
  }

  private tact(side: Side) {
    return VIZ_TACT[this.tactics[side]] || VIZ_TACT.balanced;
  }

  private stageKickoff(side: Side) {
    const team = this.team(side);
    this.possession = side;
    this.carrier = null;
    this.runner = null;
    this.collect = false;
    const taker =
      [team[9], team[8], team[6]].find((p) => p && !p.off) || team.find((p) => !p.gk && !p.off);
    this.kickoff = { side, t: this.queue.length ? 0.7 : 1.4, taker: taker as Sprite };
  }

  private takeover(side: Side, carrier: Sprite | null) {
    if (this.possession !== side && this.tactics[side] === 'counter') this.breakT[side] = 2.5;
    this.possession = side;
    this.carrier = carrier;
    this.goalKick = false;
    this.stealCd = 0.9;
    if (this.ballDistOwn(side) < 190) this.passTimer = Math.min(this.passTimer, 0.25);
  }

  private computeDepthOffsets() {
    (['home', 'away'] as Side[]).forEach((side) => {
      const team = this.players.filter((p) => p.isHome === (side === 'home'));
      if (!team.length) return;
      const distOwn = (p: Sprite) => (side === 'home' ? p.baseX - VIZ.M : VIZ.W - VIZ.M - p.baseX);
      [1, 2, 3].forEach((role) => {
        const grp = team.filter((p) => !p.gk && (p.num <= 5 ? 1 : p.num <= 8 ? 2 : 3) === role);
        const avg = grp.reduce((s, p) => s + distOwn(p), 0) / (grp.length || 1);
        grp.forEach((p) => {
          p.depthOff = distOwn(p) - avg;
        });
      });
      team[0].depthOff = 0;
    });
  }

  private team(side: Side): Sprite[] {
    return this.players.filter((p) => p.isHome === (side === 'home'));
  }

  // 이벤트가 가리키는 실제 선수의 스프라이트를 찾는다 — playerId가 있으면
  // id로 정확히 매칭하고(같은 성을 가진 동료가 있어도 안 헷갈림), 없는
  // 과거 데이터/엣지 케이스에서만 이름 문자열 매칭으로 폴백한다. 예전엔
  // 항상 이름 매칭만 썼는데, 매칭이 실패하거나 동명이인일 때 득점 배너/
  // 스탯은 맞는 선수를 가리키면서 정작 필드 위에서 골을 넣는 스프라이트는
  // 엉뚱한 선수가 되는 원인이었다.
  private findSprite(side: Side, playerId: string | null | undefined, playerName: string | undefined): Sprite | null {
    const pool = this.team(side).filter((pl) => !pl.off && !pl.gk);
    if (playerId) {
      const byId = pool.find((pl) => pl.id === playerId);
      if (byId) return byId;
    }
    const short = vizShortName(playerName);
    return pool.find((pl) => pl.label === short) || null;
  }

  private dir(side: Side): number {
    return side === 'home' ? 1 : -1;
  }

  private goalX(attackingSide: Side): number {
    return attackingSide === 'home' ? VIZ.W - VIZ.M : VIZ.M;
  }

  private inBox(side: Side, x: number, y: number): boolean {
    const dir = this.dir(side);
    const depth = (this.goalX(side) - x) * dir;
    return depth <= BOX_DEPTH && Math.abs(y - VIZ.H / 2) <= BOX_WIDTH / 2;
  }

  private midfielder(side: Side): Sprite {
    const team = this.team(side);
    return (
      [team[6], team[5], team[1]].find((p) => p && !p.off) ||
      team.find((p) => !p.gk && !p.off) ||
      team[1]
    );
  }

  private nearest(side: Side, x: number, y: number, exclude?: Sprite | null): Sprite | null {
    let best: Sprite | null = null;
    let bd = Infinity;
    this.team(side).forEach((p) => {
      if (p === exclude || p.gk || p.off) return;
      const d = (p.x - x) ** 2 + (p.y - y) ** 2;
      if (d < bd) {
        bd = d;
        best = p;
      }
    });
    return best;
  }

  private push(x: number, y: number, speed: number, opts: Partial<ScriptStep> = {}) {
    this.script.push({
      x,
      y,
      speed,
      wait: opts.wait || 0,
      onDone: opts.onDone,
      track: opts.track || null,
      holdFor: opts.holdFor || null,
      holdT: 2.5,
    });
  }

  private throughBall(target: { x: number; y: number }, runner: Sprite, opts: Partial<ScriptStep> = {}) {
    const b = this.ball;
    const d = Math.hypot(target.x - b.x, target.y - b.y);
    const rd = Math.hypot(target.x - runner.x, target.y - runner.y);
    const runnerTime = rd / (170 * (runner.paceMul || 1));
    const speed = Math.max(240, Math.min(560, d / Math.max(0.35, runnerTime * 0.9)));
    this.runner = runner;
    this.push(target.x, target.y, speed, opts);
  }

  private penetrate(atk: AttackState) {
    const side = atk.e.team;
    const dir = this.dir(side);
    const gx = this.goalX(side);
    const gy = VIZ.H / 2;
    const team = this.team(side);
    const forwards = team.filter((p) => !p.gk && !p.off && p.num >= 9);
    // 골 이벤트라면 백엔드가 이미 정한 득점자를 빌드업의 최종 수신자로
    // 우선한다 — "마지막으로 터치한 선수가 골을 넣는다"가 실제로 성립하게.
    const preferred = atk.e.type === 'goal' ? this.findSprite(side, atk.e.playerId, atk.e.player) : null;
    const runner1 =
      preferred || forwards[Math.floor(Math.random() * forwards.length)] || team.filter((p) => !p.gk && !p.off).pop();
    atk.phase = 'finish';
    if (Math.random() < 0.55) {
      const target = {
        x: Math.max(VIZ.M + 16, Math.min(VIZ.W - VIZ.M - 16, gx - dir * (46 + Math.random() * 70))),
        y: gy + (Math.random() < 0.5 ? -1 : 1) * (26 + Math.random() * 80),
      };
      this.say(`${this.name(this.carrier)}의 침투 스루패스 — ${this.name(runner1 as Sprite)}, 뒷공간 돌파!`);
      this.throughBall(target, runner1 as Sprite, {
        onDone: () => {
          this.carrier = runner1 as Sprite;
          this.runner = null;
          this.passTimer = 0.3;
        },
      });
    } else {
      const wideY = this.ball.y < gy ? VIZ.M + 46 : VIZ.H - VIZ.M - 46;
      let wide = runner1 as Sprite;
      team.forEach((p) => {
        if (!p.gk && !p.off && p !== this.carrier && Math.abs(p.y - wideY) < Math.abs(wide.y - wideY)) wide = p;
      });
      const corner1 = {
        x: Math.max(VIZ.M + 16, Math.min(VIZ.W - VIZ.M - 16, gx - dir * (26 + Math.random() * 30))),
        y: wideY,
      };
      this.say(`측면 공략 — ${this.name(wide)}에게 벌려줍니다`);
      this.throughBall(corner1, wide, {
        onDone: () => {
          this.carrier = wide;
          // 컷백 이후 실제로 마무리하는 선수도 마찬가지로 진짜 득점자를
          // 우선한다(측면으로 벌려준 wide는 그냥 배달자일 뿐).
          const late = preferred || forwards.find((p) => p !== wide) || (runner1 as Sprite);
          const cut = { x: gx - dir * (52 + Math.random() * 40), y: gy + (Math.random() * 56 - 28) };
          this.say(`${this.name(wide)}의 컷백!`);
          this.throughBall(cut, late, {
            wait: 0.25,
            holdFor: wide,
            onDone: () => {
              this.carrier = late;
              this.runner = null;
              this.passTimer = 0.25;
            },
          });
        },
      });
    }
  }

  private schedulePass() {
    const side = this.possession;
    const carrier = this.carrier;
    if (!carrier) return;
    const dir = this.dir(side);
    const mates = this.team(side).filter((p) => p !== carrier && !p.gk && !p.off);
    if (!mates.length) return;
    const tact = this.tact(side);
    const attackMode = !!this.attack && this.attack.e.team === side;
    const breaking = this.breakT[side] > 0;
    const gx = this.goalX(side);

    const gkRestart = this.goalKick && carrier.gk;
    if (gkRestart) this.goalKick = false;

    if (breaking || (!attackMode && !gkRestart && this.ballDistOwn(side) < 190)) {
      let out = mates[0];
      mates.forEach((p) => {
        if ((p.x - out.x) * dir > 0) out = p;
      });
      if (this.offsideCheck(side, out)) {
        this.offsidePass(side, out);
        return;
      }
      const target = {
        x: Math.max(VIZ.M + 30, Math.min(VIZ.W - VIZ.M - 30, out.x + dir * (90 + Math.random() * 70))),
        y: Math.max(VIZ.M + 20, Math.min(VIZ.H - VIZ.M - 20, out.y + (Math.random() * 60 - 30))),
      };
      this.say(
        breaking
          ? `역습 전개! ${this.name(carrier)}의 롱볼 — ${this.name(out)} 질주`
          : `${this.name(carrier)}, 위험 지역에서 길게 걷어냅니다`
      );
      this.throughBall(target, out, {
        onDone: () => {
          this.carrier = out;
          this.runner = null;
          this.passTimer = 0.5;
        },
      });
      return;
    }

    const roleOf = (p: Sprite) => (p.gk || p.num <= 5 ? 1 : p.num <= 8 ? 2 : 3);
    const CHAIN: Record<number, Record<number, number>> = {
      1: { 1: 0.7, 2: 1.5, 3: 0.6 },
      2: { 1: 0.6, 2: 1.0, 3: 1.4 },
      3: { 1: 0.3, 2: 1.1, 3: 1.3 },
    };
    const chain = CHAIN[roleOf(carrier)];

    const recycle = !attackMode && Math.abs(gx - carrier.x) < 250;
    const weighted = mates.map((p) => {
      const fwd = ((p.x - carrier.x) * dir + 140) / 140;
      const back = ((carrier.x - p.x) * dir + 160) / 160;
      const dist = Math.hypot(p.x - carrier.x, p.y - carrier.y);
      const distW = dist < 60 ? 0.3 : dist > 340 ? 0.4 : 1;
      let w = Math.max(0.1, recycle ? back : fwd) * distW * chain[roleOf(p)];
      if (attackMode) {
        w *= 1.6 - Math.min(1, Math.abs(gx - p.x) / (VIZ.W - 2 * VIZ.M));
        if ((p.x - carrier.x) * dir < 0) w *= 0.25;
      }
      return { p, w };
    });
    const ownGK = this.team(side)[0];
    if (
      !attackMode &&
      !carrier.gk &&
      ownGK &&
      !ownGK.off &&
      this.ballDistOwn(side) < 420 &&
      (carrier.x - ownGK.x) * dir > 60
    ) {
      weighted.push({ p: ownGK, w: 0.35 });
    }
    const total = weighted.reduce((s, o) => s + o.w, 0);
    let r = Math.random() * total;
    let receiver = weighted[weighted.length - 1].p;
    for (const o of weighted) {
      r -= o.w;
      if (r <= 0) {
        receiver = o.p;
        break;
      }
    }
    if (!gkRestart && this.offsideCheck(side, receiver)) {
      this.offsidePass(side, receiver);
      return;
    }
    this.runner = receiver;
    if (Math.random() < 0.3) {
      const verb = ['패스 연결', '짧게 이어갑니다', '전진 패스', '방향 전환'][Math.floor(Math.random() * 4)];
      this.say(`${this.name(carrier)} → ${this.name(receiver)}, ${verb}`);
    }
    const passSpd = (300 + Math.random() * 140) * (carrier.passMul || 1);
    this.push(receiver.x, receiver.y, passSpd, {
      track: receiver,
      onDone: () => {
        this.carrier = receiver;
        this.runner = null;
        if (receiver.gk) {
          this.comCd = 0;
          this.say(`${this.name(receiver)}, 백패스는 손을 쓸 수 없습니다 — 발로 처리`);
          this.passTimer = 0.45;
        } else {
          this.passTimer = (attackMode ? 0.4 + Math.random() * 0.4 : 0.6 + Math.random()) / tact.tempo;
        }
      },
    });
  }

  private offsideCheck(side: Side, receiver: Sprite | null): boolean {
    if (this.attack || this.offsideCd > 0 || !receiver) return false;
    const defSide: Side = side === 'home' ? 'away' : 'home';
    const dir = this.dir(side);
    let last: Sprite | null = null;
    this.team(defSide).forEach((p) => {
      if (p.gk || p.off) return;
      if (!last || (p.x - last.x) * dir > 0) last = p;
    });
    if (!last) return false;
    const lastP = last as Sprite;
    const inOppHalf = dir > 0 ? receiver.x > VIZ.W / 2 : receiver.x < VIZ.W / 2;
    const beyondLine = (receiver.x - lastP.x) * dir > 10;
    const beyondBall = (receiver.x - this.ball.x) * dir > 0;
    return inOppHalf && beyondLine && beyondBall;
  }

  private offsidePass(side: Side, receiver: Sprite) {
    const defSide: Side = side === 'home' ? 'away' : 'home';
    this.offsideCd = 9;
    this.runner = receiver;
    this.push(receiver.x, receiver.y, 340, {
      track: receiver,
      onDone: () => {
        this.comCd = 0;
        this.say(`부심 깃발이 올라갑니다 — ${this.name(receiver)} 오프사이드!`);
        this.cb.onBanner(`🚩 오프사이드 — ${this.name(receiver)}`, 'offside', 2200);
        this.carrier = null;
        this.runner = this.nearest(defSide, this.ball.x, this.ball.y);
        this.push(this.ball.x, this.ball.y, 1, {
          wait: 1.0,
          onDone: () => {
            this.runner = null;
            this.takeover(defSide, this.nearest(defSide, this.ball.x, this.ball.y));
            this.passTimer = 0.6;
          },
        });
      },
    });
  }

  private ambientShot(side: Side) {
    const defSide: Side = side === 'home' ? 'away' : 'home';
    const defGK = this.team(defSide)[0];
    const shooter = this.carrier;
    if (!shooter || !defGK) return;
    this.comCd = 0;
    this.say(`${this.name(shooter)}, 1:1 찬스 — 슈팅!`);
    this.carrier = null;
    this.runner = null;
    this.push(defGK.x, defGK.y, Math.round(540 * (shooter.shotMul || 1)), {
      track: defGK,
      onDone: () => {
        this.comCd = 0;
        this.say(`${this.name(defGK)}, 침착하게 막아냅니다`);
        this.takeover(defSide, defGK);
        this.passTimer = 1.0;
      },
    });
  }

  private beginEvent(e: MatchEvent) {
    if (!this.ball) return;
    const b = this.ball;
    const feed = () => this.cb.onFeedItem(e.minute + "'", e.text, e.type);

    if (e.type === 'card' || e.type === 'foul') {
      // 백엔드가 명시적으로 계산해 보내는 값을 우선 쓴다 — foul은 team이
      // 이미 프리킥을 얻는 팀이고 card는 반대 팀이라, 타입별로 뒤집어
      // 계산하던 예전 방식은 둘 중 하나만 바뀌어도 조용히 어긋날 수 있었다.
      const fkSide: Side = e.awardedTeam ?? (e.type === 'foul' ? e.team : e.team === 'home' ? 'away' : 'home');
      if (this.possession !== fkSide) {
        this.takeover(fkSide, this.nearest(fkSide, b.x, b.y));
        this.passTimer = 1.2;
      }
      this.duel = {
        e,
        fkSide,
        t: this.queue.length ? 1.3 : 2.6,
        advantage: e.type === 'foul' && Math.random() < 0.4,
      };
      return;
    }

    if (e.type === 'throwin') {
      const outY = b.y < VIZ.H / 2 ? VIZ.M - 10 : VIZ.H - VIZ.M + 10;
      const outX = Math.max(VIZ.M + 20, Math.min(VIZ.W - VIZ.M - 20, b.x + (Math.random() * 40 - 20)));
      this.carrier = null;
      this.runner = null;
      const thrower = this.nearest(e.team, outX, outY);
      const oppSide: Side = e.team === 'home' ? 'away' : 'home';
      const deflector = this.nearest(oppSide, b.x, b.y);
      if (deflector) {
        this.push(deflector.x, deflector.y, 300, {
          track: deflector,
          onDone: () => {
            this.comCd = 0;
            this.say(`${this.name(deflector)}, 몸에 맞고 밖으로 나갑니다`);
          },
        });
      }
      this.push(outX, outY, 260, { onDone: feed });
      const landX = outX + (Math.random() * 80 - 40);
      const landY = outY < VIZ.H / 2 ? VIZ.M + 55 : VIZ.H - VIZ.M - 55;
      this.push(landX, landY, 300, {
        wait: 0.4,
        holdFor: thrower,
        onDone: () => {
          this.runner = null;
          this.comCd = 0;
          this.say(`${this.name(thrower)}, 스로인으로 연결`);

          // both sides converge on the landing spot and contest it, weighted
          // by physical/defending with a moderate retention edge for the
          // throwing side (real throw-ins are usually kept in) — instead of
          // handing possession to the thrower deterministically.
          const nearestN = (side: Side, n: number, exclude: (Sprite | null)[]) =>
            this.team(side)
              .filter((p) => !p.gk && !p.off && !exclude.includes(p))
              .sort(
                (a, b2) =>
                  (a.x - landX) ** 2 + (a.y - landY) ** 2 - ((b2.x - landX) ** 2 + (b2.y - landY) ** 2)
              )
              .slice(0, n);
          const contestants = [...nearestN(e.team, 2, [thrower]), ...nearestN(oppSide, 2, [deflector])];
          contestants.forEach((p) => {
            this.push(landX + (Math.random() * 30 - 15), landY + (Math.random() * 30 - 15), 220, { track: p });
          });

          const weight = (p: Sprite) => {
            const w = (p.defMul || 1) * 0.55 + (p.paceMul || 1) * 0.45;
            return (p.isHome ? 'home' : 'away') === e.team ? w * 1.5 : w;
          };
          const pool = [thrower, ...contestants].filter((p): p is Sprite => !!p);
          const fallback = thrower || this.team(e.team)[1] || this.team(e.team)[0];
          let winner: Sprite = fallback;
          if (pool.length) {
            const total = pool.reduce((s, p) => s + weight(p), 0);
            let r = Math.random() * total;
            winner = pool[pool.length - 1];
            for (const p of pool) {
              r -= weight(p);
              if (r <= 0) {
                winner = p;
                break;
              }
            }
          }
          const winnerSide: Side = winner.isHome ? 'home' : 'away';
          if (winnerSide !== e.team) {
            this.comCd = 0;
            this.say(`${this.name(winner)}, 스로인 경합에서 볼을 따냅니다!`);
          }
          this.takeover(winnerSide, winner);
          this.passTimer = 0.5;
        },
      });
      return;
    }

    if (e.type === 'injury' || e.type === 'strop') {
      // reuses the exact ".off" unavailability mechanism a red card uses —
      // the 14 existing "!p.off" filters elsewhere then keep them out of
      // play. id로 매칭해서 동명이인/매칭 실패로 아무도 안 빠지는(=필드에
      // "남아있는") 상황을 없앤다.
      feed();
      const short = vizShortName(e.player);
      const dot = this.findSprite(e.team, e.playerId, e.player);
      const minor = e.type === 'injury' && e.severity === 'minor';
      if (dot) {
        dot.off = true;
        if (this.carrier === dot) this.carrier = null;
        if (this.runner === dot) this.runner = null;
        // 경미한 부상: 잠시 빠졌다가(치료) 같은 자리로 복귀 — 중상(또는
        // 태업)만 실제 교체가 나올 때까지 계속 빠진 상태를 유지한다.
        if (minor) {
          window.setTimeout(() => {
            dot.off = false;
          }, 3000);
        }
      }
      const label = e.type === 'injury' ? (minor ? '경미한 부상' : '부상') : '태업';
      this.banner(`🚑 ${label} — ${short}`, e.type === 'injury' ? 'red' : 'yellow', 2600);
      return;
    }

    const hurry = 1 + Math.min(2.2, this.queue.length * 0.6);
    this.attack = {
      e,
      hurry,
      timeLeft: 7 / hurry,
      phase: 'advance',
      longShot: e.type !== 'goal' && !e.via && Math.random() < this.tact(e.team).longShot,
    };

    if (this.possession !== e.team) {
      // 요청("패스를 상대팀이 해서 골을 우리팀이 넣는 경우...그런 경우는
      // 패스미스로써 처리가 되는게 맞는데 그 빈도가 너무 잦아"): 백엔드
      // 타임라인은 분 단위로 확정된 이벤트(골/슈팅 등)를 쏘아 보낼 뿐, 그
      // 순간 화면상 앰비언트(장식용) 점유가 어느 팀에 있었는지는 전혀
      // 모른다 — 그래서 이 공격 이벤트가 시작될 때 볼이 아직 수비팀 쪽에
      // 있는 경우가 절반 가까이 생긴다. 예전엔 여기서 아무 설명 없이
      // this.takeover()로 볼을 그냥 순간이동시켰는데, 그러면 시청자 눈에는
      // "상대가 패스하다가 갑자기 우리가 골을 넣은"것처럼 보였다(프로
      // 축구에서는 극히 드문 그림). 실제로는 이 전환이 곧 "우리 팀이 상대
      // 패스를 끊어낸 것"이라는 뜻이므로, 그걸 침묵의 순간이동이 아니라
      // 명시적인 "패스 미스/볼 탈취" 대사로 내보내 자연스러운 턴오버처럼
      // 보이게 한다 — 발생 빈도 자체(대략 절반)는 구조적으로 못 줄이지만,
      // 최소한 "왜 갑자기 우리 팀이 볼을 잡았는지"는 항상 설명된다.
      const stealer = this.nearest(e.team, this.ball.x, this.ball.y);
      this.takeover(e.team, stealer);
      this.passTimer = 0.3;
      if (stealer) {
        this.comCd = 0;
        this.say(`${this.name(stealer)}, 상대 패스를 끊어냅니다 — 패스 미스!`);
      }
    }

    // Sync the on-pitch carrier to whichever sprite the backend actually
    // credited for this event (e.player). Without this, the pitch keeps
    // showing whoever the frontend's own ball-carrier AI happened to have
    // dribbling — a system with no notion of "who this event is about" —
    // while the feed/banner name a specific (usually different) player.
    if (e.player) {
      // 자책골은 e.team(득점 혜택팀)이 아니라 상대팀 수비수가 주인공이다.
      const named = e.ownGoal
        ? this.findSprite(e.ownGoalTeam === 'home' ? 'home' : 'away', e.ownGoalPlayerId, e.player)
        : this.findSprite(e.team, e.playerId, e.player);
      if (named) this.carrier = named;
    }
  }

  private shoot(atk: AttackState) {
    const e = atk.e;
    const side = e.team;
    const dir = this.dir(side);
    const gx = this.goalX(side);
    const gy = VIZ.H / 2;
    const defSide: Side = side === 'home' ? 'away' : 'home';
    const defGK = this.team(defSide)[0];
    const feed = () => this.cb.onFeedItem(e.minute + "'", e.text, e.type);
    const done = () => {
      this.attack = null;
    };
    // Prefer the sprite that actually matches the backend-computed scorer
    // (e.player) — falling back to "whoever's currently carrying" only if
    // that name can't be found on the pitch (e.g. an edge-case timing gap).
    // Without this, a penalty/free kick/corner ceremony would show whoever
    // happened to be dribbling standing over the ball while the feed/toast
    // announce a completely different player's name.
    // 자책골은 e.team(득점 혜택팀) 소속이 아니라 상대(실점팀) 수비수가
    // "슈터" 역할이다 — 자기 골문에 넣는 그 수비수를 찾아야 한다.
    const namedShooter = e.ownGoal
      ? this.findSprite(defSide, e.ownGoalPlayerId, e.player)
      : this.findSprite(side, e.playerId, e.player);
    const shooter = namedShooter || this.carrier || this.team(side)[9] || this.team(side)[8];
    const shotSpd = Math.round(600 * ((shooter && shooter.shotMul) || 1));
    this.runner = null;

    if (e.via === 'penalty') {
      atk.ceremony = true;
      this.carrier = null;
      this.runner = shooter;
      this.push(gx - dir * 66, gy, 300, { wait: 0.3 });
      this.push(gx - dir * 66, gy, 1, {
        wait: 1.2,
        onDone: () => {
          this.runner = null;
        },
      });
    } else if (e.via === 'freekick') {
      atk.ceremony = true;
      this.carrier = null;
      this.runner = shooter;
      atk.wall = this.team(defSide)
        .filter((p) => !p.gk && !p.off)
        .sort((a, b) => Math.hypot(a.x - this.ball.x, a.y - this.ball.y) - Math.hypot(b.x - this.ball.x, b.y - this.ball.y))
        .slice(0, 3);
      this.push(this.ball.x, this.ball.y, 1, {
        wait: 1.4,
        onDone: () => {
          this.runner = null;
        },
      });
    } else if (e.via === 'corner') {
      // deliver from the flag into the box, then fall through to the
      // 'goal'/'save'/'miss' switch below for the actual header finish —
      // same shape as the non-scoring corner choreography in case 'corner'.
      atk.ceremony = true;
      this.carrier = null;
      const cy = this.ball.y < VIZ.H / 2 ? VIZ.M : VIZ.H - VIZ.M;
      this.runner = shooter;
      atk.taker = shooter;
      this.push(gx - dir * 60, cy, 300, { wait: 0.5 });
      this.push(gx - dir * 60, gy + (Math.random() * 60 - 30), 430, {
        wait: 0.5,
        holdFor: shooter,
        onDone: () => {
          this.runner = null;
        },
      });
    }

    switch (e.type) {
      case 'goal':
        this.push(gx + dir * 10, gy + (Math.random() * 52 - 26), shotSpd, {
          wait: 0.18,
          onDone: () => {
            this.flash = { text: e.ownGoal ? '⚽ OWN GOAL' : '⚽ GOAL!', until: this.now + 1500 };
            this.carrier = null;
            feed();
            this.cb.onBanner(
              e.ownGoal
                ? `⚽ 자책골! ${vizShortName(e.player)}`
                : `⚽ ${vizShortName(e.player)} 골!${e.assist ? ` (도움: ${vizShortName(e.assist)})` : ''}`,
              'goal',
              3000
            );
            if (e.score) this.cb.onScore(e.score.home, e.score.away);
          },
        });
        this.push(VIZ.W / 2, VIZ.H / 2, 250, {
          wait: 1.2,
          onDone: () => {
            done();
            this.stageKickoff(defSide);
          },
        });
        break;
      case 'disallowed':
        this.push(gx + dir * 10, gy + (Math.random() * 52 - 26), shotSpd, {
          wait: 0.18,
          onDone: () => {
            this.flash = { text: '🖥 VAR 판독 중…', until: this.now + 1800 };
            this.carrier = null;
          },
        });
        this.push(gx - dir * (34 + Math.random() * 26), gy + (Math.random() * 40 - 20), 240, {
          wait: 2.0,
          onDone: () => {
            feed();
            this.flash = { text: '❌ 득점 취소', until: this.now + 1400 };
            this.cb.onBanner(`🚩 오프사이드 — ${vizShortName(e.player)} 득점 취소`, 'offside', 2600);
            done();
            this.takeover(defSide, defGK);
            this.goalKick = true;
            this.passTimer = 1.0;
          },
        });
        break;
      case 'save':
        this.push(gx - dir * 8, gy + (Math.random() * 46 - 23), shotSpd, {
          wait: 0.15,
          onDone: () => {
            feed();
            done();
            this.takeover(defSide, defGK);
            this.passTimer = 0.9;
          },
        });
        break;
      case 'miss':
        this.push(gx + dir * 14, gy + (Math.random() < 0.5 ? -1 : 1) * (52 + Math.random() * 40), shotSpd, {
          wait: 0.15,
          onDone: feed,
        });
        this.push(gx - dir * (30 + Math.random() * 34), gy + (Math.random() * 60 - 30), 260, {
          wait: 0.6,
          onDone: () => {
            done();
            this.takeover(defSide, defGK);
            this.goalKick = true;
            this.passTimer = 1.0;
          },
        });
        break;
      case 'corner': {
        if (Math.hypot(gx - this.ball.x, gy - this.ball.y) > 420) {
          feed();
          done();
          break;
        }
        atk.ceremony = true;
        const cy = this.ball.y < VIZ.H / 2 ? VIZ.M : VIZ.H - VIZ.M;
        const blocker = this.nearest(defSide, gx - dir * 40, gy) || defGK;
        this.push(blocker.x, blocker.y, shotSpd, {
          wait: 0.12,
          track: blocker,
          onDone: () => {
            this.comCd = 0;
            this.say(`${this.name(blocker)}, 몸을 던져 막아냅니다 — 굴절!`);
          },
        });
        this.push(gx + dir * 6, cy < gy ? VIZ.M + 20 : VIZ.H - VIZ.M - 20, 300, { onDone: feed });
        this.push(gx - dir * 2, cy, 220, { wait: 0.3 });
        const taker = this.nearest(side, gx, cy) as Sprite;
        atk.taker = taker;

        const secondBall = () => {
          let best: Sprite | null = null;
          let bd = Infinity;
          this.players.forEach((pl) => {
            if (pl.gk || pl.off) return;
            const dd = (pl.x - this.ball.x) ** 2 + (pl.y - this.ball.y) ** 2;
            if (dd < bd) {
              bd = dd;
              best = pl;
            }
          });
          done();
          this.takeover(best && (best as Sprite).isHome ? 'home' : 'away', best || this.team(defSide)[1]);
          this.passTimer = 0.6;
        };

        const resolveDelivery = () => {
          const roll = Math.random();
          if (roll < 0.25) {
            const clearer = this.nearest(defSide, this.ball.x, this.ball.y);
            this.comCd = 0;
            this.say(`${this.name(clearer)}, 헤더로 걷어냅니다!`);
            this.push(gx - dir * (180 + Math.random() * 120), gy + (Math.random() * 160 - 80), 380, {
              onDone: secondBall,
            });
          } else if (roll < 0.45) {
            const clearer = this.nearest(defSide, this.ball.x, this.ball.y);
            this.comCd = 0;
            this.say(`${this.name(clearer)}, 급하게 걷어낸 공이 터치라인 밖으로!`);
            atk.ceremony = false;
            const outY2 = Math.random() < 0.5 ? VIZ.M - 10 : VIZ.H - VIZ.M + 10;
            const outX2 = gx - dir * (90 + Math.random() * 120);
            this.push(outX2, outY2, 360);
            const thrower2 = this.nearest(side, outX2, outY2);
            this.push(outX2 + (Math.random() * 60 - 30), outY2 < VIZ.H / 2 ? VIZ.M + 50 : VIZ.H - VIZ.M - 50, 300, {
              wait: 0.3,
              holdFor: thrower2,
              onDone: () => {
                done();
                this.takeover(side, this.nearest(side, this.ball.x, this.ball.y));
                this.passTimer = 0.6;
              },
            });
          } else if (roll < 0.63) {
            this.comCd = 0;
            this.say(`${this.name(defGK)}, 나와서 크로스를 잡아냅니다`);
            this.push(defGK.x, defGK.y, 320, {
              track: defGK,
              onDone: () => {
                done();
                this.takeover(defSide, defGK);
                this.passTimer = 0.9;
              },
            });
          } else if (roll < 0.75) {
            this.comCd = 0;
            this.say(`${this.name(defGK)}, 주먹으로 쳐냅니다 — 펀칭!`);
            this.push(defGK.x, defGK.y, 320, { track: defGK });
            this.push(gx - dir * (140 + Math.random() * 80), gy + (Math.random() * 140 - 70), 420, {
              onDone: secondBall,
            });
          } else {
            const header = this.nearest(side, this.ball.x, this.ball.y, taker);
            this.comCd = 0;
            this.say(`${this.name(header)}의 헤더 — 골문을 살짝 넘어갑니다!`);
            this.push(gx + dir * 12, gy + (Math.random() < 0.5 ? -1 : 1) * (48 + Math.random() * 36), 420);
            this.push(gx - dir * (30 + Math.random() * 30), gy + (Math.random() * 50 - 25), 240, {
              wait: 0.5,
              onDone: () => {
                done();
                this.takeover(defSide, defGK);
                this.goalKick = true;
                this.passTimer = 1.0;
              },
            });
          }
        };

        if (Math.random() < 0.25) {
          const support = this.nearest(side, gx - dir * 90, cy, taker) || taker;
          const sy = cy < gy ? cy + 44 : cy - 44;
          this.push(gx - dir * (70 + Math.random() * 20), sy, 300, {
            wait: 0.8,
            holdFor: taker,
            onDone: () => {
              this.comCd = 0;
              this.say('숏코너 — 짧게 전개합니다');
            },
          });
          // "박스 선수가 달려나와서 받아서 크로스나 돌파" — the receiver either
          // whips a first-time cross in or carries it themselves, weighted by
          // their passing vs dribbling instead of always crossing.
          const dribWeight = support.dribMul || 1;
          const crossWeight = support.passMul || 1;
          if (Math.random() * (dribWeight + crossWeight) < dribWeight) {
            this.push(gx - dir * 24, gy + (Math.random() * 40 - 20), 330, {
              wait: 0.4,
              holdFor: support,
              onDone: () => {
                this.comCd = 0;
                this.say(`${this.name(support)}, 직접 몰고 들어갑니다 — 돌파 시도!`);
              },
            });
            this.push(gx + dir * 4, gy + (Math.random() * 30 - 15), 380, {
              wait: 0.35,
              onDone: resolveDelivery,
            });
          } else {
            this.push(gx - dir * 60, gy + (Math.random() * 60 - 30), 430, {
              wait: 0.35,
              holdFor: support,
              onDone: resolveDelivery,
            });
          }
        } else {
          this.push(gx - dir * 60, gy + (Math.random() * 60 - 30), 430, {
            wait: 0.9,
            holdFor: taker,
            onDone: resolveDelivery,
          });
        }
        break;
      }
      default:
        feed();
        done();
        break;
    }
  }

  private tickPossessionRoll() {
    if (this.script.length || this.queue.length || this.attack || this.kickoff || this.duel) return;
    const wantHome = Math.random() * 100 < this.possHome;
    const want: Side = wantHome ? 'home' : 'away';
    if (want !== this.possession && Math.random() < 0.45) {
      this.takeover(want, this.nearest(want, this.ball.x, this.ball.y));
      this.passTimer = 0.4;
      if (this.carrier) this.say(`${this.name(this.carrier)}, 패스 차단`);
    }
  }

  private banner(text: string, kind: string, ms: number) {
    this.cb.onBanner(text, kind, ms);
  }

  // ---- main loop ----

  private frame(ts: number) {
    if (!this.canvas || !this.ctx || !this.active) {
      this.raf = null;
      return;
    }
    const wallDt = this.paused ? 0 : this.lastTs ? Math.min((ts - this.lastTs) / 1000, 0.05) : 0.016;
    this.lastTs = ts;
    this.now = ts;
    if (!this.matchStartTs) this.matchStartTs = ts;

    const elapsedSec = (ts - this.matchStartTs) / 1000;
    const backlogSec = this.queue.length * VIZ_AVG_EVENT_SEC + (this.attack ? Math.max(0, this.attack.timeLeft) : 0);
    const projectedSec = elapsedSec + backlogSec;
    const speedMul = projectedSec > VIZ_TIME_CAP_SEC ? Math.min(VIZ_MAX_SPEED, projectedSec / VIZ_TIME_CAP_SEC) : 1;
    const dt = wallDt * speedMul;
    const ctx = this.ctx;
    const { W, H, M } = VIZ;

    const minTarget = this.attack
      ? this.attack.e.minute
      : this.duel
        ? this.duel.e.minute
        : this.queue.length
          ? this.queue[0].minute
          : this.srvMin;
    if (minTarget > this.dispMin) {
      const rate = 1.54;
      this.dispMin = Math.min(minTarget, this.dispMin + rate * dt);
    }
    const shownMin = Math.floor(this.dispMin);
    if (shownMin !== this.shownMin) {
      this.shownMin = shownMin;
      this.cb.onMinute(shownMin <= 90 ? `${shownMin}'` : `90+${shownMin - 90}'`);
    }

    this.possTime[this.possession] += dt;
    this.comCd = Math.max(0, this.comCd - dt);
    this.possUiT += dt;
    if (this.possUiT >= 0.5) {
      this.possUiT = 0;
      const tot = this.possTime.home + this.possTime.away || 1;
      const ph = Math.round((this.possTime.home / tot) * 100);
      this.cb.onPossession(ph);
    }

    if (this.duel && !this.paused) {
      const d = this.duel;
      d.t -= dt;
      const offSide: Side = d.fkSide === 'home' ? 'away' : 'home';
      d.chaser = this.nearest(offSide, this.ball.x, this.ball.y);
      const bx = this.ball.x;
      const outsideBoxes = bx > M + 104 && bx < W - M - 104;
      const contact = !this.script.length && d.chaser && Math.hypot(d.chaser.x - this.ball.x, d.chaser.y - this.ball.y) < 18;
      const advOk = d.advantage && this.possession === d.fkSide && this.ballDistOwn(d.fkSide) > (W - 2 * M) / 2;
      if (contact && outsideBoxes && advOk) {
        this.duel = null;
        this.cb.onFeedItem(d.e.minute + "'", d.e.text, d.e.type);
        this.comCd = 0;
        this.say('심판, 어드밴티지 선언 — 플레이 온!');
      } else if ((contact && outsideBoxes) || (d.t <= 0 && !this.script.length)) {
        this.duel = null;
        this.cb.onFeedItem(d.e.minute + "'", d.e.text, d.e.type);
        this.comCd = 0;
        if (d.e.red) {
          const short = vizShortName(d.e.player);
          const dot = this.findSprite(d.e.team, d.e.playerId, d.e.player) || (d.chaser && !d.chaser.gk ? d.chaser : null);
          if (dot) dot.off = true;
          this.say(`🟥 ${this.name(dot)} 퇴장! 팀은 10명으로 싸웁니다`);
          // 심각한 반칙으로 경고 없이 바로 나온 스트레이트 레드는 VAR
          // 판독을 거친 것으로 서사를 붙인다(백엔드 simulate.js가 이미
          // "straight red" 텍스트를 넣어 보내면 그걸 그대로 쓴다).
          const varReview = /심각한 반칙|VAR/.test(d.e.text || '');
          if (varReview) this.banner('📺 VAR 판독 중...', 'yellow', 1400);
          this.banner(`🟥 레드카드 — ${short}`, 'red', 3000);
        } else if (d.e.type === 'card') {
          // the small commentary line and the banner named different players
          // before — chaser (nearest defender) vs d.e.player (actually
          // booked) — match by id here too so both agree.
          const cardedShort = vizShortName(d.e.player);
          const booked = this.findSprite(d.e.team, d.e.playerId, d.e.player) || d.chaser;
          this.say(`${this.name(booked ?? null)}의 거친 태클 — 휘슬이 울립니다`);
          this.banner(`🟨 옐로카드 — ${cardedShort}`, 'yellow', 2200);
        } else {
          this.say(`${this.name(d.chaser ?? null)}의 거친 태클 — 휘슬이 울립니다`);
        }
        this.carrier = null;
        this.runner = this.nearest(d.fkSide, this.ball.x, this.ball.y);
        this.push(this.ball.x, this.ball.y, 1, {
          wait: this.queue.length ? 0.5 : 1.1,
          onDone: () => {
            this.runner = null;
            this.takeover(d.fkSide, this.nearest(d.fkSide, this.ball.x, this.ball.y));
            this.passTimer = 0.4;
          },
        });
      }
    }

    if (this.kickoff && !this.paused) {
      const ko = this.kickoff;
      ko.t -= dt;
      const taker = ko.taker;
      if (ko.t <= 0 && Math.hypot(taker.x - this.ball.x, taker.y - this.ball.y) < 34) {
        this.kickoff = null;
        this.carrier = taker;
        this.comCd = 0;
        this.say(`${this.names[ko.side]} 킥오프 — 경기 재개`);
        const recv = this.midfielder(ko.side);
        this.runner = recv;
        this.push(recv.x, recv.y, 300, {
          track: recv,
          onDone: () => {
            this.carrier = recv;
            this.runner = null;
            this.passTimer = 0.7;
          },
        });
      }
    }

    if (this.attack) {
      this.attack.timeLeft -= dt;
      const stallAt = this.attack.e.type === 'corner' ? -8 : -2;
      if (this.attack.timeLeft <= stallAt && !this.script.length) this.shoot(this.attack);
    } else if (!this.script.length && !this.kickoff && !this.paused && !this.duel) {
      // dispMin >= 45: the queue draining past 45 isn't enough on its own —
      // the on-screen minute counter climbs toward its target at a fixed
      // rate independent of the queue, so without this gate the halftime
      // banner could fire while the visible clock still reads well under 45
      // (e.g. "40'") whenever the first half had few enough events that the
      // queue empties before the counter animation catches up.
      if (this.pendingHalf && (!this.queue.length || this.queue[0].minute > 45) && this.dispMin >= 45) {
        this.pendingHalf = false;
        if (this.pendingHalfText) {
          this.cb.onFeedItem('', this.pendingHalfText, 'phase');
          this.banner(this.pendingHalfText, 'phase', 2600);
          this.pendingHalfText = null;
        }
        this.carrier = null;
        this.runner = null;
        this.push(VIZ.W / 2, VIZ.H / 2, 300, {
          onDone: () => {
            this.secondHalf = true;
            this.stageKickoff('away');
          },
        });
      } else if (this.queue.length) {
        this.beginEvent(this.queue.shift() as MatchEvent);
      } else {
        this.runner = null;
        // 하프타임 배너와 같은 이유의 같은 버그: 큐가 비었다고 바로 종료
        // 팝업을 띄우면, 후반 막판에 이벤트가 적어 큐가 먼저 말라버릴 때
        // 화면 시계(dispMin)가 아직 90+추가시간에 못 미친 채로 경기 종료
        // 팝업이 뜬다 — finalMinute(서버가 계산한 90+추가시간)까지 시계가
        // 다 채워진 뒤에만 넘긴다.
        const finalMinute = this.pendingResult?.finalMinute ?? 90;
        if (this.pendingResult && (!this.flash || this.now > this.flash.until) && this.dispMin >= finalMinute) {
          const res = this.pendingResult;
          this.pendingResult = null;
          this.deliverResult(res);
        }
      }
    }

    const b = this.ball;
    let ballSpeed = 0;
    if (this.paused) {
      // frozen
    } else if (this.script.length) {
      const step = this.script[0];
      if (step.wait > 0) {
        step.wait -= dt;
      } else if (step.holdFor && step.holdT > 0 && Math.hypot(step.holdFor.x - b.x, step.holdFor.y - b.y) > 26) {
        step.holdT -= dt;
      } else {
        step.holdFor = null;
        if (step.track) {
          step.x = step.track.x;
          step.y = step.track.y;
        }
        const dx = step.x - b.x;
        const dy = step.y - b.y;
        const d = Math.hypot(dx, dy);
        const move = step.speed * dt;
        ballSpeed = step.speed;
        if (d <= move + 2 || step.speed <= 2) {
          b.x = step.x;
          b.y = step.y;
          this.script.shift();
          if (step.onDone) step.onDone();
        } else {
          b.x += (dx / d) * move;
          b.y += (dy / d) * move;
        }
      }
    } else if (this.carrier) {
      const side = this.possession;
      const dir = this.dir(side);
      const carryX = this.carrier.x + dir * 12;
      const carryY = this.carrier.y;
      const gap = Math.hypot(carryX - b.x, carryY - b.y);
      this.collect = gap > 34;
      if (this.collect) {
        ballSpeed = 0;
      } else {
        let mx = (carryX - b.x) * Math.min(1, dt * 9);
        let my = (carryY - b.y) * Math.min(1, dt * 9);
        const m = Math.hypot(mx, my);
        const cap = 430 * dt;
        if (m > cap) {
          mx *= cap / m;
          my *= cap / m;
        }
        b.x += mx;
        b.y += my;
        b.x = Math.max(M + 4, Math.min(W - M - 4, b.x));
        b.y = Math.max(M + 4, Math.min(H - M - 4, b.y));
        ballSpeed = 60;
        const atk = this.attack && this.attack.e.team === side ? this.attack : null;
        if (atk) {
          const gDist = Math.hypot(this.goalX(side) - b.x, H / 2 - b.y);
          if (atk.e.via === 'freekick') {
            if (gDist < 280 && !this.inBox(side, b.x, b.y)) {
              this.shoot(atk);
            } else if (atk.timeLeft <= 0) {
              const dir2 = this.dir(side);
              b.x = this.goalX(side) - dir2 * (BOX_DEPTH + 30);
              b.y = H / 2;
              this.shoot(atk);
            } else {
              this.passTimer -= dt * 1.3 * atk.hurry;
              if (this.passTimer <= 0) this.schedulePass();
            }
          } else if (atk.e.via === 'penalty') {
            if (this.inBox(side, b.x, b.y)) {
              this.comCd = 0;
              this.say(`${this.name(this.carrier)}, 박스 안에서 넘어집니다! 페널티킥!`);
              this.shoot(atk);
            } else if (atk.timeLeft <= 0) {
              const dir2 = this.dir(side);
              b.x = this.goalX(side) - dir2 * (BOX_DEPTH - 10);
              b.y = H / 2;
              this.comCd = 0;
              this.say(`${this.name(this.carrier)}, 박스 안에서 넘어집니다! 페널티킥!`);
              this.shoot(atk);
            } else {
              this.passTimer -= dt * 1.3 * atk.hurry;
              if (this.passTimer <= 0) this.schedulePass();
            }
          } else if (atk.e.via === 'corner') {
            // scoring corner: skip the open-play dribble-advance entirely and
            // let shoot()'s via==='corner' staging drive straight to the flag.
            this.shoot(atk);
          } else if (atk.e.type === 'corner') {
            if (gDist < 320 || atk.timeLeft <= -6) this.shoot(atk);
            else {
              this.passTimer -= dt * 1.3 * atk.hurry;
              if (this.passTimer <= 0) this.schedulePass();
            }
          } else if (atk.timeLeft <= 0) {
            this.shoot(atk);
          } else if (atk.longShot && gDist < 300) {
            this.shoot(atk);
          } else if (atk.phase !== 'finish' && gDist < 290) {
            this.penetrate(atk);
          } else if (atk.phase === 'finish' && gDist < this.tact(side).shootFrom) {
            this.passTimer -= dt * 2;
            if (this.passTimer <= 0) this.shoot(atk);
          } else {
            this.passTimer -= dt * 1.3 * atk.hurry;
            if (this.passTimer <= 0) this.schedulePass();
          }
        } else {
          const oppLine = side === 'home' ? W - M - this.line.away : M + this.line.home;
          const beyond = side === 'home' ? b.x > oppLine + 8 : b.x < oppLine - 8;
          const gDist2 = Math.hypot(this.goalX(side) - b.x, H / 2 - b.y);
          if (beyond && gDist2 < 240 && this.chanceCd <= 0 && !this.carrier.gk && !this.duel && !this.kickoff) {
            this.chanceCd = 7;
            this.ambientShot(side);
          } else {
            const holdUp = this.carrier.gk ? 2.2 : this.carrier.num <= 5 ? 1.5 : 1;
            this.passTimer -= dt * this.tact(side).tempo * holdUp;
            if (this.passTimer <= 0) this.schedulePass();
          }
        }
      }
    } else {
      this.collect = false;
    }
    this.ballAngle += (ballSpeed / 14) * dt;

    const lineTarget = (side: Side) => {
      const tact = this.tact(side);
      const ballDist = this.ballDistOwn(side);
      const hasBall = this.possession === side;
      const raw = ballDist * 0.5 + 40 + tact.line * 0.8 + (hasBall ? 60 : -10);
      return Math.max(64, Math.min(430, raw));
    };
    (['home', 'away'] as Side[]).forEach((s) => {
      this.line[s] += (lineTarget(s) - this.line[s]) * Math.min(1, dt * 1.3);
      this.breakT[s] = Math.max(0, this.breakT[s] - dt);
    });
    this.stealCd = Math.max(0, this.stealCd - dt);
    this.chanceCd = Math.max(0, this.chanceCd - dt);
    this.offsideCd = Math.max(0, this.offsideCd - dt);

    const defendSide: Side = this.possession === 'home' ? 'away' : 'home';
    const presser = this.carrier ? this.nearest(defendSide, b.x, b.y) : null;
    const presser2 = presser && this.tact(defendSide).press >= 2 ? this.nearest(defendSide, b.x, b.y, presser) : null;
    const t = ts / 1000;
    const ballDy = b.y - H / 2;
    const setPiece = !!(this.attack && this.attack.ceremony);
    const pressEngaged = this.ballDistOwn(defendSide) < this.tact(defendSide).engage;
    this.players.forEach((p) => {
      const mySide: Side = p.isHome ? 'home' : 'away';
      const attacking = this.possession === mySide;
      const dir = p.isHome ? 1 : -1;
      const ox = p.isHome ? M : W - M;
      const role = p.gk ? 0 : p.num <= 5 ? 1 : p.num <= 8 ? 2 : 3;
      const tact = this.tact(mySide);
      const line = this.line[mySide];
      const oppLineAbs = p.isHome ? W - M - this.line.away : M + this.line.home;

      const roamX = Math.sin(t * p.speed + p.phase) * 10;
      const roamY = Math.cos(t * p.speed * 0.8 + p.phase * 1.7) * 10;
      const gapDM = attacking ? 120 : 92;
      let tx: number;
      let ty: number;
      if (p.gk) {
        tx = ox + dir * Math.max(12, Math.min(56, line * 0.22));
        ty = H / 2 + ballDy * 0.12;
      } else if (role === 1) {
        const isWide = Math.abs(p.baseY - H / 2) > 100;
        tx = ox + dir * (line + (p.depthOff || 0) * 0.4 + (attacking && isWide ? 46 : 0));
        ty = p.baseY + ballDy * (attacking ? 0.2 : 0.34);
      } else if (role === 2) {
        tx = ox + dir * (line + gapDM + (p.depthOff || 0));
        ty = p.baseY + ballDy * (attacking ? 0.22 : 0.34);
      } else if (attacking) {
        tx = oppLineAbs - dir * 16;
        ty = p.baseY + ballDy * 0.24;
      } else {
        tx = ox + dir * (line + gapDM + 85 + (p.depthOff || 0) * 0.5);
        ty = p.baseY + ballDy * 0.3;
      }
      tx += roamX;
      ty += roamY;
      let sp = 105 * p.paceMul;

      if (!p.gk && !p.off && attacking && !p.run && p !== this.carrier && Math.random() < dt * 0.12 * tact.runFreq) {
        p.run = {
          tx: Math.max(M, Math.min(W - M, p.x + dir * (70 + Math.random() * 90))),
          ty: Math.max(M, Math.min(H - M, p.y + (Math.random() * 120 - 60))),
          until: t + 2.5,
        };
      }
      if (p.run && (!attacking || t > p.run.until || Math.hypot(p.x - p.run.tx, p.y - p.run.ty) < 10)) {
        p.run = null;
      }

      if (p.off) {
        tx = p.x;
        ty = p.y < H / 2 ? M - 8 : H - M + 8;
        sp = 90;
      } else if (this.kickoff) {
        if (p === this.kickoff.taker) {
          tx = W / 2 - dir * 14;
          ty = H / 2;
        } else {
          tx = p.baseX;
          ty = p.baseY;
        }
        sp = 150 * p.paceMul;
      } else if (p === this.carrier && !this.script.length) {
        if (this.collect) {
          tx = b.x;
          ty = b.y;
          sp = 175 * p.paceMul;
        } else if (p.gk) {
          sp = 120 * p.paceMul;
        } else {
          const boost =
            tact.carrier *
            (this.breakT[mySide] > 0 ? 1.35 : 1) *
            (this.attack && this.attack.e.team === mySide ? 1.25 : 1);
          if (this.attack && this.attack.e.team === mySide) {
            const ang = Math.atan2(H / 2 - p.y, this.goalX(mySide) - p.x);
            tx = p.x + Math.cos(ang) * 44;
            ty = p.y + Math.sin(ang) * 44;
          } else {
            tx = p.x + dir * 44;
            ty = p.y + Math.sin(t * 2 + p.phase) * 18;
          }
          sp = 100 * (0.55 * p.dribMul + 0.45 * p.paceMul) * boost;
        }
      } else if (this.script.length && this.script[0].holdFor === p) {
        tx = b.x;
        ty = b.y;
        sp = 180 * p.paceMul;
      } else if (this.script.length && p === this.runner) {
        tx = this.script[0].x;
        ty = this.script[0].y;
        sp = 175 * p.paceMul;
      } else if (this.duel && p === this.duel.chaser) {
        tx = b.x;
        ty = b.y;
        sp = 190 * p.paceMul;
      } else if (setPiece && this.attack!.e.via === 'freekick' && this.attack!.wall && this.attack!.wall.indexOf(p) >= 0) {
        const wgx = this.goalX(this.attack!.e.team);
        const wang = Math.atan2(H / 2 - b.y, wgx - b.x);
        const wi = (this.attack!.wall.indexOf(p) - 1) * 15;
        tx = b.x + Math.cos(wang) * 62 + Math.cos(wang + Math.PI / 2) * wi;
        ty = b.y + Math.sin(wang) * 62 + Math.sin(wang + Math.PI / 2) * wi;
        sp = 175 * p.paceMul;
      } else if (setPiece && this.attack!.e.via === 'penalty' && p !== this.runner && !p.gk) {
        const pgx = this.goalX(this.attack!.e.team);
        const pdir = this.attack!.e.team === 'home' ? 1 : -1;
        if (Math.abs(pgx - tx) < 128 && Math.abs(ty - H / 2) < 112) {
          tx = pgx - pdir * (132 + Math.abs(p.depthOff || 0) * 0.3);
        }
      } else if (
        setPiece &&
        (this.attack!.e.type === 'corner' || this.attack!.e.via === 'corner') &&
        p !== this.attack!.taker
      ) {
        const ce = this.attack!.e;
        const cgx = this.goalX(ce.team);
        const cdir = ce.team === 'home' ? 1 : -1;
        const isAtk = (p.isHome ? 'home' : 'away') === ce.team;
        const SPOTS = [[56, -40], [44, -4], [58, 36], [30, -18], [36, 24], [70, 8], [26, 44]];
        if (!isAtk && p.gk) {
          tx = cgx - cdir * 10;
          ty = H / 2;
        } else if (isAtk && !p.gk && p.num >= 6) {
          const s = SPOTS[p.num % SPOTS.length];
          tx = cgx - cdir * s[0];
          ty = H / 2 + s[1];
        } else if (!isAtk && !p.gk && p.num <= 8) {
          const s = SPOTS[(p.num + 3) % SPOTS.length];
          tx = cgx - cdir * Math.max(14, s[0] - 12);
          ty = H / 2 + s[1] * 0.8;
        }
      } else if ((p === presser || p === presser2) && !setPiece && !this.goalKick && pressEngaged) {
        tx = b.x;
        ty = b.y;
        sp = 165 * p.paceMul * (0.7 + 0.3 * p.defMul);
      } else if (p.run) {
        tx = p.run.tx;
        ty = p.run.ty;
        sp = 160 * p.paceMul;
      } else if (this.attack && this.attack.phase !== 'advance' && attacking && role === 3 && !setPiece) {
        tx += (b.x - tx) * 0.5;
        ty += (b.y - ty) * 0.3;
        sp = 150 * p.paceMul;
      }

      tx = Math.max(M - 6, Math.min(W - M + 6, tx));
      ty = Math.max(M - 6, Math.min(H - M + 6, ty));

      const ddx = tx - p.x;
      const ddy = ty - p.y;
      const dd = Math.hypot(ddx, ddy) || 1;
      const arrive = Math.min(sp, dd * 4);
      p.vx += ((ddx / dd) * arrive - p.vx) * Math.min(1, dt * 5);
      p.vy += ((ddy / dd) * arrive - p.vy) * Math.min(1, dt * 5);
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.x = Math.max(M - 8, Math.min(W - M + 8, p.x));
      p.y = Math.max(M - 8, Math.min(H - M + 8, p.y));
    });

    if (
      !this.script.length &&
      !this.attack &&
      !this.duel &&
      !this.collect &&
      !this.goalKick &&
      this.stealCd <= 0 &&
      this.carrier &&
      presser
    ) {
      const pd = Math.hypot(presser.x - b.x, presser.y - b.y);
      if (pd < 18 && Math.random() < (dt * 2.2 * presser.defMul) / this.carrier.dribMul) {
        this.takeover(defendSide, presser);
        this.passTimer = 0.5 + Math.random() * 0.7;
        this.say(`${this.name(presser)}, 볼 탈취!`);
      }
    }

    // ---- draw ----
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.save();
    const flipped = this.flip !== this.secondHalf;
    if (flipped) {
      ctx.translate(this.canvas.width, 0);
      ctx.rotate(Math.PI / 2);
    } else {
      ctx.translate(0, this.canvas.height);
      ctx.rotate(-Math.PI / 2);
    }
    const textRot = flipped ? -Math.PI / 2 : Math.PI / 2;

    for (let i = 0; i < 8; i++) {
      ctx.fillStyle = i % 2 ? '#1e7a3c' : '#226f3a';
      ctx.fillRect((W / 8) * i, 0, W / 8, H);
    }
    ctx.strokeStyle = 'rgba(255,255,255,.5)';
    ctx.lineWidth = 2;
    ctx.strokeRect(M, M, W - 2 * M, H - 2 * M);
    ctx.beginPath();
    ctx.moveTo(W / 2, M);
    ctx.lineTo(W / 2, H - M);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(W / 2, H / 2, 56, 0, Math.PI * 2);
    ctx.stroke();
    const boxH = BOX_WIDTH;
    const boxW = BOX_DEPTH;
    ctx.strokeRect(M, (H - boxH) / 2, boxW, boxH);
    ctx.strokeRect(W - M - boxW, (H - boxH) / 2, boxW, boxH);
    const goalH = 70;
    ctx.fillStyle = 'rgba(255,255,255,.85)';
    ctx.fillRect(M - 7, (H - goalH) / 2, 7, goalH);
    ctx.fillRect(W - M, (H - goalH) / 2, 7, goalH);

    this.players.forEach((p) => {
      if (p.off && (p.y <= M - 2 || p.y >= H - M + 2)) return;
      const isCarrier = p === this.carrier && !this.script.length;
      ctx.beginPath();
      ctx.arc(p.x, p.y, 12, 0, Math.PI * 2);
      ctx.fillStyle = p.isHome ? (p.gk ? '#1d4ed8' : '#3b82f6') : p.gk ? '#b91c1c' : '#ef4444';
      ctx.fill();
      ctx.lineWidth = isCarrier ? 3 : 1.5;
      ctx.strokeStyle = isCarrier ? '#ffd76e' : 'rgba(255,255,255,.85)';
      ctx.stroke();
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(textRot);
      ctx.fillStyle = '#fff';
      ctx.font = 'bold 11px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(String(p.num), 0, 0.5);
      if (p.label) {
        ctx.font = '9px sans-serif';
        ctx.fillStyle = 'rgba(255,255,255,.75)';
        ctx.fillText(p.label, 0, 21);
      }
      ctx.restore();
    });

    const R = 9;
    if (ballImg.complete && ballImg.naturalWidth) {
      ctx.save();
      ctx.translate(b.x, b.y);
      ctx.rotate(this.ballAngle);
      ctx.drawImage(ballImg, -R, -R, R * 2, R * 2);
      ctx.restore();
    } else {
      ctx.beginPath();
      ctx.arc(b.x, b.y, 6.5, 0, Math.PI * 2);
      ctx.fillStyle = '#fff';
      ctx.fill();
      ctx.strokeStyle = '#111';
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }
    ctx.restore();

    if (this.flash && this.now < this.flash.until) {
      ctx.fillStyle = 'rgba(0,0,0,.45)';
      ctx.fillRect(0, this.canvas.height / 2 - 46, this.canvas.width, 92);
      ctx.fillStyle = '#ffd76e';
      ctx.font = '900 48px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(this.flash.text, this.canvas.width / 2, this.canvas.height / 2);
    }

    this.raf = requestAnimationFrame(this.frameBound);
  }
}
