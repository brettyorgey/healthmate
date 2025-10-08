// /api/mascot.js
export const config = { runtime: 'edge' }; // ✅ Use Edge (Response API is valid here)

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

function okHeaders() {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error('Missing OPENAI_API_KEY');
  return {
    'Authorization': `Bearer ${key}`,
    'Content-Type': 'application/json',
    'OpenAI-Beta': 'assistants=v2',
  };
}
function json(obj, status=200){
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}
function sleep(ms){ return new Promise(r => setTimeout(r, ms)); }

async function loadLinks(req) {
  try {
    const url = new URL('/links.json', req.url);
    const res = await fetch(url.toString(), { cache: 'force-cache' });
    if (!res.ok) return [];
    return await res.json();
  } catch { return []; }
}

function inferCategoryFromText(text="") {
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
  if (link.title && p.includes(link.title.toLowerCase())) score += 1;
  if (link.domain && p.includes((link.domain||'').toLowerCase())) score += 1;

  return { score, catScore, kwHits };
}

function findBestLinks(links, category, prompt, max=4) {
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

async function getJsonOrThrow(url, options, stageLabel) {
  const r = await fetch(url, options);
  const text = await r.text();
  if (!r.ok) {
    throw new Error(`${stageLabel}: ${r.status} ${r.statusText} — ${text.slice(0,180)}`);
  }
  try { return JSON.parse(text); }
  catch (e) { throw new Error(`${stageLabel}: JSON parse error — ${e.message}`); }
}

// Keep server open only briefly (Edge has stricter timeouts)
const FIRST_POLL_CEILING_MS = 3000;

export default async function handler(req) {
  if (req.method !== 'POST') return json({ error: 'Use POST' }, 405);

  let stage = 'init';
  try {
    if (!process.env.OPENAI_ASSISTANT_ID) {
      return json({ error: 'Missing OPENAI_ASSISTANT_ID' }, 500);
    }

    const body = await req.json();
    const { message, followup, thread_id: clientThreadId, categoryLabel, peek } = body || {};

    const links = await loadLinks(req);
    const inferredCategory =
      (categoryLabel || '').trim().toLowerCase() || (message ? inferCategoryFromText(message) : null);

    // Peeking: just check if an assistant reply exists already
    if (peek) {
      if (!clientThreadId) return json({ error: 'Missing thread_id for peek' }, 400);
      stage = 'peek:get-messages';
      const msgs = await getJsonOrThrow(
        `https://api.openai.com/v1/threads/${clientThreadId}/messages?order=desc&limit=1`,
        { headers: okHeaders() },
        stage
      );
      const msg = msgs.data?.[0];
      if (msg?.role === 'assistant') {
        const rawOutput = msg?.content?.[0]?.text?.value || 'No response';
        const curatedSources = message ? findBestLinks(links, inferredCategory, message, 4) : [];
        return json({ output: rawOutput, sources: curatedSources, thread_id: clientThreadId }, 200);
      }
      return json({ pending: true, thread_id: clientThreadId }, 202);
    }

    if (!message) return json({ error: 'Missing message' }, 400);

    // Create or reuse a thread
    let thread_id = clientThreadId;
    if (!thread_id) {
      stage = 'thread:create';
      const thread = await getJsonOrThrow('https://api.openai.com/v1/threads', {
        method: 'POST', headers: okHeaders()
      }, stage);
      thread_id = thread.id;
    }

    // Add user message
    stage = 'message:add';
    await getJsonOrThrow(`https://api.openai.com/v1/threads/${thread_id}/messages`, {
      method: 'POST',
      headers: okHeaders(),
      body: JSON.stringify({ role: 'user', content: message }),
    }, stage);

    // Create a short-run
    stage = 'run:create';
    const runCreateBody = { assistant_id: process.env.OPENAI_ASSISTANT_ID };
    // Only simplify for follow-ups (not first turn)
    if (clientThreadId && followup === true) runCreateBody.instructions = FOLLOWUP_INSTRUCTIONS;

    const run = await getJsonOrThrow(`https://api.openai.com/v1/threads/${thread_id}/runs`, {
      method: 'POST', headers: okHeaders(), body: JSON.stringify(runCreateBody)
    }, stage);

    // Very short poll (Edge-safe). If not done, let the browser keep peeking.
    const start = Date.now();
    let delay = 300;

    while (Date.now() - start < FIRST_POLL_CEILING_MS) {
      await sleep(delay);
      delay = Math.min(900, Math.floor(delay * 1.5));

      stage = 'run:poll';
      const run2 = await getJsonOrThrow(
        `https://api.openai.com/v1/threads/${thread_id}/runs/${run.id}`,
        { headers: okHeaders() },
        stage
      );
      if (run2.status === 'completed') {
        stage = 'messages:get';
        const msgs = await getJsonOrThrow(
          `https://api.openai.com/v1/threads/${thread_id}/messages?order=desc&limit=1`,
          { headers: okHeaders() },
          stage
        );
        const msg = msgs.data?.[0];
        const rawOutput = msg?.content?.[0]?.text?.value || 'No response';
        const curatedSources = findBestLinks(links, inferredCategory, message, 4);
        return json({ output: rawOutput, sources: curatedSources, thread_id }, 200);
      }
      if (run2.status === 'failed')   return json({ error: 'run failed', detail: run2.last_error?.message, stage }, 502);
      if (run2.status === 'expired')  return json({ error: 'run expired', stage }, 504);
      if (run2.status === 'cancelled')return json({ error: 'run cancelled', stage }, 504);
      if (run2.status === 'requires_action') return json({ error: 'requires_action not handled', stage }, 501);
    }

    // Not finished yet — tell client to keep peeking
    return json({ pending: true, thread_id }, 202);

  } catch (e) {
    // Surface which stage failed
    return json({ error: e?.message || 'Server error', stage }, 500);
  }
}
