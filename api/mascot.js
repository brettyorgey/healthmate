// api/mascot.js — Vercel Serverless Function (gpt-4.1)
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
    const { message = "" } = (req.body || {});
    if (!message.trim()) {
      res.setHeader("Access-Control-Allow-Origin", "*");
      return res.status(400).json({ error: "message required" });
    }

    // Red-flag check
    if (RED_FLAGS.some(r => r.test(message))) {
      res.setHeader("Access-Control-Allow-Origin", "*");
      return res.status(200).json({ output: ESCALATION });
    }

    const key = process.env.OPENAI_API_KEY;
    if (!key) {
      res.setHeader("Access-Control-Allow-Origin", "*");
      return res.status(500).json({ error: "Missing OPENAI_API_KEY" });
    }

    const SYSTEM =
      process.env.MASCOT_SYSTEM_PROMPT ||
      "You are the FifthQtr Healthmate, supporting past AFL/AFLW players and families with safe, compassionate, evidence-based guidance. You are not a doctor. Encourage GP follow-up. End every response with: 'This service provides general information only. Please see your GP for medical advice. In an emergency call 000.'";

    const payload = {
      model: "gpt-4.1",
      temperature: 0.3,
      input: [
        { role: "system", content: SYSTEM },
        { role: "user", content: message },
      ],
    };

    const r = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${key}`,
      },
      body: JSON.stringify(payload),
    });

    const data = await r.json();
    res.setHeader("Access-Control-Allow-Origin", "*");
    return res.status(200).json({ output: data?.output_text || "No response" });
  } catch (e) {
    res.setHeader("Access-Control-Allow-Origin", "*");
    return res.status(500).json({ error: String(e) });
  }
}
