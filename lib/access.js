// Dashboard access: one random link code + a 6-digit PIN per person. PINs are stored only as salted scrypt hashes.
import crypto from 'node:crypto';
import { promisify } from 'node:util';
import { TAB } from './tabs.js';
import { safeEqual, randomToken, b64url } from './crypto.js';

const scrypt = promisify(crypto.scrypt);
const q = (t) => `'${t}'`;
export const MAX_TRIES = 5;
export const LOCK_MS = 15 * 60000;
export const SESSION_MS = 12 * 3600e3;
export const COOKIE = 'p4p_s';

export const newPin = () => String(crypto.randomInt(0, 1000000)).padStart(6, '0');
export const newCode = () => randomToken(24);

export async function hashPin(pin, saltB64) {
  return (await scrypt(String(pin), Buffer.from(saltB64, 'base64'), 32)).toString('base64');
}
async function makeCredential(pin) {
  const salt = crypto.randomBytes(16).toString('base64');
  return { salt, hash: await hashPin(pin, salt) };
}
async function pinMatches(pin, salt, hash) {
  if (!salt || !hash || !/^\d{6}$/.test(String(pin))) return false;
  return safeEqual(await hashPin(pin, salt), hash);
}

// ---- signed session cookie ----
function sessionKey() {
  const k = process.env.ENCRYPTION_KEY || '';
  if (k.length < 32) throw new Error('ENCRYPTION_KEY must be at least 32 characters');
  return crypto.createHash('sha256').update(`session:${k}`).digest();
}
export function signSession(code, now = Date.now()) {
  const body = b64url(JSON.stringify({ c: code, e: now + SESSION_MS }));
  return `${body}.${crypto.createHmac('sha256', sessionKey()).update(body).digest('base64url')}`;
}
export function verifySession(cookieValue, code, now = Date.now()) {
  const [body, mac] = String(cookieValue || '').split('.');
  if (!body || !mac) return false;
  if (!safeEqual(crypto.createHmac('sha256', sessionKey()).update(body).digest('base64url'), mac)) return false;
  try {
    const p = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    return p.c === code && p.e > now;
  } catch { return false; }
}
export const readCookie = (req, name = COOKIE) => new RegExp(`(?:^|;\\s*)${name}=([^;]+)`).exec(req.headers.cookie || '')?.[1] || '';
export const sessionCookie = (value, maxAgeSec) => `${COOKIE}=${value}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${maxAgeSec}`;

// ---- Dashboard Access tab ----
export async function loadAccess(sh) {
  const rows = await sh.get(`${q(TAB.access)}!A2:I300`);
  return rows.map((r, i) => ({
    row: i + 2, name: String(r[0] || ''), role: String(r[1] || ''), code: String(r[2] || ''), salt: String(r[3] || ''), hash: String(r[4] || ''),
    failed: Number(r[5]) || 0, lockedUntil: Number(r[6]) || 0, lastLogin: String(r[7] || ''), active: String(r[8] ?? 'Yes').toLowerCase() !== 'no',
  })).filter((r) => r.name);
}

export const findByCode = (rows, code) => {
  let hit = null;
  for (const r of rows) if (r.code && code && safeEqual(r.code, code)) hit = r; // compare against all rows, no early exit
  return hit;
};

// Tries a PIN. Returns { ok } or { ok:false, locked:true, minutes } or { ok:false }.
export async function attemptPin(sh, rec, pin, now = Date.now()) {
  if (!rec.active) return { ok: false };
  if (rec.lockedUntil > now) return { ok: false, locked: true, minutes: Math.ceil((rec.lockedUntil - now) / 60000) };
  if (await pinMatches(pin, rec.salt, rec.hash)) {
    await sh.put(`${q(TAB.access)}!F${rec.row}:H${rec.row}`, [[0, 0, new Date(now).toISOString()]]);
    return { ok: true };
  }
  const failed = rec.failed + 1;
  if (failed >= MAX_TRIES) {
    await sh.put(`${q(TAB.access)}!F${rec.row}:G${rec.row}`, [[0, now + LOCK_MS]]);
    return { ok: false, locked: true, minutes: Math.ceil(LOCK_MS / 60000) };
  }
  await sh.put(`${q(TAB.access)}!F${rec.row}`, [[failed]]);
  return { ok: false, triesLeft: MAX_TRIES - failed };
}

// Creates a link + PIN for anyone listed who has none. Returns the people created (their PINs exist only in this return value).
export async function ensureAccess(sh, people) { // people: [{name, role}]
  const rows = await loadAccess(sh);
  const have = new Set(rows.map((r) => `${r.role}|${r.name}`));
  const created = [];
  const add = [];
  for (const p of people) {
    if (have.has(`${p.role}|${p.name}`)) continue;
    const pin = newPin();
    const { salt, hash } = await makeCredential(pin);
    const code = newCode();
    add.push([p.name, p.role, code, salt, hash, 0, 0, '', 'Yes']);
    created.push({ name: p.name, role: p.role, code, pin });
  }
  if (add.length) await sh.append(`${q(TAB.access)}!A:I`, add);
  return created;
}

export async function resetPin(sh, name, role) {
  const rec = (await loadAccess(sh)).find((r) => r.name === name && r.role === role);
  if (!rec) return null;
  const pin = newPin();
  const { salt, hash } = await makeCredential(pin);
  await sh.put(`${q(TAB.access)}!D${rec.row}:G${rec.row}`, [[salt, hash, 0, 0]]);
  return { name, role, code: rec.code, pin };
}
