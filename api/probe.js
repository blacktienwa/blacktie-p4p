import { safeEqual } from '../lib/crypto.js';
import { send, params } from '../lib/http.js';
import { sheetsApi } from '../lib/google.js';
import { ensureTabs, State } from '../lib/tabs.js';
import { getAccessToken, gql } from '../lib/jobber.js';

// Diagnostic: lists the field names Jobber's API offers on a few record types. Shows names only, no business data.
// Open /api/probe?key=SETUP_KEY   (optionally &types=Job,Invoice)
const typeName = (t) => (t ? (t.name || `${t.kind === 'LIST' ? '[' : ''}${typeName(t.ofType)}${t.kind === 'LIST' ? ']' : ''}`) : '?');
const Q = `query($n:String!){ __type(name:$n){ name fields{ name args{ name } type{ kind name ofType{ kind name ofType{ kind name ofType{ kind name } } } } } enumValues{ name } inputFields{ name type{ kind name ofType{ kind name ofType{ kind name ofType{ kind name } } } } } } }`;

export default async function handler(req, res) {
  if (!safeEqual(params(req).get('key'), process.env.SETUP_KEY)) return send(res, 401, { error: 'unauthorized' });
  try {
    const sh = sheetsApi(process.env.SHEET_ID);
    await ensureTabs(sh);
    const state = await State.load(sh);
    const token = await getAccessToken(state);
    const want = (params(req).get('types') || 'Job,Invoice,PaymentRecord,JobStatusTypeEnum,InvoiceStatusTypeEnum').split(',');
    const out = {};
    for (const n of want) {
      try {
        const t = (await gql(token, Q, { n })).__type;
        out[n] = !t ? 'no such type' : t.enumValues ? t.enumValues.map((e) => e.name) : t.inputFields ? t.inputFields.map((f) => `${f.name}: ${typeName(f.type)}`) : t.fields.map((f) => `${f.name}: ${typeName(f.type)}${f.args?.length ? ` (args: ${f.args.map((a) => a.name).join(', ')})` : ''}`);
      } catch (e) { out[n] = `error: ${String(e.message).slice(0, 200)}`; }
    }
    send(res, 200, out);
  } catch (e) { send(res, 500, { error: String(e.message || e) }); }
}
