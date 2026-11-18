// Match Employees-tab names to Jobber user IDs (only users who actually clocked time).
export const JOBBER_ID_PREFIX = 'Z2lkOi8vSm9iYmVyL1VzZXIv'; // base64 of gid://Jobber/User/

// Employee-tab name -> name used in Jobber, where they differ (normalized, letters only)
const ALIASES = {
  michaelmadden: 'michaelmaddan',
  samgil: 'samuelgil',
};

export const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z]/g, '');
export const isJobberId = (v) => typeof v === 'string' && v.startsWith(JOBBER_ID_PREFIX);

// employees: [{row, name, current}], users: Map(id -> jobberName)
export function autoMap(employees, users) {
  const updates = [];
  const unmatched = [];
  for (const e of employees) {
    if (!e.name || isJobberId(e.current)) continue;
    const want = new Set([norm(e.name), ALIASES[norm(e.name)]].filter(Boolean));
    const hits = [...users].filter(([, name]) => want.has(norm(name)));
    if (hits.length === 1) updates.push({ row: e.row, id: hits[0][0], name: e.name });
    else unmatched.push(`${e.name} (${hits.length ? 'several Jobber users share this name' : 'no time entries seen yet'})`);
  }
  return { updates, unmatched };
}
