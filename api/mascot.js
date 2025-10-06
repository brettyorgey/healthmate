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

/* ----------------------------- Registry cache ------------------------------ */
let LINK_REGISTRY = null;          // array of {id,title,url,domain,...}
let REGISTRY_ETAG = null;
let REGISTRY_LAST_LOAD = 0;
const REGISTRY_TTL_MS = 5 * 60 * 1000;  // 5 minutes (adjust if you want)

/* Load /links.json once, then cache; auto-refresh every REGISTRY_TTL_MS */
async function loadRegistry(req) {
  const now = Date.now();
  if (LINK_REGISTRY && (now - REGISTRY_LAST_LOAD < REGISTRY_TTL_MS)) {
    return LINK_REGISTRY;
  }
  const origin = new URL(req.url).origin;
  const url = `${origin}/links.json`;

  const headers = {};
  if (REGISTRY_ETAG) headers['If-None-Match'] = REGISTRY_ETAG;

  const res = await fetch(url, { headers });
  if (res.status === 304 && LINK_REGISTRY) {
    REGISTRY_LAST_LOAD = now;
    return LINK_REGISTRY;
  }
  if (!res.ok) {
    // If fetch fails but we have a previous copy, keep serving it.
    if (LINK_REGISTRY) return LINK_REGISTRY;
    throw new Error(`Failed to load links.json (${res.status})`);
  }
  try {
    const json = await res.json();
    // Normalize domains if missing
    LINK_REGISTRY = (json || []).map(r => ({
      ...r,
      domain: r.domain || safeHost(r.url)
    }));
    REGISTRY_ETAG = res.headers.get('etag') || null;
    REGISTRY_LAST_LOAD = now;
    return LINK_REGISTRY;
  } catch {
    if (LINK_REGISTRY) return LINK_REGISTRY;
    throw new Error('Invalid links.json');
  }
}

function safeHost(u) { try { return new URL(u).hostname.replace(/^www\./,''); } catch { return ''; } }
function norm(s) { return (s || '').toLowerCase().trim(); }
function sim(a,b){
  a=norm(a); b=norm(b);
  if (!a || !b) return 0;
  if (a===b) return 1;
  if (a.includes(b) || b.includes(a)) return 0.82;
  return 0;
}

/* Resolve one candidate source to the best registry entry */
function resolveToRegistry(cand, registry){
  const title = (cand.title || cand.filename || '').trim();
  const url = cand.url || '';
  const host = safeHost(url);

  let best = null, score = 0;

  for (const r of registry){
    const sHost = host && r.domain ? sim(host, r.domain) : 0;
    const sTitle = title ? sim(title, r.title) : 0;
    const s = Math.max(sHost * 1.25, sTitle);   // weight host slightly higher
    if (s > score) { score = s; best = r; }
  }

  // accept only reasonable matches
  if (best && score >= 0.6) return { id: best.id, title: best.title, url: best.url };
  return null;
}

/* Map all extracted sources to the registry (dedup, cap at 5) */
async function mapSourcesToRegistry(extracted, req){
  const registry = await loadRegistry(req);
  const out = [];
  const used = new Set();

  for (const c of extracted || []){
    const m = resolveToRegistry(c, registry);
    if (m && !used.has(m.id)){
      out.push(m);
      used.add(m.id);
      if (out.length >= 5) break;
    }
  }

  // Fallbacks if model didn’t provide anything useful
  if (!out.length) {
    // Try to include a sensible default (adjust these IDs to ones in your links.json)
    const prefer = [
      'healthdirect-concussion',
      'cisa-about-concussion',
      'dementia-cte-overview',
      'fifthqtr-home'
    ];
    for (const id of prefer){
      const r = registry.find(x => x.id === id);
      if (r && !used.has(r.id)){
        out.push({ id:r.id, title:r.title, url:r.url });
        used.add(r.id);
        if (out.length >= 3) break;
      }
    }
  }

  return out;
}

/* ------------------- Strip & rewrite links in model output ------------------ */
/* Keep only the links we return in sources[]; downgrade others to "(link unavailable)" */
function rewriteOutputLinks(output, sources) {
  if (!output) return output;
  const ok = new Set((sources || []).map(s => s.url));
  const linkRe = /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g;
  return output.replace(linkRe, (m, text, url) => ok.has(url) ? m : `${text} (link unavailable)`);
}

/* Remove model’s own “Sources” section so we render only our curated list */
function stripModelSourcesSection(output) {
  if (!output) return output;
  const re = /(?:^|\n)\s{0,3}(?:##\s+)?Sources\s*(?:\n|$)[\s\S]*$/i;
  return output.replace(re, '').trim();
}

/* ------------------------------ Title cleaner ------------------------------- */
function cleanTitle(t) {
  if (!t) return t;
  return t.replace(/\(\s*\[.*?link.*?\]\s*\)/gi, '').trim();
}

/* ---------------------- Extract links the model mentioned ------------------- */
function extractSourcesFromMessage(msg) {
  const out = [];
  try {
    const block = msg?.content?.[0]?.text;
    const text = block?.value || '';
    const ann = block?.annotations || [];

    // Vector-store file citations (kept as title-only; they will map to registry if you add them)
    for (const a of ann) {
      if (a.type === 'file_citation' && a.file_citation?.file_id) {
        out.push({ title: cleanTitle(a.file_citation?.title || 'Document') });
      }
      if (a.type === 'file_path' && a.file_path?.file_id) {
        out.push({ title: cleanTitle(a.file_path?.file_name || 'Attachment') });
      }
    }

    // Markdown links
    const linkRe = /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g;
    let m;
    while ((m = linkRe.exec(text)) !== null) {
      out.push({ title: cleanTitle(m[1]), url: m[2] });
    }

    // Bare "www.example.com/..." patterns
    const wwwRe = /\b(www\.[^\s)]+)\b/g;
    let n;
    while ((n = wwwRe.exec(text)) !== null) {
      out.push({ title: cleanTitle(n[1]), url: 'https://' + n[1] });
    }
  } catch {}
  return out;
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

    // Detect FIRST TURN (so we only apply FOLLOWUP_INSTRUCTIONS later)
    let isFirstTurn = true;
    try {
      const listResp = await fetch(
        `https://api.openai.com/v1/threads/${thread_id}/messages?order=asc&limit=3`,
        { headers: headers() }
      );
      const listJson = await listResp.json();
      isFirstTurn = !(Array.isArray(listJson?.data) && listJson.data.length > 1);
    } catch { isFirstTurn = true; }

    // 3) Create run (override instructions for valid follow-ups)
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

    // EXTRACT → MAP TO REGISTRY (no live URL checks)
    const extracted = extractSourcesFromMessage(msg);
    const sources = await mapSourcesToRegistry(extracted, req);

    // Rewrite output: keep only registry links; strip model’s “Sources” section
    let output = rewriteOutputLinks(outputRaw, sources);
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
