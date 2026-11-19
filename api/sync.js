import { runSync } from '../lib/sync.js';
import { safeEqual } from '../lib/crypto.js';
import { send, params, alertFailure } from '../lib/http.js';

// Runs on Vercel's schedule (vercel.json) and on demand: /api/sync?key=SETUP_KEY
export default async function handler(req, res) {
  const bearer = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const fromCron = process.env.CRON_SECRET && safeEqual(bearer, process.env.CRON_SECRET);
  const manual = safeEqual(params(req).get('key'), process.env.SETUP_KEY);
  if (!fromCron && !manual) return send(res, 401, { error: 'unauthorized' });
  try {
    send(res, 200, await runSync({ allJobs: params(req).get('jobs') === 'all' }));
  } catch (e) {
    await alertFailure(String(e.message || e));
    send(res, 500, { error: String(e.message || e) });
  }
}
