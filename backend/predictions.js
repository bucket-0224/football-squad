'use strict';

const store = require('./store');

// ---------------------------------------------------------------------------
// League predictions (승부 예측) — real fixtures.
//
// Upcoming matches are pulled from TheSportsDB (the same service the team
// logos come from): one next fixture per tracked league. Users bet on the
// outcome (and optionally the exact score) before the real kickoff. Once the
// real result is published, the fixture resolves and pays out — the reward
// scales with how hard the pick actually was to make (see rewardFor):
//   exact score   -> 200 (+ up to 150 more for a wild, high-scoring line)
//   draw, correct -> 160 (draws are the rarer outcome across most leagues)
//   win/loss, correct -> 100
//   participation -> 50 coins regardless
// All network access is throttled and cached in the store, so the API's
// free-tier rate limit is never approached and offline reads keep working.
// ---------------------------------------------------------------------------

const REWARD_EXACT = 200;
const REWARD_OUTCOME = 100;
const REWARD_DRAW_OUTCOME = 160;
const REWARD_PLAY = 50;
const EXACT_BONUS_PER_GOAL = 30; // a wilder scoreline is harder to call exactly
const EXACT_BONUS_MAX = 150;

const TSDB = 'https://www.thesportsdb.com/api/v1/json/3';
const LEAGUES = [
  { id: 4328, label: 'EPL' },
  { id: 4335, label: '라리가' },
  { id: 4331, label: '분데스리가' },
  { id: 4332, label: '세리에 A' },
  { id: 4334, label: '리그 1' },
  { id: 4346, label: 'MLS' },
  { id: 4351, label: '브라질레이랑' },
  { id: 4689, label: 'K리그 1' },
];

const UPCOMING_TTL_MS = 10 * 60 * 1000; // refresh fixture list every 10 min
const RESULT_TTL_MS = 5 * 60 * 1000; // poll finished games every 5 min
const MATCH_RUNNING_MS = 105 * 60 * 1000; // don't even check for a result before ~FT
// 요청: "경기가 안 끝났는데 예측 탭에서 끝난 걸로 처리" — 105분이 지나고
// intHomeScore/intAwayScore가 채워져 있기만 하면(연장전/승부차기/지연으로
// 아직 진행 중이어도 라이브 스코어는 이미 들어있다) 곧바로 종료 처리하던
// 게 원인이었다. 이 시점부턴 strStatus로 "진짜 끝났는지"부터 확인하고,
// 안 끝났으면 계속 live로 두고 다음 tick(RESULT_TTL_MS)에 다시 본다.
// MATCH_FORCE_SETTLE_MS는 안전망 — 리그별로 strStatus 표기가 일관되지
// 않아 "끝남"을 영영 못 읽는 경우에도, 연장전+승부차기+지연을 다 감안해도
// 이 시점이면 사실상 끝났다고 보고 강제로 정산한다(fixture가 영원히
// live에 머물러 정산이 안 되는 걸 막는 최후 보루).
const MATCH_FORCE_SETTLE_MS = 170 * 60 * 1000;
const HISTORY_MAX = 12;

let lastUpcomingFetch = 0;
let lastResultFetch = 0;
let refreshing = null; // in-flight refresh promise (dedupes concurrent reads)

function db() {
  const d = store.get();
  // v2: real fixtures keyed by TheSportsDB event id (old simulated rounds
  // from v1 are discarded on first read)
  if (!d.predictions || d.predictions.v !== 2) {
    d.predictions = { v: 2, fixtures: [], resolved: [] };
  }
  return d.predictions;
}

