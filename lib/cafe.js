// Cafeteria plan: benefit dollars earned per hour worked, split into each employee's banks (PTO, education, ...).
// Lives in its own Google Sheet (CAFE_SHEET_ID). Deposits post once per Frozen payroll period; withdrawals come
// from the office (Ledger tab) or from employee requests that the office approves (Requests tab).
import { TAB } from './tabs.js';
import { localDate, serial } from './transform.js';
import { sheetsApi } from './google.js';

export const CT = {
  settings: 'Settings',
  tiers: 'Hours Tiers',
  rates: 'Rates',
  emp: 'Employees',
  deposits: 'Deposits',
  ledger: 'Ledger',
  requests: 'Requests',
  balances: 'Balances',
};
const q = (t) => `'${t}'`;
const num = (v) => (typeof v === 'number' ? v : Number(String(v ?? '').replace(/[$,%\s]/g, '')) || 0);
const str = (v) => String(v ?? '').trim();
const norm = (v) => str(v).toLowerCase();
export const cents = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

export const DEFAULT_BANKS = ['PTO', 'Education', 'Tool Allowance', 'Health'];
export const SUBCONTRACTORS = ['Jake Welch', 'Kyle Ungerer', 'Ramon Casillas'];
export const CAFE_ONLY = ['Tyler Eldridge', 'Kat Weaver', 'Tony Spencer'];

const SETTINGS_ROWS = [
  ['Start deposits with period', '', 'First payroll period (ID from Payroll Periods) that earns deposits. Opening balances on Employees cover everything before it.'],
  ['Banks', DEFAULT_BANKS.join(', '), 'Comma-separated. After adding a bank, open the setup link again to add its columns on Employees.'],
  ['Average window (days)', 182, 'How far back the average weekly hours look (182 days = 6 months).'],
  ['Hours history starts', '', 'First date with Jobber time in the main sheet. Weeks before this date are not counted in the average.'],
];
const TIER_ROWS = [
  ['Minimum avg weekly hours', '% of $/hr rate', 'Rule: the highest row whose minimum is at or below the average (rounded to 2 decimals) applies.'],
  [0, 0.25, '25 hours or less'],
  [25.01, 0.75, 'Over 25, under 30'],
  [30, 1, '30 or more'],
];
const RATE_ROWS = [
  ['Years from', 'Years to (less than)', 'Technician $/hr', 'Mgmt $/hr (Lead Tech / PM)'],
  [0, 1, 1, 1.4], [1, 2, 1.2, 1.6], [2, 4, 1.4, 1.8], [4, 6, 1.6, 2], [6, 8, 1.8, 2.2], [8, '', 2, 2.4],
];
export const EMP_FIXED = ['Name', 'Jobber User ID', 'Role (Technician / Mgmt)', 'Hire Date', 'Eligible (Yes / No)', 'Notes'];
const DEPOSIT_HEADERS = ['Payroll Period', 'Employee', 'Hours in Period', 'Avg Weekly Hours', 'Hours Tier %', 'Role', 'Years of Service', 'Rate $/hr', 'Deposit ($)', 'Split', 'Posted (UTC)', 'Key (do not edit)'];
const LEDGER_HEADERS = ['Date', 'Employee', 'Bank', 'Type (Deposit / Withdrawal / Adjustment)', 'Amount ($)', 'Payroll Period', 'Note', 'Source', 'Key (do not edit)'];
const REQUEST_HEADERS = ['Request ID', 'Submitted (Central)', 'Employee', 'Bank', 'Amount ($)', 'Reason', 'Status (Pending / Approved / Denied)', 'Office Note', 'Posted to Ledger', 'Handled By'];

// ---------- pure helpers ----------

// A date cell as a sheet serial. Accepts serial numbers, 2024-03-15, 3/15/2024.
export function toSerial(v) {
  if (typeof v === 'number' && v > 0) return Math.floor(v);
  const s = str(v);
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(s);
  if (m) return serial(`${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`);
  m = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/.exec(s);
  if (m) { const y = m[3].length === 2 ? `20${m[3]}` : m[3]; return serial(`${y}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`); }
  return null;
}
const serialToYmd = (s) => new Date(Date.UTC(1899, 11, 30) + s * 86400000).toISOString().slice(0, 10);

