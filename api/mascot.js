// /api/mascot.js — CommonJS, safe for Vercel Node serverless (no long polling)
module.exports.config = { runtime: 'nodejs' };

/* -------------------- constants -------------------- */
const FOLLOWUP_INSTRUCTIONS = `
You are still the FifthQtr Healthmate (Beta) — an AU-based information assistant supporting sports alumni, their families, partners, friends, and club officials.

Provide brief, plain-English follow-ups that clarify or extend earlier answers.
Keep responses focused on 'Why this matters' and offer 3–5 relevant Australian sources only.

Use a tone that matches the topic:
- Empathetic and reassuring for mental health, family, or social questions.
- Calm and factual for physical or financial matters.
- Always stigma-free, respectful, and inclusive.

If a question sounds urgent or worsening, include:
"If this feels urgent, call 000 or go to urgent care now."

Always finish with:
"Information only — not a medical diagnosis. In an emergency call 000."
`;

const MAX_SOURCES = 4;               // client renders up to 4 curated sources
const LINK_VERIFY_MODE = (process.env.LINK_VERIFY || '').toLowerCase(); // 'head' to enable quick reachability check

const CAT_SYNONYMS = {
  physical: ["injury","rehab","rehabilitation","fitness","exercise","pain","knee","shoulder","hip","ankle","physio","physiotherapy","mobility","strength"],
  psychological: ["mental","mood","anxiety","depression","stress","relationship","support"],
  "brain-health": ["concussion","cte","head knock","post-concussion","headache","light sensitivity","memory","thinking","cognition"],
  career: ["work","job","resume","cv","learning","course","study","scholarship","networking","mentoring"],
  family: ["partner","carer","caregiver","family","community","alumni","regional"],
  cultural: ["indigenous","aboriginal","torres strait","culturally","spiritual","faith"],
  identity: ["identity","foreclosure","retirement","lgbtqi","gender","sexuality","inclusion"],
  financial: ["money","budget","grant","superannuation","financial","cost"],
  environmental: ["alcohol","drugs","gambling","dependency","addiction"],
  female: ["women","female","motherhood","menstrual","pregnancy","aflw"],
  aged care: ["care","housing","support","respite","residential"]
};

/* -------------------- small helpers -------------------- */
function apiHeaders() {
  return {
    'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
    'Content-Type': 'application/json',
    'OpenAI-Beta': 'assistants=v2',
  };
}
function sendJson(res, status, obj) {
  res.status(status).setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(obj));
}
async function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    try {
      if (req.body && typeof req.body === 'object') return resolve(req.body);
      let data = '';
      req.on('data', chunk => (data += chunk));
      req.on('end', () => {
        try { resolve(data ? JSON.parse(data) : {}); }
        catch (e) { reject(new Error('Invalid JSON body')); }
      });
    } catch (e) { reject(e); }
  });
}
async function fetchWithTimeout(url, opts = {}, ms = 15000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try {
    return await fetch(url, { ...opts, signal: ctl.signal });
  } finally {
    clearTimeout(t);
  }
}
async function getJsonOrThrow(url, options, timeoutMs = 15000, retries = 1) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const r = await fetchWithTimeout(url, options, timeoutMs);
      const text = await r.text();
      if (!r.ok) throw new Error(`Fetch ${url} failed: ${r.status} ${r.statusText} — ${text.slice(0,200)}`);
      try { return JSON.parse(text); }
      catch (e) { throw new Error(`JSON parse error from ${url}: ${e.message}`); }
    } catch (e) {
      lastErr = e;
      const msg = String(e?.message || e);
      const isAbort = msg.includes('Abort') || msg.includes('aborted') || msg.includes('AbortError');
      if (attempt < retries && isAbort) continue;
      break;
    }
  }
  throw lastErr;
}
function baseUrlFromReq(req) {
  const host = req.headers['x-forwarded-host'] || req.headers.host || process.env.VERCEL_URL;
  const proto = req.headers['x-forwarded-proto'] || 'https';
  if (!host) return 'http://localhost:3000';
  return `${proto}://${host}`;
}

