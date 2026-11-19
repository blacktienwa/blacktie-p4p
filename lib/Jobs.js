// Stage 2: Jobber jobs + invoices -> "Jobber Jobs" tab, plus the rows that depend on them (Job Payouts A:B, new Job Budgets rows).
import { gql } from './jobber.js';
import { localDate, serial } from './transform.js';
import { TAB } from './tabs.js';
import { LAYOUT_VERSION, LAST_ROW, JOBBER_JOBS_FORMULAS, JOBBER_JOBS_HEADERS_NO, PAYOUT_FORMULAS, BUDGET_D, fill } from './layout.js';

const q = (t) => `'${t}'`;

const STATUS_LABEL = {
  requires_invoicing: 'Requires invoicing', archived: 'Archived', late: 'Late', today: 'Today', upcoming: 'Upcoming',
  action_required: 'Action required', on_hold: 'On hold', unscheduled: 'Unscheduled', active: 'Active', expiring_within_30_days: 'Active',
};

const JOBS_QUERY = `query Jobs($first: Int!, $filter: JobFilterAttributes) {
  jobs(first: $first, filter: $filter) {
    nodes {
      id jobNumber title jobStatus completedAt jobberWebUri uninvoicedTotal
      client { name }
      invoices(first: 25) {
        nodes { id invoiceStatus amounts { invoiceBalance } paymentRecords(first: 25) { nodes { entryDate amount } pageInfo { hasNextPage } } }
        pageInfo { hasNextPage }
      }
    }
  }
}`;
const INVOICES_UPDATED_QUERY = `query Inv($after: String, $filter: InvoiceFilterAttributes) {
  invoices(first: 50, after: $after, filter: $filter) { nodes { jobs(first: 5) { nodes { id } } } pageInfo { hasNextPage endCursor } }
}`;
const JOBS_COMPLETED_QUERY = `query Done($after: String, $filter: JobFilterAttributes) {
  jobs(first: 100, after: $after, filter: $filter) { nodes { id } pageInfo { hasNextPage endCursor } }
}`;

async function putChunked(sh, sheet, c1, c2, startRow, rows, mode = 'RAW') {
  for (let i = 0; i < rows.length; i += 2000) {
    const chunk = rows.slice(i, i + 2000);
    const a = startRow + i;
    await sh.put(`${q(sheet)}!${c1}${a}:${c2}${a + chunk.length - 1}`, chunk, mode);
  }
}

// One Jobber job -> the values we keep in the sheet.
export function summarizeJob(n, tz) {
  const invs = (n.invoices?.nodes || []).filter((i) => i.invoiceStatus !== 'voided');
  let lastPay = '';
  let balance = 0;
  let partial = Boolean(n.invoices?.pageInfo?.hasNextPage);
  for (const i of invs) {
    balance += Number(i.amounts?.invoiceBalance) || 0;
    if (i.paymentRecords?.pageInfo?.hasNextPage) partial = true;
    for (const p of i.paymentRecords?.nodes || []) if (Number(p.amount) > 0 && p.entryDate && p.entryDate > lastPay) lastPay = p.entryDate;
  }
  const unpaid = invs.filter((i) => i.invoiceStatus !== 'paid');
  const uninvoiced = Number(n.uninvoicedTotal) || 0;
  let invStatus;
  if (!invs.length) invStatus = 'No invoices';
  else if (unpaid.length === 0) invStatus = uninvoiced > 0.005 ? 'Not fully invoiced' : 'Paid';
  else if (unpaid.some((i) => i.invoiceStatus === 'bad_debt')) invStatus = 'Bad debt';
  else if (unpaid.some((i) => i.invoiceStatus === 'past_due')) invStatus = 'Past due';
  else if (unpaid.some((i) => i.invoiceStatus === 'draft')) invStatus = 'Draft invoice';
  else invStatus = 'Awaiting payment';
  if (partial && invStatus === 'Paid') invStatus = 'Paid (REVIEW: 25+ invoices or payments)';
  const completed = n.completedAt ? serial(localDate(n.completedAt, tz)) : '';
  const paid = invStatus === 'Paid' && lastPay ? serial(localDate(lastPay, tz)) : '';
  const client = n.client?.name || '';
  return {
    number: n.jobNumber,
    title: [client, n.title].filter(Boolean).join(' - '),
    status: n.completedAt ? 'Completed' : STATUS_LABEL[n.jobStatus] || String(n.jobStatus || ''),
    completed,
    invStatus,
    paid,
    invoices: invs.length,
    balance: Math.round(balance * 100) / 100,
    uninvoiced: Math.round(uninvoiced * 100) / 100,
    id: n.id,
    uri: n.jobberWebUri || '',
  };
}