// Completed years of service on a date.
export function yearsOfService(hire, asOf) {
  const [hy, hm, hd] = serialToYmd(hire).split('-').map(Number);
  const [ay, am, ad] = serialToYmd(asOf).split('-').map(Number);
  let y = ay - hy;
  if (am < hm || (am === hm && ad < hd)) y--;
  return Math.max(0, y);
}

export function roleKey(v) {
  const s = norm(v);
  if (!s) return '';
  if (/mgmt|manag|lead|pm\b|project/.test(s)) return 'mgmt';
  if (/tech/.test(s)) return 'tech';
  return '';
}

export function rateFor(rates, role, years) {
  const row = rates.find((r) => years >= r.from && (r.to === null || years < r.to));
  if (!row) return null;
  return role === 'mgmt' ? row.mgmt : row.tech;
}

export function tierFor(tiers, avg) {
  const a = Math.round(avg * 100) / 100;
  let hit = null;
  for (const t of [...tiers].sort((x, y) => x.min - y.min)) if (a >= t.min) hit = t;
  return hit ? hit.pct : 0;
}

// Average weekly hours over the window ending on `end` (inclusive). Weeks before hire or before the data starts are not counted.
export function avgWeekly(entries, end, { windowDays = 182, hire = null, dataStart = null } = {}) {
  let from = end - windowDays + 1;
  if (hire && hire > from) from = hire;
  if (dataStart && dataStart > from) from = dataStart;
  const days = end - from + 1;
  if (days <= 0) return 0;
  const total = entries.reduce((s, e) => (e.date >= from && e.date <= end ? s + e.hours : s), 0);
  return total / Math.max(1, days / 7);
}

// Split percentages for one employee: accepts 50 or 0.5 style. Returns fractions summing to 1, or an error.
export function readSplit(raw) {
  const vals = raw.map(num);
  const sum = vals.reduce((a, b) => a + b, 0);
  if (sum <= 0) return { error: 'no split % entered' };
  let fr;
  if (Math.abs(sum - 1) < 0.0005) fr = vals;
  else if (Math.abs(sum - 100) < 0.05) fr = vals.map((v) => v / 100);
  else return { error: `split adds up to ${sum <= 1.5 ? `${Math.round(sum * 1000) / 10}%` : `${Math.round(sum * 10) / 10}%`}, not 100%` };
  if (fr.some((v) => v < 0)) return { error: 'split has a negative %' };
  return { split: fr };
}

// Divides an amount into banks to the cent; any rounding cent goes to the biggest share.
export function splitAmount(amount, fractions) {
  const parts = fractions.map((f) => cents(amount * f));
  const diff = cents(amount - parts.reduce((a, b) => a + b, 0));
  if (diff) { const i = fractions.indexOf(Math.max(...fractions)); parts[i] = cents(parts[i] + diff); }
  return parts;
}

export function ledgerEffect(type, amount) {
  const t = norm(type);
  const a = num(amount);
  if (t.startsWith('withdraw')) return -Math.abs(a);
  if (t.startsWith('deposit')) return Math.abs(a);
  return a; // adjustment: signed
}

// Balances per employee per bank: opening + ledger.
export function computeBalances(plan) {
  const out = new Map();
  for (const e of plan.employees) {
    const b = new Map(plan.banks.map((k, i) => [k, num(e.opening[i])]));
    out.set(e.name, b);
  }
  for (const r of plan.ledger) {
    const b = out.get(r.employee);
    if (!b) continue;
    const bank = plan.banks.find((k) => norm(k) === norm(r.bank));
    if (!bank) continue;
    b.set(bank, cents(b.get(bank) + ledgerEffect(r.type, r.amount)));
  }
  return out;
}

export function pendingByBank(plan, name, exceptId = '') {
  const m = new Map(plan.banks.map((k) => [k, 0]));
  for (const r of plan.requests) {
    if (r.employee !== name || r.id === exceptId) continue;
    if (norm(r.status) !== 'pending' && !(norm(r.status) === 'approved' && !r.posted.startsWith('Posted'))) continue;
    const bank = plan.banks.find((k) => norm(k) === norm(r.bank));
    if (bank) m.set(bank, cents(m.get(bank) + num(r.amount)));
  }
  return m;
}