async function tsdb(path) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 8000);
  try {
    const res = await fetch(`${TSDB}/${path}`, { signal: ctl.signal });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function kickoffMs(ev) {
  // strTimestamp is UTC without a zone suffix
  if (ev.strTimestamp) {
    const t = Date.parse(ev.strTimestamp + 'Z');
    if (!Number.isNaN(t)) return t;
  }
  if (ev.dateEvent) {
    const t = Date.parse(`${ev.dateEvent}T${ev.strTime || '12:00:00'}Z`);
    if (!Number.isNaN(t)) return t;
  }
  return 0;
}

function fixtureFromEvent(ev, league) {
  return {
    id: 'tsdb' + ev.idEvent,
    eventId: ev.idEvent,
    league: league.id,
    leagueLabel: league.label,
    home: ev.strHomeTeam,
    away: ev.strAwayTeam,
    homeLogo: ev.strHomeTeamBadge || null,
    awayLogo: ev.strAwayTeamBadge || null,
    kickoffAt: kickoffMs(ev),
    status: 'open', // open -> live (kicked off) -> done
    result: null,
    bets: {}, // userId -> { pick, score?, reward?, rewarded }
  };
}

// 요청: "K리그 실시간 76분인데 현재 예측 여기선 99분으로 뜸" — 예전엔
// 킥오프 시각으로부터 그냥 흐른 벽시계 분을 그대로 보여줬는데, 하프타임
// 휴식(약 15분)만큼 실제 경기 시간보다 항상 더 크게 나온다(전/후반 사이
// 공은 안 굴러가는데 시계는 계속 흐르므로). 두 단계로 보정한다:
//   1) TheSportsDB가 strStatus에 실제 분(예: "76")을 그대로 주는 경우가
//      있어 그게 있으면 최우선으로 쓴다 — 벽시계 추정은 그게 없을 때만.
//   2) 없으면 벽시계 경과분에서 하프타임 휴식분을 빼는 방식으로 추정.
//      전반 45분까지는 그대로, 휴식 구간(45~45+휴식분)엔 45분에 고정,
//      후반 시작 뒤엔 휴식분만큼 빼서 실제 경기 시간에 더 가깝게 만든다.
//      추가시간까지 정확히 맞출 순 없지만(그건 API가 없으면 알 수 없다),
//      최소한 하프타임만큼 부풀려 보이는 건 없앤다.
const HALFTIME_BREAK_MIN = 15;
const LIVE_MINUTE_CAP = 130;

function liveMinuteFromStatus(status) {
  if (!status) return null;
  const m = /^(\d{1,3})'?$/.exec(String(status).trim());
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) && n >= 0 ? Math.min(LIVE_MINUTE_CAP, n) : null;
}

function estimateLiveMinute(wallClockMin) {
  if (wallClockMin <= 45) return wallClockMin;
  if (wallClockMin <= 45 + HALFTIME_BREAK_MIN) return 45;
  return Math.min(LIVE_MINUTE_CAP, wallClockMin - HALFTIME_BREAK_MIN);
}

// TheSportsDB의 strStatus는 리그/제공사에 따라 표기가 제각각이라
// (예: "FT", "Match Finished", "AET", "Pen") 실제로 관측되는 "끝남" 계열
// 표기를 폭넓게 인식한다 — 반대로 "1H"/"HT"/"2H"/분 숫자처럼 진행 중을
// 뜻하는 값은 여기 안 걸려 false로 남는다.
function isFinishedStatus(status) {
  if (!status) return false;
  const s = String(status).trim().toUpperCase();
  return s === 'FT' || s === 'AET' || s === 'PEN' || s === 'AWARDED' || s.includes('FINISH');
}

function outcomeOf(score) {
  if (score.home === score.away) return 'draw';
  return score.home > score.away ? 'home' : 'away';
}

// Reward scales with how hard the real result actually was to predict —
// no external odds feed exists (free tier), so this uses the match's own
// final score as the difficulty signal instead: a wild high-scoring exact
// call pays more than a plain 1-0, and picking a draw (the rarer outcome in
// most leagues) pays more than picking a straightforward win.
function rewardFor(bet, result) {
  const { score, outcome } = result;
  const exactMatch = bet.score && bet.score.home === score.home && bet.score.away === score.away;
  if (exactMatch) {
    const totalGoals = score.home + score.away;
    const bonus = Math.min(EXACT_BONUS_MAX, Math.max(0, totalGoals - 2) * EXACT_BONUS_PER_GOAL);
    return REWARD_EXACT + bonus;
  }
  if (bet.pick === outcome) {
    return outcome === 'draw' ? REWARD_DRAW_OUTCOME : REWARD_OUTCOME;
  }
  return REWARD_PLAY;
}

function settle(fx, score) {
  fx.status = 'done';
  fx.result = { score, outcome: outcomeOf(score) };
  fx.resolvedAt = Date.now();
  Object.entries(fx.bets).forEach(([userId, bet]) => {
    if (bet.rewarded) return;
    const reward = rewardFor(bet, fx.result);
    bet.reward = reward;
    bet.rewarded = true;
    const u = store.getUser(userId);
    if (u) {
      u.coins += reward;
      store.putUser(u);
    }
  });
}

