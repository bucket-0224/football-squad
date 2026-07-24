'use strict';

const fs = require('fs');
const path = require('path');
const auth = require('./auth');
const store = require('./store');

// Profile photos live in frontend/public/img/avatars/, the same convention
// player/team images already use (backend/data/players.js's IMG_DIR). That
// convention relies on Vite serving public/ directly in dev — in production
// the frontend is a static build (frontend/dist, a snapshot taken at the
// last deploy), so an avatar uploaded after that snapshot would 404 until
// the next deploy. index.js serves this directory itself (GET /img/avatars)
// so uploads are visible immediately regardless of the frontend build state.
const AVATAR_DIR = path.join(__dirname, '..', 'frontend', 'public', 'img', 'avatars');
const MAX_AVATAR_BYTES = 3 * 1024 * 1024; // 3MB decoded
const EXT_BY_MIME = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' };

function changePassword(user, currentPassword, newPassword) {
  if (!auth.verifyPassword(String(currentPassword || ''), user.passwordHash)) {
    return { error: '현재 비밀번호가 일치하지 않습니다.', status: 400 };
  }
  if (typeof newPassword !== 'string' || newPassword.length < 4) {
    return { error: '새 비밀번호는 4자 이상이어야 합니다.', status: 400 };
  }
  user.passwordHash = auth.hashPassword(newPassword);
  store.putUser(user);
  return { ok: true };
}

function removeStaleAvatarFiles(userId, keepExt) {
  Object.values(EXT_BY_MIME).forEach((ext) => {
    if (ext === keepExt) return;
    const f = path.join(AVATAR_DIR, `${userId}.${ext}`);
    if (fs.existsSync(f)) fs.unlinkSync(f);
  });
}

function setAvatar(user, dataUrl) {
  const m = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl || ''));
  if (!m) return { error: '지원하지 않는 이미지 형식입니다. (PNG/JPEG/WEBP)', status: 400 };
  const ext = EXT_BY_MIME[m[1]];
  const buf = Buffer.from(m[2], 'base64');
  if (!buf.length) return { error: '이미지를 읽을 수 없습니다.', status: 400 };
  if (buf.length > MAX_AVATAR_BYTES) {
    return { error: '이미지 용량은 3MB 이하여야 합니다.', status: 400 };
  }
  fs.mkdirSync(AVATAR_DIR, { recursive: true });
  removeStaleAvatarFiles(user.id, ext);
  fs.writeFileSync(path.join(AVATAR_DIR, `${user.id}.${ext}`), buf);
  user.avatarUrl = `/img/avatars/${user.id}.${ext}?v=${Date.now()}`;
  store.putUser(user);
  return { ok: true, avatarUrl: user.avatarUrl };
}

function clearAvatar(user) {
  removeStaleAvatarFiles(user.id, null);
  user.avatarUrl = null;
  store.putUser(user);
  return { ok: true };
}

module.exports = { changePassword, setAvatar, clearAvatar, AVATAR_DIR };
