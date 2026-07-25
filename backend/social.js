'use strict';

// 친구 시스템 — event.js/devotion.js처럼 순수 함수 모듈로 분리하고
// backend/index.js는 얇게 라우팅만 한다. 요청/수락 양쪽 유저 레코드를
// 항상 같이 갱신해(store.putUser 두 번) friendRequests.incoming/outgoing이
// 서로 어긋나지 않게 한다.

const store = require('./store');

function summarize(u) {
  return { id: u.id, username: u.username, clubName: u.clubName, points: u.points, record: u.record };
}

function sendFriendRequest(user, targetUsername) {
  const name = String(targetUsername || '').trim();
  if (!name) return { error: '닉네임을 입력해주세요.', status: 400 };
  const target = store.findUserByName(name);
  if (!target) return { error: '존재하지 않는 유저입니다.', status: 404 };
  if (target.id === user.id) return { error: '자기 자신에게는 친구 요청을 보낼 수 없습니다.', status: 400 };
  if (user.friends.includes(target.id)) return { error: '이미 친구입니다.', status: 400 };
  if (user.friendRequests.outgoing.includes(target.id)) {
    return { error: '이미 친구 요청을 보냈습니다.', status: 400 };
  }

  // 상대가 이미 나에게 요청을 보낸 상태라면 새 요청 대신 바로 수락한다.
  if (user.friendRequests.incoming.includes(target.id)) {
    return acceptFriendRequest(user, target.id);
  }

  user.friendRequests.outgoing.push(target.id);
  if (!target.friendRequests.incoming.includes(user.id)) target.friendRequests.incoming.push(user.id);
  store.putUser(user);
  store.putUser(target);
  return { ok: true };
}

function acceptFriendRequest(user, requesterId) {
  const idx = user.friendRequests.incoming.indexOf(requesterId);
  if (idx < 0) return { error: '받은 친구 요청이 없습니다.', status: 400 };
  const requester = store.getUser(requesterId);
  if (!requester) return { error: '존재하지 않는 유저입니다.', status: 404 };
  user.friendRequests.incoming.splice(idx, 1);
  const oi = requester.friendRequests.outgoing.indexOf(user.id);
  if (oi >= 0) requester.friendRequests.outgoing.splice(oi, 1);
  if (!user.friends.includes(requesterId)) user.friends.push(requesterId);
  if (!requester.friends.includes(user.id)) requester.friends.push(user.id);
  store.putUser(user);
  store.putUser(requester);
  return { ok: true };
}

function declineFriendRequest(user, requesterId) {
  const idx = user.friendRequests.incoming.indexOf(requesterId);
  if (idx < 0) return { error: '받은 친구 요청이 없습니다.', status: 400 };
  user.friendRequests.incoming.splice(idx, 1);
  const requester = store.getUser(requesterId);
  if (requester) {
    const oi = requester.friendRequests.outgoing.indexOf(user.id);
    if (oi >= 0) requester.friendRequests.outgoing.splice(oi, 1);
    store.putUser(requester);
  }
  store.putUser(user);
  return { ok: true };
}

// 보낸 요청 취소 — 친구가 되기 전 마음이 바뀐 경우.
function cancelFriendRequest(user, targetId) {
  const idx = user.friendRequests.outgoing.indexOf(targetId);
  if (idx < 0) return { error: '보낸 친구 요청이 없습니다.', status: 400 };
  user.friendRequests.outgoing.splice(idx, 1);
  const target = store.getUser(targetId);
  if (target) {
    const ii = target.friendRequests.incoming.indexOf(user.id);
    if (ii >= 0) target.friendRequests.incoming.splice(ii, 1);
    store.putUser(target);
  }
  store.putUser(user);
  return { ok: true };
}

function removeFriend(user, friendId) {
  const idx = user.friends.indexOf(friendId);
  if (idx < 0) return { error: '친구가 아닙니다.', status: 400 };
  user.friends.splice(idx, 1);
  const friend = store.getUser(friendId);
  if (friend) {
    const fi = friend.friends.indexOf(user.id);
    if (fi >= 0) friend.friends.splice(fi, 1);
    store.putUser(friend);
  }
  store.putUser(user);
  return { ok: true };
}

// 탈퇴 등으로 사라진 유저 id가 섞여 있어도 filter(Boolean)로 조용히 걸러진다.
function friendsView(user) {
  const friends = user.friends.map((id) => store.getUser(id)).filter(Boolean).map(summarize);
  const incoming = user.friendRequests.incoming.map((id) => store.getUser(id)).filter(Boolean).map(summarize);
  const outgoing = user.friendRequests.outgoing.map((id) => store.getUser(id)).filter(Boolean).map(summarize);
  return { friends, incoming, outgoing };
}

module.exports = {
  sendFriendRequest,
  acceptFriendRequest,
  declineFriendRequest,
  cancelFriendRequest,
  removeFriend,
  friendsView,
};
