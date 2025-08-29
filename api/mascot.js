// api/mascot.js — Vercel Serverless Function (Responses API, gpt-4.1)
// Robust extraction + clear error messages

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

// Safely pull text out of various OpenAI response shapes
function extractText(d) {
  if (!d || typeof d !== "object") return "";

  // Responses API convenience field
  if (typeof d.output_text === "string" && d.output_text.trim()) return d.output_text.trim();

  // Some Responses payloads mirror "message" style objects
  if (Array.isArray(d.output)) {
    // e.g., d.output[0].content[0].text.value
    for (const item of d.output) {
      const content = item?.content;
      if (Array.isArray(content)) {
        for (const part of content) {
          const v = part?.text?.value || part?.content || part?.string;
          if (typeof v === "string" && v.trim()) return v.trim();
        }
      }
    }
  }

  // Chat-style (if the SDK or API returns choices)
  if (Array.isArray(d.choices) && d.choices[0]?.message?.content) {
    const c = d.choices[0].message.content;
    if (Array.isArray(c)) {
      // assistants-style array of parts
      const joined = c.map(p => (p?.text?.value || p?.content || "")).join("\n").trim();
      if (joined) return joined;
    } else if (typeof c === "string" && c.trim()) {
      return c.trim();
    }
  }

  // Some SDKs return data[] with content[]
  if (Array.isArray(d.data)) {
    for (const it of d.data) {
      if (Array.isArray(it?.content)) {
        for (const part of it.content) {
          const v = part?.text?.value || part?.content;
          if (typeof v === "string" && v.trim()) return v.trim();
        }
      }
    }
  }

  return "";
}

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

    const body = req.body || {};
    const message = String(body.message || "").trim();
    if (!message) {
      res.setHeader("Access-Control-Allow-Origin", "*");
      return res.status(400).json({ error: "message required" });
    }

    // Red-flag triage first
    if (RED_FLAGS.some(r => r.test(message))) {
      res.setHeader("Access-Control-Allow-Origin", "*");
      return res.status(200).json({ output: ESCALATION });
    }

    const SYSTEM =
      process.env.MASCOT_SYSTEM_PROMPT ||
      "You are the FifthQtr Healthmate, supporting past AFL/AFLW players and families with safe, compassionate, evidence-based guidance. You are not a doctor. Encourage GP follow-up. Include Australian pathways and helplines where appropriate. End every response with: 'This service provides general information only. Please see your GP for medical advice. In an emergency call 000.'";

    const payload = {
      model: "gpt-4.1",
      temperature: 0.3,
      input: [
        { role: "system", content: SYSTEM },
        { role: "user", content: message }
      ]
    };

    const oa = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${key}`
        // If your org/project requires it, you can add:
        // "OpenAI-Organization": "<org_id>",
        // "OpenAI-Project": "<project_id>",
      },
      body: JSON.stringify(payload)
    });

    const data = await oa.json().catch(() => ({}));

    // After: const data = await oa.json().catch(() => ({}));

    if (!oa.ok) {
      const msg =
      data?.error?.message ||
      data?.message ||
      (typeof data === "string" ? data : JSON.stringify(data));
    res.setHeader("Access-Control-Allow-Origin", "*");
    return res.status(oa.status).json({ error: "OpenAI error", detail: msg });
}

    const text = extractText(data);
    res.setHeader("Access-Control-Allow-Origin", "*");
    if (text) {
      return res.status(200).json({ output: text });
    } else {
      // Surface the raw payload so we can see what shape came back
      return res.status(200).json({ output: "I couldn't find text in the model response.", detail: data });
    }
  } catch (e) {
    res.setHeader("Access-Control-Allow-Origin", "*");
    return res.status(500).json({ error: String(e) });
  }
}