/* -------------------- links.json (cached) -------------------- */
const LINKS_CACHE = { data: null, ts: 0 };
async function loadLinks(req) {
  const now = Date.now();
  if (LINKS_CACHE.data && (now - LINKS_CACHE.ts) < 120000) return LINKS_CACHE.data;
  try {
    const res = await fetchWithTimeout(`${baseUrlFromReq(req)}/links.json`, { cache: 'no-store' }, 4000);
    if (!res.ok) return LINKS_CACHE.data || [];
    const data = await res.json();
    LINKS_CACHE.data = Array.isArray(data) ? data : [];
    LINKS_CACHE.ts = now;
    return LINKS_CACHE.data;
  } catch {
    return LINKS_CACHE.data || [];
  }
}

/* -------------------- category normalisation -------------------- */
function normalizeCategoryKey(input) {
  if (!input) return null;
  const s = String(input).trim().toLowerCase();
  const map = {
    'physical': 'physical',
    'psychological': 'psychological',
    'career': 'career',
    'family': 'family',
    'cultural': 'cultural',
    'identity': 'identity',
    'financial': 'financial',
    'environmental': 'environmental',
    'female': 'female'
    'aged care': 'aged care'
  };
  return map[s] || null;
}
function canonicalFromLabel(label='') {
  const head = (label.split('–')[0] || label).trim().toLowerCase();
  return normalizeCategoryKey(head);
}

/* -------------------- link utilities -------------------- */
function safeUrlOrNull(u){
  try {
    const url = new URL(u);
    if (!/^https?:$/.test(url.protocol)) return null;
    return url.toString();
  } catch {
    return null;
  }
}
function domainOf(u){
  try { return new URL(u).hostname.replace(/^www\./,'').toLowerCase(); }
  catch { return ''; }
}
function dedupeByDomain(arr){
  const seen = new Set();
  const out = [];
  for (const s of arr){
    const d = domainOf(s.url || '');
    const key = d || (s.url || s.title || '');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s);
  }
  return out;
}
async function headReachable(url, ms=2000){
  try {
    const r = await fetchWithTimeout(url, { method:'HEAD', redirect:'follow' }, ms);
    // Accept 2xx and 3xx; some sites reject HEAD -> try GET if HEAD is 405
    if (r.ok || (r.status >= 300 && r.status < 400)) return true;
    if (r.status === 405) {
      const g = await fetchWithTimeout(url, { method:'GET' }, Math.max(1500, ms));
      return g.ok || (g.status >= 300 && g.status < 400);
    }
    return false;
  } catch { return false; }
}
async function verifyLinksQuick(links){
  if (LINK_VERIFY_MODE !== 'head') return links;
  const checks = links.map(async l => {
    const ok = await headReachable(l.url, 2000);
    return ok ? l : null;
  });
  const res = await Promise.allSettled(checks);
  const filtered = res.map(x => (x.status === 'fulfilled' ? x.value : null)).filter(Boolean);
  // if all failed, fall back to original (avoid empty box due to transient blocks)
  return filtered.length ? filtered : links;
}

/* -------------------- link scoring -------------------- */
function inferCategoryFromText(text = "") {
  const t = (text || '').toLowerCase();
  if (/(knee|shoulder|ankle|hip|physio|physiotherapy|rehab|exercise|pain)\b/.test(t)) return 'physical';
  let best = null, bestHits = 0;
  for (const [cat, words] of Object.entries(CAT_SYNONYMS)) {
    let hits = 0; for (const w of words) if (t.includes(w)) hits++;
    if (hits > bestHits) { best = cat; bestHits = hits; }
  }
  return best;
}

/**
 * Score a single link against:
 * - resolved category
 * - prompt text and message
 * - optional meta: keywords[], subpillar, audience
 */
