import { sheetsApi } from './google.js';
import { getAccessToken, pullEntries } from './jobber.js';
import { entryToRecord, computeOvertime } from './transform.js';
import { autoMap } from './mapping.js';
import { ensureTabs, State, TAB } from './tabs.js';
import { syncJobs } from './jobs.js';

const need = (n) => { const v = process.env[n]; if (!v) throw new Error(`${n} is not set`); return v; };
const q = (t) => `'${t}'`;
const SPARE_ROWS = 2000;

const timeFormulaG = (r) => `=IF(C${r}="","",IFERROR(INDEX(Employees!$A$2:$A$26,MATCH(C${r},Employees!$B$2:$B$26,0)),"UNKNOWN USER"))`;
const timeFormulaH = (r) => `=IF(B${r}="","",IFERROR(IF(B${r}<=INDEX('Payroll Periods'!$C$2:$C$60,MATCH(B${r},'Payroll Periods'!$B$2:$B$60,1)),INDEX('Payroll Periods'!$A$2:$A$60,MATCH(B${r},'Payroll Periods'!$B$2:$B$60,1)),""),""))`;

async function putChunked(sh, sheet, c1, c2, startRow, rows, mode = 'RAW') {
  for (let i = 0; i < rows.length; i += 4000) {
    const chunk = rows.slice(i, i + 4000);
    const a = startRow + i;
    await sh.put(`${q(sheet)}!${c1}${a}:${c2}${a + chunk.length - 1}`, chunk, mode);
  }
}

async function readTime(sh) {
  const rows = await sh.get(`${q(TAB.time)}!A2:K`);
  const out = new Map();
  for (const r of rows) {
    const id = r[0];
    if (typeof id !== 'string' || !id.startsWith('Z2lk')) continue; // drops old sample rows
    out.set(id, { id, date: Number(r[1]), userId: String(r[2] || ''), job: r[3] ?? '', hours: Number(r[4]) || 0, ot: Number(r[5]) || 0, startAt: String(r[8] || ''), jobId: String(r[9] || ''), flag: String(r[10] || '') });
  }
  return { records: out, rowCount: rows.length };
}

async function ensureGrid(sh, meta, state, tab, needRows) {
  const info = meta.get(tab);
  const gridThrough = Number(state.get('grid_through') || 5001);
  const requests = [];
  if (info.rowCount < needRows + 10) {
    requests.push({ appendDimension: { sheetId: info.sheetId, dimension: 'ROWS', length: needRows + 10 - info.rowCount } });
  }
  if (requests.length) await sh.batch(requests);
  return gridThrough;
}

async function writeTime(sh, meta, state, records, prevRowCount) {
  const n = records.length;
  const through = Number(state.get('grid_through') || 5001);
  const wantThrough = Math.max(through, n + 1 + SPARE_ROWS);
  await ensureGrid(sh, meta, state, TAB.time, wantThrough);
  const info = meta.get(TAB.time);

  if (n) {
    await putChunked(sh, TAB.time, 'A', 'F', 2, records.map((r) => [r.id, r.date, r.userId, r.job, r.hours, r.ot]));
    await putChunked(sh, TAB.time, 'I', 'K', 2, records.map((r) => [r.startAt, r.jobId || '', r.flag]));
  }
  if (prevRowCount > n) {
    await sh.clear(`${q(TAB.time)}!A${n + 2}:F${prevRowCount + 1}`);
    await sh.clear(`${q(TAB.time)}!I${n + 2}:K${prevRowCount + 1}`);
  }
  if (wantThrough > through) {
    const rows = [];
    for (let r = through + 1; r <= wantThrough; r++) rows.push([timeFormulaG(r), timeFormulaH(r)]);
    await putChunked(sh, TAB.time, 'G', 'H', through + 1, rows, 'USER_ENTERED');
    await sh.batch([
      { repeatCell: { range: { sheetId: info.sheetId, startRowIndex: through, endRowIndex: wantThrough, startColumnIndex: 1, endColumnIndex: 2 }, cell: { userEnteredFormat: { numberFormat: { type: 'DATE', pattern: 'mm/dd/yyyy' } } }, fields: 'userEnteredFormat.numberFormat' } },
      { repeatCell: { range: { sheetId: info.sheetId, startRowIndex: through, endRowIndex: wantThrough, startColumnIndex: 4, endColumnIndex: 6 }, cell: { userEnteredFormat: { numberFormat: { type: 'NUMBER', pattern: '0.00' } } }, fields: 'userEnteredFormat.numberFormat' } },
    ]);
    state.set('grid_through', wantThrough);
  }
  await sh.put(`${q(TAB.time)}!I1:K1`, [['Start (UTC)', 'Jobber Job ID', 'Flag']]);
}

