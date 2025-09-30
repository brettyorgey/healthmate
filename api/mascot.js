// /api/mascot.js
export const config = { runtime: 'edge' };

const FULL_INSTRUCTIONS = `
INITIAL MODE (FIRST TURN):
Follow your base safety instructions, and produce a FULL structured response with these sections:

1) Headline — ≤12 words summarising the action.
2) What to do now — 3–6 short, clear steps.
3) Why this matters — 1–2 plain-English sentences.
4) Who to contact — GP + specific AU supports (with phone numbers where relevant).
5) What to bring to your appointment — short checklist.
6) Watch for and act on — urgent red-flags list.
7) Sources — bullet list of the exact AU pages used (markdown links).
8) Footer — “Information only — not a medical diagnosis. In an emergency call 000.”

Do not diagnose. Use Australian resources only. Keep tone calm, supportive, stigma-free.
`;

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
  if (req.method !== 'POST') return json({ error: 'Use POST' }, 405);

  try {
    const body = await req.json();
    const { message, followup, thread_id: clientThreadId } = body || {};
    if (!message) return json({ error: 'Missing message' }, 400);

    // 1) Reuse or create thread
    // If the browser claims "followup", reuse; otherwise start fresh.
    let thread_id = (followup === true) ? clientThreadId : undefined;
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

    // 2b) Determine turn number by counting messages in the thread now
    // If there's only 1 message total (the one we just posted), this is the FIRST TURN.
    const countResp = await fetch(
      `https://api.openai.com/v1/threads/${thread_id}/messages?order=asc&limit=2`,
      { headers: headers() }
    );
    const countData = await countResp.json();
    const messageCount = Array.isArray(countData?.data) ? countData.data.length : 0;
    const isFirstTurn = messageCount <= 1;

    // 3) Create run with explicit per-turn instructions
    const mode = isFirstTurn ? 'full' : (followup === true ? 'followup' : 'full');
    const runCreateBody = {
      assistant_id: process.env.OPENAI_ASSISTANT_ID,
      instructions: mode === 'followup' ? FOLLOWUP_INSTRUCTIONS : FULL_INSTRUCTIONS,
    };

    const runResp = await fetch(`https://api.openai.com/v1/threads/${thread_id}/runs`, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify(runCreateBody),
    });
    const run = await runResp.json();

    // 4) Poll
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

    // 5) Fetch last assistant message
    const msgsResp = await fetch(
      `https://api.openai.com/v1/threads/${thread_id}/messages?order=desc&limit=1`,
      { headers: headers() }
    );
    const msgs = await msgsResp.json();
    const msg = msgs.data?.[0];

    const output = msg?.content?.[0]?.text?.value || 'No response';
    const sources = extractSourcesFromMessage(msg);

    // Return debug fields so you can verify behaviour
    return json({
      output,
      sources,
      thread_id,
      mode,                 // "full" or "followup"
      debug: {
        followupReceived: followup === true,
        messageCount,
        isFirstTurn
      }
    }, 200);
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
