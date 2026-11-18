// In-memory fakes of the Google Sheets and Jobber APIs, used to test the sync without network access.
import crypto from 'node:crypto';

const colIdx = (s) => [...s].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1;

export function makeEnv() {
  const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
  Object.assign(process.env, {
    SHEET_ID: 'SHEET123',
    GOOGLE_SERVICE_ACCOUNT_JSON: JSON.stringify({ client_email: 'p4p-sync@test.iam.gserviceaccount.com', private_key: privateKey }),
    ENCRYPTION_KEY: 'x'.repeat(40),
    JOBBER_CLIENT_ID: 'cid',
    JOBBER_CLIENT_SECRET: 'secret',
    JOBBER_REDIRECT_URI: 'https://example.vercel.app/api/jobber/callback',
    SETUP_KEY: 'setup',
    BACKFILL_START: '2026-08-01',
    TIMEZONE: 'America/Chicago',
  });
}

export function installFakes({ sheets, entries }) {
  // sheets: { title: rows[][] }
  const meta = new Map();
  let nextId = 1;
  for (const t of Object.keys(sheets)) meta.set(t, { sheetId: nextId++, rowCount: 1000 });
  const log = { jobberCalls: 0, tokenCalls: [], sheetCalls: 0 };

  const parse = (range) => {
    const m = /^(?:'([^']+)'|([^!]+))!([A-Z]+)(\d+)?(?::([A-Z]+)(\d+)?)?$/.exec(decodeURIComponent(range));
    if (!m) throw new Error(`fake: bad range ${range}`);
    const title = m[1] || m[2];
    return { title, c1: colIdx(m[3]), r1: (Number(m[4]) || 1) - 1, c2: m[5] ? colIdx(m[5]) : colIdx(m[3]), r2: m[6] ? Number(m[6]) - 1 : null };
  };
  const rowsOf = (t) => { if (!sheets[t]) throw new Error(`fake: no sheet ${t}`); return sheets[t]; };

  const trim = (rows) => {
    const out = rows.map((r) => { const a = [...r]; while (a.length && (a[a.length - 1] === '' || a[a.length - 1] === undefined)) a.pop(); return a; });
    while (out.length && out[out.length - 1].length === 0) out.pop();
    return out;
  };

  const jobberHandler = (body) => {
    log.jobberCalls++;
    const { query, variables } = body;
    if (query.includes('account')) return { data: { account: { id: 'acc', name: 'Black Tie Test' } } };
    const f = variables.filter || {};
    let list = entries.filter((e) => e.endAt);
    if (f.startAt?.after) list = list.filter((e) => e.startAt >= f.startAt.after);
    if (f.updatedAt?.after) list = list.filter((e) => e.updatedAt >= f.updatedAt.after);
    const start = variables.after ? Number(Buffer.from(variables.after, 'base64').toString()) : 0;
    const page = list.slice(start, start + variables.first);
    const end = start + page.length;
    return {
      data: { timeSheetEntries: { nodes: page.map(({ updatedAt, ...n }) => n), pageInfo: { hasNextPage: end < list.length, endCursor: Buffer.from(String(end)).toString('base64') } } },
      extensions: { cost: { requestedQueryCost: 100, actualQueryCost: 100, throttleStatus: { maximumAvailable: 10000, currentlyAvailable: 9000, restoreRate: 500 } } },
    };
  };

  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    const json = (code, obj) => ({ ok: code < 300, status: code, json: async () => obj, text: async () => JSON.stringify(obj) });
    if (u === 'https://oauth2.googleapis.com/token') return json(200, { access_token: 'g-token', expires_in: 3600 });
    if (u === 'https://api.getjobber.com/api/oauth/token') {
      const p = new URLSearchParams(init.body);
      log.tokenCalls.push(Object.fromEntries(p));
      return json(200, { access_token: `A${log.tokenCalls.length}`, refresh_token: `R${log.tokenCalls.length}`, expires_in: 3600 });
    }
    if (u === 'https://api.getjobber.com/api/graphql') {
      if (!(init.headers['X-JOBBER-GRAPHQL-VERSION'])) return json(400, { errors: [{ message: 'no version header' }] });
      return json(200, jobberHandler(JSON.parse(init.body)));
    }
    if (u.startsWith('https://sheets.googleapis.com/v4/spreadsheets/')) {
      log.sheetCalls++;
      const rest = u.replace('https://sheets.googleapis.com/v4/spreadsheets/SHEET123', '');
      const body = init.body ? JSON.parse(init.body) : undefined;
      if (rest.startsWith('?fields')) return json(200, { sheets: [...meta].map(([title, m]) => ({ properties: { title, sheetId: m.sheetId, gridProperties: { rowCount: m.rowCount } } })) });
      if (rest === ':batchUpdate') {
        for (const r of body.requests) {
          if (r.addSheet) { meta.set(r.addSheet.properties.title, { sheetId: nextId++, rowCount: 1000 }); sheets[r.addSheet.properties.title] = []; }
          if (r.appendDimension) { for (const m of meta.values()) if (m.sheetId === r.appendDimension.sheetId) m.rowCount += r.appendDimension.length; }
        }
        return json(200, { replies: [] });
      }
      const mv = /^\/values\/([^?]+?)(:clear|:append)?(\?.*)?$/.exec(rest);
      if (!mv) throw new Error(`fake: unhandled ${init.method} ${rest}`);
      const range = mv[1];
      const p = parse(range);
      const rows = rowsOf(p.title);
      if (mv[2] === ':clear') {
        for (let r = p.r1; r < (p.r2 ?? rows.length - 1) + 1 && r < rows.length; r++) for (let c = p.c1; c <= p.c2; c++) if (rows[r]) rows[r][c] = undefined;
        return json(200, {});
      }
      if (mv[2] === ':append') { rows.push(...body.values); return json(200, {}); }
      if (init.method === 'PUT') {
        body.values.forEach((vals, i) => {
          const r = p.r1 + i;
          while (rows.length <= r) rows.push([]);
          vals.forEach((v, j) => { rows[r][p.c1 + j] = v; });
        });
        return json(200, {});
      }
      const end = p.r2 === null ? rows.length : p.r2 + 1;
      const slice = rows.slice(p.r1, end).map((r) => Array.from({ length: p.c2 - p.c1 + 1 }, (_, j) => r[p.c1 + j]));
      return json(200, { values: trim(slice) });
    }
    throw new Error(`fake: unhandled url ${u}`);
  };
  return { sheets, meta, log };
}
