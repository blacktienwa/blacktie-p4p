export const TAB = {
  time: 'Jobber Time',
  users: 'Jobber Users',
  emp: 'Employees',
  state: 'Sync State',
  log: 'Sync Log',
  jobs: 'Jobber Jobs',
  budgets: 'Job Budgets',
  payouts: 'Job Payouts',
  periods: 'Payroll Periods',
  results: 'Results',
  settings: 'Settings',
  history: 'Payroll History',
  ledger: 'Bank Ledger',
  payHist: 'Payout History',
  preview: 'Dashboard Preview',
  access: 'Dashboard Access',
  cards: 'Cards',
};

const NEW_TABS = [
  { title: TAB.state, headers: ['Key', 'Value (tokens are encrypted - do not edit)'] },
  { title: TAB.log, headers: ['Time (UTC)', 'Status', 'Mode', 'Entries fetched', 'New', 'Updated', 'Flagged (over limit)', 'Seconds', 'Notes'] },
  { title: TAB.payHist, headers: ['Jobber Job #', 'Employee', 'Payroll Period', 'Budget Hours', 'Job Pool ($)', 'Employee Hours on Job', 'Total Hours on Job', 'Share of Hours', 'P4P Rate', 'P4P Earned ($)', 'Cards on Job ($)', 'Net P4P ($)', 'Flag', 'Frozen On'] },
  { title: TAB.preview, headers: ['Period ID', 'Start', 'End', 'Pay Date', 'Updated (UTC)'] },
  { title: TAB.access, headers: ['Name', 'Role', 'Link Code', 'PIN Salt', 'PIN Hash', 'Failed Tries', 'Locked Until (ms)', 'Last Login (UTC)', 'Active'] },
  { title: TAB.users, headers: ['Jobber User ID', 'Jobber Name', 'Mapped Employee', 'Hours (last 60 days)', 'Status'] },
];

// Creates the helper tabs if missing. Returns Map(title -> {sheetId, rowCount}).
export async function ensureTabs(sh) {
  let meta = await sh.meta();
  const have = new Set(meta.sheets.map((s) => s.properties.title));
  const missing = NEW_TABS.filter((t) => !have.has(t.title));
  if (missing.length) {
    await sh.batch(missing.map((t) => ({ addSheet: { properties: { title: t.title } } })));
    for (const t of missing) await sh.put(`'${t.title}'!A1`, [t.headers]);
    meta = await sh.meta();
  }
  const map = new Map();
  for (const s of meta.sheets) map.set(s.properties.title, { sheetId: s.properties.sheetId, rowCount: s.properties.gridProperties?.rowCount || 1000 });
  for (const t of [TAB.time, TAB.emp]) {
    if (!map.has(t)) throw new Error(`The sheet has no "${t}" tab. Is SHEET_ID pointing at the right file?`);
  }
  return map;
}

// Small key/value store kept in the "Sync State" tab.
export class State {
  constructor(sh) { this.sh = sh; this.m = new Map(); }
  static async load(sh) {
    const s = new State(sh);
    const rows = await sh.get(`'${TAB.state}'!A2:B200`);
    for (const r of rows) if (r[0]) s.m.set(String(r[0]), r[1] === undefined ? '' : String(r[1]));
    return s;
  }
  get(k) { return this.m.get(k); }
  set(k, v) { this.m.set(k, String(v)); }
  async save() {
    const rows = [...this.m].map(([k, v]) => [k, v]);
    await this.sh.clear(`'${TAB.state}'!A2:B200`);
    if (rows.length) await this.sh.put(`'${TAB.state}'!A2:B${rows.length + 1}`, rows);
  }
}
