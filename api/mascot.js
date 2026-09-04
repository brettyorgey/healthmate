// /api/mascot.js — Responses API migration
// CommonJS, safe for Vercel Node serverless.
// Preserves the existing frontend contract: POST -> 202 { pending, thread_id }
// and peek polling with { peek: true, thread_id }.
// IMPORTANT: thread_id is retained as the client-facing field name for compatibility,
// but it now contains an OpenAI Response ID (resp_...), not an Assistants Thread ID.

module.exports.config = { runtime: 'nodejs' };

/* -------------------- Healthmate instructions -------------------- */
const HEALTHMATE_INSTRUCTIONS = `
You are FifthQtr Healthmate (Beta) — a cautious, Australia-based information assistant for sports alumni, their families, partners, friends, and club officials.

MISSION
Provide calm, trustworthy, stigma-free guidance on wellbeing, life transitions, and community connection after sport. You provide general information only and you never diagnose, prescribe, or provide medication instructions.

KNOWLEDGE SOURCES — CRITICAL CONSTRAINT
You have access to the FifthQtr knowledge base through the File Search tool.

Mandatory process:
1. ALWAYS use File Search first to search the FifthQtr knowledge base.
2. ONLY answer factual questions using documents returned by File Search.
3. Cite every factual claim using exact document names from the search results.
4. If File Search returns no relevant results, use the Limited Information Available template below.

Do NOT:
- Answer factual questions from general knowledge without searching first.
- Cite documents that were not returned by File Search.
- Mention specific people, organisations, or resources unless they are present in the search results, except for the approved general helplines in the Limited Information Available template.
- Make up information to be helpful.

CITATIONS — MANDATORY
Every factual claim must be cited using documents returned by File Search.

Citation format:
<cite source="exact-filename-from-search.pdf">Your claim here</cite>

Citation rules:
1. Use exact document names from File Search results.
2. Only cite facts explicitly stated in the documents.
3. Paraphrase; do not copy long passages verbatim.
4. Multiple claims from the same document may share one citation.

WHEN FILE SEARCH RETURNS NO RELEVANT RESULTS
Use this template:

**[Topic] - Limited Information Available**

**Why this matters**
[1-2 sentences of general explanation. No citations required.]

**What to do now**
1. Book an appointment with your GP to discuss [topic].
2. They can provide personalised advice and referrals.
3. Bring any questions or concerns you have.

**Who to contact**
- GP (for assessment and referral)
- Relevant Australian helpline where appropriate:
  - Lifeline: 13 11 14
  - Beyond Blue: 1300 22 4636
  - Dementia Australia: 1800 100 500
- FifthQtr for athlete-specific support

**Note**
This specific topic is not currently covered in detail in the FifthQtr knowledge base. The guidance above is general — your GP can provide information tailored to your situation.

Information only — not a medical diagnosis. In an emergency call 000.

TONE
Supportive and conversational, never clinical or authoritative. Respect identity, culture, and gender diversity.

Adjust tone by topic:
- Psychological (mental health, concussion, cognition, memory, brain): empathetic, plain English, normalise challenges, emphasise early action and medical review.
- Physical: practical, evidence-based, safety-first.
- Career: optimistic, transferable skills, purposeful.
- Family: warm, validating, connection-focused.
- Cultural / Spiritual: inclusive, reflective language.
- Financial: calm, simple, pragmatic.
- Environmental Risks: harm-reduction, non-judgmental.
- Identity: transition, inclusion, and belonging.
- Women's Health: supportive and normalising, care pathways.
- Aged Care: three-layer navigation framework.

SAFETY — URGENT ESCALATION
If the user describes urgent red flags, respond with:
"⚠️ Call 000 or go to urgent care now if experiencing:
- Sudden, severe, or worsening headache
- Repeated vomiting
- Seizure or collapse
- Rapidly worsening confusion
- Trouble speaking or walking
- New weakness or numbness
- Severe neck pain
- Head injury with loss of consciousness"

If caring for someone, advise not leaving them alone and monitoring breathing and responsiveness.
Safety warnings do not require citations.

RESPONSE FORMAT — FIRST RESPONSE TO A NEW TOPIC WITH SEARCH RESULTS
1. Headline (12 words or fewer)
2. Why this matters — 3–4 sentences with inline citations using <cite source="filename">...</cite>
3. What to do now
   1. [Step — cite if from search results]
   2. [Step — cite if from search results]
   3. [Step — general advice, no citation needed]
4. Who to contact
   - GP (bring symptom diary and history)
   - [Specific Australian service from retrieved documents, cited]
   - [General helplines where appropriate — no citation required]
5. What to bring
   - ✓ [Item — cite if it is a specific recommendation from retrieved documents]
   - ✓ [Item — general advice, no citation needed]
6. Watch for and act on — ⚠️ Call 000 if experiencing relevant red flags
7. Sources
   - [Exact Document Name]: [Readable description of content]
   - List ONLY documents actually returned by File Search and cited above.

FOLLOW-UP RESPONSE WITH SEARCH RESULTS
**Why this matters**
[Short explanation with inline citations using exact retrieved filenames.]

**Sources**
- [Exact Document Name]: [Readable description]

ANY RESPONSE WITH NO RELEVANT SEARCH RESULTS
Use the Limited Information Available template above.

MANDATORY FOOTER — ALWAYS
End every response with exactly:
"Information only — not a medical diagnosis. In an emergency call 000."

PRIVACY
- Do not request unnecessary personal details.
- Do not store or repeat sensitive personal health information unnecessarily.
- Where appropriate, offer: "Would you like to copy this summary for your GP?"

SELF-CHECK BEFORE RESPONDING
Before answering, verify:
1. Did I use File Search?
2. Did it return relevant documents?
3. Am I citing ONLY those documents?
4. Are citations using exact document names from search?
5. If there were no relevant results, am I using the Limited Information Available template?
If the answer to any item is no, revise the response before returning it.
`;

