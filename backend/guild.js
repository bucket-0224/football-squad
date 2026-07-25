'use strict';

// 길드(가입 신청 + 길드장 승인 방식) — event.js/devotion.js처럼 순수 함수
// 모듈로 분리하고 backend/index.js는 얇게 라우팅만 한다.

const crypto = require('crypto');
const store = require('./store');

const MAX_MEMBERS = 20;

function summarizeMember(u) {
  return { id: u.id, username: u.username, clubName: u.clubName, points: u.points };
}

function publicGuild(g) {
  const members = g.members.map((id) => store.getUser(id)).filter(Boolean).map(summarizeMember);
  const pending = g.pending.map((id) => store.getUser(id)).filter(Boolean).map(summarizeMember);
  return {
    id: g.id,
    name: g.name,
    tag: g.tag,
    ownerId: g.ownerId,
    createdAt: g.createdAt,
    members,
    pending,
    totalPoints: members.reduce((s, m) => s + (m.points || 0), 0),
  };
}

function createGuild(user, name, tag) {
  if (user.guildId) return { error: '이미 길드에 소속되어 있습니다.', status: 400 };
  const cleanName = String(name || '').trim().slice(0, 24);
  const cleanTag = String(tag || '').trim().slice(0, 6);
  if (!cleanName) return { error: '길드 이름을 입력해주세요.', status: 400 };
  if (!cleanTag) return { error: '길드 태그를 입력해주세요.', status: 400 };
  const lowerName = cleanName.toLowerCase();
  if (store.allGuilds().some((g) => g.name.toLowerCase() === lowerName)) {
    return { error: '이미 사용 중인 길드 이름입니다.', status: 400 };
  }
  const guild = {
    id: 'g' + crypto.randomBytes(6).toString('hex'),
    name: cleanName,
    tag: cleanTag,
    ownerId: user.id,
    members: [user.id],
    pending: [],
    createdAt: Date.now(),
  };
  store.putGuild(guild);
  user.guildId = guild.id;
  store.putUser(user);
  return { guild: publicGuild(guild) };
}

function requestJoin(user, guildId) {
  if (user.guildId) return { error: '이미 길드에 소속되어 있습니다.', status: 400 };
  const guild = store.getGuild(guildId);
  if (!guild) return { error: '존재하지 않는 길드입니다.', status: 404 };
  if (guild.members.length >= MAX_MEMBERS) return { error: '길드 정원이 가득 찼습니다.', status: 400 };
  if (guild.pending.includes(user.id)) return { error: '이미 가입 신청을 보냈습니다.', status: 400 };
  guild.pending.push(user.id);
  store.putGuild(guild);
  return { ok: true };
}

// 신청 취소 — 아직 승인 전, 신청자 본인이 취소.
function cancelJoin(user, guildId) {
  const guild = store.getGuild(guildId);
  if (!guild) return { error: '존재하지 않는 길드입니다.', status: 404 };
  const idx = guild.pending.indexOf(user.id);
  if (idx < 0) return { error: '대기 중인 가입 신청이 없습니다.', status: 400 };
  guild.pending.splice(idx, 1);
  store.putGuild(guild);
  return { ok: true };
}

function approveJoin(owner, userId) {
  const guild = store.getGuild(owner.guildId);
  if (!guild || guild.ownerId !== owner.id) return { error: '길드장만 승인할 수 있습니다.', status: 403 };
  const idx = guild.pending.indexOf(userId);
  if (idx < 0) return { error: '대기 중인 가입 신청이 없습니다.', status: 400 };
  if (guild.members.length >= MAX_MEMBERS) return { error: '길드 정원이 가득 찼습니다.', status: 400 };
  guild.pending.splice(idx, 1);
  const applicant = store.getUser(userId);
  if (!applicant || applicant.guildId) {
    // 유저가 사라졌거나 대기 중 다른 길드에 먼저 가입한 경우 — 대기열에서만 제거.
    store.putGuild(guild);
    return { error: '해당 유저가 이미 다른 길드에 가입했거나 존재하지 않습니다.', status: 400 };
  }
  guild.members.push(userId);
  applicant.guildId = guild.id;
  store.putGuild(guild);
  store.putUser(applicant);
  return { guild: publicGuild(guild) };
}

function rejectJoin(owner, userId) {
  const guild = store.getGuild(owner.guildId);
  if (!guild || guild.ownerId !== owner.id) return { error: '길드장만 처리할 수 있습니다.', status: 403 };
  const idx = guild.pending.indexOf(userId);
  if (idx < 0) return { error: '대기 중인 가입 신청이 없습니다.', status: 400 };
  guild.pending.splice(idx, 1);
  store.putGuild(guild);
  return { ok: true };
}

function leaveGuild(user) {
  if (!user.guildId) return { error: '소속된 길드가 없습니다.', status: 400 };
  const guild = store.getGuild(user.guildId);
  const leftGuildId = user.guildId;
  user.guildId = null;
  store.putUser(user);
  if (!guild) return { ok: true, guildId: leftGuildId };
  guild.members = guild.members.filter((id) => id !== user.id);
  if (!guild.members.length) {
    store.deleteGuild(guild.id);
    return { ok: true, guildId: leftGuildId };
  }
  if (guild.ownerId === user.id) {
    guild.ownerId = guild.members[0]; // 다음 멤버(가입 순)에게 소유권 이전
  }
  store.putGuild(guild);
  return { ok: true, guildId: leftGuildId };
}

function guildDetail(guildId) {
  const guild = store.getGuild(guildId);
  return guild ? publicGuild(guild) : null;
}

function guildList() {
  return store.allGuilds().map((g) => ({
    id: g.id,
    name: g.name,
    tag: g.tag,
    memberCount: g.members.length,
    pendingCount: g.pending.length,
  }));
}

function guildLeaderboard() {
  return store
    .allGuilds()
    .map((g) => publicGuild(g))
    .sort((a, b) => b.totalPoints - a.totalPoints)
    .slice(0, 50);
}

module.exports = {
  MAX_MEMBERS,
  createGuild,
  requestJoin,
  cancelJoin,
  approveJoin,
  rejectJoin,
  leaveGuild,
  guildDetail,
  guildList,
  guildLeaderboard,
};
