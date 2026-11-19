import { sheetsApi } from '../lib/google.js';
import { ensureAccess, loadAccess, resetPin } from '../lib/access.js';
import { safeEqual } from '../lib/crypto.js';
import { params, send } from '../lib/http.js';
import { renderAccessPage } from '../lib/render.js';
import { TAB } from '../lib/tabs.js';
import { ensureTabs } from '../lib/tabs.js';

// Office page: /api/access?key=SETUP_KEY
// Creates a link and PIN for every active employee (and the admins) who has none, and shows PINs once.
export default async function handler(req, res) {
  const p = params(req);
  const key = p.get('key');
  if (!safeEqual(key, process.env.SETUP_KEY)) return send(res, 401, { error: 'unauthorized' });
  try {
    const sh = sheetsApi(process.env.SHEET_ID);
    await ensureTabs(sh);
    const emps = (await sh.get(`'${TAB.emp}'!A2:G60`)).filter((r) => r[0] && String(r[4] ?? 'Yes').toLowerCase() !== 'no').map((r) => ({ name: String(r[0]), role: 'employee' }));
    const admins = (process.env.ADMIN_NAMES || 'Deric,Jeremy').split(',').map((s) => s.trim()).filter(Boolean).map((name) => ({ name, role: 'admin' }));
    const created = await ensureAccess(sh, [...emps, ...admins]);
    if (p.get('reset')) {
      const r = await resetPin(sh, p.get('reset'), p.get('role') === 'admin' ? 'admin' : 'employee');
      if (r) created.push(r);
    }
    const host = process.env.APP_URL || `https://${req.headers['x-forwarded-host'] || req.headers.host}`;
    const rows = await loadAccess(sh);
    res.statusCode = 200;
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.setHeader('cache-control', 'no-store');
    res.end(renderAccessPage({ rows, base: host.replace(/\/$/, ''), created, key }));
  } catch (e) {
    send(res, 500, { error: String(e.message || e) });
  }
}