const FOLLOWUP_INSTRUCTIONS = `
This is a follow-up within an existing Healthmate conversation.
Keep the response brief and in plain English while preserving all Healthmate knowledge, citation, safety, privacy, and footer requirements above.
Focus on clarifying or extending the earlier answer and on why the information matters.
`;

const MAX_SOURCES = 4;
const LINK_VERIFY_MODE = (process.env.LINK_VERIFY || '').toLowerCase();
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-5.6-terra';

const CAT_SYNONYMS = {
  physical: ["injury","rehab","rehabilitation","fitness","exercise","pain","knee","shoulder","hip","ankle","physio","physiotherapy","mobility","strength"],
  psychological: ["mental","mood","anxiety","depression","stress","relationship","support"],
  "brain-health": ["concussion","cte","head knock","post-concussion","headache","light sensitivity","memory","thinking","cognition"],
  career: ["work","job","resume","cv","learning","course","study","scholarship","networking","mentoring"],
  family: ["partner","carer","caregiver","family","community","alumni","regional"],
  cultural: ["indigenous","aboriginal","torres strait","culturally","spiritual","faith"],
  identity: ["identity","foreclosure","retirement","lgbtqi","gender","sexuality","inclusion"],
  financial: ["money","budget","grant","superannuation","financial","cost"],
  environmental: ["alcohol","drugs","gambling","dependency","addiction"],
  female: ["women","female","motherhood","menstrual","pregnancy","aflw"],
  aged_care: ["care","housing","support","respite","residential"]
};

/* -------------------- helpers -------------------- */
function apiHeaders() {
  return {
    'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
    'Content-Type': 'application/json'
  };
}

function sendJson(res, status, obj) {
  res.status(status).setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(obj));
}

async function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    try {
      if (req.body && typeof req.body === 'object') return resolve(req.body);
      let data = '';
      req.on('data', chunk => (data += chunk));
      req.on('end', () => {
        try { resolve(data ? JSON.parse(data) : {}); }
        catch { reject(new Error('Invalid JSON body')); }
      });
    } catch (e) { reject(e); }
  });
}

async function fetchWithTimeout(url, opts = {}, ms = 15000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try {
    return await fetch(url, { ...opts, signal: ctl.signal });
  } finally {
    clearTimeout(t);
  }
}

