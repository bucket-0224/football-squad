'use strict';

const store = require('./store');

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

const CHECK_COOLDOWN_MS = 3 * 60 * 1000; // at most one roll per 3 real minutes — keeps notifications arriving often enough that the game feels "live"
const RAISE_CHANCE = 0.9; // high — the 3-min cooldown is what paces things, not this roll
const MAX_PENDING = 5; // stop rolling new ones once this many are unread

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

// Opportunistically roll a new complaint for one user. Driven by the cron
// sweep below rather than request traffic, so complaints accrue whether or
// not the user is logged in. Complaints stack (a player raising one doesn't
// block another from doing the same) so the user clears them individually
// from a notification list instead of a single blocking popup.
function maybeRaiseComplaint(user) {
  if (user.complaints.length >= MAX_PENDING) return;
  const now = Date.now();
  if (now - (user.lastComplaintCheck || 0) < CHECK_COOLDOWN_MS) return;
  user.lastComplaintCheck = now;
  if (Math.random() >= RAISE_CHANCE) return;
  const starters = (user.squad.starters || []).filter(Boolean);
  if (!starters.length) return;
  const playerId = starters[Math.floor(Math.random() * starters.length)];
  const issue = ISSUES[Math.floor(Math.random() * ISSUES.length)];
  user.complaints.push({
    id: 'c' + Math.random().toString(36).slice(2, 10),
    playerId,
    issue: issue.id,
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

const SWEEP_INTERVAL_MS = 60 * 1000; // finer than CHECK_COOLDOWN_MS so the per-user cooldown, not tick granularity, governs odds

// ---------------------------------------------------------------------------
// 이적 요청 (transfer request): a player whose devotion has cratered asks to
// leave outright, offering a binary choice — no gradual dialogue like
// complaints, since by this point goodwill is already gone.
// ---------------------------------------------------------------------------
const TRANSFER_REQUEST_DEVOTION_THRESHOLD = 15;
const TRANSFER_REQUEST_CHANCE = 0.05; // per critically-low player, gated by CHECK_COOLDOWN_MS like complaints

function maybeRaiseTransferRequest(user) {
  if (!Array.isArray(user.owned) || !user.owned.length) return;
  if (!user.transferRequests) user.transferRequests = [];
  const now = Date.now();
  if (now - (user.lastTransferCheck || 0) < CHECK_COOLDOWN_MS) return;
  user.lastTransferCheck = now;
  const pending = new Set(user.transferRequests.map((r) => r.playerId));
  const candidates = user.owned.filter(
    (id) => (user.devotion[id] ?? 60) < TRANSFER_REQUEST_DEVOTION_THRESHOLD && !pending.has(id)
  );
  if (!candidates.length || Math.random() >= TRANSFER_REQUEST_CHANCE) return;
  const playerId = candidates[Math.floor(Math.random() * candidates.length)];
  user.transferRequests.push({
    id: 't' + Math.random().toString(36).slice(2, 10),
    playerId,
    createdAt: Date.now(),
  });
}

// 'keep' (잔류): devotion resets to a moderate baseline, request cleared.
// 'release' (이적 허용): player leaves outright — no coin compensation, a
// clean release, mirrors /api/market/sell's roster/slot-vacating logic minus
// the payout.
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
    user.owned = user.owned.filter((id) => id !== playerId);
    user.drawn = user.drawn.filter((id) => id !== playerId);
    if (user.upgrades) delete user.upgrades[playerId];
    user.squad.starters = user.squad.starters.map((id) => (id === playerId ? null : id));
    user.pvpSquad.starters = user.pvpSquad.starters.map((id) => (id === playerId ? null : id));
    delete user.playerStats[playerId];
    delete user.devotion[playerId];
    user.complaints = (user.complaints || []).filter((c) => c.playerId !== playerId);
    list.splice(idx, 1);
    return { released: true };
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
  publicComplaints,
  resolveComplaint,
  resolveTransferRequest,
};
