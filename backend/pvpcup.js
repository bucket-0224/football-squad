'use strict';

// ---------------------------------------------------------------------------
// PvP 컵 토너먼트 ("챔피언스 토너먼트").
//
// 요청: "PVP 느낌인데 컵대회 — 오버롤 기준으로 브라켓을 집계해서 인원에
// 따라서 최대 64강까지. 결승전에는 오버롤이 가장 높은 상대랑 맞붙고, 3일마다
// 초기화. 그 날 그 시각에 들어오지 않으면 몰수승으로 다음 단계로 넘어가고,
// 그 경우 (안 들어온) 상대팀은 승점이 3점 깎인다."
//
// 구조:
// - 3일 주기(CYCLE_MS)마다 새 대회. cycleId = floor(now / CYCLE_MS)라 서버
//   재시작과 무관하게 결정적이다.
// - 참가자: 대회 시작 시점의 전체 유저를 클럽 스쿼드 OVR 순으로 집계, 상위
//   2^k명(최대 64)만 브라켓에 들어간다. 그 이후 가입한 유저는 다음 주기부터.
// - 시드 배치는 표준 토너먼트 시딩(1번 시드와 2번 시드는 결승에서만 만나는
//   구조) — "결승전에는 오버롤이 가장 높은 상대"가 자연히 성립한다.
// - 라운드마다 고정 시간 창(주기를 라운드 수로 균등 분할)이 열린다. 창이
//   열린 동안 양쪽 모두 '입장'하면 그 시점에 실제 시뮬레이션 경기가 열리고
//   (matchmaking.js의 queue_pvpcup), 마감까지 한쪽만 입장했으면 입장한 쪽이
//   몰수승으로 진출하며 불참자는 승점 -3. 양쪽 다 불참이면 둘 다 -3을 받고
//   시드(OVR)가 높은 쪽이 부전 진출한다(브라켓은 멈출 수 없으므로).
// - 무승부는 승부차기(GK 가중 — matchmaking.js resolveShootout과 동일 공식)로
//   진출자를 가른다.
//
// 상태는 store.getPvpCup()/putPvpCup()의 단일 문서로 저장하고, 모든 공개
// 함수가 진입 시 sweep()을 먼저 돌려 지난 마감/주기를 게으르게 정산한다 —
// 별도 타이머가 없어 서버 재시작에도 안전하다.
// ---------------------------------------------------------------------------

const store = require('./store');
const { computeRatings } = require('./game/simulate');
const mailbox = require('./mailbox');

const CYCLE_MS = 3 * 24 * 60 * 60 * 1000; // 3일마다 초기화
const MAX_FIELD = 64; // 최대 64강
const FORFEIT_POINT_PENALTY = 3; // 불참 몰수패 승점 차감
const ROUND_LABELS = { 64: '64강', 32: '32강', 16: '16강', 8: '8강', 4: '4강', 2: '결승' };

// 챔피언 보상(결승 승리 보상과 별도) — 우편함으로 지급.
const CHAMPION_COINS = 1500;
const CHAMPION_POINTS = 10;

function cycleIdFor(now) {
  return Math.floor(now / CYCLE_MS);
}

function tournamentSquad(u) {
  return { ...u.squad, upgrades: u.upgrades || {}, ultra: u.ultra || [], devotion: u.devotion || {} };
}

function ovrOf(u) {
  try {
    return computeRatings(tournamentSquad(u)).OVR;
  } catch {
    return 40;
  }
}

// 표준 토너먼트 시딩: 브라켓 자리 순서(1-based 시드 번호 배열). n=8이면
// [1,8,4,5,2,7,3,6] — 1시드와 2시드는 서로 반대쪽 반브라켓에 떨어져
// 결승에서만 만난다.
function seedOrder(n) {
  let arr = [1];
  while (arr.length < n) {
    const m = arr.length * 2;
    const next = [];
    arr.forEach((s) => {
      next.push(s);
      next.push(m + 1 - s);
    });
    arr = next;
  }
  return arr;
}

function roundLabel(remaining) {
  return ROUND_LABELS[remaining] || `${remaining}강`;
}

