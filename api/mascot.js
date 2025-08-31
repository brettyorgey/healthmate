// api/mascot.js — Assistants API v2 + File Search (with citations)

const RED_FLAGS = [
  /loss of consciousness|passed out/i, /seizure|convulsion/i,
  /repeated vomiting/i, /worsening headache/i, /slurred speech/i,
  /weakness|numbness/i, /increasing confusion|very hard to wake/i,
  /fluid from (ear|nose)|bleeding from (ear|nose)/i, /severe (neck|back) pain/i,
];

const ESCALATION = `**Seek urgent medical care now**
Call **000** or go to the nearest emergency department immediately.

While waiting:
- Keep them still and comfortable.
- Do not give food, drink, or medicines.
- Do not leave them alone. Monitor their breathing and responsiveness.

*Information only — not a medical diagnosis. In an emergency call 000.*`;

const POLL_INTERVAL_MS = Number(process.env.ASSISTANT_POLL_INTERVAL_MS || 900);
const MAX_POLL_MS      = Number(process.env.ASSISTANT_MAX_POLL_MS || 45000);

function cors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, OpenAI-Beta");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
}
const ASSISTANTS_BETA = { "OpenAI-Beta": "assistants=v2" };

function isTerminal(status) {
  return ["completed", "failed", "cancelled", "expired"].includes(status);
}
async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function harvestMessageParts(message) {
  let textOut = "";
  const citations = []; // { file_id, quote? }
  for (const part of message?.content || []) {
    if (part?.type === "text" && part?.text?.value) {
      if (textOut) textOut += "\n\n";
      textOut += part.text.value;
      for (const a of (part.text.annotations || [])) {
        if (a?.file_citation?.file_id) {
          citations.push({ file_id: a.file_citation.file_id, quote: a.file_citation.quote || "" });
        }
        if (a?.file_path?.file_id) {
          citations.push({ file_id: a.file_path.file_id });
        }
      }
    }
  }
  return { textOut, citations };
}

export default async function handler(req, res) {
  if (req.method === "OPTIONS") { cors(res); return res.status(200).end(); }
  if (req.method !== "POST")    { cors(res); return res.status(405).json({ error: "Use POST" }); }

  try {
    const key = process.env.OPENAI_API_KEY;
    const assistantId = process.env.OPENAI_ASSISTANT_ID;
    if (!key || !assistantId) { cors(res); return res.status(500).json({ error: "Missing OPENAI_API_KEY or OPENAI_ASSISTANT_ID" }); }

    const { message = "" } = req.body || {};
    const text = String(message).trim();
    if (!text) { cors(res); return res.status(400).json({ error: "message required" }); }

    if (RED_FLAGS.some(r => r.test(text))) {
      cors(res);
      return res.status(200).json({ output: ESCALATION });
    }

    // Common headers (include the beta header on EVERY Assistants call)
    const headers = {
      "Authorization": `Bearer ${key}`,
      "Content-Type": "application/json",
      ...ASSISTANTS_BETA,
    };
    if (process.env.OPENAI_PROJECT_ID) headers["OpenAI-Project"] = process.env.OPENAI_PROJECT_ID;
    if (process.env.OPENAI_ORG_ID)     headers["OpenAI-Organization"] = process.env.OPENAI_ORG_ID;

    // 1) Create thread
    const tResp = await fetch("https://api.openai.com/v1/threads", {
      method: "POST", headers, body: JSON.stringify({})
    });
    const thread = await tResp.json().catch(()=>({}));
    if (!tResp.ok) { cors(res); return res.status(tResp.status).json({ error: "OpenAI error (create thread)", detail: thread }); }

    // 2) Add user message
    const mCreate = await fetch(`https://api.openai.com/v1/threads/${thread.id}/messages`, {
      method: "POST", headers, body: JSON.stringify({ role: "user", content: text })
    });
    const mData = await mCreate.json().catch(()=>({}));
    if (!mCreate.ok) { cors(res); return res.status(mCreate.status).json({ error: "OpenAI error (add message)", detail: mData }); }

    // 3) Start run
    const rResp = await fetch(`https://api.openai.com/v1/threads/${thread.id}/runs`, {
      method: "POST", headers, body: JSON.stringify({ assistant_id: assistantId })
    });
    let run = await rResp.json().catch(()=>({}));
    if (!rResp.ok) { cors(res); return res.status(rResp.status).json({ error: "OpenAI error (start run)", detail: run }); }

    // 4) Poll
    const start = Date.now();
    while (!isTerminal(run.status)) {
      if (Date.now() - start > MAX_POLL_MS) { cors(res); return res.status(504).json({ error: "Assistant run timed out" }); }
      await sleep(POLL_INTERVAL_MS);
      const p = await fetch(`https://api.openai.com/v1/threads/${thread.id}/runs/${run.id}`, {
        method: "GET", headers
      });
      run = await p.json().catch(()=>({}));
      if (!p.ok) { cors(res); return res.status(p.status).json({ error: "OpenAI error (poll run)", detail: run }); }
    }
    if (run.status !== "completed") { cors(res); return res.status(500).json({ error: `Assistant run ${run.status}`, detail: run?.last_error || null }); }

    // 5) Get messages
    const list = await fetch(`https://api.openai.com/v1/threads/${thread.id}/messages?limit=10`, {
      method: "GET", headers
    });
    const listData = await list.json().catch(()=>({}));
    if (!list.ok) { cors(res); return res.status(list.status).json({ error: "OpenAI error (list messages)", detail: listData }); }

    const assistantMsg = (listData?.data || []).find(m => m.role === "assistant");
    if (!assistantMsg) { cors(res); return res.status(200).json({ output: "No response" }); }

    const { textOut, citations } = harvestMessageParts(assistantMsg);

    // De-duplicate citations; resolve filenames
    const seen = new Set(); 
    const unique = [];
    for (const c of citations) {
      if (c.file_id && !seen.has(c.file_id)) {
        seen.add(c.file_id);
        unique.push(c);
      }
    }

    const resolved = [];
    for (const c of unique.slice(0,12)) {
      try {
        const f = await fetch(`https://api.openai.com/v1/files/${c.file_id}`, {
          method: "GET",
          headers: { 
            "Authorization": `Bearer ${key}`, 
            "OpenAI-Beta": "assistants=v2" 
          }
        }).then(r => r.json());
        resolved.push({ 
          file_id: c.file_id, 
          filename: f?.filename || c.file_id, 
          quote: c.quote || "" 
        });
      } catch {
        resolved.push(c);
      }
    }

    let out = textOut || "";
    if (out) {
      out += `\n\nThis service provides general information only. Please see your GP for medical advice. In an emergency call 000.`;
    }

    cors(res);
    return res.status(200).json({
      output: out || "No response",
      sources: resolved.map(x => ({
        file_id: x.file_id,
        filename: x.filename,
        quote: x.quote || ""
      }))
    });
  } catch (e) {
    cors(res);
    return res.status(500).json({ error: String(e) });
  }
}
