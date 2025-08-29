// api/mascot.js — Healthmate (Chat Completions API; robust & model-switchable)

const RED_FLAGS = [
  /loss of consciousness|passed out/i,
  /seizure|convulsion/i,
  /repeated vomiting/i,
  /worsening headache/i,
  /slurred speech/i,
  /weakness|numbness/i,
  /increasing confusion|very hard to wake/i,
  /fluid from (ear|nose)|bleeding from (ear|nose)/i,
  /severe (neck|back) pain/i
];

const ESCALATION = `**Seek urgent medical care now**
Call **000** or go to the nearest emergency department immediately.

While waiting:
- Keep them still and comfortable.
- Do not give food, drink, or medicines.
- Do not leave them alone. Monitor their breathing and responsiveness.

*Information only — not a medical diagnosis. In an emergency call 000.*`;

export default async function handler(req, res) {
  // CORS
  if (req.method === "OPTIONS") {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
    return res.status(200).end();
  }
  if (req.method !== "POST") {
    res.setHeader("Access-Control-Allow-Origin", "*");
    return res.status(405).json({ error: "Use POST" });
  }

  try {
    const key = process.env.OPENAI_API_KEY;
    if (!key) {
      res.setHeader("Access-Control-Allow-Origin", "*");
      return res.status(500).json({ error: "Missing OPENAI_API_KEY" });
    }

    const { message = "" } = req.body || {};
    const text = String(message).trim();
    if (!text) {
      res.setHeader("Access-Control-Allow-Origin", "*");
      return res.status(400).json({ error: "message required" });
    }

    // Triage red flags first
    if (RED_FLAGS.some(r => r.test(text))) {
      res.setHeader("Access-Control-Allow-Origin", "*");
      return res.status(200).json({ output: ESCALATION });
    }

    const SYSTEM =
      process.env.MASCOT_SYSTEM_PROMPT ||
      "You are the FifthQtr Healthmate, supporting past AFL/AFLW players and families with safe, compassionate, evidence-based guidance. You are not a doctor. Encourage GP follow-up. Include Australian pathways and helplines where appropriate. End every response with: 'This service provides general information only. Please see your GP for medical advice. In an emergency call 000.'";

    // Default to gpt-4o-mini (widely available, inexpensive). You can set OPENAI_MODEL=gpt-4.1 later if chat-completions supports it in your account.
    const model = process.env.OPENAI_MODEL || "gpt-4o-mini";

    const headers = {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${key}`,
    };
    // Only include these if your account requires scoping
    if (process.env.OPENAI_PROJECT_ID) headers["OpenAI-Project"] = process.env.OPENAI_PROJECT_ID;
    if (process.env.OPENAI_ORG_ID)     headers["OpenAI-Organization"] = process.env.OPENAI_ORG_ID;

    const payload = {
      model,
      temperature: 0.3,
      messages: [
        { role: "system", content: SYSTEM },
        { role: "user", content: text }
      ]
    };

    const resp = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers,
      body: JSON.stringify(payload)
    });

    const data = await resp.json().catch(() => ({}));

    if (!resp.ok) {
      const msg =
        data?.error?.message ||
        data?.message ||
        (typeof data === "string" ? data : JSON.stringify(data));
      res.setHeader("Access-Control-Allow-Origin", "*");
      return res.status(resp.status).json({ error: "OpenAI error", detail: msg });
    }

    const content = data?.choices?.[0]?.message?.content;
    const out = (typeof content === "string" && content.trim()) ? content.trim() : "";
    res.setHeader("Access-Control-Allow-Origin", "*");
    if (out) return res.status(200).json({ output: out });

    return res.status(200).json({ output: "I couldn't parse a reply from the model.", detail: data });
  } catch (e) {
    res.setHeader("Access-Control-Allow-Origin", "*");
    return res.status(500).json({ error: String(e) });
  }
}