// Checks a withdrawal request before it is saved. Blocks anything over the available balance.
export function checkRequest(plan, name, { bank, amount, reason }) {
  const emp = plan.employees.find((e) => e.name === name && e.eligible);
  if (!emp) return { error: 'You are not set up in the cafeteria plan. Ask the office.' };
  const b = plan.banks.find((k) => norm(k) === norm(bank));
  if (!b) return { error: 'Pick a bank.' };
  const amt = cents(num(amount));
  if (!(amt > 0)) return { error: 'Enter an amount greater than $0.' };
  if (amt > 100000) return { error: 'That amount is too large.' };
  const why = str(reason).replace(/\s+/g, ' ');
  if (why.length < 3) return { error: 'Add a short reason (for example, the dates for PTO or the class name).' };
  const open = plan.requests.filter((r) => r.employee === name && norm(r.status) === 'pending').length;
  if (open >= 5) return { error: 'You already have 5 requests waiting. Wait for the office to handle those first.' };
  const balance = computeBalances(plan).get(name)?.get(b) ?? 0;
  const held = pendingByBank(plan, name).get(b) || 0;
  const available = cents(balance - held);
  if (amt > available + 0.001) return { error: `Your ${b} bank has ${fmt(available)} available${held ? ` (${fmt(held)} is already requested)` : ''}. Request ${fmt(available)} or less.`, available };
  return { ok: true, bank: b, amount: amt, reason: why.slice(0, 300) };
}
const fmt = (n) => `$${(Math.round(n * 100) / 100).toFixed(2)}`;

// One deposit for one person and one frozen period. Returns { deposit } or { skip: reason }.
export function computeDeposit(plan, emp, period, entries, opts = {}) {
  if (!emp.eligible) return { skip: 'not eligible' };
  const role = roleKey(emp.role);
  if (!role) return { skip: `${emp.name}: Role is blank or not Technician / Mgmt` };
  const hire = toSerial(emp.hire);
  if (!hire) return { skip: `${emp.name}: Hire Date is blank or not a date` };
  if (hire > period.end) return { skip: 'hired after period' };
  const sp = readSplit(emp.split);
  if (sp.error) return { skip: `${emp.name}: ${sp.error}` };
  if (!emp.userId) return { skip: `${emp.name}: no Jobber User ID, so no hours can be counted` };
  const mine = entries.filter((e) => e.userId === emp.userId);
  const hours = mine.reduce((s, e) => (e.date >= period.start && e.date <= period.end ? s + e.hours : s), 0);
  const avg = avgWeekly(mine, period.end, { windowDays: plan.windowDays, hire, dataStart: opts.dataStart || plan.dataStart });
  const pct = tierFor(plan.tiers, avg);
  const years = yearsOfService(hire, period.end);
  const rate = rateFor(plan.rates, role, years);
  if (rate === null) return { skip: `${emp.name}: no rate row for ${years} years` };
  const amount = cents(hours * rate * pct);
  return { deposit: { period: period.id, employee: emp.name, hours: Math.round(hours * 100) / 100, avg: Math.round(avg * 100) / 100, pct, role: role === 'mgmt' ? 'Mgmt' : 'Technician', years, rate, amount, parts: splitAmount(amount, sp.split) } };
}

// ---------- sheet IO ----------

export const cafeSheet = () => (process.env.CAFE_SHEET_ID ? sheetsApi(process.env.CAFE_SHEET_ID) : null);