function scoreLink(link, context) {
  const { promptText, category, meta, combinedText } = context;
  const p = (promptText || '').toLowerCase();
  const c = (category || '').toLowerCase();
  const bag = (combinedText || '').toLowerCase();

  let score = 0, catScore = 0, kwHits = 0;

  const lcats = (link.category || []).map(x => (x||'').toLowerCase());
  if (lcats.includes(c)) { score += 6; catScore = 6; }
  else if (lcats.some(x => c && (c.includes(x) || x.includes(c)))) { score += 4; catScore = Math.max(catScore, 4); }

  // keywords on link
  if (Array.isArray(link.keywords)) {
    for (const k of link.keywords) {
      const kk = (k||'').toLowerCase();
      if (!kk) continue;
      if (p.includes(kk)) { score += 4; kwHits++; }
      else if (bag.includes(kk)) { score += 3; kwHits++; }
    }
  }

  // category synonyms
  for (const s of (CAT_SYNONYMS[c] || [])) if (p.includes(s)) score += 2;

  // simple title/domain match
  if (link.title && p.includes((link.title||'').toLowerCase())) score += 1;
  if (link.domain && p.includes((link.domain||'').toLowerCase())) score += 1;

  // meta-aware boosts (backward-compatible)
  if (meta) {
    const metaKw = Array.isArray(meta.keywords) ? meta.keywords : [];
    for (const k of metaKw) if (k && bag.includes(String(k).toLowerCase())) score += 2;

    if (meta.subpillar && bag.includes(String(meta.subpillar).toLowerCase())) score += 2;
    if (meta.audience && bag.includes(String(meta.audience).toLowerCase())) score += 1;

    // If link declares subpillars/audience (optional in links.json)
    const linkSubs = (link.subpillars || []).map(x => String(x||'').toLowerCase());
    if (meta.subpillar && linkSubs.includes(String(meta.subpillar).toLowerCase())) score += 2;

    const linkAudience = (link.audience || []).map(x => String(x||'').toLowerCase());
    if (meta.audience && linkAudience.includes(String(meta.audience).toLowerCase())) score += 1;
  }

  // safety: prefer https and valid url
  if (safeUrlOrNull(link.url)) score += 1;

  return { score, catScore, kwHits };
}

function findBestLinks(links, opts) {
  const {
    category, promptText, userMessage, meta, max = MAX_SOURCES
  } = opts;

  // Build a combined bag of words to softly match
  const parts = [
    promptText || '',
    userMessage || '',
    Array.isArray(meta?.keywords) ? meta.keywords.join(' ') : '',
    meta?.subpillar || '',
    meta?.audience || ''
  ];
  const combinedText = parts.filter(Boolean).join(' ').trim();

  const ctx = { promptText, category, meta, combinedText };
  const c = (category || '').toLowerCase();

  const scored = [];
  for (const l of (links || [])) {
    if (!l?.url) continue;
    const s = scoreLink(l, ctx);
    scored.push({ ...l, ...s });
  }

  // If we have at least a reasonably strong category signal, prefer those
  const bestCat = Math.max(0, ...scored.map(s => s.catScore || 0));
  let filtered = scored;
  if (bestCat >= 4) filtered = scored.filter(s => s.catScore >= 4);
  else {
    const hasKW = scored.some(s => s.kwHits > 0);
    if (hasKW) filtered = scored.filter(s => s.kwHits > 0);
  }

  // Sort, dedupe by domain, clamp, and strip down fields
  const sorted = filtered.sort((a,b) => b.score - a.score);
  const deduped = dedupeByDomain(sorted);
  const top = deduped.slice(0, max).map(({ id, title, url, domain, filename, file_id }) => {
    const clean = safeUrlOrNull(url);
    return clean ? { id, title, url: clean, domain } : (file_id ? { id, title: filename || 'Document', file_id } : null);
  }).filter(Boolean);

  return top;
}

