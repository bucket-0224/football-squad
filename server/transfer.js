'use strict';

const players = require('./data/players');
const store = require('./store');

// ---------------------------------------------------------------------------
// Transfer negotiations.
//
// Signing a player is a two-stage negotiation:
//   1. 'club'     — agree a transfer fee with the owning club. The club has a
//                   hidden asking price around the market value; lowball offers
//                   burn attempts and harden its stance.
//   2. 'personal' — agree personal terms (signing bonus) with the player.
// Free agents skip the club stage. Coins are only deducted when the contract
// is signed (fee + bonus together).
//
// Negotiations are in-memory, one per user at a time.
// ---------------------------------------------------------------------------

const negotiations = new Map(); // userId -> negotiation
const ATTEMPTS_PER_STAGE = 3;
const BONUS_RATE = 0.25; // personal-terms demand ≈ 25% of market value

function rand(lo, hi) {
  return lo + Math.random() * (hi - lo);
}

function marketValue(playerId) {
  return players.getPrice(playerId);
}

function publicView(neg) {
  const p = players.publicPlayer(neg.playerId);
  return {
    playerId: neg.playerId,
    player: p,
    stage: neg.stage,
    attemptsLeft: neg.attempts[neg.stage],
    fee: neg.fee,
    bonus: neg.bonus,
    counter: neg.counter, // 상대의 최근 역제안 (있을 때만)
    marketValue: marketValue(neg.playerId),
  };
}

function start(user, playerId) {
  const p = players.getPlayer(playerId);
  const value = marketValue(playerId);
  if (!p || !value) return { error: '존재하지 않는 선수입니다.', status: 404 };
  if (user.owned.includes(playerId)) return { error: '이미 보유 중인 선수입니다.', status: 400 };

  const neg = {
    playerId,
    stage: p.team ? 'club' : 'personal',
    fee: p.team ? null : 0, // FA는 이적료 없음
    bonus: null,
    counter: null,
    // hidden targets
    clubAsk: Math.round(value * rand(1.05, 1.3)),
    bonusDemand: Math.round(value * BONUS_RATE * rand(0.9, 1.15)),
    attempts: { club: ATTEMPTS_PER_STAGE, personal: ATTEMPTS_PER_STAGE },
  };
  negotiations.set(user.id, neg);

  const opening =
    neg.stage === 'club'
      ? `${p.team} 구단이 협상 테이블에 나왔습니다. 이적료를 제시하세요.`
      : `${p.name} 선수는 자유계약(FA) 신분입니다. 바로 개인 협상(계약 보너스)을 진행하세요.`;
  return { negotiation: publicView(neg), message: opening };
}

// One offer against the current stage. Returns negotiation state + result:
//   'accepted' — stage cleared (club stage: moves on to personal)
//   'counter'  — counter-offer made, attempt consumed
//   'rejected' — offer scoffed at, attempt consumed, stance hardens
//   'failed'   — attempts exhausted, negotiation over
//   'signed'   — contract done, player added, coins deducted
function offer(user, amount) {
  const neg = negotiations.get(user.id);
  if (!neg) return { error: '진행 중인 협상이 없습니다.', status: 400 };
  const p = players.getPlayer(neg.playerId);
  amount = Math.round(Number(amount));
  if (!Number.isFinite(amount) || amount < 0) {
    return { error: '제시 금액이 올바르지 않습니다.', status: 400 };
  }

  const alreadyCommitted = neg.stage === 'personal' ? neg.fee : 0;
  if (amount + alreadyCommitted > user.coins) {
    return { error: '보유 코인을 넘는 금액은 제시할 수 없습니다.', status: 400 };
  }

  const target = neg.stage === 'club' ? neg.clubAsk : neg.bonusDemand;
  const who = neg.stage === 'club' ? `${p.team} 구단` : `${p.name} 측`;

  // Accept
  if (amount >= target) {
    neg.counter = null;
    if (neg.stage === 'club') {
      neg.fee = amount;
      neg.stage = 'personal';
      return {
        negotiation: publicView(neg),
        result: 'accepted',
        message: `${who}과(와) 이적료 🪙${amount.toLocaleString()}에 합의했습니다! 이제 선수 개인 협상입니다.`,
      };
    }
    // personal accepted -> sign
    neg.bonus = amount;
    const total = neg.fee + neg.bonus;
    if (total > user.coins) {
      negotiations.delete(user.id);
      return { error: '코인이 부족해 계약이 무산되었습니다.', status: 400 };
    }
    user.coins -= total;
    user.owned.push(neg.playerId);
    store.putUser(user);
    negotiations.delete(user.id);
    return {
      negotiation: null,
      result: 'signed',
      total,
      fee: neg.fee,
      bonus: neg.bonus,
      message: `🎉 ${p.name} 영입 완료! (이적료 🪙${neg.fee.toLocaleString()} + 보너스 🪙${neg.bonus.toLocaleString()})`,
    };
  }

  neg.attempts[neg.stage]--;

  // Attempts exhausted -> negotiation collapses
  if (neg.attempts[neg.stage] <= 0) {
    negotiations.delete(user.id);
    return {
      negotiation: null,
      result: 'failed',
      message: `${who}이(가) 협상 결렬을 선언했습니다. 처음부터 다시 시도해야 합니다.`,
    };
  }

  // Close offer -> counter, and the target softens toward the midpoint
  if (amount >= target * 0.85) {
    const counter = Math.round((target + amount) / 2);
    if (neg.stage === 'club') neg.clubAsk = counter;
    else neg.bonusDemand = counter;
    neg.counter = counter;
    return {
      negotiation: publicView(neg),
      result: 'counter',
      message: `${who}의 역제안: 🪙${counter.toLocaleString()} — 이 금액이면 사인하겠다고 합니다.`,
    };
  }

  // Lowball -> stance hardens slightly
  const hardened = Math.round(target * 1.05);
  if (neg.stage === 'club') neg.clubAsk = hardened;
  else neg.bonusDemand = hardened;
  neg.counter = null;
  const gap = amount / target;
  const tone = gap < 0.5 ? '모욕적인 제안이라며 화를 냅니다' : '너무 낮다며 고개를 젓습니다';
  return {
    negotiation: publicView(neg),
    result: 'rejected',
    message: `${who}이(가) ${tone}. (요구액이 오히려 올라갔습니다)`,
  };
}

