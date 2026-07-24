'use strict';

const store = require('./store');
const players = require('./data/players');

// Player 불만(complaint) -> 대화 선택 -> 헌신도(devotion) system.
// Each issue has one "satisfying" choice (bigger devotion gain) and one or
// two lesser/neutral choices, so how the user responds actually matters.
const ISSUES = [
  {
    id: 'playtime',
    prompt: '출전 시간이 부족하다며 불만을 표합니다.',
    choices: [
      { id: 'promise', label: '다음 경기 선발 출전을 약속한다', satisfies: true, devotionDelta: 15 },
      { id: 'explain', label: '전술적인 이유를 차분히 설명한다', satisfies: false, devotionDelta: 4 },
      { id: 'ignore', label: '대수롭지 않게 넘긴다', satisfies: false, devotionDelta: -10 },
    ],
  },
  {
    id: 'results',
    prompt: '최근 팀 성적에 실망감을 드러냅니다.',
    choices: [
      { id: 'apologize', label: '책임을 인정하고 개선을 약속한다', satisfies: true, devotionDelta: 12 },
      { id: 'defend', label: '상황을 설명하며 다독인다', satisfies: false, devotionDelta: 4 },
      { id: 'ignore', label: '무시한다', satisfies: false, devotionDelta: -10 },
    ],
  },
  {
    id: 'ambition',
    prompt: '더 큰 무대에서 뛰고 싶다고 이야기합니다.',
    choices: [
      { id: 'support', label: '성장을 적극적으로 지원하겠다고 약속한다', satisfies: true, devotionDelta: 15, costCoins: 100 },
      { id: 'neutral', label: '지금은 어렵다고 솔직히 말한다', satisfies: false, devotionDelta: 0 },
      { id: 'ignore', label: '무시한다', satisfies: false, devotionDelta: -10 },
    ],
  },
];

const CHECK_COOLDOWN_MS = 10 * 60 * 1000; // at most one roll per 10 real minutes
const RAISE_CHANCE = 0.9; // high — the cooldown is what paces things, not this roll
const MAX_PENDING = 5; // stop rolling new ones once this many are unread

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

// "출전시간 불만" 후보: 보유 중이지만 실제 출전 횟수가 하위권인 선수 —
// matchmaking.js가 매 경기 종료 시 실제 선발 명단 기준으로 채우는
// playerStats[id].appearances 를 근거로 삼는다(전적 무관한 완전 랜덤이 아님).
function pickLowAppearancePlayer(owned, playerStats) {
  const withApps = owned.map((id) => ({ id, apps: (playerStats[id] && playerStats[id].appearances) || 0 }));
  withApps.sort((a, b) => a.apps - b.apps);
  const bottomHalf = withApps.slice(0, Math.max(1, Math.ceil(withApps.length / 2)));
  return bottomHalf[Math.floor(Math.random() * bottomHalf.length)].id;
}

// Opportunistically roll a new complaint for one user. Driven by the cron
// sweep below rather than request traffic, so complaints accrue whether or
// not the user is logged in. Complaints stack (a player raising one doesn't
// block another from doing the same) so the user clears them individually
// from a notification list instead of a single blocking popup.
//
// Which issue fires — and who it targets — is grounded in real per-user
// data rather than a uniform random pick:
//   - "playtime" only fires if there's an actual bench to be unhappy about,
//     and targets whoever's genuinely played the least (appearances).
//   - "results" only fires once the team has an actual losing record
//     (>=3 games played, >=40% losses), targeting a current starter.
//   - "ambition" has no real-world signal to gate on, so it stays the
//     always-eligible fallback (matches the original behavior).
function maybeRaiseComplaint(user) {
  if (user.complaints.length >= MAX_PENDING) return;
  const now = Date.now();
  if (now - (user.lastComplaintCheck || 0) < CHECK_COOLDOWN_MS) return;
  user.lastComplaintCheck = now;
  if (Math.random() >= RAISE_CHANCE) return;

  const owned = (user.owned || []).filter(Boolean);
  if (!owned.length) return;
  const starters = (user.squad.starters || []).filter(Boolean);
  const playerStats = user.playerStats || {};
  const record = user.record || { w: 0, d: 0, l: 0 };
  const totalGames = (record.w || 0) + (record.d || 0) + (record.l || 0);
  const lossRate = totalGames ? (record.l || 0) / totalGames : 0;

  const resultsEligible = totalGames >= 3 && lossRate >= 0.4 && starters.length > 0;
  const playtimeEligible = owned.length >= 3; // need an actual bench to compare against

  const pool = [];
  if (playtimeEligible) pool.push('playtime');
  if (resultsEligible) pool.push('results');
  pool.push('ambition');

  const issueId = pool[Math.floor(Math.random() * pool.length)];
  let playerId;
  if (issueId === 'playtime') {
    playerId = pickLowAppearancePlayer(owned, playerStats);
  } else if (issueId === 'results') {
    playerId = starters[Math.floor(Math.random() * starters.length)];
  } else {
    playerId = owned[Math.floor(Math.random() * owned.length)];
  }

  user.complaints.push({
    id: 'c' + Math.random().toString(36).slice(2, 10),
    playerId,
    issue: issueId,
    createdAt: now,
  });
}

