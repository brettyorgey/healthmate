// /api/mascot.js
export const config = { runtime: 'edge' };

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

export default async function handler(req) {
  if (req.method !== 'POST') {
    return json({ error: 'Use POST' }, 405);
  }

  try {
    const body = await req.json();
    const { message, cf_token, followup, thread_id: clientThreadId } = body || {};
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

    // 2) Add user message to the SAME thread
    await fetch(`https://api.openai.com/v1/threads/${thread_id}/messages`, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({ role: 'user', content: message }),
    });

    // 3) Create run (override instructions for follow-ups)
    const runCreateBody = { assistant_id: process.env.OPENAI_ASSISTANT_ID };
    if (followup) runCreateBody.instructions = FOLLOWUP_INSTRUCTIONS;

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
      if (Date.now() - started > 60000) break; // 60s guard
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

    const output = msg?.content?.[0]?.text?.value || 'No response';
    const sources = extractSourcesFromMessage(msg);

    // Return the thread_id so the browser can reuse it for follow-ups
    return json({ output, sources, thread_id }, 200);
  } catch (e) {
    console.error(e);
    return json({ error: e?.message || 'Server error' }, 500);
  }
}

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

function extractSourcesFromMessage(msg) {
  const out = [];
  try {
    const block = msg?.content?.[0]?.text;
    const text = block?.value || '';
    const ann = block?.annotations || [];

    // a) File citations from vector store
    for (const a of ann) {
      if (a.type === 'file_citation' && a.file_citation?.file_id) {
        out.push({
          filename: a.file_citation?.title || 'Document',
          file_id: a.file_citation.file_id,
          quote: a.text || ''
        });
      }
      if (a.type === 'file_path' && a.file_path?.file_id) {
        out.push({
          filename: a.file_path?.file_name || 'Attachment',
          file_id: a.file_path.file_id
        });
      }
    }

    // b) Markdown links for web sources
    const linkRe = /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g;
    let m;
    while ((m = linkRe.exec(text)) !== null) {
      out.push({ title: m[1], url: m[2] });
    }
  } catch {}
  return out;
}