function cancel(user) {
  negotiations.delete(user.id);
  return { ok: true };
}

function current(user) {
  const neg = negotiations.get(user.id);
  return neg ? publicView(neg) : null;
}

// ---------------------------------------------------------------------------
// Card packs (선수 뽑기).
//
// Each pack draws one player from an OVR band, weighted so the top of the
// band is rare. Duplicates auto-convert to coins at the sell rate.
// ---------------------------------------------------------------------------

const SELL_RATE = 0.55;

// 테스트 모드: true면 모든 팩이 무료 (뽑기 테스트용 토글).
const FREE_PACKS = false;

const PACKS = {
  bronze: { name: '브론즈 팩', price: 250, filter: (p) => !p.enhanced && p.ovr <= 79 },
  silver: { name: '실버 팩', price: 700, filter: (p) => !p.enhanced && p.ovr >= 78 && p.ovr <= 85 },
  gold: { name: '골드 팩', price: 1800, filter: (p) => !p.enhanced && p.ovr >= 84 },
  special: { name: '스페셜 팩', price: 4000, filter: (p) => p.ovr >= 86 },
};

function packPrice(def) {
  return FREE_PACKS ? 0 : def.price;
}

function packList() {
  return Object.entries(PACKS).map(([id, def]) => ({ id, name: def.name, price: packPrice(def) }));
}

function drawFrom(pool) {
  // Rarity: weight drops steeply as ovr climbs within the pool.
  const minOvr = Math.min(...pool.map((p) => p.ovr));
  const weight = (p) => {
    let w = 1 / Math.pow(1.35, p.ovr - minOvr);
    if (p.enhanced) w *= 0.35; // enhanced cards are the jackpot tier
    return w;
  };
  const total = pool.reduce((s, p) => s + weight(p), 0);
  let r = Math.random() * total;
  for (const p of pool) {
    r -= weight(p);
    if (r <= 0) return p;
  }
  return pool[pool.length - 1];
}

function openPack(user, packId) {
  const def = PACKS[packId];
  if (!def) return { error: '존재하지 않는 팩입니다.', status: 404 };
  const price = packPrice(def);
  if (user.coins < price) return { error: '코인이 부족합니다.', status: 400 };

  // youth academy fillers of dynamic clubs are club-only, never in packs
  const pool = Object.values(players.CATALOG).filter((p) => !p.youth).filter(def.filter);
  if (!pool.length) return { error: '팩에 뽑을 선수가 없습니다.', status: 500 };

  const p = drawFrom(pool);
  user.coins -= price;

  // drawn[] gates the PvP squad: only cards from packs may be fielded there.
  const owned = user.owned.includes(p.id);
  const alreadyDrawn = user.drawn.includes(p.id);
  let duplicate = false;
  let unlocked = false; // roster-owned player that just became PvP-eligible
  let refund = 0;
  if (owned && alreadyDrawn) {
    duplicate = true;
    refund = Math.round(players.getPrice(p.id) * SELL_RATE);
    user.coins += refund;
  } else if (owned) {
    unlocked = true;
    user.drawn.push(p.id);
  } else {
    user.owned.push(p.id);
    user.drawn.push(p.id);
  }
  store.putUser(user);

  return {
    pack: packId,
    player: players.publicPlayer(p.id),
    duplicate,
    unlocked,
    refund,
  };
}

module.exports = { start, offer, cancel, current, packList, openPack };