export async function loadPlan(cs) {
  const g = (r) => cs.get(r);
  const [settings, tiers, rates, emp, deposits, ledger, requests] = await Promise.all([
    g(`${q(CT.settings)}!A2:B20`), g(`${q(CT.tiers)}!A2:B20`), g(`${q(CT.rates)}!A2:D20`), g(`${q(CT.emp)}!A1:AZ200`),
    g(`${q(CT.deposits)}!A2:L20000`), g(`${q(CT.ledger)}!A2:I20000`), g(`${q(CT.requests)}!A2:J5000`),
  ]);
  const set = new Map(settings.filter((r) => r[0]).map((r) => [norm(r[0]), r[1]]));
  const banks = str(set.get('banks') || DEFAULT_BANKS.join(',')).split(',').map((s) => s.trim()).filter(Boolean);
  const head = (emp[0] || []).map(str);
  const col = (h) => head.findIndex((x) => norm(x) === norm(h));
  const splitCols = banks.map((b) => col(`${b} split %`));
  const openCols = banks.map((b) => col(`${b} opening $`));
  const employees = emp.slice(1).map((r, i) => ({
    row: i + 2,
    name: str(r[0]), userId: str(r[1]), role: str(r[2]), hire: r[3], eligible: norm(r[4]) === 'yes', notes: str(r[5]),
    split: splitCols.map((c) => (c < 0 ? '' : r[c])), opening: openCols.map((c) => (c < 0 ? 0 : num(r[c]))),
  })).filter((e) => e.name);
  return {
    startPeriod: str(set.get('start deposits with period')),
    windowDays: num(set.get('average window (days)')) || 182,
    dataStart: toSerial(set.get('hours history starts')),
    banks,
    missingColumns: banks.filter((b, i) => splitCols[i] < 0 || openCols[i] < 0),
    tiers: tiers.filter((r) => r[0] !== undefined && r[0] !== '' && r[1] !== undefined && r[1] !== '').map((r) => ({ min: num(r[0]), pct: num(r[1]) > 1 ? num(r[1]) / 100 : num(r[1]) })),
    rates: rates.filter((r) => r[0] !== undefined && r[0] !== '').map((r) => ({ from: num(r[0]), to: r[1] === '' || r[1] === undefined ? null : num(r[1]), tech: num(r[2]), mgmt: num(r[3]) })),
    employees,
    deposits: deposits.filter((r) => r[0]).map((r) => ({ period: str(r[0]), employee: str(r[1]), hours: num(r[2]), avg: num(r[3]), pct: num(r[4]), role: str(r[5]), years: num(r[6]), rate: num(r[7]), amount: num(r[8]), posted: str(r[10]), key: str(r[11]) })),
    ledger: ledger.map((r, i) => ({ row: i + 2, date: r[0], employee: str(r[1]), bank: str(r[2]), type: str(r[3]), amount: r[4], period: str(r[5]), note: str(r[6]), source: str(r[7]), key: str(r[8]) })).filter((r) => r.employee && r.bank),
    requests: requests.map((r, i) => ({ row: i + 2, id: str(r[0]), submitted: str(r[1]), employee: str(r[2]), bank: str(r[3]), amount: num(r[4]), reason: str(r[5]), status: str(r[6]) || 'Pending', officeNote: str(r[7]), posted: str(r[8]), handledBy: str(r[9]) })).filter((r) => r.id),
  };
}

async function readEntries(sh) {
  const rows = await sh.get(`${q(TAB.time)}!B2:E`);
  return rows.filter((r) => typeof r[0] === 'number' && r[1]).map((r) => ({ date: r[0], userId: String(r[1]), hours: num(r[3]) }));
}
async function readPeriods(sh) {
  return (await sh.get(`${q(TAB.periods)}!A2:E60`)).filter((r) => r[0]).map((r) => ({ id: str(r[0]), start: num(r[1]), end: num(r[2]), pay: num(r[3]), status: norm(r[4]) }));
}

