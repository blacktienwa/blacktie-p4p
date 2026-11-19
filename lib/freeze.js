// Freezing a payroll period: copies its results into Payroll History, Bank Ledger and Payout History as plain values.
// Nothing is frozen unless the office types "Freeze" in the period's Status cell (Payroll Periods column E).
import { TAB } from './tabs.js';
import { localDate, serial } from './transform.js';
import { LAST_ROW } from './layout.js';

const q = (t) => `'${t}'`;
const norm = (v) => String(v ?? '').trim().toLowerCase();
const DONE = new Set(['frozen', 'skipped']);
const num = (v) => (typeof v === 'number' ? v : Number(v) || 0);

async function readPeriods(sh) {
  return (await sh.get(`${q(TAB.periods)}!A2:F60`))
    .map((r, i) => ({ row: i + 2, id: String(r[0] || ''), start: num(r[1]), end: num(r[2]), pay: num(r[3]), status: norm(r[4]) }))
    .filter((p) => p.id);
}

// Approved jobs that point at a period that is already frozen or skipped will never be paid. Report them.
export async function checkLateApprovals(sh) {
  const periods = await readPeriods(sh);
  const closed = new Set(periods.filter((p) => DONE.has(p.status)).map((p) => p.id));
  if (!closed.size) return [];
  const jobs = await sh.get(`${q(TAB.jobs)}!A2:O${LAST_ROW}`);
  const notes = [];
  const bad = jobs.filter((r) => r[0] && norm(r[13]) === 'approved' && closed.has(String(r[7] || '')));
  if (bad.length) notes.push(`WARNING: ${bad.length} approved job(s) point at a frozen or skipped period and will not be paid: ${bad.slice(0, 10).map((r) => `${r[0]} (${r[7]})`).join(', ')}. Change the job's period override in Job Budgets column G.`);
  return notes;
}

export async function freezeRequested({ sh, now }) {
  const notes = [];
  const frozen = [];
  const periods = await readPeriods(sh);
  const requests = periods.filter((p) => p.status === 'freeze').sort((a, b) => a.start - b.start);
  if (!requests.length) return { notes, frozen, warn: false };
  const today = serial(localDate(new Date(now || Date.now()).toISOString(), 'America/Chicago'));
  let warn = false;

  for (const p of requests) {
    const blockers = [];
    for (const e of periods) if (e.start < p.start && !DONE.has(e.status) && e.id !== p.id) blockers.push(`earlier period ${e.id} is still ${e.status || 'blank'} (set it to Frozen or Skipped, or freeze it first)`);

    // Completed-and-paid jobs in this period that nobody approved or put on hold
    const jobs = await sh.get(`${q(TAB.jobs)}!A2:O${LAST_ROW}`);
    const unreviewed = jobs.filter((r) => r[0] && typeof r[6] === 'number' && r[6] >= p.start && r[6] <= p.end && norm(r[13]) !== 'approved' && norm(r[13]) !== 'hold' && norm(r[13]) !== 'excluded');
    if (unreviewed.length) blockers.push(`${unreviewed.length} job(s) paid in this period are still Pending (approve, Hold or Exclude): ${unreviewed.slice(0, 10).map((r) => r[0]).join(', ')}`);

    // This period's payout rows: no missing budget hours, nothing already paid in another period
    const payRows = (await sh.get(`${q(TAB.payouts)}!A2:M${LAST_ROW}`)).filter((r) => r[0] && String(r[2] || '') === p.id);
    const noBh = [...new Set(payRows.filter((r) => String(r[12] || '').startsWith('NO BUDGET')).map((r) => r[0]))];
    if (noBh.length) blockers.push(`approved job(s) with no budget hours would pay $0: ${noBh.slice(0, 10).join(', ')}`);
    const hist = await sh.get(`${q(TAB.payHist)}!A2:C5000`);
    const paidBefore = new Set(hist.filter((r) => r[0] && String(r[2]) !== p.id).map((r) => `${r[0]}`));
    const twice = [...new Set(payRows.filter((r) => paidBefore.has(String(r[0]))).map((r) => r[0]))];
    if (twice.length) blockers.push(`job(s) already paid in an earlier period: ${twice.slice(0, 10).join(', ')}`);

    if (blockers.length) {
      notes.push(`WARNING: cannot freeze ${p.id}: ${blockers.join('; ')}.`);
      warn = true;
      break; // later periods depend on this one
    }

    // Take the results of this period: point Settings at it, read Results, and always put Settings back.
    const original = (await sh.get(`${q(TAB.settings)}!B8`))[0]?.[0];
    let results;
    let unknownHours = 0;
    try {
      await sh.put(`${q(TAB.settings)}!B8`, [[p.id]]);
      const head = String((await sh.get(`${q(TAB.results)}!A2`))[0]?.[0] || '');
      if (!head.includes(p.id)) throw new Error(`Results tab shows "${head.slice(0, 40)}" instead of ${p.id}`);
      results = await sh.get(`${q(TAB.results)}!A5:Q29`);
      unknownHours = num((await sh.get(`${q(TAB.results)}!E34`))[0]?.[0]);
    } catch (e) {
      notes.push(`WARNING: cannot freeze ${p.id}: ${e.message}.`);
      warn = true;
      break;
    } finally {
      if (original !== undefined) await sh.put(`${q(TAB.settings)}!B8`, [[original]]);
    }

    const people = results.filter((r) => r[0]).map((r) => Array.from({ length: 17 }, (_, i) => r[i] ?? ''));
    if (!people.length) { notes.push(`WARNING: cannot freeze ${p.id}: Results is empty.`); warn = true; break; }
    if (people.some((r) => r.slice(1).some((v) => typeof v === 'string' && v.startsWith('#')))) { notes.push(`WARNING: cannot freeze ${p.id}: Results has formula errors.`); warn = true; break; }

    // Write history (skipping anything already written by a run that stopped halfway)
    const doneHist = new Set((await sh.get(`${q(TAB.history)}!A2:A5000`)).map((r) => String(r[0])));
    if (!doneHist.has(p.id)) await sh.append(`${q(TAB.history)}!A:T`, people.map((r) => [p.id, p.pay, today, ...r]));
    const doneLedger = new Set((await sh.get(`${q(TAB.ledger)}!A2:A5000`)).map((r) => String(r[0])));
    if (!doneLedger.has(p.id)) await sh.append(`${q(TAB.ledger)}!A:G`, people.map((r) => [p.id, p.pay, r[0], r[9], r[11], r[12], r[15]]));
    const donePay = new Set((await sh.get(`${q(TAB.payHist)}!C2:C5000`)).map((r) => String(r[0])));
    if (!donePay.has(p.id) && payRows.length) await sh.append(`${q(TAB.payHist)}!A:N`, payRows.map((r) => [...Array.from({ length: 13 }, (_, i) => r[i] ?? ''), today]));

    await sh.put(`${q(TAB.periods)}!E${p.row}:F${p.row}`, [['Frozen', today]]);
    p.status = 'frozen';
    frozen.push(p.id);
    notes.push(`Froze ${p.id} (${people.length} employees, ${payRows.length} job rows).`);
    if (unknownHours > 0.0001) { notes.push(`WARNING: ${p.id} had ${unknownHours.toFixed(2)} hours from Jobber users who are not on the Employees tab (not included in anyone's pay).`); warn = true; }
  }
  return { notes, frozen, warn };
}
