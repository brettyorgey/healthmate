// /api/mascot.js
export const config = { runtime: 'edge' };

// Fallback simplified follow-up instruction
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

// Cached registry
let LINK_REGISTRY = null;
let REGISTRY_TIMESTAMP = 0;
const REGISTRY_TTL_MS = 1000 * 60 * 10; // 10 minutes

export default async function handler(req) {
  if (req.method !== "POST") {
    return json({ error: "Use POST" }, 405);
  }

  try {
    const body = await req.json();
    const { message, followup, thread_id: clientThreadId } = body || {};
    if (!message) return json({ error: "Missing message" }, 400);

    // Load or refresh verified links
    await ensureRegistry();

    // 1. Reuse or create thread
    let thread_id = clientThreadId;
    if (!thread_id) {
      const threadResp = await fetch("https://api.openai.com/v1/threads", {
        method: "POST",
        headers: headers(),
      });
      const thread = await threadResp.json();
      thread_id = thread.id;
    }

    // 2. Add message
    await fetch(`https://api.openai.com/v1/threads/${thread_id}/messages`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ role: "user", content: message }),
    });

    // 3. Create run (simplified instructions for follow-ups)
    const runCreateBody = { assistant_id: process.env.OPENAI_ASSISTANT_ID };
    if (followup) runCreateBody.instructions = FOLLOWUP_INSTRUCTIONS;

    const runResp = await fetch(
      `https://api.openai.com/v1/threads/${thread_id}/runs`,
      {
        method: "POST",
        headers: headers(),
        body: JSON.stringify(runCreateBody),
      }
    );
    const run = await runResp.json();

    // 4. Poll for completion
    let status = run.status;
    const run_id = run.id;
    const started = Date.now();
    while (status === "in_progress" || status === "queued") {
      if (Date.now() - started > 60000) break;
      await sleep(800);
      const r2 = await fetch(
        `https://api.openai.com/v1/threads/${thread_id}/runs/${run_id}`,
        { headers: headers() }
      );
      const run2 = await r2.json();
      status = run2.status;
    }

    // 5. Fetch last assistant message
    const msgsResp = await fetch(
      `https://api.openai.com/v1/threads/${thread_id}/messages?order=desc&limit=1`,
      { headers: headers() }
    );
    const msgs = await msgsResp.json();
    const msg = msgs.data?.[0];
    const output = msg?.content?.[0]?.text?.value || "No response";

    // 6. Try to attach known, verified sources
    const sources = matchSources(output, message);

    return json({ output, sources, thread_id }, 200);
  } catch (e) {
    console.error("Mascot error:", e);
    return json({ error: e?.message || "Server error" }, 500);
  }
}

/* -------------------- Helpers -------------------- */

function headers() {
  return {
    Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
    "Content-Type": "application/json",
    "OpenAI-Beta": "assistants=v2",
  };
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/* --------- Link Registry & Matching ---------- */

async function ensureRegistry() {
  const now = Date.now();
  if (LINK_REGISTRY && now - REGISTRY_TIMESTAMP < REGISTRY_TTL_MS) return;
  const res = await fetch(`${process.env.NEXT_PUBLIC_BASE_URL || ""}/links.json`);
  if (!res.ok) throw new Error("Could not load links registry");
  LINK_REGISTRY = await res.json();
  REGISTRY_TIMESTAMP = now;
}

function matchSources(output, query) {
  if (!LINK_REGISTRY) return [];
  const text = `${output} ${query}`.toLowerCase();
  const matches = [];

  for (const link of LINK_REGISTRY) {
    const keywords = [
      link.title,
      ...(link.keywords || []),
      ...(link.category || []),
    ]
      .join(" ")
      .toLowerCase();

    const score = keywords.split(/\s+/).reduce((acc, k) => {
      return acc + (text.includes(k) ? 1 : 0);
    }, 0);

    if (score > 0) matches.push({ ...link, score });
  }

  return matches
    .sort((a, b) => b.score - a.score)
    .slice(0, 5)
    .map((m) => ({
      title: m.title,
      url: m.url,
      domain: m.domain,
    }));
}
