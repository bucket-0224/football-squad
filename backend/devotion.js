'use strict';

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

const CHECK_COOLDOWN_MS = 30 * 60 * 1000; // at most one roll per 30 real minutes
const RAISE_CHANCE = 0.12;
const MAX_PENDING = 5; // stop rolling new ones once this many are unread

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

// Opportunistically roll a new complaint. Called on the frequently-polled
// /api/me route instead of running a dedicated timer. Complaints stack (a
// player raising one doesn't block another from doing the same) so the user
// clears them individually from a notification list instead of a single
// blocking popup.
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

module.exports = { maybeRaiseComplaint, publicComplaints, resolveComplaint };