// Pull upcoming real fixtures of every tracked league into the board. The
// free tier's eventsnextleague returns just one event, but its round+season
// unlock eventsround (also free, up to 5 events per call) — so the whole
// current round of every league lands on the board.
async function refreshUpcoming(p) {
  const known = new Set(p.fixtures.map((f) => f.eventId));
  const now = Date.now();
  for (const league of LEAGUES) {
    const data = await tsdb(`eventsnextleague.php?id=${league.id}`);
    const events = (data && data.events) || [];
    let pool = events;
    const first = events[0];
    if (first && first.intRound && first.strSeason) {
      const round = await tsdb(
        `eventsround.php?id=${league.id}&r=${first.intRound}&s=${encodeURIComponent(first.strSeason)}`
      );
      const roundEvents = (round && round.events) || [];
      if (roundEvents.length) {
        const seen = new Set();
        pool = [...roundEvents, ...events].filter((ev) => {
          if (seen.has(ev.idEvent)) return false;
          seen.add(ev.idEvent);
          return true;
        });
      }
    }
    for (const ev of pool) {
      if (known.has(ev.idEvent) || p.resolved.some((f) => f.eventId === ev.idEvent)) continue;
      const fx = fixtureFromEvent(ev, league);
      // 이미 한참 지난 라운드 잔여 경기는 제외 (킥오프 1시간 전후부터만)
      if (fx.kickoffAt && fx.kickoffAt > now - 60 * 60 * 1000) {
        p.fixtures.push(fx);
        known.add(ev.idEvent);
      }
    }
  }
}

// Fetch real final scores for fixtures whose match should have ended.
// Looks up each due fixture directly by its own event id (lookupevent.php —
// same endpoint refreshLive already uses for live scores) rather than
// searching a shared "recent past events for this league" list: that bulk
// endpoint is capped to a small handful of events on the free tier, so a
// fixture could silently never be found there once enough other matches
// had since taken its place in the window — leaving it stuck open/live
// forever even with a working cron calling this on schedule.
async function resolveDue(p, now) {
  const due = p.fixtures.filter((f) => f.status !== 'done' && now >= f.kickoffAt + MATCH_RUNNING_MS);
  for (const fx of due) {
    const data = await tsdb(`lookupevent.php?id=${fx.eventId}`);
    const ev = data && data.events && data.events[0];
    if (!ev) continue;
    const h = Number(ev.intHomeScore);
    const a = Number(ev.intAwayScore);
    if (ev.intHomeScore == null || Number.isNaN(h) || Number.isNaN(a)) continue;
    // 105분이 지났다고 곧바로 종료 처리하지 않는다 — 그 시점에도 스코어
    // 필드는 이미 채워져 있지만(라이브 스코어), 연장전/승부차기/지연 등으로
    // 아직 실제로 진행 중일 수 있다. strStatus로 진짜 종료를 확인하고,
    // 안 끝났으면 live로 갱신만 하고 다음 tick에 다시 확인한다 — 단
    // MATCH_FORCE_SETTLE_MS를 넘기면(리그별 상태 표기 불일치 대비 안전망)
    // 상태와 무관하게 그냥 정산한다.
    const finished = isFinishedStatus(ev.strStatus);
    if (!finished && now - fx.kickoffAt < MATCH_FORCE_SETTLE_MS) {
      fx.status = 'live';
      fx.lastLiveFetch = now;
      fx.live = { home: h, away: a, status: ev.strStatus || null };
      continue;
    }
    settle(fx, { home: h, away: a });
  }
  // move settled fixtures into the history list
  const settled = p.fixtures.filter((f) => f.status === 'done');
  if (settled.length) {
    p.fixtures = p.fixtures.filter((f) => f.status !== 'done');
    p.resolved = [...settled, ...p.resolved].slice(0, HISTORY_MAX);
  }
}

