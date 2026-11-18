import { decrypt, safeEqual } from '../../lib/crypto.js';
import { send, params, page, escapeHtml } from '../../lib/http.js';
import { sheetsApi } from '../../lib/google.js';
import { ensureTabs, State } from '../../lib/tabs.js';
import { tokenRequest, storeTokens, gql, ACCOUNT_QUERY } from '../../lib/jobber.js';

// Step 2: Jobber redirects here after the admin clicks "Allow Access".
export default async function handler(req, res) {
  try {
    const p = params(req);
    if (p.get('error')) throw new Error(`Jobber returned: ${p.get('error')}`);
    const code = p.get('code');
    const cookieRaw = /(?:^|;\s*)p4p_oauth=([^;]+)/.exec(req.headers.cookie || '')?.[1];
    if (!code || !cookieRaw) throw new Error('Missing code or session. Start again from /api/jobber/connect.');

    const saved = JSON.parse(decrypt(decodeURIComponent(cookieRaw)));
    if (!safeEqual(p.get('state'), saved.state) || Date.now() > saved.exp) throw new Error('Authorization expired or did not match. Start again from /api/jobber/connect.');

    const tok = await tokenRequest({
      grant_type: 'authorization_code',
      code,
      redirect_uri: process.env.JOBBER_REDIRECT_URI,
      code_verifier: saved.verifier,
    });

    const sh = sheetsApi(process.env.SHEET_ID);
    await ensureTabs(sh);
    const state = await State.load(sh);
    storeTokens(state, tok);
    await state.save();

    const data = await gql(tok.access_token, ACCOUNT_QUERY);
    res.setHeader('set-cookie', 'p4p_oauth=; HttpOnly; Secure; SameSite=Lax; Path=/api/jobber; Max-Age=0');
    send(res, 200, page('Jobber connected', `<p>Connected to <strong>${escapeHtml(data.account.name)}</strong>.</p><p>The tokens are stored encrypted in the sheet's <code>Sync State</code> tab. You can close this page. Next: run the first sync at <code>/api/sync?key=YOUR_SETUP_KEY</code>.</p>`), 'text/html');
  } catch (e) {
    send(res, 500, page('Connection failed', `<p>${escapeHtml(e.message || e)}</p><p>You can try again from <code>/api/jobber/connect</code>.</p>`), 'text/html');
  }
}
