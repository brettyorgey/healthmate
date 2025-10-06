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
let LINK_REGISTRY = null;          // array of {id,title,url,domain,keywords?,...}
let REGISTRY_ETAG = null;
let REGISTRY_LAST_LOAD = 0;
const REGISTRY_TTL_MS = 5 * 60 * 1000;  // refresh every 5 mins

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
    if (LINK_REGISTRY) return LINK_REGISTRY;
    throw new Error(`Failed to load links.json (${res.status})`);
  }
  const json = await res.json();
  LINK_REGISTRY = (json || []).map(r => ({
    ...r,
    domain: r.domain || safeHost(r.url),
    keywords: Array.isArray(r.keywords) ? r.keywords : []
  }));
  REGISTRY_ETAG = res.headers.get('etag') || null;
  REGISTRY_LAST_LOAD = now;
  return LINK_REGISTRY;
}

/* ------------------------------- Utilities --------------------------------- */
function safeHost(u) { try { return new URL(u).hostname.replace(/^www\./,''); } catch { return ''; } }
function norm(s) { return (s || '').toLowerCase().trim(); }
function sim(a,b){
  a=norm(a); b=norm(b);
  if (!a || !b) return 0;
  if (a===b) return 1;
  if (a.includes(b) || b.includes(a)) return 0.82;
  return 0;
}

/* Resolve one candidate to best registry entry using host, title, and keywords */
function resolveToRegistry(cand, registry){
  const title = (cand.title || cand.filename || '').trim();
  const url = cand.url || '';
  const host = safeHost(url);
  const titleN = norm(title);

  let best = null, score = 0;

  for (const r of registry){
    const rHost = r.domain || safeHost(r.url);
    const sHost = host && rHost ? sim(host, rHost) : 0;

    // Compare against title and keywords
    const candidates = [r.title, ...(r.keywords || [])].filter(Boolean);
    let sText = 0;
    for (const txt of candidates) {
      sText = Math.max(sText, sim(titleN, txt));
    }

    // Weight host slightly more; allow keywords to lift fuzzy titles
    const s = Math.max(sHost * 1.25, sText);
    if (s > score) { score = s; best = r; }
  }

  // Only accept if reasonably close
  return (best && score >= 0.60) ? { id: best.id, title: best.title, url: best.url } : null;
}

/* Map all extracted sources to registry; dedupe and cap at 5 */
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

  // Fallbacks if nothing mapped; adjust IDs for your registry
  if (!out.length) {
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

/* Remove model-written Sources/References/etc blocks (we render our curated list only) */
function stripModelReferencesSection(output) {
  if (!output) return output;
  const heads = ['Sources','Source','References','Further reading','Citations'];
  const re = new RegExp(
    `(?:^|\\n)\\s{0,3}(?:#{1,3}\\s*)?(?:${heads.join('|')})\\s*(?:\\n|$)[\\s\\S]*$`,
    'i'
  );
  return output.replace(re, '').trim();
}

/* Keep only links that appear in sources[]; downgrade all others to plain text */
function rewriteOutputLinks(output, sources) {
  if (!output) return output;
  const ok = new Set((sources || []).map(s => s.url));

  // 1) Neutralize markdown links not in sources
  const linkRe = /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g;
  output = output.replace(linkRe, (m, text, url) => ok.has(url) ? m : `${text} (link unavailable)`);

  // 2) Neutralize bare URLs not in sources
  const bareUrlRe = /\bhttps?:\/\/[^\s)]+/gi;
  output = output.replace(bareUrlRe, (url) => ok.has(url) ? url : `${url} (link unavailable)`);

  // 3) Neutralize bare www. URLs not in sources
  const wwwRe = /\bwww\.[^\s)]+/gi;
  output = output.replace(wwwRe, (u) => {
    const full = `https://${u}`;
    return ok.has(full) ? u : `${u} (link unavailable)`;
  });

  return output;
}

/* Clean titles coming from annotations */
function cleanTitle(t) { return t ? t.replace(/\(\s*\[.*?link.*?\]\s*\)/gi, '').trim() : t; }

/* Extract links the model mentioned (we'll map them to registry) */
function extractSourcesFromMessage(msg) {
  const out = [];
  try {
    const block = msg?.content?.[0]?.text;
    const text = block?.value || '';
    const ann = block?.annotations || [];

    // Vector-store citations → title only; will map if you add those docs to registry
    for (const a of ann) {
      if (a.type === 'file_citation' && a.file_citation?.file_id) {
        out.push({ title: cleanTitle(a.file_citation?.title || 'Document') });
      }
      if (a.type === 'file_path' && a.file_path?.file_id) {
        out.push({ title: cleanTitle(a.file_path?.file_name || 'Attachment') });
      }
    }

    // Markdown links in body
    const linkRe = /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g;
    let m; while ((m = linkRe.exec(text)) !== null) {
      out.push({ title: cleanTitle(m[1]), url: m[2] });
    }

    // Bare www.* hints
    const wwwRe = /\b(www\.[^\s)]+)\b/g;
    let n; while ((n = wwwRe.exec(text)) !== null) {
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

    // 5) Latest assistant message
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

    // Rewrite output: remove model’s “Sources/References”; neutralize stray links
    let output = stripModelReferencesSection(outputRaw);
    output = rewriteOutputLinks(output, sources);

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
