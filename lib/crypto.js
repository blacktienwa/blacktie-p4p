import crypto from 'node:crypto';

// Any string of 32+ characters works as ENCRYPTION_KEY; it is hashed to a 256-bit key.
function key() {
  const k = process.env.ENCRYPTION_KEY || '';
  if (k.length < 32) throw new Error('ENCRYPTION_KEY must be at least 32 characters');
  return crypto.createHash('sha256').update(k).digest();
}

export function encrypt(text) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const ct = Buffer.concat([c.update(String(text), 'utf8'), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64');
}

export function decrypt(s) {
  const b = Buffer.from(String(s), 'base64');
  const d = crypto.createDecipheriv('aes-256-gcm', key(), b.subarray(0, 12));
  d.setAuthTag(b.subarray(12, 28));
  return Buffer.concat([d.update(b.subarray(28)), d.final()]).toString('utf8');
}

export function safeEqual(a, b) {
  const x = Buffer.from(String(a || ''));
  const y = Buffer.from(String(b || ''));
  return x.length > 0 && x.length === y.length && crypto.timingSafeEqual(x, y);
}

export const b64url = (buf) => Buffer.from(buf).toString('base64url');
export const sha256 = (s) => crypto.createHash('sha256').update(s).digest();
export const randomToken = (n = 32) => crypto.randomBytes(n).toString('base64url');
