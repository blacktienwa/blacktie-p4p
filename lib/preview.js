// Snapshot of the Results tab for the upcoming payroll period, written as plain values for the dashboard.
// Money math stays in the sheet's formulas; the dashboard only reads this copy.
import { TAB } from './tabs.js';

const q = (t) => `'${t}'`;
const norm = (v) => String(v ?? '').trim().toLowerCase();
const num = (v) => (typeof v === 'number' ? v : Number(v) || 0);

export async function writePreview({ sh, now }) {
  const periods = (await sh.get(`${q(TAB.periods)}!A2:F60`))
    .map((r) => ({ id: String(r[0] || ''), start: num(r[1]), end: num(r[2]), pay: num(r[3]), status: norm(r[4]) }))
    .filter((p) => p.id && (p.status === 'open' || p.status === 'freeze'))
    .sort((a, b) => a.start - b.start);
  const p = periods[0];
  if (!p) {
    await sh.clear(`${q(TAB.preview)}!A2:Z60`);
    return { notes: ['No open payroll period for the dashboard preview.'] };
  }

  const original = (await sh.get(`${q(TAB.settings)}!B8`))[0]?.[0];
  let results;
  try {
    await sh.put(`${q(TAB.settings)}!B8`, [[p.id]]);
    const head = String((await sh.get(`${q(TAB.results)}!A2`))[0]?.[0] || '');
    if (!head.includes(p.id)) throw new Error(`Results tab shows "${head.slice(0, 40)}" instead of ${p.id}`);
    results = await sh.get(`${q(TAB.results)}!A4:Q29`);
  } finally {
    if (original !== undefined) await sh.put(`${q(TAB.settings)}!B8`, [[original]]);
  }
  const header = Array.from({ length: 17 }, (_, i) => results[0]?.[i] ?? '');
  const people = results.slice(1).filter((r) => r[0]).map((r) => Array.from({ length: 17 }, (_, i) => r[i] ?? ''));
  await sh.clear(`${q(TAB.preview)}!A2:Z60`);
  await sh.put(`${q(TAB.preview)}!A1:E2`, [['Period ID', 'Start', 'End', 'Pay Date', 'Updated (UTC)'], [p.id, p.start, p.end, p.pay, new Date(now || Date.now()).toISOString()]]);
  await sh.put(`${q(TAB.preview)}!A4:Q${4 + people.length}`, [header, ...people]);
  return { notes: [], period: p.id, people: people.length };
}