// Builds the tabs (safe to run again: it only adds what is missing) and pre-fills employees on the first run.
export async function setupCafe(sh, cs) {
  const notes = [];
  const meta = await cs.meta();
  const have = new Set(meta.sheets.map((s) => s.properties.title));
  const want = Object.values(CT).filter((t) => !have.has(t));
  if (want.length) await cs.batch(want.map((title) => ({ addSheet: { properties: { title } } })));
  const fresh = new Set(want);
  const periods = await readPeriods(sh);

  if (fresh.has(CT.settings)) {
    const next = periods.filter((p) => p.status !== 'frozen' && p.status !== 'skipped').sort((a, b) => a.start - b.start)[0];
    const rows = SETTINGS_ROWS.map((r) => [...r]);
    rows[0][1] = next?.id || '';
    rows[3][1] = process.env.BACKFILL_START || '2026-08-01';
    await cs.put(`${q(CT.settings)}!A1:C${rows.length + 1}`, [['Setting', 'Value', 'What it does'], ...rows]);
    notes.push(`Deposits start with ${next?.id || '(set this on Settings)'}.`);
  }
  if (fresh.has(CT.tiers)) await cs.put(`${q(CT.tiers)}!A1:C${TIER_ROWS.length}`, TIER_ROWS);
  if (fresh.has(CT.rates)) await cs.put(`${q(CT.rates)}!A1:D${RATE_ROWS.length}`, RATE_ROWS);
  if (fresh.has(CT.deposits)) await cs.put(`${q(CT.deposits)}!A1:L1`, [DEPOSIT_HEADERS]);
  if (fresh.has(CT.ledger)) await cs.put(`${q(CT.ledger)}!A1:I1`, [LEDGER_HEADERS]);
  if (fresh.has(CT.requests)) await cs.put(`${q(CT.requests)}!A1:J1`, [REQUEST_HEADERS]);

  // Employees: fixed columns, then "<bank> split %" and "<bank> opening $" for every bank
  const plan0 = await loadPlan(cs);
  const head = ((await cs.get(`${q(CT.emp)}!A1:AZ1`))[0] || []).map(str);
  const base = head.length ? head : [...EMP_FIXED];
  const add = [];
  for (const b of plan0.banks) for (const h of [`${b} split %`, `${b} opening $`]) if (!base.some((x) => norm(x) === norm(h))) add.push(h);
  if (!head.length || add.length) {
    const full = [...base, ...add];
    await cs.put(`${q(CT.emp)}!A1:${colName(full.length - 1)}1`, [full]);
    if (add.length) notes.push(`Added Employees columns: ${add.join(', ')}.`);
  }

  if (!plan0.employees.length) {
    const people = await suggestEmployees(sh);
    if (people.length) {
      await cs.put(`${q(CT.emp)}!A2:F${people.length + 1}`, people.map((p) => [p.name, p.userId, '', '', p.eligible ? 'Yes' : 'No', p.note]));
      notes.push(`Listed ${people.length} people on Employees. Fill in Role, Hire Date, split % and opening $ for each.`);
    }
  }
  await writeBalances(cs, await loadPlan(cs));
  return { notes };
}

const colName = (i) => { let s = ''; i += 1; while (i) { const m = (i - 1) % 26; s = String.fromCharCode(65 + m) + s; i = Math.floor((i - 1) / 26); } return s; };

// Everyone from the main sheet's Employees tab and Jobber Users tab, plus the cafeteria-only staff.
async function suggestEmployees(sh) {
  const [emp, users] = await Promise.all([sh.get(`${q(TAB.emp)}!A2:B60`), sh.get(`${q(TAB.users)}!A2:C500`)]);
  const out = new Map();
  const same = (a, b) => norm(a).replace(/\s+/g, ' ') === norm(b).replace(/\s+/g, ' ');
  const isSub = (...names) => SUBCONTRACTORS.some((s) => names.some((n) => n && same(n, s)));
  for (const r of emp) if (r[0]) out.set(str(r[0]), { name: str(r[0]), userId: str(r[1]), jobberName: '' });
  for (const r of users) {
    if (!r[0]) continue;
    const mapped = str(r[2]);
    const name = mapped && out.has(mapped) ? mapped : str(r[1]);
    const cur = out.get(name) || { name, userId: '', jobberName: '' };
    if (!cur.userId) cur.userId = str(r[0]);
    cur.jobberName = str(r[1]);
    out.set(name, cur);
  }
  for (const n of CAFE_ONLY) if (![...out.values()].some((p) => same(p.name, n) || same(p.jobberName, n))) out.set(n, { name: n, userId: '', jobberName: '' });
  return [...out.values()].map((p) => {
    const sub = isSub(p.name, p.jobberName);
    const cafeOnly = CAFE_ONLY.some((n) => same(n, p.name) || same(n, p.jobberName));
    const note = sub ? 'Subcontractor - no cafeteria plan' : cafeOnly ? `No P4P - cafeteria plan only${p.userId ? '' : '. Add their Jobber User ID if they clock time in Jobber'}` : '';
    return { ...p, eligible: !sub, note };
  }).sort((a, b) => a.name.localeCompare(b.name));
}

