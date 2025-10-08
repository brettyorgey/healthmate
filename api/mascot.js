// /api/mascot.js  (CommonJS version for Node runtime)
module.exports.config = { runtime: 'nodejs' };

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

// ---------- small Node helpers ----------
function headers() {
  return {
    'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
    'Content-Type': 'application/json',
    'OpenAI-Beta': 'assistants=v2',
  };
}

function baseUrlFromReq(req) {
  const host = req.headers['x-forwarded-host'] || req.headers.host || process.env.VERCEL_URL;
  const proto = req.headers['x-forwarded-proto'] || 'https';
  if (!host) return 'http://localhost:3000';
  return `${proto}://${host}`;
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

function sendJson(res, status, obj) {
  res.status(status).setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(obj));
}

async function getJsonOrThrow(url, options) {
  const r = await fetch(url, options);
  const text = await r.text();
  if (!r.ok) throw new Error(`Fetch ${url} failed: ${r.status} ${r.statusText} — ${text.slice(0,200)}`);
  try { return JSON.parse(text); }
  catch (e) { throw new Error(`JSON parse error from ${url}: ${e.message}`); }
}

async function loadLinks(req) {
  try {
    const res = await fetch(`${baseUrlFromReq(req)}/links.json`, { cache: 'no-store' });
    if (!res.ok) return [];
    return await res.json();
  } catch {
    return [];
  }
}

// ---------- scoring ----------
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
    for (const k of link.keywords) if (k && p.includes((k||'').toLowerCase())) { score += 4; kwHits++; }
  }
  for (const s of (CAT_SYNONYMS[c] || [])) if (p.includes(s)) score += 2;
  if (link.title && p.includes(link.title.toLowerCase())) score += 1;
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

// ---------- main handler (CommonJS) ----------
module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return sendJson(res, 405, { error: 'Use POST' });

  try {
    const body = await readJsonBody(req);
    const { message, followup, thread_id: clientThreadId, categoryLabel, peek } = body || {};

    if (peek && !clientThreadId) return sendJson(res, 400, { error: 'Missing thread_id for peek' });

    const links = await loadLinks(req);
    const inferredCategory =
      (categoryLabel || '').trim().toLowerCase() || (message ? inferCategoryFromText(message) : null);

    // Create or reuse thread (unless peeking)
    let thread_id = clientThreadId;
    const firstTurn = !thread_id && !peek;
    if (firstTurn) {
      const thread = await getJsonOrThrow('https://api.openai.com/v1/threads', {
        method: 'POST',
        headers: headers()
      });
      thread_id = thread.id;
    }

    // Add user message (skip for peek)
    if (!peek) {
      if (!message) return sendJson(res, 400, { error: 'Missing message' });
      await getJsonOrThrow(`https://api.openai.com/v1/threads/${thread_id}/messages`, {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({ role: 'user', content: message }),
      });
    }

    // Create run only when not peeking
    let run_id = null;
    if (!peek) {
      const runCreateBody = { assistant_id: process.env.OPENAI_ASSISTANT_ID };
      if (!firstTurn && followup === true) runCreateBody.instructions = FOLLOWUP_INSTRUCTIONS;

      const run = await getJsonOrThrow(`https://api.openai.com/v1/threads/${thread_id}/runs`, {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify(runCreateBody),
      });
      run_id = run.id;
    }

    // Poll
    const start = Date.now();
    let delay = 700;

    while (true) {
      if (Date.now() - start > 55000) return sendJson(res, 202, { pending: true, thread_id });
      await new Promise(r => setTimeout(r, delay));
      delay = Math.min(2200, Math.floor(delay * 1.3));

      if (peek) {
        const msgs = await getJsonOrThrow(
          `https://api.openai.com/v1/threads/${thread_id}/messages?order=desc&limit=1`,
          { headers: headers() }
        );
        const msg = msgs.data?.[0];
        if (msg?.role === 'assistant') {
          const rawOutput = msg?.content?.[0]?.text?.value || 'No response';
          const curatedSources = message ? findBestLinks(links, inferredCategory, message, 4) : [];
          return sendJson(res, 200, { output: rawOutput, sources: curatedSources, thread_id });
        }
        continue;
      }

      const run2 = await getJsonOrThrow(
        `https://api.openai.com/v1/threads/${thread_id}/runs/${run_id}`,
        { headers: headers() }
      );
      const status = run2.status;

      if (status === 'completed') break;
      if (status === 'failed')  return sendJson(res, 502, { error: run2.last_error?.message || 'Assistant run failed' });
      if (status === 'expired' || status === 'cancelled') return sendJson(res, 504, { error: `Run ${status}` });
      if (status === 'requires_action') return sendJson(res, 501, { error: 'Run requires action (tools not handled).' });
      // else queued/in_progress -> keep looping
    }

    // Completed: fetch last assistant message
    const msgs = await getJsonOrThrow(
      `https://api.openai.com/v1/threads/${thread_id}/messages?order=desc&limit=1`,
      { headers: headers() }
    );
    const msg = msgs.data?.[0];
    const rawOutput = msg?.content?.[0]?.text?.value || 'No response';
    const curatedSources = findBestLinks(links, inferredCategory, message, 4);
    return sendJson(res, 200, { output: rawOutput, sources: curatedSources, thread_id });

  } catch (e) {
    console.error('mascot error:', e);
    return sendJson(res, 500, { error: e?.message || 'Server error' });
  }
};