async function getJsonOrThrow(url, options, timeoutMs = 15000, retries = 1) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const r = await fetchWithTimeout(url, options, timeoutMs);
      const text = await r.text();
      if (!r.ok) throw new Error(`Fetch ${url} failed: ${r.status} ${r.statusText} — ${text.slice(0,500)}`);
      try { return JSON.parse(text); }
      catch (e) { throw new Error(`JSON parse error from ${url}: ${e.message}`); }
    } catch (e) {
      lastErr = e;
      const msg = String(e?.message || e);
      const isAbort = msg.includes('Abort') || msg.includes('aborted') || msg.includes('AbortError');
      if (attempt < retries && isAbort) continue;
      break;
    }
  }
  throw lastErr;
}

function baseUrlFromReq(req) {
  const host = req.headers['x-forwarded-host'] || req.headers.host || process.env.VERCEL_URL;
  const proto = req.headers['x-forwarded-proto'] || 'https';
  if (!host) return 'http://localhost:3000';
  return `${proto}://${host}`;
}

function extractResponseText(response) {
  if (!response) return null;
  if (typeof response.output_text === 'string' && response.output_text.trim()) {
    return response.output_text.trim();
  }

  const parts = [];
  for (const item of (response.output || [])) {
    if (item?.type !== 'message') continue;
    for (const content of (item.content || [])) {
      if (content?.type === 'output_text' && typeof content.text === 'string') {
        parts.push(content.text);
      }
    }
  }
  const text = parts.join('\n').trim();
  return text || null;
}

/* -------------------- user-friendly citation formatting -------------------- */
function filenameToDisplayTitle(filename = '') {
  return String(filename)
    .replace(/^.*[\\/]/, '')
    .replace(/\.[A-Za-z0-9]{1,8}$/, '')
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\bAnd\b/g, 'and')
    .replace(/\bFor\b/g, 'for')
    .replace(/\bOf\b/g, 'of')
    .replace(/\bThe\b/g, 'the')
    .replace(/^./, c => c.toUpperCase());
}

/**
 * Healthmate asks the model to use exact filenames inside <cite> tags so that
 * grounding can be audited. This function keeps that internal traceability but
 * converts the raw markup into a cleaner user-facing form:
 *
 *   <cite source="document-name.pdf">Claim</cite>
 * becomes
 *   Claim [1]
 *
 * It also replaces raw filenames elsewhere in the response (especially the
 * model-generated Sources section) with readable titles.
 */
