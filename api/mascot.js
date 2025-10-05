// /api/mascot.js
export const config = { runtime: 'edge' }; // use Node runtime if you prefer

/* ----------------------------- Follow-up template --------------------------- */
const FOLLOWUP_INSTRUCTIONS = `
FOLLOW-UP MODE:
Return ONLY these two sections using markdown headings:
## Why this matters
<≤120 words in plain English>

## Sources
- [Readable title 1](https://valid.au.url/...)
- [Readable title 2](https://valid.au.url/...)
(3–5 items, markdown links only)

End with: "Information only — not a medical diagnosis. In an emergency call 000."
`;

/* ----------------------------- Link check cache ----------------------------- */
const LINK_CACHE = new Map(); // key=url, value={ ok:boolean, until:number }
const LINK_TTL_MS = 24 * 60 * 60 * 1000; // 24h

function cacheGet(url) {
  const hit = LINK_CACHE.get(url);
  if (!hit) return null;
  if (Date.now() > hit.until) { LINK_CACHE.delete(url); return null; }
  return hit.ok;
}
function cacheSet(url, ok) {
  LINK_CACHE.set(url, { ok, until: Date.now() + LINK_TTL_MS });
}

/* ----------------------------- HTTP helpers -------------------------------- */
async function fetchWithTimeout(url, opts = {}, timeoutMs = 4000) {
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort('timeout'), timeoutMs);
  try {
    return await fetch(url, { ...opts, signal: ctrl.signal, redirect: 'follow' });
  } finally {
    clearTimeout(to);
  }
}

/* --------------------------- (Optional) AU domain gate ---------------------- */
// Toggle to true to only allow .gov.au / .org.au external links
const LIMIT_TO_AU_PUBLIC = false;
function allowDomain(url) {
  try {
    const u = new URL(url);
    return u.hostname.endsWith('.gov.au') || u.hostname.endsWith('.org.au');
  } catch { return false; }
}

/* --------------------------- Validate external links ------------------------ */
async function checkUrlOK(url) {
  const c = cacheGet(url);
  if (typeof c === 'boolean') return c;

  // HEAD (cheap). Some sites block HEAD -> fallback to GET.
  try {
    const head = await fetchWithTimeout(url, { method: 'HEAD' }, 4000);
    if (head.ok) { cacheSet(url, true); return true; }
  } catch { /* ignore */ }

  try {
    const get = await fetchWithTimeout(url, { method: 'GET' }, 5000);
    const ok = get.ok;
    cacheSet(url, ok);
    return ok;
  } catch {
    cacheSet(url, false);
    return false;
  }
}

async function validateSources(sources) {
  const out = [];
  for (const s of sources || []) {
    if (s.url) {
      if (LIMIT_TO_AU_PUBLIC && !allowDomain(s.url)) {
        out.push({ title: (s.title || 'Source') + ' (link unavailable)' });
        continue;
      }
      const ok = await checkUrlOK(s.url);
      if (ok) {
        out.push(s);
      } else {
        out.push({ title: (s.title || s.url || 'Source') + ' (link unavailable)' });
      }
    } else {
      // file citations or items without URLs
      out.push(s);
    }
  }
  return out;
}

/* ------------------- Rewrite model output markdown links -------------------- */
function rewriteOutputLinks(output, validatedSources) {
  if (!output) return output;
  const okUrls = new Set((validatedSources || []).filter(s => s.url).map(s => s.url));
  const linkRe = /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g;
  return output.replace(linkRe, (m, text, url) => {
    if (okUrls.has(url)) return m; // keep valid link
    return `${text} (link unavailable)`; // drop broken link
  });
}

