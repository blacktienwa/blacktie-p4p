export function send(res, code, body, type = 'application/json') {
  res.statusCode = code;
  res.setHeader('content-type', `${type}; charset=utf-8`);
  res.setHeader('cache-control', 'no-store');
  res.end(type === 'application/json' ? JSON.stringify(body, null, 2) : body);
}

export const params = (req) => new URL(req.url, 'http://localhost').searchParams;

export const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function page(title, body) {
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title>
<style>body{font:16px/1.5 system-ui,sans-serif;max-width:34rem;margin:3rem auto;padding:0 1rem;color:#1a1a1a}code{background:#f2f2f2;padding:.1em .3em;border-radius:4px}</style>
<h1>${escapeHtml(title)}</h1>${body}`;
}

export async function alertFailure(message) {
  const url = process.env.ALERT_WEBHOOK_URL;
  if (!url) return;
  try {
    await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: `Black Tie P4P sync failed: ${message}` }) });
  } catch { /* nothing more to do */ }
}