function formatCitationsForUser(rawText) {
  if (!rawText) return { text: rawText, citations: [] };

  // Models/Markdown renderers sometimes escape the angle brackets. Normalise
  // those variants before parsing.
  let text = String(rawText)
    .replace(/\\<cite\b/gi, '<cite')
    .replace(/\\<\/cite\>/gi, '</cite>');

  const citations = [];
  const byFilename = new Map();
  const citeRegex = /<cite\s+source=["']([^"']+)["']\s*>([\s\S]*?)<\/cite>/gi;

  text = text.replace(citeRegex, (_match, filename, claim) => {
    const cleanFilename = String(filename).trim();
    let number = byFilename.get(cleanFilename);

    if (!number) {
      number = citations.length + 1;
      byFilename.set(cleanFilename, number);
      citations.push({
        number,
        filename: cleanFilename,
        title: filenameToDisplayTitle(cleanFilename)
      });
    }

    return `${String(claim).trim()} [${number}]`;
  });

  // Replace raw filenames anywhere else in the response with readable titles.
  for (const citation of citations) {
    const escaped = citation.filename.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    text = text.replace(new RegExp(escaped, 'g'), citation.title);
  }

  // Remove any model-generated Sources section. We rebuild it deterministically
  // from the citations actually parsed above, so [1], [2], etc. always have a
  // matching readable source entry.
  text = text.replace(
    /(?:^|\n)\s*(?:#{1,6}\s*)?\*{0,2}Sources\*{0,2}\s*\n[\s\S]*?(?=\n\s*#{1,6}\s+|\n\s*Information only\s+—|$)/gi,
    '\n'
  );

  // Normalise ordered-list formatting. The model can emit escaped Markdown
  // markers (1\\.) or place multiple numbered steps on one line. Convert these
  // to standard Markdown list items on separate lines.
  text = text
    .replace(/(^|\n)\s*(\d+)\\\.\s+/g, '$1$2. ')
    .replace(/\s{2,}(\d+)\\?\.\s+/g, '\n$1. ')
    .replace(/(^|\n)\s+(\d+)\.\s+/g, '$1$2. ');

  if (citations.length) {
    const footer = 'Information only — not a medical diagnosis. In an emergency call 000.';
    const sourceBlock = `## References used\n${citations.map(c => `${c.number}. ${c.title}`).join('\n')}`;
    const footerIndex = text.lastIndexOf(footer);

    if (footerIndex >= 0) {
      const before = text.slice(0, footerIndex).trimEnd();
      const after = text.slice(footerIndex).trimStart();
      text = `${before}\n\n${sourceBlock}\n\n${after}`;
    } else {
      text = `${text.trimEnd()}\n\n${sourceBlock}`;
    }
  }

  return { text: text.trim(), citations };
}

/* -------------------- links.json (cached) -------------------- */
const LINKS_CACHE = { data: null, ts: 0 };
async function loadLinks(req) {
  const now = Date.now();
  if (LINKS_CACHE.data && (now - LINKS_CACHE.ts) < 120000) return LINKS_CACHE.data;
  try {
    const r = await fetchWithTimeout(`${baseUrlFromReq(req)}/links.json`, { cache: 'no-store' }, 4000);
    if (!r.ok) return LINKS_CACHE.data || [];
    const data = await r.json();
    LINKS_CACHE.data = Array.isArray(data) ? data : [];
    LINKS_CACHE.ts = now;
    return LINKS_CACHE.data;
  } catch {
    return LINKS_CACHE.data || [];
  }
}

/* -------------------- category normalisation -------------------- */
function normalizeCategoryKey(input) {
  if (!input) return null;
  const s = String(input).trim().toLowerCase();
  const map = {
    'physical': 'physical',
    'psychological': 'psychological',
    'brain-health': 'brain-health',
    'brain health': 'brain-health',
    'career': 'career',
    'family': 'family',
    'cultural': 'cultural',
    'identity': 'identity',
    'financial': 'financial',
    'environmental': 'environmental',
    'female': 'female',
    'aged care': 'aged_care',
    'aged_care': 'aged_care'
  };
  return map[s] || null;
}

function canonicalFromLabel(label='') {
  const head = (label.split('–')[0] || label).trim().toLowerCase();
  return normalizeCategoryKey(head);
}

/* -------------------- link utilities -------------------- */
function safeUrlOrNull(u){
  try {
    const url = new URL(u);
    if (!/^https?:$/.test(url.protocol)) return null;
    return url.toString();
  } catch {
    return null;
  }
}

function domainOf(u){
  try { return new URL(u).hostname.replace(/^www\./,'').toLowerCase(); }
  catch { return ''; }
}

function dedupeByDomain(arr){
  const seen = new Set();
  const out = [];
  for (const s of arr){
    const d = domainOf(s.url || '');
    const key = d || (s.url || s.title || '');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s);
  }
  return out;
}

async function headReachable(url, ms=2000){
  try {
    const r = await fetchWithTimeout(url, { method:'HEAD', redirect:'follow' }, ms);
    if (r.ok || (r.status >= 300 && r.status < 400)) return true;
    if (r.status === 405) {
      const g = await fetchWithTimeout(url, { method:'GET' }, Math.max(1500, ms));
      return g.ok || (g.status >= 300 && g.status < 400);
    }
    return false;
  } catch { return false; }
}

async function verifyLinksQuick(links){
  if (LINK_VERIFY_MODE !== 'head') return links;
  const checks = links.map(async l => {
    const ok = await headReachable(l.url, 2000);
    return ok ? l : null;
  });
  const res = await Promise.allSettled(checks);
  const filtered = res.map(x => (x.status === 'fulfilled' ? x.value : null)).filter(Boolean);
  return filtered.length ? filtered : links;
}

/* -------------------- link scoring -------------------- */
function inferCategoryFromText(text = "") {
  const t = (text || '').toLowerCase();
  if (/(knee|shoulder|ankle|hip|physio|physiotherapy|rehab|exercise|pain)\b/.test(t)) return 'physical';
  let best = null, bestHits = 0;
  for (const [cat, words] of Object.entries(CAT_SYNONYMS)) {
    let hits = 0;
    for (const w of words) if (t.includes(w)) hits++;
    if (hits > bestHits) { best = cat; bestHits = hits; }
  }
  return best;
}