// 새 주기의 브라켓을 만든다. 유저가 2명 미만이면 휴장 상태로 둔다.
function buildCycle(now) {
  const cycleId = cycleIdFor(now);
  const users = store
    .allUsers()
    .map((u) => ({ id: u.id, clubName: u.clubName, ovr: ovrOf(u) }))
    .sort((a, b) => b.ovr - a.ovr);

  let fieldSize = 2;
  while (fieldSize * 2 <= Math.min(users.length, MAX_FIELD)) fieldSize *= 2;
  if (users.length < 2) {
    return { cycleId, idle: true, seeds: [], fieldSize: 0, totalRounds: 0, roundMs: 0, rounds: [], champion: null, rewarded: false };
  }

  const seeds = users.slice(0, fieldSize); // seeds[i] = (i+1)번 시드
  const totalRounds = Math.log2(fieldSize);
  const roundMs = Math.floor(CYCLE_MS / totalRounds);
  const order = seedOrder(fieldSize); // 브라켓 자리 -> 시드 번호

  const matches = [];
  for (let i = 0; i < fieldSize; i += 2) {
    matches.push({
      a: seeds[order[i] - 1].id,
      b: seeds[order[i + 1] - 1].id,
      winner: null,
      played: false,
      forfeit: false,
      playing: false,
      attended: {},
      score: null,
    });
  }

  return {
    cycleId,
    idle: false,
    startedAt: cycleId * CYCLE_MS,
    fieldSize,
    totalRounds,
    roundMs,
    seeds,
    rounds: [{ matches }],
    champion: null,
    rewarded: false,
  };
}

function seedInfo(doc, userId) {
  return doc.seeds.find((s) => s.id === userId) || null;
}

function seedRank(doc, userId) {
  const i = doc.seeds.findIndex((s) => s.id === userId);
  return i < 0 ? 999 : i;
}

function windowOf(doc, roundIdx) {
  const start = doc.startedAt + roundIdx * doc.roundMs;
  return { start, end: start + doc.roundMs };
}

function penalizeAbsent(userId) {
  const u = store.getUser(userId);
  if (!u) return;
  u.points = Math.max(0, (u.points || 0) - FORFEIT_POINT_PENALTY);
  mailbox.sendMail(u, {
    message: `🏟 PvP 토너먼트 불참 몰수패 — 승점 ${FORFEIT_POINT_PENALTY}점 차감되었습니다.`,
  });
  store.putUser(u);
}

function awardChampion(doc) {
  if (!doc.champion || doc.rewarded) return;
  doc.rewarded = true;
  const u = store.getUser(doc.champion);
  if (!u) return;
  u.coins += CHAMPION_COINS;
  u.points += CHAMPION_POINTS;
  mailbox.sendMail(u, {
    message: `🏆 PvP 토너먼트 우승! 보너스 🪙${CHAMPION_COINS} + 승점 ${CHAMPION_POINTS}점이 지급되었습니다.`,
    packs: [{ id: 'gold', count: 1 }],
  });
  store.putUser(u);
}

// 지난 마감을 정산하고(몰수승), 라운드가 다 끝났으면 다음 라운드를 만들며,
// 주기가 바뀌었으면 새 대회를 연다. 모든 공개 진입점이 먼저 호출한다.
function sweep(now = Date.now()) {
  let doc = store.getPvpCup();
  if (!doc || doc.cycleId !== cycleIdFor(now)) {
    // 주기가 넘어갔다 — 새 브라켓을 만들기 전에 이전 대회의 남은 마감을
    // 전부 정산해 챔피언 보상/몰수 벌점이 유실되지 않게 한다. 마지막
    // 라운드의 마감은 정확히 주기 종료 시각이라, 정산 기회는 항상 이
    // 롤오버 시점에 온다.
    if (doc && !doc.idle && !doc.champion) {
      resolveRounds(doc, doc.startedAt + CYCLE_MS + 1);
      store.putPvpCup(doc);
    }
    doc = buildCycle(now);
    store.putPvpCup(doc);
    return doc;
  }
  if (doc.idle || doc.champion) return doc;

  if (resolveRounds(doc, now)) store.putPvpCup(doc);
  return doc;
}

