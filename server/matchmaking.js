'use strict';

const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const store = require('./store');
const auth = require('./auth');
const players = require('./data/players');
const { FORMATIONS, DEFAULT_FORMATION, LINE, posPenalty } = require('./game/formations');
const { simulateMatch, simulateRemainder, TACTICS } = require('./game/simulate');

// 1 simulated minute per tick → a full match streams in ~1 minute,
// slow enough for the client top-view to animate every event.
const TICK_MS = 650;

// 작전 타임: pauses per side per match and the auto-resume timeout.
const PAUSES_PER_SIDE = 2;
const PAUSE_TIMEOUT_MS = 45 * 1000;
const SUBS_PER_SIDE = 5; // EPL rule: five substitutions per match

// [coins, points] per outcome.
const REWARDS = {
  pvp: { win: [500, 3], draw: [250, 1], loss: [120, 0] },
  ai: { win: [250, 1], draw: [120, 0], loss: [60, 0] },
};

function send(ws, msg) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg));
}

function squadReady(user) {
  return (
    user &&
    Array.isArray(user.squad.starters) &&
    user.squad.starters.length === 11 &&
    user.squad.starters.every((id) => id && players.getPlayer(id))
  );
}

function ratingSummary(r) {
  return {
    formation: r.formation,
    ATT: r.ATT,
    MID: r.MID,
    DEF: r.DEF,
    GK: r.GK,
    OVR: r.OVR,
    chemistry: r.chemistry,
  };
}

function tacticName(id) {
  return TACTICS[id] ? TACTICS[id].name : TACTICS.balanced.name;
}

// Slot-ordered starters with the attributes the top view animates from.
// Empty slots are explicitly filled by youth stand-ins (OVR 40) — they play,
// they're weak, and the pitch labels them '유스' instead of showing a ghost.
function lineupOf(squad) {
  const starters = (squad && squad.starters) || [];
  const formation = squad && FORMATIONS[squad.formation] ? squad.formation : DEFAULT_FORMATION;
  const slots = FORMATIONS[formation];
  const up = (squad && squad.upgrades) || {};
  return Array.from({ length: 11 }, (_, i) => {
    const raw = starters[i] && players.getPlayer(starters[i]);
    const p = raw && players.upgraded(raw, up[raw.id]); // 강화 반영
    if (!p) {
      return {
        name: '유스',
        pos: slots[i] || 'CM',
        ovr: 40,
        youth: true,
        attrs: { pace: 45, shooting: 40, passing: 42, dribbling: 42, defending: 42, physical: 44 },
      };
    }
    // converted card: playing out of position changes the shown position and
    // costs up to 10 OVR (CAM at RB etc.)
    const slotPos = slots[i] || p.pos;
    const pen = posPenalty(p.pos, slotPos);
    return { name: p.name, pos: slotPos, ovr: Math.max(30, p.ovr - pen), attrs: p.attrs };
  });
}

// Live-squad validation for 작전 타임 changes (mirrors PUT /api/squad rules).
function validateLiveSquad(user, mode, formation, starters) {
  if (!FORMATIONS[formation]) return '알 수 없는 포메이션입니다.';
  if (!Array.isArray(starters) || starters.length !== 11) {
    return '선발 명단은 11개 슬롯이어야 합니다.';
  }
  const pool = new Set(mode === 'pvp' ? user.drawn : user.owned);
  const slots = FORMATIONS[formation];
  const seen = new Set();
  for (let i = 0; i < 11; i++) {
    const id = starters[i];
    if (id === null) continue;
    const p = players.getPlayer(id);
    if (!p || !pool.has(id)) return '보유하지 않은 선수가 포함되어 있습니다.';
    if (seen.has(id)) return '같은 선수를 두 슬롯에 배치할 수 없습니다.';
    const slotLine = LINE[slots[i]];
    if (slotLine === 'GK' && p.line !== 'GK') return '골키퍼 슬롯에는 골키퍼만 배치할 수 있습니다.';
    if (p.line === 'GK' && slotLine !== 'GK') return '골키퍼는 골키퍼 슬롯에만 배치할 수 있습니다.';
    seen.add(id);
  }
  return null;
}