function scoreLink(link, context) {
  const { promptText, category, meta, combinedText } = context;
  const p = (promptText || '').toLowerCase();
  const c = (category || '').toLowerCase();
  const bag = (combinedText || '').toLowerCase();

  let score = 0, catScore = 0, kwHits = 0;
  const lcats = (link.category || []).map(x => (x||'').toLowerCase());

  if (lcats.includes(c)) { score += 6; catScore = 6; }
  else if (lcats.some(x => c && (c.includes(x) || x.includes(c)))) { score += 4; catScore = Math.max(catScore, 4); }

  if (Array.isArray(link.keywords)) {
    for (const k of link.keywords) {
      const kk = (k||'').toLowerCase();
      if (!kk) continue;
      if (p.includes(kk)) { score += 4; kwHits++; }
      else if (bag.includes(kk)) { score += 3; kwHits++; }
    }
  }

  for (const s of (CAT_SYNONYMS[c] || [])) if (p.includes(s)) score += 2;
  if (link.title && p.includes((link.title||'').toLowerCase())) score += 1;
  if (link.domain && p.includes((link.domain||'').toLowerCase())) score += 1;

  if (meta) {
    const metaKw = Array.isArray(meta.keywords) ? meta.keywords : [];
    for (const k of metaKw) if (k && bag.includes(String(k).toLowerCase())) score += 2;

    if (meta.subpillar && bag.includes(String(meta.subpillar).toLowerCase())) score += 2;
    if (meta.audience && bag.includes(String(meta.audience).toLowerCase())) score += 1;

    const linkSubs = (link.subpillars || []).map(x => String(x||'').toLowerCase());
    if (meta.subpillar && linkSubs.includes(String(meta.subpillar).toLowerCase())) score += 2;

    const linkAudience = (link.audience || []).map(x => String(x||'').toLowerCase());
    if (meta.audience && linkAudience.includes(String(meta.audience).toLowerCase())) score += 1;
  }

  if (safeUrlOrNull(link.url)) score += 1;
  return { score, catScore, kwHits };
}

function findBestLinks(links, opts) {
  const { category, promptText, userMessage, meta, max = MAX_SOURCES } = opts;

  const parts = [
    promptText || '',
    userMessage || '',
    Array.isArray(meta?.keywords) ? meta.keywords.join(' ') : '',
    meta?.subpillar || '',
    meta?.audience || ''
  ];
  const combinedText = parts.filter(Boolean).join(' ').trim();
  const ctx = { promptText, category, meta, combinedText };
  const c = (category || '').toLowerCase();

  const scored = [];
  for (const l of (links || [])) {
    if (!l?.url) continue;
    const s = scoreLink(l, ctx);
    scored.push({ ...l, ...s });
  }

  const bestCat = Math.max(0, ...scored.map(s => s.catScore || 0));
  let filtered = scored;
  if (bestCat >= 4) filtered = scored.filter(s => s.catScore >= 4);
  else {
    const hasKW = scored.some(s => s.kwHits > 0);
    if (hasKW) filtered = scored.filter(s => s.kwHits > 0);
  }

  const sorted = filtered.sort((a,b) => b.score - a.score);
  const deduped = dedupeByDomain(sorted);
  return deduped.slice(0, max).map(({ id, title, url, domain, filename, file_id }) => {
    const clean = safeUrlOrNull(url);
    return clean ? { id, title, url: clean, domain } : (file_id ? { id, title: filename || 'Document', file_id } : null);
  }).filter(Boolean);
}