async function writeUsers(sh, users) {
  const rows = [...users].filter(([id]) => id).sort((a, b) => a[1].localeCompare(b[1]));
  await sh.clear(`${q(TAB.users)}!A2:E500`);
  if (!rows.length) return;
  await sh.put(`${q(TAB.users)}!A2:B${rows.length + 1}`, rows.map(([id, name]) => [id, name]));
  const f = rows.map((_, i) => {
    const r = i + 2;
    return [
      `=IFERROR(INDEX(Employees!$A$2:$A$26,MATCH(A${r},Employees!$B$2:$B$26,0)),"")`,
      `=SUMIFS('Jobber Time'!$E$2:$E$20000,'Jobber Time'!$C$2:$C$20000,A${r},'Jobber Time'!$B$2:$B$20000,">="&(TODAY()-60))`,
      `=IF(C${r}<>"","Mapped",IF(D${r}>0,"Not in Employees (OK for non-p4p staff)","No recent hours"))`,
    ];
  });
  await sh.put(`${q(TAB.users)}!C2:E${rows.length + 1}`, f, 'USER_ENTERED');
}

export async function runSync(opts = {}) {
  const t0 = Date.now();
  const deadline = t0 + (opts.budgetMs || 240000);
  const sh = sheetsApi(need('SHEET_ID'));
  const tz = process.env.TIMEZONE || 'America/Chicago';
  const maxHours = Number(process.env.MAX_ENTRY_HOURS || 16);
  const backfillStart = process.env.BACKFILL_START || '2026-08-01';

  const meta = await ensureTabs(sh);
  const state = await State.load(sh);
  if (Number(state.get('lock_until') || 0) > Date.now()) return { skipped: 'another sync is still running' };
  state.set('lock_until', t0 + 9 * 60000);
  await state.save();

  const out = { mode: '', fetched: 0, added: 0, updated: 0, flagged: 0, notes: [] };
  try {
    const token = await getAccessToken(state);
    const { records: existing, rowCount } = await readTime(sh);

    // Known user names: existing Jobber Users tab + anything seen in this run
    const users = new Map();
    for (const r of await sh.get(`${q(TAB.users)}!A2:B500`)) if (r[0]) users.set(String(r[0]), String(r[1] || ''));

    const fetched = new Map();
    const touchedJobs = new Set();
    const onNodes = (nodes) => {
      for (const n of nodes) {
        if (n.user?.id) users.set(n.user.id, (n.user.name?.full || users.get(n.user.id) || '').trim());
        const rec = entryToRecord(n, { tz, maxHours });
        if (rec && rec.startAt >= `${backfillStart}T00:00:00Z`) { fetched.set(rec.id, rec); if (rec.job !== '') touchedJobs.add(Number(rec.job)); } // ignore entries from before the tracking window
      }
    };

    let advance = false;
    let since = null;
    // The first run after stage 2 is installed re-reads all entries once, to record each entry's Jobber job ID.
    if (state.get('backfill_done') !== '1' || state.get('jobids_done') !== '1') {
      out.mode = 'backfill';
      if (!state.get('backfill_cursor')) state.set('backfill_started', t0);
      const r = await pullEntries(token, { startAt: { after: `${backfillStart}T00:00:00Z` } }, state.get('backfill_cursor') || null, deadline, onNodes);
      if (r.done) { state.set('backfill_done', '1'); state.set('jobids_done', '1'); state.set('backfill_cursor', ''); state.set('last_sync_started', state.get('backfill_started')); out.notes.push('Backfill complete.'); }
      else { state.set('backfill_cursor', r.cursor); out.notes.push('Backfill not finished - next run continues where this stopped.'); }
    } else {
      out.mode = 'incremental';
      const last = Number(state.get('last_sync_started') || 0);
      since = new Date((last || Date.parse(`${backfillStart}T00:00:00Z`)) - 3 * 3600e3).toISOString();
      const a = await pullEntries(token, { updatedAt: { after: since } }, null, deadline, onNodes);
      const recent = new Date(t0 - 3 * 86400e3).toISOString();
      const b = await pullEntries(token, { startAt: { after: recent } }, null, deadline, onNodes);
      advance = a.done && b.done;
      if (!advance) out.notes.push('Incremental pull hit the time limit; will repeat next run.');
    }

    out.fetched = fetched.size;
    const merged = new Map(existing);
    for (const [id, rec] of fetched) {
      if (existing.has(id)) out.updated++; else out.added++;
      merged.set(id, rec);
    }
    const records = computeOvertime([...merged.values()]);
    out.flagged = records.filter((r) => r.flag).length;

    await writeTime(sh, meta, state, records, rowCount);
    await writeUsers(sh, users);

    // Link Employees-tab rows to Jobber IDs by name where unambiguous
    const empRows = (await sh.get(`${q(TAB.emp)}!A2:B60`)).map((r, i) => ({ row: i + 2, name: r[0], current: r[1] }));
    const { updates, unmatched } = autoMap(empRows.filter((e) => e.name), users);
    for (const u of updates) { await sh.put(`${q(TAB.emp)}!B${u.row}`, [[u.id]]); out.notes.push(`Linked ${u.name} to Jobber ID.`); }
    if (unmatched.length) out.notes.push(`Not linked: ${unmatched.join('; ')}`);
    if (out.flagged) out.notes.push(`${out.flagged} entries over ${maxHours}h are excluded until fixed in Jobber (see Flag column).`);

    // Stage 2: jobs, invoices, approvals. A failure here must not lose the time-entry sync above.
    let status = 'OK';
    try {
      const j = await syncJobs({ sh, meta, state, token, tz, records, fetchedJobs: touchedJobs, since, deadline: deadline - 20000, allJobs: Boolean(opts.allJobs) });
      out.jobs = { reloaded: j.reloaded, rows: j.rows, excluded: j.excluded, pending: j.pending, payoutRows: j.payoutRows, budgetRowsAdded: j.budgetRowsAdded };
      out.notes.push(...j.notes);
      if (j.pending) out.notes.push(`${j.pending} jobs still to load - they continue on the next run.`);
      if (j.notes.some((x) => x.startsWith('WARNING'))) status = 'WARN';
    } catch (e) {
      status = 'WARN';
      out.notes.push(`Jobs step failed: ${String(e.message || e).slice(0, 250)}`);
    }

    if (advance) state.set('last_sync_started', t0);
    state.set('lock_until', 0);
    await state.save();
    await sh.append(`${q(TAB.log)}!A:I`, [[new Date().toISOString(), status, out.mode, out.fetched, out.added, out.updated, out.flagged, Math.round((Date.now() - t0) / 1000), out.notes.join(' | ')]]);
    return { ok: true, ...out, seconds: Math.round((Date.now() - t0) / 1000) };
  } catch (e) {
    try {
      state.set('lock_until', 0);
      await state.save();
      await sh.append(`${q(TAB.log)}!A:I`, [[new Date().toISOString(), 'ERROR', out.mode, '', '', '', '', Math.round((Date.now() - t0) / 1000), String(e.message || e).slice(0, 400)]]);
    } catch { /* best effort */ }
    throw e;
  }
}
