// FifthQtr Healthmate — Assistants API + File Search (citations)
// Drop this into: /api/mascot.js  (Vercel serverless function)

const RED_FLAGS = [
  /loss of consciousness|passed out/i,
  /seizure|convulsion/i,
  /repeated vomiting/i,
  /worsening headache/i,
  /slurred speech/i,
  /weakness|numbness/i,
  /increasing confusion|very hard to wake/i,
  /fluid from (ear|nose)|bleeding from (ear|nose)/i,
  /severe (neck|back) pain/i,
];

const ESCALATION = `**Seek urgent medical care now**
Call **000** or go to the nearest emergency department immediately.

While waiting:
- Keep them still and comfortable.
- Do not give food, drink, or medicines.
- Do not leave them alone. Monitor their breathing and responsiveness.

*Information only — not a medical diagnosis. In an emergency call 000.*`;

// Config
const POLL_INTERVAL_MS = Number(process.env.ASSISTANT_POLL_INTERVAL_MS || 900);
const MAX_POLL_MS      = Number(process.env.ASSISTANT_MAX_POLL_MS || 45000); // 45s

function cors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
}

function isTerminal(status) {
  return ["completed", "failed", "cancelled", "expired"].includes(status);
}

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// Build a readable text + collect file citations from an assistant message
function harvestMessageParts(message) {
  let textOut = "";
  const citations = []; // { file_id, quote? }

  for (const part of message?.content || []) {
    if (part?.type === "text" && part?.text?.value) {
      if (textOut) textOut += "\n\n";
      textOut += part.text.value;

      // Citations can arrive as annotations on the text
      const anns = part.text.annotations || [];
      for (const a of anns) {
        if (a?.file_citation?.file_id) {
          citations.push({
            file_id: a.file_citation.file_id,
            quote: a.file_citation.quote || ""
          });
        }
        // Some assistants return a file_path annotation; keep it in case you want to surface links later
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
    if (!key || !assistantId) {
      cors(res);
      return res.status(500).json({ error: "Missing OPENAI_API_KEY or OPENAI_ASSISTANT_ID" });
    }

    const body = req.body || {};
    const message = String(body.message || "").trim();
    if (!message) { cors(res); return res.status(400).json({ error: "message required" }); }

    // Triage first
    if (RED_FLAGS.some(r => r.test(message))) {
      cors(res);
      return res.status(200).json({ output: ESCALATION });
    }

    // --- 1) Create a thread
    const headers = {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${key}`,
    };
    if (process.env.OPENAI_PROJECT_ID) headers["OpenAI-Project"] = process.env.OPENAI_PROJECT_ID;
    if (process.env.OPENAI_ORG_ID)     headers["OpenAI-Organization"] = process.env.OPENAI_ORG_ID;

    const tResp = await fetch("https://api.openai.com/v1/threads", {
      method: "POST",
      headers,
      body: JSON.stringify({})
    });
    if (!tResp.ok) {
      const txt = await tResp.text().catch(() => "");
      cors(res);
      return res.status(tResp.status).json({ error: "OpenAI error (create thread)", detail: txt });
    }
    const thread = await tResp.json();

    // --- 2) Add user message
    const mCreate = await fetch(`https://api.openai.com/v1/threads/${thread.id}/messages`, {
      method: "POST",
      headers,
      body: JSON.stringify({ role: "user", content: message })
    });
    if (!mCreate.ok) {
      const txt = await mCreate.text().catch(() => "");
      cors(res);
      return res.status(mCreate.status).json({ error: "OpenAI error (add message)", detail: txt });
    }

    // --- 3) Run the assistant (uses its File Search vector store)
    const rResp = await fetch(`https://api.openai.com/v1/threads/${thread.id}/runs`, {
      method: "POST",
      headers,
      body: JSON.stringify({ assistant_id: assistantId })
    });
    if (!rResp.ok) {
      const txt = await rResp.text().catch(() => "");
      cors(res);
      return res.status(rResp.status).json({ error: "OpenAI error (start run)", detail: txt });
    }
    let run = await rResp.json();

    // --- 4) Poll until completed or terminal
    const start = Date.now();
    while (!isTerminal(run.status)) {
      if (Date.now() - start > MAX_POLL_MS) {
        cors(res);
        return res.status(504).json({ error: "Assistant run timed out" });
      }
      await sleep(POLL_INTERVAL_MS);
      const p = await fetch(`https://api.openai.com/v1/threads/${thread.id}/runs/${run.id}`, {
        headers: { "Authorization": `Bearer ${key}` }
      });
      run = await p.json();
    }

    if (run.status !== "completed") {
      cors(res);
      return res.status(500).json({ error: `Assistant run ${run.status}`, detail: run?.last_error || null });
    }

    // --- 5) Read back the assistant's latest message
    const list = await fetch(`https://api.openai.com/v1/threads/${thread.id}/messages?limit=10`, {
      headers: { "Authorization": `Bearer ${key}` }
    });
    if (!list.ok) {
      const txt = await list.text().catch(() => "");
      cors(res);
      return res.status(list.status).json({ error: "OpenAI error (list messages)", detail: txt });
    }
    const mData = await list.json();
    // Messages usually come newest-first; find the first assistant message
    const assistantMsg = (mData?.data || []).find(m => m.role === "assistant");
    if (!assistantMsg) {
      cors(res);
      return res.status(200).json({ output: "No response" });
    }

    const { textOut, citations } = harvestMessageParts(assistantMsg);

    // De-duplicate by file_id
    const seen = new Set();
    const unique = [];
    for (const c of citations) {
      if (c.file_id && !seen.has(c.file_id)) { seen.add(c.file_id); unique.push(c); }
    }

    // Resolve filenames (best-effort; ignore errors). Cap to avoid long chains.
    const resolved = [];
    for (const c of unique.slice(0, 12)) {
      try {
        const f = await fetch(`https://api.openai.com/v1/files/${c.file_id}`, {
          headers: { "Authorization": `Bearer ${key}` }
        }).then(r => r.json());
        resolved.push({ ...c, filename: f?.filename || c.file_id });
      } catch {
        resolved.push(c);
      }
    }

    // Build Sources section
    let out = textOut || "";
    if (resolved.length) {
      const bullets = resolved.map((c, i) =>
        `- [${i + 1}] ${c.filename}${c.quote ? ` — “${c.quote}”` : ""}`
      ).join("\n");
      out += `\n\n**Sources**\n${bullets}`;
    }

    // Safety footer (belt & braces; your Assistant’s instructions should also set this)
    if (out) {
      out += `\n\nThis service provides general information only. Please see your GP for medical advice. In an emergency call 000.`;
    }

    cors(res);
    return res.status(200).json({ output: out || "No response" });

  } catch (e) {
    cors(res);
    return res.status(500).json({ error: String(e) });
  }
}