// 마감이 지난 매치를 몰수 처리하고 라운드 완결 시 다음 라운드/챔피언을
// 만든다. 변경이 있었으면 true (저장은 호출자 몫).
function resolveRounds(doc, now) {
  let changed = false;
  for (let r = 0; r < doc.rounds.length; r++) {
    const round = doc.rounds[r];
    const { end } = windowOf(doc, r);
    round.matches.forEach((m) => {
      if (m.winner || now < end) return;
      // 마감이 지났는데 승자가 없다 — 몰수 처리.
      const aIn = !!m.attended[m.a];
      const bIn = !!m.attended[m.b];
      m.forfeit = true;
      if (aIn && bIn) {
        // 둘 다 입장했는데 결과가 안 남은 극단 케이스(경기 도중 서버 재시작
        // 등) — 누구 잘못도 아니므로 벌점 없이 시드 높은 쪽이 진출한다.
        m.winner = seedRank(doc, m.a) <= seedRank(doc, m.b) ? m.a : m.b;
      } else if (aIn) {
        m.winner = m.a;
        penalizeAbsent(m.b);
      } else if (bIn) {
        m.winner = m.b;
        penalizeAbsent(m.a);
      } else {
        // 둘 다 안 들어온 경우: 둘 다 승점 차감, 시드(OVR) 높은 쪽 부전 진출
        // — 브라켓이 멈추면 뒤 라운드 전체가 막히므로 진출자는 반드시 낸다.
        m.winner = seedRank(doc, m.a) <= seedRank(doc, m.b) ? m.a : m.b;
        penalizeAbsent(m.a);
        penalizeAbsent(m.b);
      }
      changed = true;
    });

    // 라운드 완결 -> 다음 라운드 생성 (마지막 라운드였으면 챔피언 확정)
    const allDone = round.matches.every((mm) => mm.winner);
    if (allDone && r === doc.rounds.length - 1) {
      if (round.matches.length === 1) {
        doc.champion = round.matches[0].winner;
        awardChampion(doc);
        changed = true;
      } else {
        const winners = round.matches.map((mm) => mm.winner);
        const matches = [];
        for (let i = 0; i < winners.length; i += 2) {
          matches.push({
            a: winners[i],
            b: winners[i + 1],
            winner: null,
            played: false,
            forfeit: false,
            playing: false,
            attended: {},
            score: null,
          });
        }
        doc.rounds.push({ matches });
        changed = true;
      }
    }
  }
  return changed;
}

// 현재 진행 라운드 인덱스 — 만들어진 라운드 중 미완결인 첫 라운드.
function currentRoundIdx(doc) {
  for (let r = 0; r < doc.rounds.length; r++) {
    if (doc.rounds[r].matches.some((m) => !m.winner)) return r;
  }
  return doc.rounds.length - 1;
}

function myMatchIn(doc, roundIdx, userId) {
  return doc.rounds[roundIdx].matches.find((m) => m.a === userId || m.b === userId) || null;
}

// 유저 화면용 상태 요약.
function publicState(user, now = Date.now()) {
  const doc = sweep(now);
  const base = {
    cycleId: doc.cycleId,
    fieldSize: doc.fieldSize || 0,
    cycleEndsAt: (doc.cycleId + 1) * CYCLE_MS,
    champion: doc.champion ? (seedInfo(doc, doc.champion) || { id: doc.champion, clubName: '?', ovr: 0 }) : null,
  };
  if (doc.idle) return { ...base, status: 'idle' };
  if (!seedInfo(doc, user.id)) return { ...base, status: 'not_in_bracket' };

  // 내가 탈락했는지: 지나온 라운드 중 내 매치에서 패배했으면 탈락.
  for (let r = 0; r < doc.rounds.length; r++) {
    const m = myMatchIn(doc, r, user.id);
    if (m && m.winner && m.winner !== user.id) {
      return { ...base, status: 'eliminated', round: roundLabel(doc.rounds[r].matches.length * 2) };
    }
  }
  if (doc.champion === user.id) return { ...base, status: 'champion' };
  if (doc.champion) return { ...base, status: 'eliminated', round: '결승' };

  const r = currentRoundIdx(doc);
  const m = myMatchIn(doc, r, user.id);
  if (!m) {
    // 현재 라운드에 내 매치가 없다 = 아직 내 다음 매치가 안 만들어졌거나(이전
    // 라운드 진행 중) 논리상 도달 불가 — 대기 표시.
    return { ...base, status: 'waiting_bracket' };
  }
  const win = windowOf(doc, r);
  const oppId = m.a === user.id ? m.b : m.a;
  const opp = seedInfo(doc, oppId);
  return {
    ...base,
    status: m.winner ? (m.winner === user.id ? 'advanced' : 'eliminated') : 'in_round',
    round: roundLabel(doc.rounds[r].matches.length * 2),
    windowStart: win.start,
    windowEnd: win.end,
    windowOpen: now >= win.start && now < win.end,
    opponent: opp ? { clubName: opp.clubName, ovr: opp.ovr } : null,
    attendedMe: !!m.attended[user.id],
    attendedOpp: !!m.attended[oppId],
    played: m.played,
    forfeit: m.forfeit,
    score: m.score,
    mySeed: seedRank(doc, user.id) + 1,
  };
}