async function fetchJobs(token, ids, deadline) {
  const nodes = [];
  const attempted = new Set();
  for (let i = 0; i < ids.length; i += 10) {
    if (Date.now() > deadline) break;
    const chunk = ids.slice(i, i + 10);
    const d = await gql(token, JOBS_QUERY, { first: chunk.length, filter: { ids: chunk } });
    nodes.push(...d.jobs.nodes);
    chunk.forEach((x) => attempted.add(x));
  }
  return { nodes, attempted };
}

async function idsFromPages(token, query, vars, pick, deadline) {
  const ids = new Set();
  let after = null;
  for (;;) {
    const d = await gql(token, query, { ...vars, after });
    const conn = d.invoices || d.jobs;
    for (const n of conn.nodes) pick(n).forEach((x) => ids.add(x));
    if (!conn.pageInfo.hasNextPage || Date.now() > deadline) return { ids, done: !conn.pageInfo.hasNextPage };
    after = conn.pageInfo.endCursor;
  }
}

// Creates headers, formulas, formats and the approval dropdown (once per layout version).
async function ensureLayout(sh, meta, state) {
  if (state.get('layout_version') === LAYOUT_VERSION) return;
  for (const t of [TAB.jobs, TAB.budgets, TAB.payouts, TAB.periods]) {
    if (!meta.has(t)) throw new Error(`The sheet has no "${t}" tab.`);
  }
  const grow = [];
  for (const t of [TAB.jobs, TAB.budgets, TAB.payouts]) {
    const info = meta.get(t);
    if (info.rowCount < LAST_ROW + 10) { grow.push({ appendDimension: { sheetId: info.sheetId, dimension: 'ROWS', length: LAST_ROW + 10 - info.rowCount } }); info.rowCount = LAST_ROW + 10; }
  }
  if (grow.length) await sh.batch(grow);

  await sh.put(`${q(TAB.jobs)}!N1:T1`, [JOBBER_JOBS_HEADERS_NO]);
  await sh.put(`${q(TAB.budgets)}!H1`, [['Approval (Pending / Approved / Hold)']]);

  const rows = (list) => { const out = []; for (let r = 2; r <= LAST_ROW; r++) out.push(list.map((f) => fill(f, r))); return out; };
  await putChunked(sh, TAB.jobs, 'G', 'O', 2, rows(JOBBER_JOBS_FORMULAS), 'USER_ENTERED');
  await putChunked(sh, TAB.payouts, 'C', 'M', 2, rows(PAYOUT_FORMULAS), 'USER_ENTERED');
  await putChunked(sh, TAB.budgets, 'D', 'D', 2, rows([BUDGET_D]), 'USER_ENTERED');

  const id = (t) => meta.get(t).sheetId;
  const cp = (t, src, dst) => ({ copyPaste: { source: { sheetId: id(t), ...src }, destination: { sheetId: id(t), ...dst }, pasteType: 'PASTE_FORMAT' } });
  await sh.batch([
    cp(TAB.jobs, { startRowIndex: 1, endRowIndex: 2, startColumnIndex: 0, endColumnIndex: 20 }, { startRowIndex: 2, endRowIndex: LAST_ROW, startColumnIndex: 0, endColumnIndex: 20 }),
    cp(TAB.jobs, { startRowIndex: 0, endRowIndex: 1, startColumnIndex: 12, endColumnIndex: 13 }, { startRowIndex: 0, endRowIndex: 1, startColumnIndex: 13, endColumnIndex: 20 }),
    cp(TAB.payouts, { startRowIndex: 1, endRowIndex: 2, startColumnIndex: 0, endColumnIndex: 13 }, { startRowIndex: 2, endRowIndex: LAST_ROW, startColumnIndex: 0, endColumnIndex: 13 }),
    cp(TAB.budgets, { startRowIndex: 1, endRowIndex: 2, startColumnIndex: 0, endColumnIndex: 8 }, { startRowIndex: 2, endRowIndex: LAST_ROW, startColumnIndex: 0, endColumnIndex: 8 }),
    cp(TAB.budgets, { startRowIndex: 0, endRowIndex: 1, startColumnIndex: 6, endColumnIndex: 7 }, { startRowIndex: 0, endRowIndex: 1, startColumnIndex: 7, endColumnIndex: 8 }),
    { setDataValidation: { range: { sheetId: id(TAB.budgets), startRowIndex: 1, endRowIndex: LAST_ROW, startColumnIndex: 7, endColumnIndex: 8 }, rule: { condition: { type: 'ONE_OF_LIST', values: ['Pending', 'Approved', 'Hold'].map((v) => ({ userEnteredValue: v })) }, showCustomUi: true, strict: true } } },
  ]);
  state.set('layout_version', LAYOUT_VERSION);
}

