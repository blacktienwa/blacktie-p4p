import { sheetsApi } from '../lib/google.js';
import { loadAccess, findByCode, attemptPin, signSession, verifySession, readCookie, sessionCookie, SESSION_MS } from '../lib/access.js';
import { loadData, buildView, buildOverview } from '../lib/dashdata.js';
import { renderLogin, renderNotFound, renderEmployee, renderOverview } from '../lib/render.js';

const html = (res, code, body, extra = {}) => {
  res.statusCode = code;
  res.setHeader('content-type', 'text/html; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.setHeader('x-robots-tag', 'noindex, nofollow');
  res.setHeader('referrer-policy', 'no-referrer');
  res.setHeader('x-frame-options', 'DENY');
  for (const [k, v] of Object.entries(extra)) res.setHeader(k, v);
  res.end(body);
};

async function readForm(req) {
  if (req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body)) return req.body;
  const chunks = [];
  let size = 0;
  for await (const c of req) { size += c.length; if (size > 4096) break; chunks.push(c); }
  return Object.fromEntries(new URLSearchParams(Buffer.concat(chunks).toString('utf8')));
}

// /d/<code>  employee page      /a/<code>  admin page (all employees)
export default async function handler(req, res) {
  try {
    const url = new URL(req.url, 'http://localhost');
    const m = /^\/(d|a)\/([^/?#]+)/.exec(url.pathname);
    const kind = url.searchParams.get('kind') || m?.[1];
    const code = url.searchParams.get('code') || m?.[2] || '';
    const here = `/${kind}/${code}`;
    const sh = sheetsApi(process.env.SHEET_ID);

    const rec = findByCode(await loadAccess(sh), code);
    const wantRole = kind === 'a' ? 'admin' : 'employee';
    if (!rec || rec.role !== wantRole || !rec.active) return html(res, 404, renderNotFound());

    if (url.searchParams.get('logout')) return html(res, 200, renderLogin({ name: rec.name }), { 'set-cookie': sessionCookie('', 0) });

    let authed = verifySession(readCookie(req), rec.code);
    if (!authed && req.method === 'POST') {
      const form = await readForm(req);
      const r = await attemptPin(sh, rec, String(form.pin || '').trim());
      if (r.ok) {
        res.statusCode = 303;
        res.setHeader('set-cookie', sessionCookie(signSession(rec.code), SESSION_MS / 1000));
        res.setHeader('location', here);
        res.setHeader('cache-control', 'no-store');
        return res.end();
      }
      const error = r.locked ? `Too many tries. Try again in ${r.minutes} minutes.` : 'That PIN is not right.';
      return html(res, 401, renderLogin({ name: rec.name, error, locked: r.locked }));
    }
    if (!authed) return html(res, 200, renderLogin({ name: rec.name }));

    const data = await loadData(sh);
    const logout = `${here}?logout=1`;
    if (kind === 'a') {
      const who = url.searchParams.get('e');
      if (who) {
        const v = buildView(data, who);
        if (!v) return html(res, 404, renderNotFound());
        return html(res, 200, renderEmployee(v, { back: here, logout }));
      }
      return html(res, 200, renderOverview(buildOverview(data), { base: here, logout }));
    }
    const v = buildView(data, rec.name);
    if (!v) return html(res, 200, renderNotFound());
    return html(res, 200, renderEmployee(v, { logout }));
  } catch (err) {
    console.error('dash error', err && err.message);
    html(res, 500, '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><p style="font:16px system-ui;padding:2rem">Something went wrong loading your page. Please try again in a minute.</p>');
  }
}