function attach(server) {
  const wss = new WebSocketServer({ server, path: '/ws' });
  const queue = []; // authed sockets waiting for a PvP opponent
  const playing = new Set(); // userIds currently in a live match
  const active = new Map(); // userId -> running match ctx (pause/subs)
  const live = new Map(); // matchId -> running match ctx (관전 목록)

  function removeFromQueue(ws) {
    const i = queue.indexOf(ws);
    if (i >= 0) queue.splice(i, 1);
  }

  function leaveSpectate(ws) {
    for (const ctx of live.values()) ctx.spectators.delete(ws);
  }

  // Every socket watching a match: both players plus spectators.
  function socketsOf(ctx) {
    return [ctx.home.ws, ctx.away.ws, ...ctx.spectators].filter(Boolean);
  }

  function displayMinute(minute) {
    return minute <= 90 ? `${minute}'` : `90+${minute - 90}'`;
  }

  wss.on('connection', (ws) => {
    ws.userId = null;
    ws.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw);
      } catch {
        return;
      }
      try {
        handle(ws, msg);
      } catch (err) {
        console.error('[ws] handler error:', err);
        send(ws, { type: 'error', error: '서버 오류가 발생했습니다.' });
      }
    });
    ws.on('close', () => {
      removeFromQueue(ws);
      leaveSpectate(ws);
    });
  });

  function handle(ws, msg) {
    if (msg.type === 'auth') {
      const userId = auth.userIdForToken(msg.token);
      const user = userId && store.getUser(userId);
      if (!user) return send(ws, { type: 'error', error: '인증에 실패했습니다. 다시 로그인해 주세요.' });
      ws.userId = userId;
      return send(ws, { type: 'authed' });
    }
    if (!ws.userId) return send(ws, { type: 'error', error: '먼저 인증이 필요합니다.' });

    const user = store.getUser(ws.userId);
    if (!user) return send(ws, { type: 'error', error: '유저 정보를 찾을 수 없습니다.' });

    switch (msg.type) {
      case 'queue': {
        // 랭크(실전) 매치: 실전 스쿼드 사용. 빈 슬롯은 최소 능력치로 채워지므로
        // 스쿼드가 미완성이어도 참가할 수 있다.
        if (playing.has(ws.userId)) return send(ws, { type: 'error', error: '이미 경기 중입니다.' });
        if (queue.some((q) => q.userId === ws.userId))
          return send(ws, { type: 'error', error: '이미 대기열에 등록되어 있습니다.' });

        leaveSpectate(ws);
        const opp = queue.find((q) => q.userId !== ws.userId && q.readyState === 1);
        if (opp) {
          removeFromQueue(opp);
          startPvp(opp, ws);
        } else {
          queue.push(ws);
          send(ws, { type: 'queued' });
        }
        break;
      }
      case 'cancel': {
        removeFromQueue(ws);
        send(ws, { type: 'cancelled' });
        break;
      }
      case 'queue_ai': {
        if (playing.has(ws.userId)) return send(ws, { type: 'error', error: '이미 경기 중입니다.' });
        if (!squadReady(user))
          return send(ws, { type: 'error', error: '선발 11명을 모두 배치한 뒤 대전할 수 있습니다.' });
        removeFromQueue(ws);
        leaveSpectate(ws);
        startAi(ws);
        break;
      }
      case 'spectate_list': {
        // running matches anyone can watch
        const matches = [...live.values()].map((c) => ({
          id: c.id,
          mode: c.mode,
          home: c.home.name,
          away: c.away.name,
          minute: c.minute,
          display: displayMinute(c.minute),
          score: c.score,
        }));
        send(ws, { type: 'spectate_list', matches });
        break;
      }
      case 'spectate': {
        if (playing.has(ws.userId))
          return send(ws, { type: 'error', error: '경기 중에는 관전할 수 없습니다.' });
        const ctx = live.get(msg.matchId);
        if (!ctx)
          return send(ws, { type: 'error', error: '경기를 찾을 수 없습니다. 이미 종료되었을 수 있습니다.' });
        removeFromQueue(ws);
        leaveSpectate(ws);
        ctx.spectators.add(ws);
        // join mid-match: the kept startMsg (refreshed on live squad changes)
        // plus the current minute/score to sync the scoreboard
        send(ws, {
          ...ctx.startMsg,
          youAre: 'home',
          spectate: true,
          minute: ctx.minute,
          display: displayMinute(ctx.minute),
          score: ctx.score,
        });
        break;
      }
      case 'spectate_leave': {
        leaveSpectate(ws);
        break;
      }
      case 'pause': {
        const ctx = active.get(ws.userId);
        if (!ctx || ctx.paused) return send(ws, { type: 'error', error: '지금은 작전 타임을 요청할 수 없습니다.' });
        const side = sideOf(ctx, ws.userId);
        if (ctx.minute >= 88 + (ctx.stoppage || 0))
          return send(ws, { type: 'error', error: '경기 종료 직전에는 작전 타임을 쓸 수 없습니다.' });
        if (ctx.pauses[side] <= 0) return send(ws, { type: 'error', error: '남은 작전 타임이 없습니다.' });
        ctx.paused = true;
        ctx.pausedBy = side;
        ctx.pauses[side]--;
        clearInterval(ctx.interval);
        ctx.pauseTimeout = setTimeout(() => resumeMatch(ctx), PAUSE_TIMEOUT_MS);
        const msgFor = (mySide) => ({
          type: 'paused',
          by: side,
          yours: mySide === side,
          minute: ctx.minute,
          pausesLeft: ctx.pauses,
          timeoutSec: PAUSE_TIMEOUT_MS / 1000,
          squad:
            mySide === side
              ? { formation: ctx.squads[side].formation, starters: ctx.squads[side].starters }
              : null,
          poolKind: ctx.mode === 'pvp' ? 'drawn' : 'owned',
        });
        send(ctx.home.ws, msgFor('home'));
        send(ctx.away.ws, msgFor('away'));
        const specPaused = msgFor('spec'); // yours:false, squad:null
        ctx.spectators.forEach((s) => send(s, specPaused));
        break;
      }
      case 'resume': {
        const ctx = active.get(ws.userId);
        if (ctx && ctx.paused && sideOf(ctx, ws.userId) === ctx.pausedBy) resumeMatch(ctx);
        break;
      }
      case 'update_squad': {
        const ctx = active.get(ws.userId);
        if (!ctx || !ctx.paused) {
          return send(ws, { type: 'error', error: '작전 타임 중에만 스쿼드를 변경할 수 있습니다.' });
        }
        const side = sideOf(ctx, ws.userId);
        if (side !== ctx.pausedBy) {
          return send(ws, { type: 'error', error: '자신이 요청한 작전 타임에만 변경할 수 있습니다.' });
        }
        const formation = msg.formation || ctx.squads[side].formation;
        const err = validateLiveSquad(user, ctx.mode, formation, msg.starters);
        if (err) return send(ws, { type: 'error', error: err });
        // 퇴장당한 선수는 다시 출전할 수 없다
        const offNames = redsSoFar(ctx).names[side];
        if (
          offNames.size &&
          msg.starters.some((id) => {
            const p = id && players.getPlayer(id);
            return p && offNames.has(p.name);
          })
        ) {
          return send(ws, { type: 'error', error: '퇴장당한 선수는 다시 출전할 수 없습니다.' });
        }
        // EPL rule: at most 5 substitutions per match (position swaps among
        // the current XI are free — only new entrants count)
        const current = ctx.squads[side].starters;
        const newcomers = msg.starters.filter((id) => id && !current.includes(id)).length;
        if (ctx.subs[side] + newcomers > SUBS_PER_SIDE) {
          return send(ws, {
            type: 'error',
            error: `교체는 경기당 최대 ${SUBS_PER_SIDE}명입니다. (남은 교체: ${Math.max(0, SUBS_PER_SIDE - ctx.subs[side])}명)`,
          });
        }
        ctx.subs[side] += newcomers;
        applyLiveSquad(ctx, side, formation, msg.starters);
        break;
      }
      default:
        break;
    }
  }

  function sideOf(ctx, userId) {
    return ctx.home.user && ctx.home.user.id === userId ? 'home' : 'away';
  }

  function resumeMatch(ctx) {
    if (!ctx.paused) return;
    ctx.paused = false;
    ctx.pausedBy = null;
    clearTimeout(ctx.pauseTimeout);
    ctx.interval = setInterval(() => stepMatch(ctx), TICK_MS);
    socketsOf(ctx).forEach((s) => send(s, { type: 'resumed', pausesLeft: ctx.pauses }));
  }

  // Live squad change: re-simulate the remainder with the new lineup and
  // splice the fresh timeline in from the current minute.
  // Reds that have already been shown, per side (재시뮬 수적 열세 + 재출전 금지).
  function redsSoFar(ctx) {
    const reds = { home: 0, away: 0 };
    const names = { home: new Set(), away: new Set() };
    for (const [m, evs] of ctx.byMinute) {
      if (m > ctx.minute) continue;
      evs.forEach((e) => {
        if (e.red) {
          reds[e.team]++;
          names[e.team].add(e.player);
        }
      });
    }
    return { reds, names };
  }

  function applyLiveSquad(ctx, side, formation, starters) {
    ctx.squads[side] = {
      formation,
      starters,
      tactic: ctx.squads[side].tactic,
      upgrades: ctx.squads[side].upgrades || {},
    };
    const r = simulateRemainder(
      ctx.squads.home,
      ctx.squads.away,
      ctx.minute,
      ctx.score,
      ctx.home.name,
      ctx.away.name,
      { sentOff: redsSoFar(ctx).reds }
    );
    ctx.result.ratings = r.ratings;
    ctx.result.possession = r.possession;
    ctx.result.xg = r.xg;
    ctx.result.score = r.score;
    for (const m of [...ctx.byMinute.keys()]) if (m > ctx.minute) ctx.byMinute.delete(m);
    r.timeline.forEach((e) => {
      if (!ctx.byMinute.has(e.minute)) ctx.byMinute.set(e.minute, []);
      ctx.byMinute.get(e.minute).push(e);
    });
    const upd = {
      type: 'squad_updated',
      side,
      possession: r.possession,
      home: { ratings: ratingSummary(r.ratings.home), players: lineupOf(ctx.squads.home) },
      away: { ratings: ratingSummary(r.ratings.away), players: lineupOf(ctx.squads.away) },
    };
    // keep the stored start message current for spectators joining later
    ctx.startMsg.possession = r.possession;
    ['home', 'away'].forEach((s) => {
      ctx.startMsg[s].ratings = upd[s].ratings;
      ctx.startMsg[s].players = upd[s].players;
    });
    socketsOf(ctx).forEach((s) => send(s, upd));
  }

  function startPvp(homeWs, awayWs) {
    const home = store.getUser(homeWs.userId);
    const away = store.getUser(awayWs.userId);
    if (!home || !away) return;
    const hs = liveSquad(home, home.pvpSquad);
    const as = liveSquad(away, away.pvpSquad);
    const result = simulateMatch(hs, as, home.clubName, away.clubName);
    runMatch({
      mode: 'pvp',
      result,
      squads: { home: hs, away: as },
      home: { ws: homeWs, user: home, name: home.clubName, lineup: lineupOf(hs) },
      away: { ws: awayWs, user: away, name: away.clubName, lineup: lineupOf(as) },
    });
  }

  function startAi(ws) {
    const user = store.getUser(ws.userId);
    // AI 상대는 클럽팀 중에서, 전술은 무작위로 고른다.
    const clubs = players.teamList().filter((t) => t.type === 'club');
    const team = clubs[Math.floor(Math.random() * clubs.length)];
    const tactics = Object.keys(TACTICS);
    const aiSquad = {
      formation: DEFAULT_FORMATION,
      starters: team.playerIds.slice(0, 11),
      tactic: tactics[Math.floor(Math.random() * tactics.length)],
      upgrades: {},
    };
    const us = liveSquad(user, user.squad);
    const aiName = `${team.name} (AI)`;
    const result = simulateMatch(us, aiSquad, user.clubName, aiName);
    runMatch({
      mode: 'ai',
      result,
      squads: { home: us, away: aiSquad },
      home: { ws, user, name: user.clubName, lineup: lineupOf(us) },
      away: { ws: null, user: null, name: aiName, lineup: lineupOf(aiSquad) },
    });
  }

  // Detached copy of a user's squad with their 강화 levels attached, so the
  // simulation and the top view both see the boosted cards.
  function liveSquad(user, sq) {
    return {
      formation: sq.formation,
      starters: [...sq.starters],
      tactic: sq.tactic,
      upgrades: (user && user.upgrades) || {},
    };
  }

  function runMatch(ctx) {
    const { result, home, away, mode } = ctx;
    if (home.user) playing.add(home.user.id);
    if (away.user) playing.add(away.user.id);

    const startMsg = {
      type: 'match_start',
      mode,
      home: {
        name: home.name,
        ratings: ratingSummary(result.ratings.home),
        tactic: result.tactics.home,
        tacticName: tacticName(result.tactics.home),
        players: home.lineup,
      },
      away: {
        name: away.name,
        ratings: ratingSummary(result.ratings.away),
        tactic: result.tactics.away,
        tacticName: tacticName(result.tactics.away),
        players: away.lineup,
      },
      possession: result.possession,
    };
    // each client learns which side is theirs so the pitch can point their
    // team upfield from the bottom of the screen
    send(home.ws, { ...startMsg, youAre: 'home' });
    send(away.ws, { ...startMsg, youAre: 'away' });

    // Group timeline events by minute for streaming.
    ctx.byMinute = new Map();
    result.timeline.forEach((e) => {
      if (!ctx.byMinute.has(e.minute)) ctx.byMinute.set(e.minute, []);
      ctx.byMinute.get(e.minute).push(e);
    });

    ctx.minute = 0;
    ctx.score = { home: 0, away: 0 };
    // injury time: more late events -> more stoppage (2~5분)
    const lateEvents = result.timeline.filter((e) => e.minute > 60).length;
    ctx.stoppage = Math.max(2, Math.min(5, 1 + Math.round(lateEvents / 3)));
    ctx.paused = false;
    ctx.pausedBy = null;
    ctx.pauses = { home: PAUSES_PER_SIDE, away: PAUSES_PER_SIDE };
    ctx.subs = { home: 0, away: 0 }; // EPL: 5 subs per side per match
    // 관전: keep the start message (refreshed on live squad changes) so
    // spectators joining mid-match get the current lineups
    ctx.id = 'g' + crypto.randomBytes(4).toString('hex');
    ctx.spectators = new Set();
    ctx.startMsg = startMsg;
    live.set(ctx.id, ctx);
    if (home.user) active.set(home.user.id, ctx);
    if (away.user) active.set(away.user.id, ctx);
    ctx.interval = setInterval(() => stepMatch(ctx), TICK_MS);
  }

  function stepMatch(ctx) {
    const sockets = socketsOf(ctx);
    ctx.minute++;
    const display = displayMinute(ctx.minute);
    const events = ctx.byMinute.get(ctx.minute) || [];
    events.forEach((e) => {
      if (e.type === 'goal') ctx.score = e.score;
      sockets.forEach((s) => send(s, { type: 'event', event: e }));
    });
    sockets.forEach((s) => send(s, { type: 'tick', minute: ctx.minute, display, score: ctx.score }));
    if (ctx.minute === 45) {
      sockets.forEach((s) =>
        send(s, { type: 'phase', text: `⏱ 하프타임 (${ctx.score.home} - ${ctx.score.away})`, half: true })
      );
    }
    if (ctx.minute === 90) {
      sockets.forEach((s) => send(s, { type: 'phase', text: `⏱ 추가 시간 +${ctx.stoppage}분` }));
    }
    if (ctx.minute >= 90 + ctx.stoppage) {
      clearInterval(ctx.interval);
      clearTimeout(ctx.pauseTimeout);
      if (ctx.home.user) active.delete(ctx.home.user.id);
      if (ctx.away.user) active.delete(ctx.away.user.id);
      live.delete(ctx.id);
      finishMatch(ctx);
    }
  }

  function finishMatch(ctx) {
    const { result, home, away, mode } = ctx;
    const { score } = result;

    const outcomeFor = (side) => {
      if (score.home === score.away) return 'draw';
      const homeWon = score.home > score.away;
      return (side === 'home') === homeWon ? 'win' : 'loss';
    };

    const applyReward = (side) => {
      const u = side.user && store.getUser(side.user.id);
      if (!u) return null;
      const outcome = outcomeFor(side === home ? 'home' : 'away');
      const [coins, points] = REWARDS[mode][outcome];
      u.coins += coins;
      u.points += points;
      if (outcome === 'win') u.record.w++;
      else if (outcome === 'draw') u.record.d++;
      else u.record.l++;
      store.putUser(u);
      return { outcome, coins, points, balance: u.coins };
    };

    const homeReward = applyReward(home);
    const awayReward = applyReward(away);

    store.addMatch({
      id: 'm' + crypto.randomBytes(6).toString('hex'),
      at: new Date().toISOString(),
      mode,
      homeUserId: home.user ? home.user.id : null,
      awayUserId: away.user ? away.user.id : null,
      homeName: home.name,
      awayName: away.name,
      score,
      possession: result.possession,
      xg: result.xg,
    });

    if (home.user) playing.delete(home.user.id);
    if (away.user) playing.delete(away.user.id);

    const resultMsg = (side, reward) => ({
      type: 'result',
      score,
      possession: result.possession,
      xg: result.xg,
      home: home.name,
      away: away.name,
      outcome: reward ? reward.outcome : null,
      reward: reward ? { coins: reward.coins, points: reward.points } : null,
      balance: reward ? reward.balance : null,
    });
    send(home.ws, resultMsg(home, homeReward));
    send(away.ws, resultMsg(away, awayReward));
    // spectators see the final whistle too (no outcome/reward of their own)
    const specMsg = resultMsg(null, null);
    ctx.spectators.forEach((s) => send(s, specMsg));
    ctx.spectators.clear();
  }

  return wss;
}

module.exports = { attach };