async function writeBalances(cs, plan) {
  const bal = computeBalances(plan);
  const rows = plan.employees.filter((e) => e.eligible).map((e) => {
    const b = bal.get(e.name);
    const pend = pendingByBank(plan, e.name);
    const vals = plan.banks.map((k) => b.get(k));
    return [e.name, ...vals, cents(vals.reduce((s, v) => s + v, 0)), cents([...pend.values()].reduce((s, v) => s + v, 0))];
  });
  const head = ['Employee', ...plan.banks, 'Total', 'Requested (not yet posted)'];
  const last = colName(head.length - 1);
  await cs.clear(`${q(CT.balances)}!A1:Z300`);
  await cs.put(`${q(CT.balances)}!A1:${last}${rows.length + 1}`, [head, ...rows]);
  await cs.put(`${q(CT.balances)}!${colName(head.length + 1)}1`, [[`Updated ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC. Opening $ (Employees) + Ledger. Do not edit; this tab is rewritten every sync.`]]);
}

// Runs during every sync: posts deposits for frozen periods, posts approved requests, refreshes Balances.
export async function runCafe({ sh, cs = cafeSheet(), now = Date.now() }) {
  if (!cs) return { notes: [] };
  const notes = [];
  let warn = false;
  const plan = await loadPlan(cs);
  if (plan.missingColumns.length) { notes.push(`WARNING: cafeteria plan Employees tab is missing columns for ${plan.missingColumns.join(', ')}. Open the cafeteria setup link to add them.`); warn = true; }
  const stamp = new Date(now).toISOString();
  const today = serial(localDate(stamp, process.env.TIMEZONE || 'America/Chicago'));

  // 1. Deposits
  const periods = await readPeriods(sh);
  const start = periods.find((p) => p.id === plan.startPeriod);
  if (!plan.startPeriod || !start) {
    notes.push(`WARNING: cafeteria plan Settings "Start deposits with period" ${plan.startPeriod ? `(${plan.startPeriod}) is not on Payroll Periods` : 'is blank'}; no deposits posted.`);
    warn = true;
  } else {
    const frozen = periods.filter((p) => p.status === 'frozen' && p.start >= start.start).sort((a, b) => a.start - b.start);
    const done = new Set(plan.deposits.map((d) => d.key));
    const todo = [];
    for (const p of frozen) for (const e of plan.employees) if (e.eligible && !done.has(`${p.id}|${e.name}`)) todo.push([p, e]);
    if (todo.length) {
      const entries = await readEntries(sh);
      const depRows = [];
      const ledRows = [];
      const skips = [];
      for (const [p, e] of todo) {
        const r = computeDeposit(plan, e, p, entries);
        if (r.skip) { if (r.skip !== 'not eligible' && r.skip !== 'hired after period') skips.push(r.skip); continue; }
        const d = r.deposit;
        const split = plan.banks.map((b, i) => `${b} ${fmt(d.parts[i])}`).join(', ');
        depRows.push([d.period, d.employee, d.hours, d.avg, d.pct, d.role, d.years, d.rate, d.amount, split, stamp, `${p.id}|${e.name}`]);
        plan.banks.forEach((b, i) => { if (d.parts[i]) ledRows.push([today, d.employee, b, 'Deposit', d.parts[i], d.period, `${d.hours} hrs x $${d.rate}/hr x ${Math.round(d.pct * 100)}%`, 'auto', `DEP|${p.id}|${e.name}|${b}`]); });
      }
      // Ledger first, then Deposits: a run that stops halfway is repaired by the key check below.
      const haveKeys = new Set(plan.ledger.map((l) => l.key));
      const newLed = ledRows.filter((r) => !haveKeys.has(r[8]));
      if (newLed.length) await cs.append(`${q(CT.ledger)}!A:I`, newLed);
      if (depRows.length) await cs.append(`${q(CT.deposits)}!A:L`, depRows);
      for (const r of newLed) plan.ledger.push({ employee: r[1], bank: r[2], type: r[3], amount: r[4], key: r[8] });
      if (depRows.length) notes.push(`Cafeteria plan: posted ${depRows.length} deposit(s) totaling ${fmt(depRows.reduce((s, r) => s + r[8], 0))} for ${[...new Set(depRows.map((r) => r[0]))].join(', ')}.`);
      const uniq = [...new Set(skips)];
      if (uniq.length) { notes.push(`WARNING: cafeteria plan deposits waiting on setup: ${uniq.slice(0, 8).join('; ')}${uniq.length > 8 ? `; and ${uniq.length - 8} more` : ''}.`); warn = true; }
    }
  }

  // 2. Approved requests -> withdrawals (re-checked against the balance at posting time)
  const haveKeys = new Set(plan.ledger.map((l) => l.key));
  for (const r of plan.requests) {
    if (norm(r.status) !== 'approved' || r.posted.startsWith('Posted')) continue;
    const key = `REQ|${r.id}`;
    if (haveKeys.has(key)) { await cs.put(`${q(CT.requests)}!I${r.row}`, [[`Posted ${stamp.slice(0, 10)}`]]); r.posted = 'Posted'; continue; }
    const bank = plan.banks.find((k) => norm(k) === norm(r.bank));
    const bal = bank ? computeBalances(plan).get(r.employee)?.get(bank) : undefined;
    if (bal === undefined) { await cs.put(`${q(CT.requests)}!I${r.row}`, [['NOT POSTED - unknown employee or bank']]); continue; }
    if (r.amount > bal + 0.001) { await cs.put(`${q(CT.requests)}!I${r.row}`, [[`NOT POSTED - ${bank} balance is only ${fmt(bal)}`]]); notes.push(`WARNING: approved request ${r.id} (${r.employee}) is more than the ${bank} balance; not posted.`); warn = true; continue; }
    const row = [today, r.employee, bank, 'Withdrawal', r.amount, '', `Request ${r.id}: ${r.reason}`.slice(0, 300), `request${r.handledBy ? ` (${r.handledBy})` : ''}`, key];
    await cs.append(`${q(CT.ledger)}!A:I`, [row]);
    plan.ledger.push({ employee: r.employee, bank, type: 'Withdrawal', amount: r.amount, key });
    await cs.put(`${q(CT.requests)}!I${r.row}`, [[`Posted ${stamp.slice(0, 10)}`]]);
    r.posted = 'Posted';
    notes.push(`Cafeteria plan: posted approved request ${r.id} (${r.employee}, ${bank}, ${fmt(r.amount)}).`);
  }
  const pending = plan.requests.filter((r) => norm(r.status) === 'pending').length;
  if (pending) notes.push(`Cafeteria plan: ${pending} withdrawal request(s) waiting on the Requests tab.`);

  await writeBalances(cs, plan);
  return { notes, warn };
}

