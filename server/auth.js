'use strict';

const crypto = require('crypto');
const store = require('./store');

// token -> userId (in-memory; sessions reset on server restart)
const sessions = new Map();

function hashPassword(password, salt) {
  const useSalt = salt || crypto.randomBytes(16).toString('hex');
  const derived = crypto.scryptSync(password, useSalt, 64).toString('hex');
  return `${useSalt}:${derived}`;
}

function verifyPassword(password, stored) {
  const [salt, hash] = String(stored).split(':');
  if (!salt || !hash) return false;
  const derived = crypto.scryptSync(password, salt, 64).toString('hex');
  const a = Buffer.from(hash, 'hex');
  const b = Buffer.from(derived, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function issueToken(userId) {
  const token = crypto.randomBytes(24).toString('hex');
  sessions.set(token, userId);
  return token;
}

function userIdForToken(token) {
  return sessions.get(token) || null;
}

function revoke(token) {
  sessions.delete(token);
}

// Express middleware: attaches req.user or 401s.
function authMiddleware(req, res, next) {
  const header = req.headers['authorization'] || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  const userId = token && userIdForToken(token);
  const user = userId && store.getUser(userId);
  if (!user) {
    return res.status(401).json({ error: '인증이 필요합니다. 다시 로그인해 주세요.' });
  }
  req.user = user;
  req.token = token;
  next();
}

module.exports = {
  hashPassword,
  verifyPassword,
  issueToken,
  userIdForToken,
  revoke,
  authMiddleware,
};
