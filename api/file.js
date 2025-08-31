// api/file.js — proxy file download from OpenAI (Assistants v2)
export default async function handler(req, res) {
  try {
    const key = process.env.OPENAI_API_KEY;
    const file_id = req.query?.file_id || req.query?.id || req.query?.fid;
    if (!key || !file_id) {
      res.setHeader("Access-Control-Allow-Origin", "*");
      return res.status(400).send("Missing OPENAI_API_KEY or file_id");
    }
    const r = await fetch(`https://api.openai.com/v1/files/${file_id}/content`, {
      method: "GET",
      headers: {
        "Authorization": `Bearer ${key}`,
        "OpenAI-Beta": "assistants=v2"
      }
    });
    if (!r.ok) {
      const txt = await r.text().catch(()=> "");
      res.setHeader("Access-Control-Allow-Origin", "*");
      return res.status(r.status).send(txt || "OpenAI file fetch error");
    }
    // Stream through with a friendly filename
    const buf = Buffer.from(await r.arrayBuffer());
    res.setHeader("Content-Type", r.headers.get("content-type") || "application/octet-stream");
    res.setHeader("Content-Disposition", `inline; filename="${file_id}.pdf"`);
    res.setHeader("Access-Control-Allow-Origin", "*");
    return res.status(200).send(buf);
  } catch (e) {
    res.setHeader("Access-Control-Allow-Origin", "*");
    return res.status(500).send(String(e));
  }
}
