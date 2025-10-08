// /api/mascot.js
export const config = { runtime: 'edge' };

/* ------------------------------
   Follow-up minimal format
------------------------------ */
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

/* ------------------------------
   Category synonyms (broad cues)
------------------------------ */
const CAT_SYNONYMS = {
  physical: ["injury", "rehab", "rehabilitation", "fitness", "exercise", "pain", "knee", "shoulder", "mobility"],
  psychological: ["mental", "mood", "anxiety", "depression", "stress", "memory", "thinking", "brain"],
  "brain-health": ["concussion", "head knock", "cte", "post-concussion", "headache", "light sensitivity"],
  career: ["work", "job", "resume", "cv", "learning", "course", "study", "scholarship", "networking"],
  family: ["partner", "carer", "caregiver", "family", "community", "alumni", "regional"],
  cultural: ["indigenous", "aboriginal", "torres strait", "culturally", "spiritual", "faith"],
  identity: ["identity", "foreclosure", "retirement", "lgbtqi", "gender", "sexuality", "inclusion"],
  financial: ["money", "budget", "grant", "superannuation", "financial", "cost"],
  environmental: ["alcohol", "drugs", "gambling", "dependency", "addiction"],
  female: ["women", "female", "motherhood", "menstrual", "pregnancy", "aflw"]
};

/* ------------------------------
   Helpers: links loader & scoring
------------------------------ */
async function loadLinks(req) {
  try {
    // Public assets are available via absolute URL from the request
    const url = new URL('/links.json', req.url);
    const res = await fetch(url.toString(), { cache: 'force-cache' });
    if (!res.ok) return [];
    return await res.json();
  } catch {
    return [];
  }
}

function inferCategoryFromText(text = "") {
  const t = text.toLowerCase();
  // simple heuristic: pick the first category that has ≥1 synonym present
  let best = null;
  let bestHits = 0;
  for (const [cat, words] of Object.entries(CAT_SYNONYMS)) {
    let hits = 0;
    for (const w of words) if (t.includes(w)) hits++;
    if (hits > bestHits) { best = cat; bestHits = hits; }
  }
  return best; // may be null
}

function findBestLinks(links, category, prompt, max = 4) {
  const p = (prompt || "").toLowerCase();
  const cat = (category || "").toLowerCase();

  const synonyms = CAT_SYNONYMS[cat] || [];

  const scored = links.map(l => {
    let score = 0;

    // Category weight
    if (l.category?.some(c => (c || '').toLowerCase() === cat)) score += 5;
    else if (l.category?.some(c => cat && cat.includes((c || '').toLowerCase()))) score += 3;

    // Keyword matches
    if (Array.isArray(l.keywords)) {
      for (const k of l.keywords) {
        if (p.includes((k || '').toLowerCase())) score += 4;
      }
    }

    // Synonym hints for the category
    for (const s of synonyms) {
      if (p.includes(s)) score += 2;
    }

    // Title / domain soft hints
    if (l.title && p.includes(l.title.toLowerCase())) score += 1;
    if (l.domain && p.includes(l.domain.toLowerCase())) score += 1;

    return { ...l, score };
  });

  return scored
    .filter(s => s.score > 0 && s.url)     // must have a resolvable url
    .sort((a, b) => b.score - a.score)
    .slice(0, max)
    .map(({ id, title, url, domain }) => ({ id, title, url, domain }));
}

/* ------------------------------
   OpenAI helpers
------------------------------ */
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

/* ------------------------------
   Request handler
------------------------------ */
export default async function handler(req) {
  if (req.method !== 'POST') return json({ error: 'Use POST' }, 405);

  try {
    const body = await req.json();
    const {
      message,
      followup,
      thread_id: clientThreadId,
      categoryLabel // optional: if you send selected category from UI
    } = body || {};

    if (!message) return json({ error: 'Missing message' }, 400);

    // Load curated links once per request (edge cache will keep this fast)
    const links = await loadLinks(req);

    // Choose category for link matching
    const inferredCategory = (categoryLabel || '').trim() || inferCategoryFromText(message);

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

    // 2) Add user message to thread
    await fetch(`https://api.openai.com/v1/threads/${thread_id}/messages`, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({ role: 'user', content: message }),
    });

    // 3) Create run (override instructions only for follow-ups)
    const runCreateBody = { assistant_id: process.env.OPENAI_ASSISTANT_ID };
    if (followup === true) runCreateBody.instructions = FOLLOWUP_INSTRUCTIONS;

    const runResp = await fetch(`https://api.openai.com/v1/threads/${thread_id}/runs`, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify(runCreateBody),
    });
    const run = await runResp.json();

    // 4) Poll until completion (with guard)
    let status = run.status;
    const run_id = run.id;
    const started = Date.now();
    while (status === 'in_progress' || status === 'queued') {
      if (Date.now() - started > 60000) break; // 60s guard
      await sleep(800);
      const r2 = await fetch(`https://api.openai.com/v1/threads/${thread_id}/runs/${run_id}`, {
        headers: headers(),
      });
      const run2 = await r2.json();
      status = run2.status;
    }

    // 5) Retrieve last assistant message
    const msgsResp = await fetch(
      `https://api.openai.com/v1/threads/${thread_id}/messages?order=desc&limit=1`,
      { headers: headers() }
    );
    const msgs = await msgsResp.json();
    const msg = msgs.data?.[0];
    const rawOutput = msg?.content?.[0]?.text?.value || 'No response';

    // 6) Curate sources from our verified list
    const curatedSources = findBestLinks(links, inferredCategory, message, 4);

    return json({ output: rawOutput, sources: curatedSources, thread_id }, 200);
  } catch (e) {
    console.error(e);
    return json({ error: e?.message || 'Server error' }, 500);
  }
}
