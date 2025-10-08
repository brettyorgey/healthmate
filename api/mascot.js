// /api/mascot.js
export const config = { runtime: 'nodejs' };

/* ---------------------- constants ---------------------- */

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

/* ---------------------- helpers ---------------------- */

function headers() {
  return {
    'Authorization': `Bearer ${process.env.OPENAI_API_KEY || ''}`,
    'Content-Type': 'application/json',
    'OpenAI-Beta': 'assistants=v2',
  };
}

function envHint(){
  const missing = [];
  if (!process.env.OPENAI_API_KEY) missing.push('OPENAI_API_KEY');
  if (!process.env.OPENAI_ASSISTANT_ID) missing.push('OPENAI_ASSISTANT_ID');
  return missing.length ? `Missing env var(s): ${missing.join(', ')}.` : null;
}

function sleep(ms){ return new Promise(r => setTimeout(r, ms)); }

async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString('utf8') || '{}';
  try { return JSON.parse(raw); } catch { return {}; }
}

function baseOrigin(req){
  const proto = req.headers['x-forwarded-proto'] || 'https';
  const host  = req.headers['x-forwarded-host'] || req.headers.host;
  return `${proto}://${host}`;
}

async function loadLinks(req) {
  try {
    const res = await fetch(`${baseOrigin(req)}/links.json`, { cache: 'no-store' });
    if (!res.ok) return [];
    return await res.json();
  } catch {
    return [];
  }
}

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
  if (link.title  && p.includes(link.title.toLowerCase()))  score += 1;
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
  if (bestCat >= 4) {
    filtered = scored.filter(s => s.catScore >= 4);
  } else {
    const hasKW = scored.some(s => s.kwHits > 0);
    if (hasKW) filtered = scored.filter(s => s.kwHits > 0);
  }

  return filtered
    .sort((a,b) => b.score - a.score)
    .slice(0, max)
    .map(({ id, title, url, domain }) => ({ id, title, url, domain }));
}

async function getJsonOrThrow(url, options, timeoutMs = 45000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { ...options, signal: ctrl.signal });
    const raw = await r.text();

    if (!r.ok) {
      let detail = 'unknown';
      try { detail = JSON.parse(raw)?.error?.message || JSON.parse(raw)?.message || raw.slice(0,200); }
      catch { detail = raw.slice(0,200); }
      const env = envHint();
      throw new Error(`HTTP ${r.status} from OpenAI: ${detail}${env ? ` — ${env}` : ''}`);
    }

    try { return JSON.parse(raw); }
    catch (e) { throw new Error(`JSON parse error: ${e.message}`); }

  } catch (e) {
    if (e.name === 'AbortError') {
      throw new Error('Timeout: OpenAI took too long to respond (over 45 s).');
    }
    throw e;
  } finally {
    clearTimeout(t);
  }
}

function latestAssistantMessage(messages){
  const all = Array.isArray(messages?.data) ? messages.data : [];
  return all
    .filter(m => m.role === 'assistant')
    .sort((a,b) => (b.created_at||0) - (a.created_at||0))[0] || null;
}

/* ---------------------- handler ---------------------- */

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Use POST' });
  }

  const envMissing = envHint();
  if (envMissing) {
    return res.status(500).json({ error: envMissing });
  }

  try {
    const body = await readJsonBody(req);
    const { message, followup, thread_id: clientThreadId, categoryLabel, peek } = body || {};

    if (peek && !clientThreadId) {
      return res.status(400).json({ error: 'Missing thread_id for peek' });
    }

    const links = await loadLinks(req);
    const inferredCategory =
      (categoryLabel || '').trim().toLowerCase() || (message ? inferCategoryFromText(message) : null);

    // Create or reuse thread (unless we’re just peeking)
    let thread_id = clientThreadId;
    const firstTurn = !thread_id && !peek;
    if (firstTurn) {
      const thread = await getJsonOrThrow('https://api.openai.com/v1/threads', {
        method: 'POST',
        headers: headers()
      });
      thread_id = thread.id;
    }

    // Add user message (skip in peek)
    if (!peek) {
      if (!message) return res.status(400).json({ error: 'Missing message' });
      await getJsonOrThrow(`https://api.openai.com/v1/threads/${thread_id}/messages`, {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({ role: 'user', content: message }),
      });
    }

    // Create run (skip in peek)
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

    // Short server-side poll (~10s), then let client peek
    const start = Date.now();
    let delay = 600;

    while (true) {
      if (Date.now() - start > 10000) {
        return res.status(202).json({ pending: true, thread_id });
      }
      await sleep(delay);
      delay = Math.min(1500, Math.floor(delay * 1.3));

      if (peek) {
        const msgs = await getJsonOrThrow(
          `https://api.openai.com/v1/threads/${thread_id}/messages?order=desc&limit=10`,
          { headers: headers() }
        );
        const msg = latestAssistantMessage(msgs);
        if (msg) {
          const part = msg?.content?.find?.(c => c.type === 'text');
          const rawOutput = part?.text?.value || 'No response';
          const curatedSources = message
            ? findBestLinks(links, inferredCategory, message, 4)
            : [];
          return res.status(200).json({ output: rawOutput, sources: curatedSources, thread_id });
        }
        continue;
      }

      const run2 = await getJsonOrThrow(
        `https://api.openai.com/v1/threads/${thread_id}/runs/${run_id}`,
        { headers: headers() }
      );
      const status = run2.status;

      if (status === 'completed') break;
      if (status === 'failed')  return res.status(502).json({ error: `OpenAI run failed: ${run2.last_error?.message || 'unknown'}` });
      if (status === 'expired' || status === 'cancelled') return res.status(504).json({ error: `OpenAI run ${status}` });
      if (status === 'requires_action') return res.status(501).json({ error: 'OpenAI run requires action (tools not handled).' });
    }

     // Completed: fetch messages and return the first assistant message only
      const msgs = await getJsonOrThrow(
      `https://api.openai.com/v1/threads/${thread_id}/messages?order=desc&limit=10`,
      { headers: headers() }
    );

    // find the most recent assistant message
    const firstAssistant = (msgs.data || []).find(m => m.role === 'assistant');
    if (!firstAssistant) {
    // run says completed but the message hasn't landed yet (race) → tell client to poll
    return json({ pending: true, thread_id }, 202);
    }

    // extract text safely
    const textBlock = (firstAssistant.content || []).find(c => c.type === 'text');
    const rawOutput = textBlock?.text?.value?.trim() || '(empty)';

    // curate links based on the user’s prompt/category
    const curatedSources = findBestLinks(links, inferredCategory, message, 4);

    return json({ output: rawOutput, sources: curatedSources, thread_id }, 200);
 
  }
}
