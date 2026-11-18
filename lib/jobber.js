import { decrypt, encrypt } from './crypto.js';

const API = 'https://api.getjobber.com/api/graphql';
const TOKEN_URL = 'https://api.getjobber.com/api/oauth/token';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const apiVersion = () => process.env.JOBBER_API_VERSION || '2026-05-12';

function need(name) {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set`);
  return v;
}

export async function tokenRequest(params) {
  const r = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: need('JOBBER_CLIENT_ID'), client_secret: need('JOBBER_CLIENT_SECRET'), ...params }),
  });
  const text = await r.text();
  let j;
  try { j = JSON.parse(text); } catch { j = {}; }
  if (!r.ok || !j.access_token) throw new Error(`Jobber token request failed (${r.status}): ${text.slice(0, 200)}`);
  return j;
}

export function storeTokens(state, tok) {
  if (tok.refresh_token) state.set('jobber_refresh', encrypt(tok.refresh_token));
  state.set('jobber_access', encrypt(tok.access_token));
  state.set('jobber_access_exp', String(Date.now() + (tok.expires_in || 3600) * 1000));
}

// Returns a valid access token, refreshing (and immediately persisting the rotated refresh token) if needed.
export async function getAccessToken(state) {
  const exp = Number(state.get('jobber_access_exp') || 0);
  if (state.get('jobber_access') && exp > Date.now() + 120000) return decrypt(state.get('jobber_access'));
  const enc = state.get('jobber_refresh');
  if (!enc) throw new Error('Jobber is not connected yet. Open /api/jobber/connect?key=YOUR_SETUP_KEY as a Jobber admin.');
  const tok = await tokenRequest({ grant_type: 'refresh_token', refresh_token: decrypt(enc) });
  storeTokens(state, tok);
  await state.save(); // persist right away: a lost rotated token would force re-authorization
  return tok.access_token;
}

// GraphQL call with cost-based throttling.
export async function gql(token, query, variables = {}) {
  for (let attempt = 0; attempt < 6; attempt++) {
    const r = await fetch(API, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'X-JOBBER-GRAPHQL-VERSION': apiVersion(),
        'content-type': 'application/json',
        accept: 'application/json',
        'accept-encoding': 'identity',
      },
      body: JSON.stringify({ query, variables }),
    });
    if (r.status === 401) throw new Error('Jobber rejected the access token (401). Re-run /api/jobber/connect.');
    if (r.status === 429 || r.status >= 500) { await sleep(2000 * 2 ** attempt); continue; }
    const raw = await r.text();
    let j;
    try { j = JSON.parse(raw); } catch {
      throw new Error(`Jobber returned a non-JSON reply (HTTP ${r.status}, ${r.headers?.get('content-type') || 'no type'}, encoding ${r.headers?.get('content-encoding') || 'none'}, ${raw.length} bytes)`);
    }
    const throttled = (j.errors || []).some((e) => e?.extensions?.code === 'THROTTLED');
    if (throttled) {
      const ts = j.extensions?.cost?.throttleStatus;
      await sleep(Math.min(30000, ts ? Math.ceil(((j.extensions.cost.requestedQueryCost || 2000) - ts.currentlyAvailable) / ts.restoreRate) * 1000 + 1000 : 5000));
      continue;
    }
    if (j.errors?.length) throw new Error(`Jobber GraphQL error: ${j.errors.map((e) => e.message).join('; ').slice(0, 300)}`);
    const ts = j.extensions?.cost?.throttleStatus;
    if (ts && ts.currentlyAvailable < 2500) await sleep(Math.ceil((2500 - ts.currentlyAvailable) / ts.restoreRate) * 1000);
    return j.data;
  }
  throw new Error('Jobber API kept throttling or failing; giving up for this run.');
}

const ENTRIES_QUERY = `query Entries($first: Int!, $after: String, $filter: TimeSheetEntriesFilterAttributes) {
  timeSheetEntries(first: $first, after: $after, filter: $filter) {
    nodes { id startAt endAt finalDuration user { id name { full } } job { jobNumber } }
    pageInfo { hasNextPage endCursor }
  }
}`;

// Pages through time entries; calls onNodes for each page. Stops early (returning a cursor) at the deadline.
export async function pullEntries(token, filter, startCursor, deadline, onNodes) {
  let after = startCursor || null;
  for (;;) {
    const data = await gql(token, ENTRIES_QUERY, { first: 100, after, filter });
    const conn = data.timeSheetEntries;
    onNodes(conn.nodes);
    if (!conn.pageInfo.hasNextPage) return { done: true, cursor: null };
    after = conn.pageInfo.endCursor;
    if (Date.now() > deadline) return { done: false, cursor: after };
  }
}

export const ACCOUNT_QUERY = 'query { account { id name } }';
