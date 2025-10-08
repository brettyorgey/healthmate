// /api/mascot.js — CommonJS, safe for Vercel Node serverless (no long polling)
module.exports.config = { runtime: 'nodejs' };

/* -------------------- constants -------------------- */
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
  female: ["women","female","motherhood","menstrual","pregnancy","aflw"]
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
      const isAbort = msg.includes('Abort') || msg.includes('aborted');
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

/* -------------------- link scoring -------------------- */
function inferCategoryFromText(text = "") {
  const t = text.toLowerCase();
  if (/(knee|shoulder|ankle|hip|physio|physiotherapy|rehab|exercise|pain)\b/.test(t)) return 'physical';
  let best = null, bestHits = 0;
  for (const [cat, words] of Object.entries(CAT_SYNONYMS)) {
    let hits = 0; for (const w of words) if (t.includes(w)) hits++;
    if (hits > bestHits) { best = cat; bestHits = hits; }
  }
  return best;
}
function scoreLink(link, prompt, cat) {
  const p = (prompt || '').toLowerCase();
  const c = (cat || '').toLowerCase();
  let score = 0, catScore = 0, kwHits = 0;

  const lcats = (link.category || []).map(x => (x||'').toLowerCase());
  if (lcats.includes(c)) { score += 6; catScore = 6; }
  else if (lcats.some(x => c && (c.includes(x) || x.includes(c)))) { score += 4; catScore = 4; }

  if (Array.isArray(link.keywords)) {
    for (const k of link.keywords) {
      if (k && p.includes((k||'').toLowerCase())) { score += 4; kwHits++; }
    }
  }
  for (const s of (CAT_SYNONYMS[c] || [])) if (p.includes(s)) score += 2;
  if (link.title && p.includes((link.title||'').toLowerCase())) score += 1;
  if (link.domain && p.includes((link.domain||'').toLowerCase())) score += 1;

  return { score, catScore, kwHits };
}
function findBestLinks(links, category, prompt, max = 4) {
  const c = (category || '').toLowerCase();
  const scored = [];
  for (const l of links) {
    if (!l?.url) continue;
    const s = scoreLink(l, prompt, c);
    scored.push({ ...l, ...s });
  }
  const bestCat = Math.max(0, ...scored.map(s => s.catScore));
  let filtered = scored;
  if (bestCat >= 4) filtered = scored.filter(s => s.catScore >= 4);
  else {
    const hasKW = scored.some(s => s.kwHits > 0);
    if (hasKW) filtered = scored.filter(s => s.kwHits > 0);
  }
  return filtered
    .sort((a,b) => b.score - a.score)
    .slice(0, max)
    .map(({ id, title, url, domain }) => ({ id, title, url, domain }));
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
    const { message, followup, thread_id: clientThreadId, categoryLabel, peek } = body || {};

    // Peek requires a thread id
    if (peek && !clientThreadId) return sendJson(res, 400, { error: 'Missing thread_id for peek' });

    const links = await loadLinks(req);
    const inferredCategory = (categoryLabel || '').trim().toLowerCase() || (message ? inferCategoryFromText(message) : null);

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

    // Peek mode: only return 200 when we truly have an assistant message
    const text = await getLatestAssistantText(thread_id);
    if (!text) {
      return sendJson(res, 202, { pending: true, thread_id });
    }

    const curatedSources = message ? findBestLinks(links, inferredCategory, message, 4) : [];
    return sendJson(res, 200, { output: text, sources: curatedSources, thread_id });

  } catch (e) {
    console.error('mascot error:', e);
    return sendJson(res, 500, { error: e?.message || 'Server error' });
  }
};
