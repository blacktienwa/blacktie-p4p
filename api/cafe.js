import { sheetsApi } from '../lib/google.js';
import { safeEqual } from '../lib/crypto.js';
import { params, send } from '../lib/http.js';
import { setupCafe, runCafe, cafeSheet } from '../lib/cafe.js';

// Cafeteria plan setup: /api/cafe?key=SETUP_KEY
// Builds the tabs in the cafeteria sheet (only what is missing) and lists employees on the first run.
// Add &run=1 to post deposits and approved requests right now instead of waiting for the next sync.
export default async function handler(req, res) {
  const p = params(req);
  if (!safeEqual(p.get('key'), process.env.SETUP_KEY)) return send(res, 401, { error: 'unauthorized' });
  const cs = cafeSheet();
  if (!cs) return send(res, 400, { error: 'CAFE_SHEET_ID is not set in Vercel. Add it, redeploy, then open this link again.' });
  try {
    const sh = sheetsApi(process.env.SHEET_ID);
    const out = await setupCafe(sh, cs);
    if (p.get('run')) out.notes.push(...(await runCafe({ sh, cs })).notes);
    send(res, 200, { ok: true, notes: out.notes });
  } catch (e) {
    send(res, 500, { error: String(e.message || e) });
  }
}