/* -------------------- OpenAI helpers -------------------- */
async function getLatestAssistantText(thread_id) {
  const msgs = await getJsonOrThrow(
    `https://api.openai.com/v1/threads/${thread_id}/messages?order=desc&limit=10`,
    { headers: apiHeaders() },
    12000, 0
  );
  const m = (msgs.data || []).find(x => x.role === 'assistant');
  if (!m) return null;
  const item = (m.content || []).find(c => c.type === 'text');
  return item?.text?.value || null;
}

/* -------------------- main handler -------------------- */
module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return sendJson(res, 405, { error: 'Use POST' });

  try {
    const body = await readJsonBody(req);
    const {
      message,
      followup,
      thread_id: clientThreadId,
      categoryLabel,
      categoryKey,     // canonical key from client when available
      promptId,        // stable slug from client (optional)
      promptMeta,      // richer prompt metadata (optional)
      peek
    } = body || {};

    // Peek requires a thread id
    if (peek && !clientThreadId) return sendJson(res, 400, { error: 'Missing thread_id for peek' });

    const links = await loadLinks(req);

    // Resolve effective category: categoryKey -> label -> inference
    const effectiveCategory =
      normalizeCategoryKey(categoryKey) ||
      canonicalFromLabel(categoryLabel || '') ||
      (message ? inferCategoryFromText(message) : null);

    // Create or reuse thread (unless peeking)
    let thread_id = clientThreadId;
    const firstTurn = !thread_id && !peek;
    if (firstTurn) {
      const thread = await getJsonOrThrow('https://api.openai.com/v1/threads', {
        method: 'POST',
        headers: apiHeaders()
      }, 20000, 1);
      thread_id = thread.id;
    }

    // Add user message & start a run (non-peek)
    if (!peek) {
      if (!message) return sendJson(res, 400, { error: 'Missing message' });

      await getJsonOrThrow(`https://api.openai.com/v1/threads/${thread_id}/messages`, {
        method: 'POST',
        headers: apiHeaders(),
        body: JSON.stringify({ role: 'user', content: message }),
      }, 12000, 0);

      // We pass follow-up instructions only after the very first model answer
      const runCreateBody = {
        assistant_id: process.env.OPENAI_ASSISTANT_ID,
        ...( !firstTurn && followup === true ? { instructions: FOLLOWUP_INSTRUCTIONS } : {} )
      };
      await getJsonOrThrow(`https://api.openai.com/v1/threads/${thread_id}/runs`, {
        method: 'POST',
        headers: apiHeaders(),
        body: JSON.stringify(runCreateBody),
      }, 20000, 1);

      // Important: never wait here — return 202 so the client polls
      return sendJson(res, 202, { pending: true, thread_id });
    }

    // Peek mode: return only when an assistant message exists
    const text = await getLatestAssistantText(thread_id);
    if (!text) {
      return sendJson(res, 202, { pending: true, thread_id });
    }

    // Curate sources using the current user message, resolved category, and prompt metadata
    let curatedSources = [];
    if (message) {
      const promptText = (promptMeta && typeof promptMeta === 'object' && promptMeta.prompt) ? String(promptMeta.prompt) : '';
      const meta = (promptMeta && typeof promptMeta === 'object') ? promptMeta : null;

      const preliminary = findBestLinks(links, {
        category: effectiveCategory,
        promptText: promptText || message, // always include message terms
        userMessage: message,
        meta,
        max: MAX_SOURCES
      });

      curatedSources = LINK_VERIFY_MODE === 'head'
        ? await verifyLinksQuick(preliminary)
        : preliminary;
    }

    return sendJson(res, 200, {
      output: text,
      sources: curatedSources,
      thread_id
    });

  } catch (e) {
    console.error('mascot error:', e);
    return sendJson(res, 500, { error: e?.message || 'Server error' });
  }
};