// ctx: { sh, meta, state, token, tz, records, fetchedJobs:Set(job numbers touched by entries this run), since:ISO|null, deadline, allJobs }
export async function syncJobs(ctx) {
  const { sh, meta, state, token, tz, records, fetchedJobs, since, deadline } = ctx;
  const notes = [];
  await ensureLayout(sh, meta, state);

  // Existing rows written by an earlier run (rows without a Jobber ID are old sample rows and are dropped)
  const [af, pt] = [await sh.get(`${q(TAB.jobs)}!A2:F${LAST_ROW}`), await sh.get(`${q(TAB.jobs)}!P2:T${LAST_ROW}`)];
  const rows = new Map();
  for (let i = 0; i < af.length; i++) {
    const a = af[i] || [];
    const p = pt[i] || [];
    if (!a[0] || !p[3]) continue;
    rows.set(Number(a[0]), { number: Number(a[0]), title: a[1] || '', status: a[2] || '', completed: a[3] ?? '', invStatus: a[4] || '', paid: a[5] ?? '', invoices: p[0] ?? 0, balance: p[1] ?? 0, uninvoiced: p[2] ?? 0, id: String(p[3]), uri: p[4] || '' });
  }
  const prevJobRows = af.length;
  const settled = (r) => r.status === 'Completed' && r.paid !== '';

  const periods = (await sh.get(`${q(TAB.periods)}!A2:B60`)).map((r) => Number(r[1])).filter((n) => Number.isFinite(n) && n > 0);
  const firstStart = periods.length ? Math.min(...periods) : null;
  const budgetNums = new Set((await sh.get(`${q(TAB.budgets)}!A2:A${LAST_ROW}`)).map((r) => Number(r[0])).filter(Boolean));
  const excluded = new Set(String(state.get('jobs_excluded') || '').split(',').filter(Boolean).map(Number));

  // Job number -> Jobber job ID, from time records
  const idByNumber = new Map();
  for (const r of records) if (r.job !== '' && r.jobId) idByNumber.set(Number(r.job), r.jobId);

  // Which jobs to (re)load this run
  const want = new Map(); // job id -> job number (or null)
  const add = (id, num = null) => { if (id && !want.has(id)) want.set(id, num); };
  for (const [num, id] of idByNumber) if (!rows.has(num) && !excluded.has(num)) add(id, num);
  for (const num of fetchedJobs) add(idByNumber.get(Number(num)), Number(num));
  for (const r of rows.values()) if (ctx.allJobs || !settled(r)) add(r.id, r.number);
  if (since && !ctx.allJobs) {
    const inv = await idsFromPages(token, INVOICES_UPDATED_QUERY, { filter: { updatedAt: { after: since } } }, (n) => (n.jobs?.nodes || []).map((j) => j.id), deadline);
    const done = await idsFromPages(token, JOBS_COMPLETED_QUERY, { filter: { completedAt: { after: since } } }, (n) => [n.id], deadline);
    inv.ids.forEach((id) => add(id)); done.ids.forEach((id) => add(id));
  }

  const ids = [...want.keys()];
  const { nodes, attempted } = await fetchJobs(token, ids, deadline);
  const returned = new Set(nodes.map((n) => n.id));
  const pending = ids.filter((id) => !attempted.has(id)).length;

  let reloaded = 0;
  for (const n of nodes) {
    if (!Number.isInteger(n.jobNumber)) continue;
    const s = summarizeJob(n, tz);
    reloaded++;
    const q2 = s.completed !== '' && s.paid !== '' ? Math.max(s.completed, s.paid) : null;
    const old = firstStart !== null && q2 !== null && q2 < firstStart && !budgetNums.has(s.number);
    if (old) { rows.delete(s.number); excluded.add(s.number); } else { rows.set(s.number, s); excluded.delete(s.number); }
  }
  for (const id of attempted) if (!returned.has(id) && want.get(id) != null) { rows.delete(want.get(id)); excluded.add(want.get(id)); } // deleted in Jobber

  // --- Jobber Jobs tab ---
  let list = [...rows.values()].sort((a, b) => a.number - b.number);
  if (list.length > LAST_ROW - 1) { notes.push(`More than ${LAST_ROW - 1} jobs; extra jobs not shown.`); list = list.slice(-(LAST_ROW - 1)); }
  if (list.length) {
    await putChunked(sh, TAB.jobs, 'A', 'F', 2, list.map((s) => [s.number, s.title, s.status, s.completed, s.invStatus, s.paid]));
    await putChunked(sh, TAB.jobs, 'P', 'T', 2, list.map((s) => [s.invoices, s.balance, s.uninvoiced, s.id, s.uri]));
  }
  if (prevJobRows > list.length) {
    await sh.clear(`${q(TAB.jobs)}!A${list.length + 2}:F${prevJobRows + 1}`);
    await sh.clear(`${q(TAB.jobs)}!P${list.length + 2}:T${prevJobRows + 1}`);
  }

  // --- Job Payouts A:B: one row per job + employee who clocked time on it ---
  const emps = await sh.get(`${q(TAB.emp)}!A2:B60`);
  const nameById = new Map();
  for (const r of emps) if (r[0] && typeof r[1] === 'string' && r[1].startsWith('Z2lk')) nameById.set(r[1], String(r[0]));
  const inList = new Set(list.map((s) => s.number));
  const hrs = new Map();
  for (const r of records) {
    if (r.job === '' || !(r.hours > 0) || !inList.has(Number(r.job)) || !nameById.has(r.userId)) continue;
    const k = `${Number(r.job)}|${nameById.get(r.userId)}`;
    hrs.set(k, (hrs.get(k) || 0) + r.hours);
  }
  let payouts = [...hrs.keys()].map((k) => { const [j, n] = k.split('|'); return [Number(j), n]; }).sort((a, b) => a[0] - b[0] || a[1].localeCompare(b[1]));
  if (payouts.length > LAST_ROW - 1) { notes.push('Job Payouts is full; some job/employee rows are missing.'); payouts = payouts.slice(0, LAST_ROW - 1); }
  const prevPay = (await sh.get(`${q(TAB.payouts)}!A2:A${LAST_ROW}`)).length;
  if (payouts.length) await putChunked(sh, TAB.payouts, 'A', 'B', 2, payouts);
  if (prevPay > payouts.length) await sh.clear(`${q(TAB.payouts)}!A${payouts.length + 2}:B${prevPay + 1}`);

  // --- Job Budgets: add a row (job # and title) for any job not there yet, so the office only types budget hours ---
  const bud = await sh.get(`${q(TAB.budgets)}!A2:A${LAST_ROW}`);
  const have = new Set(bud.map((r) => Number(r[0])));
  const fresh = list.filter((s) => !have.has(s.number));
  if (fresh.length) {
    const start = bud.length + 2;
    if (start + fresh.length - 1 > LAST_ROW) notes.push('Job Budgets is full; some jobs were not added.');
    else await putChunked(sh, TAB.budgets, 'A', 'B', start, fresh.map((s) => [s.number, s.title]));
  }

  // --- Warn if the old $301 ranges are still in the Results formulas and the new tabs have outgrown them ---
  if (list.length > 290 || payouts.length > 290) {
    const f = (await sh.get(`${q(TAB.results)}!F5`, 'FORMULA'))[0]?.[0];
    if (typeof f === 'string' && f.includes('$301')) notes.push('WARNING: over 290 job rows but Results formulas still stop at row 301. In the sheet: Edit > Find and replace, find $301, replace with $1501, all sheets, include formulas.');
  }

  state.set('jobs_excluded', [...excluded].sort((a, b) => a - b).join(','));
  return { reloaded, rows: list.length, excluded: excluded.size, pending, payoutRows: payouts.length, budgetRowsAdded: fresh.length, notes };
}