// Client-facing view of pending complaints — strips `satisfies`/
// `devotionDelta` so the "correct" answer can't be read off the response.
function publicComplaints(user) {
  return user.complaints
    .map((c) => {
      const issue = ISSUES.find((i) => i.id === c.issue);
      if (!issue) return null;
      return {
        id: c.id,
        playerId: c.playerId,
        createdAt: c.createdAt,
        prompt: issue.prompt,
        choices: issue.choices.map((ch) => ({ id: ch.id, label: ch.label, costCoins: ch.costCoins || 0 })),
      };
    })
    .filter(Boolean);
}

function resolveComplaint(user, complaintId, choiceId) {
  const idx = user.complaints.findIndex((c) => c.id === complaintId);
  if (idx === -1) return { error: '해결할 불만이 없습니다.', status: 400 };
  const complaint = user.complaints[idx];
  const issue = ISSUES.find((i) => i.id === complaint.issue);
  const choice = issue && issue.choices.find((c) => c.id === choiceId);
  if (!choice) return { error: '알 수 없는 선택지입니다.', status: 400 };
  if (choice.costCoins && user.coins < choice.costCoins) {
    return { error: `코인이 부족합니다. (필요: ${choice.costCoins})`, status: 400 };
  }
  if (choice.costCoins) user.coins -= choice.costCoins;
  const playerId = complaint.playerId;
  const cur = user.devotion[playerId] != null ? user.devotion[playerId] : 60;
  user.devotion[playerId] = clamp(cur + choice.devotionDelta, 0, 100);
  user.complaints.splice(idx, 1);
  return { satisfied: !!choice.satisfies, devotion: user.devotion[playerId] };
}

const SWEEP_INTERVAL_MS = 2 * 60 * 1000; // finer than CHECK_COOLDOWN_MS so the per-user cooldown, not tick granularity, governs odds

// ---------------------------------------------------------------------------
// 이적 요청 (transfer request): a player whose devotion has cratered asks to
// leave outright, offering a binary choice — no gradual dialogue like
// complaints, since by this point goodwill is already gone.
// ---------------------------------------------------------------------------
const TRANSFER_REQUEST_DEVOTION_THRESHOLD = 15;
const TRANSFER_REQUEST_CHANCE = 0.05; // fallback path: devotion cratered without 2 stacked complaints
const COMPLAINT_ESCALATION_COUNT = 2; // this many unresolved complaints on one player escalates to a real request
const ESCALATED_TRANSFER_CHANCE = 0.85; // high — this is meant to reliably fire, not be a rare roll