// 관리자 전용 전수 감사: 이미 'done'으로 정산된 경기 전부를 TheSportsDB에서
// 다시 조회해 (a) 실제로 끝났는지, (b) 기록된 스코어가 맞는지 재확인한다.
// 배포 전 버그(105분이 지나고 스코어 필드가 채워져 있기만 하면 곧바로
// 종료 처리 — resolveDue의 옛 로직)로 인해 실제로는 아직 진행 중이던
// 경기가 잘못 정산됐을 수 있어, 배포 후 한 번 돌려서 바로잡기 위한 것.
// 문제가 있는 건: 이미 지급된 보상을 회수하고(코인 차감, 0 밑으로는 안
// 내려감), 정산 상태를 리셋해 live로 되돌린다 — 그러면 다음 tick의
// resolveDue가 (이미 고쳐진 로직으로) 실제로 끝났을 때 다시, 이번엔
// 올바르게 정산한다. 새 정산 로직을 여기서 중복 구현하지 않고 기존
// 플로우에 그대로 태우는 것이 핵심.
async function auditResolved() {
  const p = db();
  const report = { checked: 0, reverted: [], unchanged: [], notFound: [] };
  const keep = [];
  for (const fx of p.resolved) {
    report.checked++;
    const data = await tsdb(`lookupevent.php?id=${fx.eventId}`);
    const ev = data && data.events && data.events[0];
    if (!ev) {
      report.notFound.push({ id: fx.id, label: `${fx.home} vs ${fx.away}` });
      keep.push(fx);
      continue;
    }
    const finished = isFinishedStatus(ev.strStatus);
    const h = Number(ev.intHomeScore);
    const a = Number(ev.intAwayScore);
    const hasScore = ev.intHomeScore != null && !Number.isNaN(h) && !Number.isNaN(a);
    const scoreMatches = hasScore && fx.result && fx.result.score.home === h && fx.result.score.away === a;

    if (finished && scoreMatches) {
      report.unchanged.push({ id: fx.id, label: `${fx.home} vs ${fx.away}`, apiStatus: ev.strStatus });
      keep.push(fx);
      continue;
    }

    const previousResult = fx.result;
    let usersAffected = 0;
    Object.entries(fx.bets).forEach(([userId, bet]) => {
      if (!bet.rewarded) return;
      const u = store.getUser(userId);
      if (u) {
        u.coins = Math.max(0, u.coins - (bet.reward || 0));
        store.putUser(u);
        usersAffected++;
      }
      bet.rewarded = false;
      bet.reward = null;
    });
    fx.status = 'live';
    fx.result = null;
    fx.resolvedAt = null;
    fx.live = hasScore ? { home: h, away: a, status: ev.strStatus || null } : fx.live || null;
    fx.lastLiveFetch = Date.now();
    p.fixtures.push(fx);
    report.reverted.push({
      id: fx.id,
      label: `${fx.home} vs ${fx.away}`,
      previousResult,
      apiStatus: ev.strStatus || null,
      apiScore: hasScore ? { home: h, away: a } : null,
      usersAffected,
    });
  }
  p.resolved = keep;
  store.save();
  return report;
}

// Best-effort live score/status peek for kicked-off fixtures. TheSportsDB's
// free tier has no dedicated livescore endpoint, but a plain event lookup
// does carry intHomeScore/intAwayScore/strStatus once the data provider has
// them — this is purely informational (never drives settlement, which still
// waits on resolveDue/MATCH_RUNNING_MS) so a miss/empty response just means
// the live line falls back to the elapsed-time-only display.
const LIVE_TTL_MS = 45 * 1000;

async function refreshLive(p, now) {
  const due = p.fixtures.filter(
    (f) => f.status === 'live' && now - (f.lastLiveFetch || 0) > LIVE_TTL_MS
  );
  for (const fx of due) {
    fx.lastLiveFetch = now;
    const data = await tsdb(`lookupevent.php?id=${fx.eventId}`);
    const ev = data && data.events && data.events[0];
    if (!ev) continue;
    const h = Number(ev.intHomeScore);
    const a = Number(ev.intAwayScore);
    if (ev.intHomeScore != null && !Number.isNaN(h) && !Number.isNaN(a)) {
      fx.live = { home: h, away: a, status: ev.strStatus || null };
    }
  }
}

// Refresh caches (throttled) and mark kicked-off fixtures live.
async function tick() {
  const p = db();
  const now = Date.now();
  let changed = false;

  p.fixtures.forEach((fx) => {
    if (fx.status === 'open' && now >= fx.kickoffAt) {
      fx.status = 'live';
      changed = true;
    }
  });

  const wantUpcoming = now - lastUpcomingFetch > UPCOMING_TTL_MS;
  const wantResults =
    now - lastResultFetch > RESULT_TTL_MS &&
    p.fixtures.some((f) => f.status !== 'done' && now >= f.kickoffAt + MATCH_RUNNING_MS);
  const wantLive = p.fixtures.some(
    (f) => f.status === 'live' && now - (f.lastLiveFetch || 0) > LIVE_TTL_MS
  );

  if ((wantUpcoming || wantResults || wantLive) && !refreshing) {
    refreshing = (async () => {
      if (wantUpcoming) {
        lastUpcomingFetch = now;
        await refreshUpcoming(p);
      }
      if (wantResults) {
        lastResultFetch = now;
        await resolveDue(p, now);
      }
      if (wantLive) {
        await refreshLive(p, now);
      }
      store.save();
    })().finally(() => {
      refreshing = null;
    });
  }
  if (refreshing) await refreshing;
  else if (changed) store.save();
}

