import crypto from 'node:crypto';

const SCOPE = 'https://www.googleapis.com/auth/spreadsheets';
let cached = null;

function serviceAccount() {
  // Easiest option: two separate variables.
  const email = (process.env.GOOGLE_CLIENT_EMAIL || '').trim();
  const pk = (process.env.GOOGLE_PRIVATE_KEY || '').trim().replace(/^["']|["']$/g, '');
  if (email && pk) return { client_email: email, private_key: pk.replace(/\\n/g, '\n') };

  let raw = (process.env.GOOGLE_SERVICE_ACCOUNT_JSON || '').replace(/^\uFEFF/, '').trim();
  if (!raw) throw new Error('Google credentials are not set (set GOOGLE_CLIENT_EMAIL and GOOGLE_PRIVATE_KEY)');
  if (/^(["']).*\1$/s.test(raw)) raw = raw.slice(1, -1).trim(); // pasted with surrounding quotes
  let sa;
  try {
    if (!raw.startsWith('{')) raw = Buffer.from(raw, 'base64').toString('utf8');
    try { sa = JSON.parse(raw); } catch { sa = JSON.parse(raw.replace(/\r?\n/g, '\\n')); } // real line breaks inside the key
  } catch {
    throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON is not valid. Instead, set two variables in Vercel: GOOGLE_CLIENT_EMAIL (the client_email value) and GOOGLE_PRIVATE_KEY (the private_key value).');
  }
  if (!sa.client_email || !sa.private_key) throw new Error('Service account JSON is missing client_email or private_key');
  sa.private_key = String(sa.private_key).replace(/\\n/g, '\n');
  return sa;
}

async function accessToken() {
  if (cached && cached.exp > Date.now() + 60000) return cached.token;
  const sa = serviceAccount();
  const now = Math.floor(Date.now() / 1000);
  const enc = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const head = enc({ alg: 'RS256', typ: 'JWT' });
  const claim = enc({ iss: sa.client_email, scope: SCOPE, aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600 });
  const sig = crypto.createSign('RSA-SHA256').update(`${head}.${claim}`).sign(sa.private_key, 'base64url');
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${head}.${claim}.${sig}` }),
  });
  const j = await r.json();
  if (!r.ok) throw new Error(`Google auth failed: ${j.error_description || j.error || r.status}`);
  cached = { token: j.access_token, exp: Date.now() + (j.expires_in || 3600) * 1000 };
  return cached.token;
}

async function call(method, url, body) {
  let lastErr;
  for (let attempt = 0; attempt < 5; attempt++) {
    const r = await fetch(url, {
      method,
      headers: { authorization: `Bearer ${await accessToken()}`, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (r.ok) return r.json();
    const text = await r.text();
    lastErr = new Error(`Google Sheets ${method} failed (${r.status}): ${text.slice(0, 300)}`);
    if (r.status === 403 || r.status === 404) {
      lastErr.message += ' - is the sheet shared with the service account as Editor, and is SHEET_ID correct?';
      throw lastErr;
    }
    if (r.status !== 429 && r.status < 500) throw lastErr;
    await new Promise((res) => setTimeout(res, 1000 * 2 ** attempt));
  }
  throw lastErr;
}

export function sheetsApi(spreadsheetId) {
  const base = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}`;
  const enc = encodeURIComponent;
  return {
    meta: () => call('GET', `${base}?fields=sheets.properties`),
    get: async (range) => (await call('GET', `${base}/values/${enc(range)}?valueRenderOption=UNFORMATTED_VALUE`)).values || [],
    put: (range, values, mode = 'RAW') =>
      call('PUT', `${base}/values/${enc(range)}?valueInputOption=${mode}`, { range, majorDimension: 'ROWS', values }),
    clear: (range) => call('POST', `${base}/values/${enc(range)}:clear`, {}),
    append: (range, values) =>
      call('POST', `${base}/values/${enc(range)}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`, { values }),
    batch: (requests) => call('POST', `${base}:batchUpdate`, { requests }),
  };
}