/* --------------------------------- Handler ---------------------------------- */
export default async function handler(req) {
  if (req.method !== 'POST') {
    return json({ error: 'Use POST' }, 405);
  }

  try {
    const body = await req.json();
    const { message, followup, thread_id: clientThreadId } = body || {};
    if (!message) return json({ error: 'Missing message' }, 400);

    // 1) Reuse or create thread
    let thread_id = clientThreadId;
    if (!thread_id) {
      const threadResp = await fetch('https://api.openai.com/v1/threads', {
        method: 'POST',
        headers: headers(),
      });
      const thread = await threadResp.json();
      thread_id = thread.id;
    }

    // 2) Add user message
    await fetch(`https://api.openai.com/v1/threads/${thread_id}/messages`, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({ role: 'user', content: message }),
    });

    // ✅ Detect FIRST TURN to prevent accidental follow-up formatting
    let isFirstTurn = true;
    try {
      const listResp = await fetch(
        `https://api.openai.com/v1/threads/${thread_id}/messages?order=asc&limit=3`,
        { headers: headers() }
      );
      const listJson = await listResp.json();
      // After posting, if there's only 1 message, it's the first turn
      isFirstTurn = !(Array.isArray(listJson?.data) && listJson.data.length > 1);
    } catch { isFirstTurn = true; }

    // 3) Create run (override instructions only for valid follow-ups)
    const runCreateBody = { assistant_id: process.env.OPENAI_ASSISTANT_ID };
    if (followup === true && !isFirstTurn) {
      runCreateBody.instructions = FOLLOWUP_INSTRUCTIONS;
    }

    const runResp = await fetch(`https://api.openai.com/v1/threads/${thread_id}/runs`, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify(runCreateBody),
    });
    const run = await runResp.json();

    // 4) Poll for completion
    let status = run.status;
    const run_id = run.id;
    const started = Date.now();
    while (status === 'in_progress' || status === 'queued') {
      if (Date.now() - started > 60000) break; // 60s cap
      await sleep(800);
      const r2 = await fetch(`https://api.openai.com/v1/threads/${thread_id}/runs/${run_id}`, {
        headers: headers(),
      });
      const run2 = await r2.json();
      status = run2.status;
    }

    // 5) Get the latest assistant message
    const msgsResp = await fetch(
      `https://api.openai.com/v1/threads/${thread_id}/messages?order=desc&limit=1`,
      { headers: headers() }
    );
    const msgs = await msgsResp.json();
    const msg = msgs.data?.[0];

    const outputRaw = msg?.content?.[0]?.text?.value || 'No response';
    const rawSources = normalizeSources(extractSourcesFromMessage(msg));
    const sources = await validateSources(rawSources);

    // ✅ rewrite output so broken links are not clickable
    const output = rewriteOutputLinks(outputRaw, sources);

    return json({ output, sources, thread_id }, 200);
  } catch (e) {
    console.error(e);
    return json({ error: e?.message || 'Server error' }, 500);
  }
}

/* --------------------------------- Helpers ---------------------------------- */
function headers() {
  return {
    'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
    'Content-Type': 'application/json',
    'OpenAI-Beta': 'assistants=v2',
  };
}
function sleep(ms){ return new Promise(r => setTimeout(r, ms)); }
function json(obj, status=200){
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}

/**
 * Pulls both vector-store file citations and markdown links from the message.
 * Returns list items like:
 *   { filename, file_id, quote }  // file citations
 *   { title, url }                // web links
 */
function extractSourcesFromMessage(msg) {
  const out = [];
  try {
    const block = msg?.content?.[0]?.text;
    const text = block?.value || '';
    const ann = block?.annotations || [];

    // a) File citations from vector store
    for (const a of ann) {
      if (a.type === 'file_citation' && a.file_citation?.file_id) {
        out.push({
          filename: a.file_citation?.title || 'Document',
          file_id: a.file_citation.file_id,
          quote: a.text || ''
        });
      }
      if (a.type === 'file_path' && a.file_path?.file_id) {
        out.push({
          filename: a.file_path?.file_name || 'Attachment',
          file_id: a.file_path.file_id
        });
      }
    }

    // b) Markdown links for web sources
    const linkRe = /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g;
    let m;
    while ((m = linkRe.exec(text)) !== null) {
      out.push({ title: m[1], url: m[2] });
    }
  } catch {}
  return out;
}

/** De-duplicate by url or file_id (or title/filename if needed) */
function normalizeSources(items) {
  const seen = new Set();
  const out = [];
  for (const s of items || []) {
    const key = s.url ? `u:${s.url}` :
                s.file_id ? `f:${s.file_id}` :
                s.title ? `t:${s.title}` :
                s.filename ? `n:${s.filename}` :
                Math.random().toString(36).slice(2);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s);
  }
  return out;
}