/* -------------------- OpenAI Responses helpers -------------------- */
async function createHealthmateResponse({ message, previousResponseId, followup }) {
  const vectorStoreId = process.env.OPENAI_VECTOR_STORE_ID;
  if (!process.env.OPENAI_API_KEY) throw new Error('Missing OPENAI_API_KEY environment variable');
  if (!vectorStoreId) throw new Error('Missing OPENAI_VECTOR_STORE_ID environment variable');

  const instructions = followup === true
    ? `${HEALTHMATE_INSTRUCTIONS}\n\n${FOLLOWUP_INSTRUCTIONS}`
    : HEALTHMATE_INSTRUCTIONS;

  const body = {
    model: OPENAI_MODEL,
    instructions,
    input: message,
    tools: [
      {
        type: 'file_search',
        vector_store_ids: [vectorStoreId],
        max_num_results: 12
      }
    ],
    tool_choice: 'required',
    include: ['file_search_call.results'],
    background: true,
    store: true,
    ...(previousResponseId ? { previous_response_id: previousResponseId } : {})
  };

  return await getJsonOrThrow(
    'https://api.openai.com/v1/responses',
    {
      method: 'POST',
      headers: apiHeaders(),
      body: JSON.stringify(body)
    },
    20000,
    1
  );
}

async function retrieveHealthmateResponse(responseId) {
  return await getJsonOrThrow(
    `https://api.openai.com/v1/responses/${encodeURIComponent(responseId)}`,
    { headers: apiHeaders() },
    12000,
    0
  );
}

/* -------------------- main handler -------------------- */
module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return sendJson(res, 405, { error: 'Use POST' });

  try {
    const body = await readJsonBody(req);
    const {
      message,
      followup,
      thread_id: clientResponseId, // legacy field name retained for frontend compatibility
      categoryLabel,
      categoryKey,
      promptId,
      promptMeta,
      peek
    } = body || {};

    if (peek && !clientResponseId) {
      return sendJson(res, 400, { error: 'Missing thread_id for peek' });
    }

    const links = await loadLinks(req);

    const effectiveCategory =
      normalizeCategoryKey(categoryKey) ||
      canonicalFromLabel(categoryLabel || '') ||
      (message ? inferCategoryFromText(message) : null);

    /* ---------- start a new Responses API request ---------- */
    if (!peek) {
      if (!message) return sendJson(res, 400, { error: 'Missing message' });

      // On follow-up turns, the previous client thread_id is actually the
      // previous completed Response ID. previous_response_id preserves context.
      const response = await createHealthmateResponse({
        message,
        previousResponseId: clientResponseId || null,
        followup: followup === true
      });

      // Keep the existing client polling behaviour. The frontend does not need
      // to know that this is now a resp_ ID rather than an old thread_ ID.
      return sendJson(res, 202, {
        pending: true,
        thread_id: response.id
      });
    }

    /* ---------- peek / poll an existing response ---------- */
    const response = await retrieveHealthmateResponse(clientResponseId);

    if (response.status === 'failed' || response.status === 'cancelled') {
      const detail = response?.error?.message || `OpenAI response ${response.status}`;
      return sendJson(res, 500, { error: detail, thread_id: clientResponseId });
    }

    if (response.status === 'incomplete') {
      const detail = response?.incomplete_details?.reason || 'OpenAI response incomplete';
      return sendJson(res, 500, { error: detail, thread_id: clientResponseId });
    }

    if (response.status !== 'completed') {
      return sendJson(res, 202, {
        pending: true,
        thread_id: clientResponseId
      });
    }

    const rawText = extractResponseText(response);
    if (!rawText) {
      return sendJson(res, 202, {
        pending: true,
        thread_id: clientResponseId
      });
    }

    const formatted = formatCitationsForUser(rawText);
    const text = formatted.text;

    /* ---------- preserve existing curated links.json sources ---------- */
    let curatedSources = [];
    if (message) {
      const promptText = (promptMeta && typeof promptMeta === 'object' && promptMeta.prompt)
        ? String(promptMeta.prompt)
        : '';
      const meta = (promptMeta && typeof promptMeta === 'object') ? promptMeta : null;

      const preliminary = findBestLinks(links, {
        category: effectiveCategory,
        promptText: promptText || message,
        userMessage: message,
        meta,
        max: MAX_SOURCES
      });

      curatedSources = LINK_VERIFY_MODE === 'head'
        ? await verifyLinksQuick(preliminary)
        : preliminary;
    }

    return sendJson(res, 200, {
      output: text,
      sources: curatedSources,
      citations: formatted.citations,
      thread_id: clientResponseId
    });

  } catch (e) {
    console.error('mascot error:', e);
    return sendJson(res, 500, { error: e?.message || 'Server error' });
  }
};
