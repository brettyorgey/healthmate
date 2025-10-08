// /api/mascot.js
// Force Node runtime on Vercel so long runs don’t hit Edge limits.
export const config = { runtime: 'nodejs' };

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

async function loadLinks(req) {
  try {
    const url = new URL('/links.json', req.url);
    const res = await fetch(url.toString(), { cache: 'force-cache' });
    if (!res.ok) return [];
    return await res.json();
  } catch {
    return [];
  }
}

function inferCategoryFromText(text = "") {
  const t = (text || "").toLowerCase();
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

// --- NEW: safe extractor for assistant text content ---
function extractAssistantText(msg){
  if (!msg || !Array.isArray(msg.content)) return null;
  for (const part of msg.content) {
    if (part?.type === 'text' && part.text?.value) return part.text.value;
  }
  return null;
}

async function getJsonOrThrow(url, options) {
  const r = await fetch(url, options);
  const text = await r.text();
  if (!r.ok) throw new Error(`Fetch ${url} failed: ${r.status} ${r.statusText} — ${text.slice(0,200)}`);
  try { return JSON.parse(text); }
  catch (e) { throw new Error(`JSON parse error from ${url}: ${e.message}`); }
}

export default async function handler(req) {
  if (req.method !== 'POST') return json({ error: 'Use POST' }, 405);

  try {
    const body = await req.json();
    const { message, followup, thread_id: clientThreadId, categoryLabel, peek } = body || {};
    if (!peek && !message) return json({ error: 'Missing message' }, 400);

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

    // Add user message (skip in peek)
    if (!peek) {
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

    // Poll (or just check latest in peek)
    const start = Date.now();
    let delay = 700;

    while (true) {
      if (Date.now() - start > 55000) {
        // Let the client poll later
        return json({ pending: true, thread_id }, 202);
      }
      await sleep(delay);
      delay = Math.min(2200, Math.floor(delay * 1.3));

      if (peek) {
        const msgs = await getJsonOrThrow(
          `https://api.openai.com/v1/threads/${thread_id}/messages?order=desc&limit=1`,
          { headers: headers() }
        );
        const msg = msgs.data?.[0];
        if (msg?.role === 'assistant') {
          const text = extractAssistantText(msg) || 'No response';
          const curatedSources = message
            ? findBestLinks(links, inferredCategory, message, 4)
            : [];
          return json({ output: text, sources: curatedSources, thread_id }, 200);
        }
        continue;
      }

      const run2 = await getJsonOrThrow(
        `https://api.openai.com/v1/threads/${thread_id}/runs/${run_id}`,
        { headers: headers() }
      );
      const status = run2.status;

      if (status === 'completed') break;
      if (status === 'failed')  return json({ error: run2.last_error?.message || 'Assistant run failed' }, 502);
      if (status === 'expired' || status === 'cancelled') return json({ error: `Run ${status}` }, 504);
      if (status === 'requires_action') return json({ error: 'Run requires action (tools not handled).' }, 501);
    }

    const msgs = await getJsonOrThrow(
      `https://api.openai.com/v1/threads/${thread_id}/messages?order=desc&limit=1`,
      { headers: headers() }
    );
    const msg = msgs.data?.[0];
    const rawOutput = extractAssistantText(msg) || 'No response';

    const curatedSources = findBestLinks(links, inferredCategory, message, 4);
    return json({ output: rawOutput, sources: curatedSources, thread_id }, 200);
  } catch (e) {
    console.error('mascot error:', e);
    return json({ error: e?.message || 'Server error' }, 500);
  }
}
