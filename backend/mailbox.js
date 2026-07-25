'use strict';

// Admin -> user reward mail. Sent via a protected admin endpoint (see
// POST /api/admin/mail in index.js) since there's no in-game way to grant
// coins directly; the user claims each item explicitly so the credit ties
// to a visible action instead of silently landing in their balance.
const MAX_ITEMS = 50;

// packs: [{id, count}] — 이벤트 열쇠 보상처럼 코인이 아니라 "팩 개봉권"을
// 우편으로 줄 때 쓴다(event.js 참고). 실제 팩 개봉(카드 뽑기)은 여기서
// 하지 않고 claim 시점에 index.js가 처리한다 — sendMail은 그저 "이 팩들을
// 나중에 열 수 있다"는 티켓만 우편에 담아 둔다.
function sendMail(user, { coins, message, packs } = {}) {
  if (!Array.isArray(user.mailbox)) user.mailbox = [];
  const mail = {
    id: 'm' + Math.random().toString(36).slice(2, 10),
    coins: Math.max(0, Math.floor(Number(coins)) || 0),
    message: String(message || '').slice(0, 200),
    packs: Array.isArray(packs) && packs.length
      ? packs.map((p) => ({ id: String(p.id), count: Math.max(1, Math.floor(Number(p.count)) || 1) }))
      : null,
    createdAt: Date.now(),
    claimed: false,
  };
  user.mailbox.unshift(mail);
  if (user.mailbox.length > MAX_ITEMS) user.mailbox.length = MAX_ITEMS;
  return mail;
}

function claimMail(user, mailId) {
  const mail = (user.mailbox || []).find((m) => m.id === mailId);
  if (!mail) return { error: '존재하지 않는 우편입니다.', status: 404 };
  if (mail.claimed) return { error: '이미 수령한 우편입니다.', status: 400 };
  mail.claimed = true;
  mail.claimedAt = Date.now();
  user.coins += mail.coins;
  return { mail };
}

module.exports = { sendMail, claimMail };
