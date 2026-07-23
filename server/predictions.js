'use strict';

const store = require('./store');

// ---------------------------------------------------------------------------
// League predictions (승부 예측) — real fixtures.
//
// Upcoming matches are pulled from TheSportsDB (the same service the team
// logos come from): one next fixture per tracked league. Users bet on the
// outcome (and optionally the exact score) before the real kickoff. Once the
// real result is published, the fixture resolves and pays out:
//   exact score  -> 200 coins
//   outcome only -> 100 coins
//   participation -> 50 coins
// All network access is throttled and cached in the store, so the API's
// free-tier rate limit is never approached and offline reads keep working.
// ---------------------------------------------------------------------------

const REWARD_EXACT = 200;
const REWARD_OUTCOME = 100;
const REWARD_PLAY = 50;

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
const MATCH_RUNNING_MS = 105 * 60 * 1000; // don't poll results before ~FT
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

function outcomeOf(score) {
  if (score.home === score.away) return 'draw';
  return score.home > score.away ? 'home' : 'away';
}

function settle(fx, score) {
  fx.status = 'done';
  fx.result = { score, outcome: outcomeOf(score) };
  fx.resolvedAt = Date.now();
  Object.entries(fx.bets).forEach(([userId, bet]) => {
    if (bet.rewarded) return;
    let reward = REWARD_PLAY;
    if (bet.pick === fx.result.outcome) {
      reward = REWARD_OUTCOME;
      if (bet.score && bet.score.home === score.home && bet.score.away === score.away) {
        reward = REWARD_EXACT;
      }
    }
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
async function resolveDue(p, now) {
  const dueLeagues = [
    ...new Set(
      p.fixtures
        .filter((f) => f.status !== 'done' && now >= f.kickoffAt + MATCH_RUNNING_MS)
        .map((f) => f.league)
    ),
  ];
  for (const leagueId of dueLeagues) {
    const data = await tsdb(`eventspastleague.php?id=${leagueId}`);
    const events = (data && data.events) || [];
    for (const ev of events) {
      const fx = p.fixtures.find((f) => f.eventId === ev.idEvent && f.status !== 'done');
      if (!fx) continue;
      const h = Number(ev.intHomeScore);
      const a = Number(ev.intAwayScore);
      if (ev.intHomeScore == null || Number.isNaN(h) || Number.isNaN(a)) continue;
      settle(fx, { home: h, away: a });
    }
  }
  // move settled fixtures into the history list
  const settled = p.fixtures.filter((f) => f.status === 'done');
  if (settled.length) {
    p.fixtures = p.fixtures.filter((f) => f.status !== 'done');
    p.resolved = [...settled, ...p.resolved].slice(0, HISTORY_MAX);
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

  if ((wantUpcoming || wantResults) && !refreshing) {
    refreshing = (async () => {
      if (wantUpcoming) {
        lastUpcomingFetch = now;
        await refreshUpcoming(p);
      }
      if (wantResults) {
        lastResultFetch = now;
        await resolveDue(p, now);
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
    result: fx.result ? { score: fx.result.score, outcome: fx.result.outcome } : null,
    myBet: bet ? { pick: bet.pick, score: bet.score || null, reward: bet.reward || null } : null,
  };
}

async function getRounds(userId) {
  await tick();
  const p = db();
  const current = [...p.fixtures].sort((a, b) => a.kickoffAt - b.kickoffAt);
  return {
    rewards: { exact: REWARD_EXACT, outcome: REWARD_OUTCOME, play: REWARD_PLAY },
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

module.exports = { getRounds, placeBet };