function fixtureView(fx, userId) {
  const bet = fx.bets[userId] || null;
  const isLive = fx.status === 'live';
  return {
    id: fx.id,
    league: fx.league,
    leagueLabel: fx.leagueLabel,
    home: fx.home,
    away: fx.away,
    homeLogo: fx.homeLogo,
    awayLogo: fx.awayLogo,
    kickoffAt: fx.kickoffAt,
    status: fx.status,
    // 실시간 경과 시간: TheSportsDB가 strStatus에 실제 분을 주면 그걸
    // 우선 쓰고(가장 정확), 없으면 킥오프 시각으로부터 하프타임 휴식을
    // 보정한 추정치로 대체한다(위 estimateLiveMinute 참고) — 벽시계
    // 경과분을 그대로 보여주면 하프타임만큼 항상 부풀려 보인다.
    elapsedMin: isLive
      ? liveMinuteFromStatus(fx.live && fx.live.status) ??
        estimateLiveMinute(Math.max(0, Math.floor((Date.now() - fx.kickoffAt) / 60000)))
      : null,
    live: isLive && fx.live ? { home: fx.live.home, away: fx.live.away } : null,
    result: fx.result ? { score: fx.result.score, outcome: fx.result.outcome } : null,
    myBet: bet ? { pick: bet.pick, score: bet.score || null, reward: bet.reward || null } : null,
  };
}

async function getRounds(userId) {
  await tick();
  const p = db();
  const current = [...p.fixtures].sort((a, b) => a.kickoffAt - b.kickoffAt);
  return {
    rewards: {
      exact: REWARD_EXACT,
      exactMax: REWARD_EXACT + EXACT_BONUS_MAX,
      outcome: REWARD_OUTCOME,
      drawOutcome: REWARD_DRAW_OUTCOME,
      play: REWARD_PLAY,
    },
    current: current.map((fx) => fixtureView(fx, userId)),
    last: p.resolved.map((fx) => fixtureView(fx, userId)),
  };
}

function placeBet(user, fixtureId, pick, score) {
  const p = db();
  const fx = p.fixtures.find((f) => f.id === fixtureId);
  if (!fx) return { error: '존재하지 않는 경기입니다.', status: 404 };
  if (fx.status !== 'open' || Date.now() >= fx.kickoffAt) {
    return { error: '이미 킥오프된 경기입니다.', status: 400 };
  }
  if (!['home', 'draw', 'away'].includes(pick)) {
    return { error: '승/무/패 중 하나를 선택해 주세요.', status: 400 };
  }
  let cleanScore = null;
  if (score && score.home !== undefined && score.home !== null && score.home !== '') {
    const h = Number(score.home);
    const a = Number(score.away);
    if (!Number.isInteger(h) || !Number.isInteger(a) || h < 0 || a < 0 || h > 9 || a > 9) {
      return { error: '스코어는 0~9 사이 정수여야 합니다.', status: 400 };
    }
    const impliedOutcome = h === a ? 'draw' : h > a ? 'home' : 'away';
    if (impliedOutcome !== pick) {
      return { error: '예상 스코어가 선택한 승/무/패와 일치하지 않습니다.', status: 400 };
    }
    cleanScore = { home: h, away: a };
  }
  fx.bets[user.id] = { pick, score: cleanScore, rewarded: false };
  store.save();
  return { fixture: fixtureView(fx, user.id) };
}

// Real cron sweep (mirrors season.js/devotion.js's init/setInterval shape).
// tick() previously only ran when a user happened to request /api/predictions
// (getRounds), so a fixture nobody checked on could sit at status:'open' or
// 'live' indefinitely after the real match had long since finished — this
// runs it independent of any request, so results settle promptly.
const TICK_INTERVAL_MS = 5 * 60 * 1000; // matches RESULT_TTL_MS granularity
function init() {
  tick().catch((err) => console.error('[predictions] init tick failed:', err));
  setInterval(() => {
    tick().catch((err) => console.error('[predictions] cron tick failed:', err));
  }, TICK_INTERVAL_MS);
}

module.exports = { init, getRounds, placeBet, auditResolved };
