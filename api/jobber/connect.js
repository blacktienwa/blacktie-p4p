import { encrypt, safeEqual, randomToken, b64url, sha256 } from '../../lib/crypto.js';
import { send, params, page } from '../../lib/http.js';

// Step 1 of the one-time Jobber authorization. Open as a Jobber admin:
//   https://YOUR-APP.vercel.app/api/jobber/connect?key=SETUP_KEY
export default async function handler(req, res) {
  try {
    if (!safeEqual(params(req).get('key'), process.env.SETUP_KEY)) {
      return send(res, 401, page('Not allowed', '<p>Missing or wrong setup key.</p>'), 'text/html');
    }
    const clientId = process.env.JOBBER_CLIENT_ID;
    const redirect = process.env.JOBBER_REDIRECT_URI;
    if (!clientId || !redirect) throw new Error('JOBBER_CLIENT_ID and JOBBER_REDIRECT_URI must be set');

    const state = randomToken(16);
    const verifier = randomToken(48);
    const challenge = b64url(sha256(verifier));
    const cookie = encrypt(JSON.stringify({ state, verifier, exp: Date.now() + 10 * 60000 }));

    const url = new URL('https://api.getjobber.com/api/oauth/authorize');
    url.search = new URLSearchParams({
      response_type: 'code',
      client_id: clientId,
      redirect_uri: redirect,
      state,
      code_challenge: challenge,
      code_challenge_method: 'S256',
    }).toString();

    res.setHeader('set-cookie', `p4p_oauth=${encodeURIComponent(cookie)}; HttpOnly; Secure; SameSite=Lax; Path=/api/jobber; Max-Age=600`);
    res.statusCode = 302;
    res.setHeader('location', url.toString());
    res.end();
  } catch (e) {
    send(res, 500, page('Setup error', `<p>${String(e.message || e).replace(/</g, '&lt;')}</p>`), 'text/html');
  }
}