function maybeRaiseTransferRequest(user) {
  if (!Array.isArray(user.owned) || !user.owned.length) return;
  if (!user.transferRequests) user.transferRequests = [];
  const now = Date.now();
  if (now - (user.lastTransferCheck || 0) < CHECK_COOLDOWN_MS) return;
  user.lastTransferCheck = now;
  const pending = new Set(user.transferRequests.map((r) => r.playerId));

  // 주된 경로: 같은 선수 불만이 COMPLAINT_ESCALATION_COUNT번 이상 쌓이면
  // ("문제가 2번 연속으로 쌓이면") 실제로 이적 요청이 발생한다.
  const complaintCounts = {};
  for (const c of user.complaints) complaintCounts[c.playerId] = (complaintCounts[c.playerId] || 0) + 1;
  const escalated = Object.keys(complaintCounts).filter(
    (id) => complaintCounts[id] >= COMPLAINT_ESCALATION_COUNT && !pending.has(id) && user.owned.includes(id)
  );
  if (escalated.length) {
    if (Math.random() < ESCALATED_TRANSFER_CHANCE) {
      const playerId = escalated[Math.floor(Math.random() * escalated.length)];
      user.transferRequests.push({
        id: 't' + Math.random().toString(36).slice(2, 10),
        playerId,
        createdAt: now,
      });
    }
    return;
  }

  // 폴백 경로: 불만이 2건까진 안 쌓였어도 헌신도 자체가 완전히 바닥난 경우 —
  // 낮은 확률로 유지 (기존 동작).
  const candidates = user.owned.filter(
    (id) => (user.devotion[id] ?? 60) < TRANSFER_REQUEST_DEVOTION_THRESHOLD && !pending.has(id)
  );
  if (!candidates.length || Math.random() >= TRANSFER_REQUEST_CHANCE) return;
  const playerId = candidates[Math.floor(Math.random() * candidates.length)];
  user.transferRequests.push({
    id: 't' + Math.random().toString(36).slice(2, 10),
    playerId,
    createdAt: now,
  });
}

// 'keep' (잔류): devotion resets to a moderate baseline, request cleared.
// 'release' (이적 허용): player leaves — paid out at (market price adjusted
// for real goal/assist contribution) minus a flat 5%, the same
// contribution-aware formula /api/market/sell uses, just discounted less
// (95% vs a normal sale's 55%) since the club didn't choose to let them go.
function resolveTransferRequest(user, requestId, choice) {
  const list = user.transferRequests || [];
  const idx = list.findIndex((r) => r.id === requestId);
  if (idx === -1) return { error: '해당 이적 요청을 찾을 수 없습니다.', status: 400 };
  const playerId = list[idx].playerId;
  if (choice === 'keep') {
    user.devotion[playerId] = 50;
    list.splice(idx, 1);
    return { released: false, devotion: 50 };
  }
  if (choice === 'release') {
    const price = players.getPrice(playerId) || 0;
    const st = user.playerStats[playerId] || { goals: 0, assists: 0 };
    const perf = Math.min(0.5, (st.goals || 0) * 0.03 + (st.assists || 0) * 0.02);
    const coinsGained = Math.round(price * (1 + perf) * 0.95);
    user.coins += coinsGained;

    user.owned = user.owned.filter((id) => id !== playerId);
    user.drawn = user.drawn.filter((id) => id !== playerId);
    if (user.upgrades) delete user.upgrades[playerId];
    user.squad.starters = user.squad.starters.map((id) => (id === playerId ? null : id));
    user.pvpSquad.starters = user.pvpSquad.starters.map((id) => (id === playerId ? null : id));
    delete user.playerStats[playerId];
    delete user.devotion[playerId];
    user.complaints = (user.complaints || []).filter((c) => c.playerId !== playerId);
    list.splice(idx, 1);
    return { released: true, coinsGained };
  }
  return { error: '알 수 없는 선택입니다.', status: 400 };
}

// Real cron sweep (mirrors season.js's init/setInterval shape) over every
// user in the store, independent of anyone polling /api/me. Each user is
// isolated in its own try/catch: an uncaught exception inside a setInterval
// callback kills the entire Node process, so one malformed record must
// never be able to take down live matches/every other user's traffic along
// with it (store.js's load() already backfills missing fields, but this is
// the last line of defense against anything unforeseen).
function sweep() {
  for (const user of store.allUsers()) {
    try {
      maybeRaiseComplaint(user);
      maybeRaiseTransferRequest(user);
      store.putUser(user);
    } catch (err) {
      console.error('[devotion] sweep failed for user', user && user.id, err);
    }
  }
}

function init() {
  setInterval(sweep, SWEEP_INTERVAL_MS);
}

module.exports = {
  init,
  sweep,
  maybeRaiseComplaint,
  maybeRaiseTransferRequest,
  publicComplaints,
  resolveComplaint,
  resolveTransferRequest,
};
