// /api/mascot.js
export const config = { runtime: 'edge' };

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

/* ----------------------------- URL helpers --------------------------------- */
function stripTrackingParams(raw) {
  try {
    const u = new URL(raw);
    [
      'utm_source','utm_medium','utm_campaign','utm_term','utm_content',
      'gclid','gbraid','gad_source','gad_campaignid'
    ].forEach(p => u.searchParams.delete(p));
    return u.toString();
  } catch { return raw; }
}
function getOrigin(raw) {
  try { return new URL(raw).origin; } catch { return null; }
}
function ensureHttps(url) {
  if (!url) return url;
  if (/^https?:\/\//i.test(url)) return url;
  if (/^www\./i.test(url)) return 'https://' + url;
  return url;
}

/* ----------------------------- HTTP helpers -------------------------------- */
async function fetchWithTimeout(url, opts = {}, timeoutMs = 4000) {
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort('timeout'), timeoutMs);
  try {
    const headers = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      ...(opts.headers || {})
    };
    return await fetch(url, { ...opts, headers, signal: ctrl.signal, redirect: 'follow' });
  } finally {
    clearTimeout(to);
  }
}

/* --------------------------- (Optional) AU domain gate ---------------------- */
const LIMIT_TO_AU_PUBLIC = false;
function allowDomain(url) {
  try {
    const u = new URL(url);
    return u.hostname.endsWith('.gov.au') || u.hostname.endsWith('.org.au');
  } catch { return false; }
}

/* --------------------------- Validate external links ------------------------ */
async function checkUrlOK(url) {
  const cached = cacheGet(url);
  if (typeof cached === 'boolean') return cached;

  // 1) Original
  if (await tryOk(url)) { cacheSet(url, true); return true; }

  // 2) Stripped of tracking
  const stripped = stripTrackingParams(url);
  if (stripped !== url && await tryOk(stripped)) {
    cacheSet(url, true); cacheSet(stripped, true);
    return true;
  }

  // 3) Site origin
  const origin = getOrigin(url);
  if (origin && await tryOk(origin)) {
    cacheSet(url, true); cacheSet(origin, true);
    return true;
  }

  cacheSet(url, false);
  return false;

  async function tryOk(u) {
    try { const r = await fetchWithTimeout(u, { method:'HEAD' }, 4000); if (r.ok) return true; } catch {}
    try { const r = await fetchWithTimeout(u, { method:'GET'  }, 5000); return r.ok; } catch { return false; }
  }
}

async function validateSources(sources) {
  const out = [];
  for (const s of sources || []) {
    if (s.url) {
      // normalize www… → https://…
      const normalized = ensureHttps(s.url);

      if (LIMIT_TO_AU_PUBLIC && !allowDomain(normalized)) {
        out.push({ title: (s.title || 'Source') + ' (link unavailable)' });
        continue;
      }

      // original → stripped → origin (upgrade URL to first working)
      if (await checkUrlOK(normalized)) { out.push({ ...s, url: normalized }); continue; }

      const stripped = stripTrackingParams(normalized);
      if (stripped !== normalized && await checkUrlOK(stripped)) {
        out.push({ ...s, url: stripped });
        continue;
      }

      const origin = getOrigin(normalized);
      if (origin && await checkUrlOK(origin)) {
        out.push({ ...s, url: origin });
        continue;
      }

      // give up
      out.push({ title: (s.title || normalized || 'Source') + ' (link unavailable)' });
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
  return output.replace(linkRe, (m, text, url) => okUrls.has(url) ? m : `${text} (link unavailable)`);
}

/* ----------- Strip the model’s own “Sources” section from output ------------ */
function stripModelSourcesSection(output) {
  if (!output) return output;
  // Remove from a "## Sources" (or "Sources") heading to the end
  const re = /(?:^|\n)\s{0,3}(?:##\s+)?Sources\s*(?:\n|$)[\s\S]*$/i;
  return output.replace(re, '').trim();
}

/* -------- Replace placeholders with a friendlier base-domain hint ----------- */
function rewritePlaceholders(output, validatedSources) {
  if (!output) return output;
  const firstWeb = (validatedSources || []).find(s => s.url);
  const host = firstWeb ? safeHost(firstWeb.url) : null;
  // e.g. "([insert relevant section or link])" → "(fifthqtr.org.au)" or "(link unavailable)"
  output = output.replace(/\(\s*\[?insert relevant section or link\]?\s*\)/gi,
    host ? `(${host})` : `(link unavailable)`);
  return output;

  function safeHost(u){
    try { return new URL(u).hostname.replace(/^www\./,''); } catch { return null; }
  }
}

/* ------------------------------ Title cleaner ------------------------------- */
function cleanTitle(t) {
  if (!t) return t;
  // drop placeholders such as ([link]) or ([insert relevant section or link])
  return t.replace(/\(\s*\[.*?link.*?\]\s*\)/gi, '').trim();
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

    // Detect FIRST TURN to prevent accidental follow-up formatting
    let isFirstTurn = true;
    try {
      const listResp = await fetch(
        `https://api.openai.com/v1/threads/${thread_id}/messages?order=asc&limit=3`,
        { headers: headers() }
      );
      const listJson = await listResp.json();
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
      if (Date.now() - started > 60000) break;
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

    // Rewrite output: remove broken links, placeholders, and model's own Sources block
    let output = rewriteOutputLinks(outputRaw, sources);
    output = rewritePlaceholders(output, sources);
    output = stripModelSourcesSection(output);

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
          filename: cleanTitle(a.file_citation?.title || 'Document'),
          file_id: a.file_citation.file_id,
          quote: a.text || ''
        });
      }
      if (a.type === 'file_path' && a.file_path?.file_id) {
        out.push({
          filename: cleanTitle(a.file_path?.file_name || 'Attachment'),
          file_id: a.file_path.file_id
        });
      }
    }

    // b) Markdown links for web sources
    const linkRe = /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g;
    let m;
    while ((m = linkRe.exec(text)) !== null) {
      out.push({ title: cleanTitle(m[1]), url: m[2] });
    }

    // c) Very plain "www.example.com/..." patterns (rare)
    const wwwRe = /\b(www\.[^\s)]+)\b/g;
    let n;
    while ((n = wwwRe.exec(text)) !== null) {
      out.push({ title: cleanTitle(n[1]), url: n[1] }); // ensureHttps() will normalize later
    }
  } catch {}
  return out;
}

/** De-duplicate by url or file_id (or title/filename if needed) */
function normalizeSources(items) {
  const seen = new Set();
  const out = [];
  for (const s of items || []) {
    if (s && s.title) s.title = cleanTitle(s.title);
    if (s && s.filename) s.filename = cleanTitle(s.filename);

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
