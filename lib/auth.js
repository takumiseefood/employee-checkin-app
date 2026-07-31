// 管理者帳號密碼驗證 — 只用 Node 內建 crypto（scrypt 雜湊 + 隨機 session token），無外部套件。
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const db = require('./db');

const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const COOKIE_NAME = 'checkin_admin_session';

function hashPassword(password, salt) {
    return crypto.scryptSync(password, salt, 64).toString('hex');
}

function createUser(username, password, { mustChangePassword = false } = {}) {
    const salt = crypto.randomBytes(16).toString('hex');
    const hash = hashPassword(password, salt);
    db.prepare(
          'INSERT OR REPLACE INTO admin_users (username, password_hash, salt, created_at, must_change_password) VALUES (?, ?, ?, ?, ?)'
        ).run(username, hash, salt, new Date().toISOString(), mustChangePassword ? 1 : 0);
}

function verifyPassword(username, password) {
    const user = db.prepare('SELECT * FROM admin_users WHERE username = ?').get(username);
    if (!user) return null;
    const hash = hashPassword(password, user.salt);
    const a = Buffer.from(hash, 'hex');
    const b = Buffer.from(user.password_hash, 'hex');
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
    return user;
}

function createSession(username) {
    const token = crypto.randomBytes(32).toString('hex');
    const now = new Date();
    const expires = new Date(now.getTime() + SESSION_TTL_MS);
    db.prepare('INSERT INTO admin_sessions (token, username, created_at, expires_at) VALUES (?, ?, ?, ?)').run(
          token, username, now.toISOString(), expires.toISOString()
        );
    return { token, expiresAt: expires };
}

function getSession(token) {
    if (!token) return null;
    const session = db.prepare('SELECT * FROM admin_sessions WHERE token = ?').get(token);
    if (!session) return null;
    if (new Date(session.expires_at) < new Date()) {
          db.prepare('DELETE FROM admin_sessions WHERE token = ?').run(token);
          return null;
    }
    return session;
}

function destroySession(token) {
    db.prepare('DELETE FROM admin_sessions WHERE token = ?').run(token);
}

function parseCookies(req) {
    const header = req.headers.cookie;
    const out = {};
    if (!header) return out;
    header.split(';').forEach((part) => {
          const idx = part.indexOf('=');
          if (idx === -1) return;
          out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
    });
    return out;
}

function setSessionCookie(res, token, expiresAt) {
    const attrs = [
          `${COOKIE_NAME}=${token}`,
          'Path=/',
          'HttpOnly',
          'SameSite=Strict',
          `Expires=${expiresAt.toUTCString()}`,
        ];
    if (process.env.FORCE_SECURE_COOKIE === '1') attrs.push('Secure');
    res.setHeader('Set-Cookie', attrs.join('; '));
}

function clearSessionCookie(res) {
    res.setHeader('Set-Cookie', `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`);
}

const failedAttempts = new Map();
const MAX_ATTEMPTS = 5;
const LOCK_MS = 60 * 1000;

function isLockedOut(ip) {
    const rec = failedAttempts.get(ip);
    if (!rec) return false;
    if (rec.lockedUntil && rec.lockedUntil > Date.now()) return true;
    if (rec.lockedUntil && rec.lockedUntil <= Date.now()) failedAttempts.delete(ip);
    return false;
}

function recordFailedAttempt(ip) {
    const rec = failedAttempts.get(ip) || { count: 0, lockedUntil: null };
    rec.count += 1;
    if (rec.count >= MAX_ATTEMPTS) {
          rec.lockedUntil = Date.now() + LOCK_MS;
          rec.count = 0;
    }
    failedAttempts.set(ip, rec);
}

function clearFailedAttempts(ip) {
    failedAttempts.delete(ip);
}

function ensureInitialAdmin() {
    const count = db.prepare('SELECT COUNT(*) AS c FROM admin_users').get().c;
    if (count > 0) return null;
    const username = 'admin';
    const password = crypto.randomBytes(9).toString('base64url');
    createUser(username, password, { mustChangePassword: true });

  const outFile = path.join(__dirname, '..', 'data', 'INITIAL_ADMIN_PASSWORD.txt');
    fs.writeFileSync(
          outFile,
          `帳號：${username}\n密碼：${password}\n\n` +
            `此檔案僅在第一次啟動時產生，登入後請立即至後台變更密碼，並刪除此檔案。\n` +
            `（此密碼僅顯示一次，遺失請用 node scripts/reset-admin-password.js 重設）\n`
        );
    return { username, password, outFile };
}

function changePassword(username, newPassword) {
    const salt = crypto.randomBytes(16).toString('hex');
    const hash = hashPassword(newPassword, salt);
    db.prepare('UPDATE admin_users SET password_hash=?, salt=?, must_change_password=0 WHERE username=?').run(
          hash, salt, username
        );
}

module.exports = {
    COOKIE_NAME,
    createUser,
    verifyPassword,
    createSession,
    getSession,
    destroySession,
    parseCookies,
    setSessionCookie,
    clearSessionCookie,
    isLockedOut,
    recordFailedAttempt,
    clearFailedAttempts,
    ensureInitialAdmin,
    changePassword,
};