// '입장' — 출석을 기록하고, 상대도 이미 입장해 있으면 실제 경기를 연다.
// 반환: { error } | { waiting, deadline } | { play: { opponentId, roundIdx } }
// play를 받은 호출자(matchmaking.js)는 경기를 돌린 뒤 recordResult를 불러야
// 한다. 경기 시작 표시(playing)는 여기서 걸어 이중 시작을 막는다.
function enter(user, now = Date.now()) {
  const doc = sweep(now);
  if (doc.idle) return { error: '참가자가 부족해 이번 주기 토너먼트가 열리지 않았습니다.' };
  if (doc.champion) return { error: '이번 주기 토너먼트가 이미 끝났습니다. 다음 주기를 기다려 주세요.' };
  if (!seedInfo(doc, user.id)) return { error: '이번 주기 브라켓에 포함되지 않았습니다. 다음 주기에 자동 참가됩니다.' };

  const r = currentRoundIdx(doc);
  const m = myMatchIn(doc, r, user.id);
  if (!m) return { error: '아직 다음 라운드 대진이 확정되지 않았습니다.' };
  if (m.winner) {
    return m.winner === user.id
      ? { error: '이번 라운드 경기는 끝났습니다. 다음 라운드 시간에 다시 입장하세요.' }
      : { error: '이번 주기에서는 탈락했습니다. 다음 주기에 다시 도전하세요.' };
  }
  const win = windowOf(doc, r);
  if (now < win.start) return { error: `${roundLabel(doc.rounds[r].matches.length * 2)} 입장은 아직 열리지 않았습니다.` };
  if (now >= win.end) {
    // 방금 마감을 넘겼다 — sweep이 다음 호출에서 몰수 처리한다.
    sweep(now + 1);
    return { error: '이번 라운드 입장 시간이 지났습니다.' };
  }
  if (m.playing) return { error: '경기가 이미 진행 중입니다.' };

  if (!m.attended[user.id]) {
    m.attended[user.id] = true;
    store.putPvpCup(doc);
  }
  const oppId = m.a === user.id ? m.b : m.a;
  if (!m.attended[oppId]) {
    return { waiting: true, deadline: win.end, opponentId: oppId };
  }
  m.playing = true;
  store.putPvpCup(doc);
  return { play: { opponentId: oppId, roundIdx: r } };
}

// 경기 종료 후 호출 — 승자를 기록한다(무승부 처리는 호출자가 승부차기로
// 승자를 정해서 넘긴다). roundIdx는 enter()가 준 값.
function recordResult(userId, opponentId, roundIdx, winnerUserId, score, now = Date.now()) {
  const doc = store.getPvpCup();
  if (!doc || doc.idle) return;
  const round = doc.rounds[roundIdx];
  if (!round) return;
  const m = round.matches.find(
    (mm) => (mm.a === userId && mm.b === opponentId) || (mm.a === opponentId && mm.b === userId)
  );
  if (!m || m.winner) return;
  m.winner = winnerUserId;
  m.played = true;
  m.playing = false;
  m.score = score || null;
  store.putPvpCup(doc);
  sweep(now); // 라운드가 이걸로 완결됐으면 다음 라운드/챔피언 처리
}

// 경기가 비정상 종료(연결 끊김 등)로 기록되지 못했을 때 잠금 해제용.
function releaseLock(userId, opponentId, roundIdx) {
  const doc = store.getPvpCup();
  if (!doc || doc.idle || !doc.rounds[roundIdx]) return;
  const m = doc.rounds[roundIdx].matches.find(
    (mm) => (mm.a === userId && mm.b === opponentId) || (mm.a === opponentId && mm.b === userId)
  );
  if (m && m.playing && !m.winner) {
    m.playing = false;
    store.putPvpCup(doc);
  }
}

module.exports = {
  CYCLE_MS,
  FORFEIT_POINT_PENALTY,
  sweep,
  publicState,
  enter,
  recordResult,
  releaseLock,
  roundLabel,
};