// Saves an employee's request (after checkRequest passed).
export async function saveRequest(cs, name, req, now = Date.now()) {
  const id = `R${new Date(now).toISOString().slice(2, 10).replace(/-/g, '')}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
  const when = new Date(now).toLocaleString('en-US', { timeZone: 'America/Chicago', month: 'numeric', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
  await cs.append(`${q(CT.requests)}!A:J`, [[id, when, name, req.bank, req.amount, req.reason, 'Pending', '', '', '']]);
  return id;
}

// Everything one person may see about their own plan.
export function buildCafeView(plan, name, periods = []) {
  const emp = plan?.employees.find((e) => e.name === name);
  if (!emp || !emp.eligible) return null;
  const bal = computeBalances(plan).get(name);
  const pend = pendingByBank(plan, name);
  const banks = plan.banks.map((b) => ({ name: b, balance: bal.get(b), pending: pend.get(b) || 0, available: cents(bal.get(b) - (pend.get(b) || 0)) }));
  const mine = plan.deposits.filter((d) => d.employee === name);
  const order = new Map(periods.map((p) => [p.id, p.start]));
  mine.sort((a, b) => (order.get(b.period) || 0) - (order.get(a.period) || 0));
  const last = mine[0] || null;
  const lastPeriod = last ? periods.find((p) => p.id === last.period) || { id: last.period } : null;
  return {
    banks,
    total: cents(banks.reduce((s, b) => s + b.balance, 0)),
    last: last ? { ...last, period: lastPeriod } : null,
    requests: plan.requests.filter((r) => r.employee === name).slice(-8).reverse(),
    activity: plan.ledger.filter((r) => r.employee === name).slice(-10).reverse().map((r) => ({ date: toSerial(r.date), bank: r.bank, type: r.type, amount: ledgerEffect(r.type, r.amount), note: r.note })),
  };
}

let cache = null;
export async function loadPlanCached(cs, now = Date.now(), ttlMs = 60000) {
  if (!cs) return null;
  if (cache && now - cache.at < ttlMs) return cache.plan;
  const plan = await loadPlan(cs);
  cache = { at: now, plan };
  return plan;
}
export const clearPlanCache = () => { cache = null; };
