import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const DATA_DIR = path.join(__dirname, 'data', 'sessions');
fs.mkdirSync(DATA_DIR, { recursive: true });

// ---- session storage (one JSON file per interview) ----
function listSessions() {
  let files = [];
  try {
    files = fs.readdirSync(DATA_DIR).filter((f) => f.endsWith('.json'));
  } catch {
    return [];
  }
  const sessions = [];
  for (const f of files) {
    try {
      sessions.push(JSON.parse(fs.readFileSync(path.join(DATA_DIR, f), 'utf-8')));
    } catch {
      /* skip corrupt file */
    }
  }
  // newest first
  sessions.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
  return sessions;
}

function readSession(id) {
  const safe = String(id).replace(/[^a-z0-9_-]/gi, '');
  try {
    return JSON.parse(fs.readFileSync(path.join(DATA_DIR, `${safe}.json`), 'utf-8'));
  } catch {
    return null;
  }
}

function writeSession(session) {
  const id = session.id || `s_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const safe = id.replace(/[^a-z0-9_-]/gi, '');
  const record = { ...session, id: safe, createdAt: session.createdAt || new Date().toISOString() };
  fs.writeFileSync(path.join(DATA_DIR, `${safe}.json`), JSON.stringify(record, null, 2));
  return record;
}

function deleteSession(id) {
  const safe = String(id).replace(/[^a-z0-9_-]/gi, '');
  try {
    fs.unlinkSync(path.join(DATA_DIR, `${safe}.json`));
    return true;
  } catch {
    return false;
  }
}

// ---- env: read fresh from .env on every access so key changes never go stale ----
function readEnv() {
  const out = {};
  for (const file of ['.env', '.env.local']) {
    try {
      const content = fs.readFileSync(path.join(__dirname, file), 'utf-8');
      for (const line of content.split('\n')) {
        const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
        if (m) out[m[1]] = m[2].trim();
      }
    } catch {
      /* file may not exist */
    }
  }
  return out;
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
};

function noCache(res) {
  // Force the browser to always fetch fresh code — kills the stale-cache class of bugs
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => (data += chunk));
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

const SYSTEM_PROMPT = `You are an expert research assistant sitting beside an interviewer during a live customer discovery call. You help them ask sharp, unbiased follow-up questions and stay one step ahead on domain knowledge.

Your PRIME DIRECTIVE is discovery, not confirmation. The goal is to uncover ANY real problem in the interviewee's world — not to keep drilling into the first or most obvious thing they mentioned. Avoid leading the witness. Follow the interviewee's reality, not the interviewer's assumptions.

You receive what the INTERVIEWEE has said so far (and optional background notes). Produce two things:

1) QUESTIONS — exactly 2 follow-up questions the interviewer should ask next. Make them COMPLEMENTARY, not redundant:
   - Question 1 (GO DEEPER): probe one concrete thing the interviewee actually said — the mechanics, frequency, cost, or who's affected. Grounded in their exact words.
   - Question 2 (GO WIDER): open an UNEXPLORED area to avoid tunnel vision — an adjacent part of their workflow, a different stakeholder, or simply "what else is painful that we haven't talked about." This question should NOT assume the first problem is the important one.
   Rules for both:
   - Open-ended and neutral. Never imply a solution, never pitch a product, never ask "why don't you just...".
   - Don't put words in their mouth or smuggle in your hypothesis. Let their answer lead.
   - Phrased so the interviewer sounds researched: correct terminology, credible framing.
   - If the interviewee has only said a little, favor broad, open exploration over narrow drilling.

2) TIPS — 2 to 3 short factual briefings (max ~18 words each): domain knowledge tied to the conversation — benchmarks, terminology, common pain points across the sector (not just the one mentioned), or context that makes the interviewer sound researched. Facts to KNOW, not things to say.

Output ONLY valid JSON in exactly this shape, no markdown, no preamble:
{"questions": ["...", "..."], "tips": ["...", "..."]}`;

async function handleQuestions(req, res) {
  const env = readEnv();
  const apiKey = env.ANTHROPIC_API_KEY;

  if (!apiKey || apiKey === 'paste_your_key_here') {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'ANTHROPIC_API_KEY missing in .env' }));
    return;
  }

  let payload;
  try {
    payload = JSON.parse(await readBody(req));
  } catch {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Invalid JSON body' }));
    return;
  }

  const { intervieweeLines = '', premeetingNotes = '' } = payload;
  let system = SYSTEM_PROMPT;
  if (premeetingNotes.trim()) {
    system += `\n\nBackground context about the interviewee (use this to inform your questions about known pain points and priorities):\n${premeetingNotes}`;
  }

  try {
    const apiRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 512,
        system,
        messages: [
          {
            role: 'user',
            content: `Here is what the interviewee has said so far. Generate the follow-up questions and tips:\n\n${intervieweeLines}`,
          },
        ],
      }),
    });

    const text = await apiRes.text();
    if (!apiRes.ok) {
      res.writeHead(apiRes.status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: `Anthropic ${apiRes.status}`, detail: text.slice(0, 300) }));
      return;
    }

    const data = JSON.parse(text);
    const content = data.content?.[0]?.text || '';
    let parsed;
    try {
      parsed = JSON.parse(content);
    } catch {
      // Model sometimes wraps in prose — extract the first JSON object
      const m = content.match(/\{[\s\S]*\}/);
      parsed = m ? JSON.parse(m[0]) : null;
    }

    const questions = Array.isArray(parsed?.questions) ? parsed.questions.slice(0, 2) : null;
    const tips = Array.isArray(parsed?.tips) ? parsed.tips.slice(0, 3) : [];

    if (!questions || questions.length < 1) {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Could not parse questions', raw: content }));
      return;
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ questions, tips }));
  } catch (err) {
    res.writeHead(502, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Request to Anthropic failed', detail: String(err) }));
  }
}

const SUMMARY_PROMPT = `You are a customer-discovery analyst. You are given the full transcript of a discovery interview (with speaker labels) and optional pre-meeting notes. Produce a sharp, founder-ready debrief.

Be objective and evidence-based. Do NOT flatter the interviewer's idea or assume their hypothesis is correct — your job is to capture what was actually learned, including signals that CHALLENGE the idea.

Return ONLY valid JSON in exactly this shape (no markdown, no preamble):
{
  "tldr": "2-3 sentence plain-language summary of what was learned",
  "painPoints": ["concrete problems the interviewee actually has, most acute first"],
  "jobsToBeDone": ["what they are ultimately trying to accomplish"],
  "currentSolutions": ["tools, workarounds, or processes they use today"],
  "quotes": ["short verbatim quotes that are revealing or quotable"],
  "signals": ["evidence of urgency, frequency, budget, or willingness to pay"],
  "risks": ["things they said that challenge or disconfirm the interviewer's idea; weak signals; where they seemed indifferent"],
  "followUps": ["specific questions to ask in a NEXT conversation"]
}
Keep each array item concise (one sentence). Omit an array's items only if truly nothing applies (use an empty array). Base everything on the transcript; never invent facts.`;

async function handleSummary(req, res) {
  const env = readEnv();
  const apiKey = env.ANTHROPIC_API_KEY;
  if (!apiKey || apiKey === 'paste_your_key_here') {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'ANTHROPIC_API_KEY missing in .env' }));
    return;
  }

  let payload;
  try {
    payload = JSON.parse(await readBody(req));
  } catch {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Invalid JSON body' }));
    return;
  }

  const { transcript = '', premeetingNotes = '' } = payload;
  if (!transcript.trim()) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Empty transcript' }));
    return;
  }

  let userContent = `Transcript:\n\n${transcript}`;
  if (premeetingNotes.trim()) userContent += `\n\nPre-meeting notes:\n${premeetingNotes}`;

  try {
    const apiRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 1024,
        system: SUMMARY_PROMPT,
        messages: [{ role: 'user', content: userContent }],
      }),
    });

    const text = await apiRes.text();
    if (!apiRes.ok) {
      res.writeHead(apiRes.status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: `Anthropic ${apiRes.status}`, detail: text.slice(0, 300) }));
      return;
    }

    const data = JSON.parse(text);
    const content = data.content?.[0]?.text || '';
    let parsed;
    try {
      parsed = JSON.parse(content);
    } catch {
      const m = content.match(/\{[\s\S]*\}/);
      parsed = m ? JSON.parse(m[0]) : null;
    }

    if (!parsed || typeof parsed !== 'object') {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Could not parse summary', raw: content }));
      return;
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ summary: parsed }));
  } catch (err) {
    res.writeHead(502, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Request to Anthropic failed', detail: String(err) }));
  }
}

// ---- Sessions API ----
function sendJson(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}

async function handleSessions(req, res) {
  // /api/sessions            GET -> list, POST -> save
  // /api/sessions/<id>       GET -> one,  DELETE -> remove
  const urlPath = req.url.split('?')[0];
  const idMatch = urlPath.match(/^\/api\/sessions\/([^/]+)$/);

  if (idMatch) {
    const id = idMatch[1];
    if (req.method === 'GET') {
      const s = readSession(id);
      return s ? sendJson(res, 200, { session: s }) : sendJson(res, 404, { error: 'Not found' });
    }
    if (req.method === 'DELETE') {
      return sendJson(res, 200, { ok: deleteSession(id) });
    }
    return sendJson(res, 405, { error: 'Method not allowed' });
  }

  if (req.method === 'GET') {
    return sendJson(res, 200, { sessions: listSessions() });
  }
  if (req.method === 'POST') {
    let payload;
    try {
      payload = JSON.parse(await readBody(req));
    } catch {
      return sendJson(res, 400, { error: 'Invalid JSON body' });
    }
    const saved = writeSession(payload);
    return sendJson(res, 200, { session: saved });
  }
  return sendJson(res, 405, { error: 'Method not allowed' });
}

const SYNTHESIS_PROMPT = `You are a customer-discovery analyst helping an early-stage founder make sense of MULTIPLE discovery interviews at once. You receive condensed summaries of every interview conducted so far.

Your job is pattern detection across interviews, not re-summarizing each one. Be rigorous and honest — an early founder needs the truth, not encouragement. Surface where evidence is strong AND where it is thin or contradictory.

Return ONLY valid JSON in exactly this shape (no markdown, no preamble):
{
  "overview": "3-4 sentence narrative of what the interviews collectively reveal",
  "themes": [
    {"theme": "short name of the recurring problem/need", "count": <number of interviewees who raised it>, "interviewees": ["names"], "insight": "one sentence on what it means"}
  ],
  "topQuotes": ["the most revealing verbatim quotes across all interviews"],
  "validated": ["patterns with strong, repeated evidence across interviewees"],
  "weakOrContradictory": ["assumptions that are unsupported, only mentioned once, or contradicted"],
  "recommendation": "2-3 sentences: what the founder should do next — dig deeper, build, narrow segment, or pivot"
}
Order "themes" by count, highest first. Only count an interviewee toward a theme if their summary genuinely supports it. Never invent interviewees or quotes.`;

async function handleSynthesis(req, res) {
  const env = readEnv();
  const apiKey = env.ANTHROPIC_API_KEY;
  if (!apiKey || apiKey === 'paste_your_key_here') {
    return sendJson(res, 500, { error: 'ANTHROPIC_API_KEY missing in .env' });
  }

  const sessions = listSessions();
  if (sessions.length === 0) {
    return sendJson(res, 400, { error: 'No saved interviews yet' });
  }

  // Condense each interview to its summary so we stay within token budget
  const condensed = sessions
    .map((s, i) => {
      const sum = s.summary || {};
      const part = (label, arr) =>
        Array.isArray(arr) && arr.length ? `${label}: ${arr.join('; ')}` : '';
      return [
        `INTERVIEW ${i + 1} — ${s.interviewee || 'Unknown'} (${s.date || ''})`,
        sum.tldr ? `TL;DR: ${sum.tldr}` : '',
        part('Pain points', sum.painPoints),
        part('Jobs to be done', sum.jobsToBeDone),
        part('Current solutions', sum.currentSolutions),
        part('Demand signals', sum.signals),
        part('Risks', sum.risks),
        part('Quotes', sum.quotes),
      ]
        .filter(Boolean)
        .join('\n');
    })
    .join('\n\n---\n\n');

  try {
    const apiRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 1536,
        system: SYNTHESIS_PROMPT,
        messages: [
          {
            role: 'user',
            content: `Here are summaries of ${sessions.length} discovery interviews. Synthesize the patterns:\n\n${condensed}`,
          },
        ],
      }),
    });

    const text = await apiRes.text();
    if (!apiRes.ok) {
      return sendJson(res, apiRes.status, { error: `Anthropic ${apiRes.status}`, detail: text.slice(0, 300) });
    }

    const data = JSON.parse(text);
    const content = data.content?.[0]?.text || '';
    let parsed;
    try {
      parsed = JSON.parse(content);
    } catch {
      const m = content.match(/\{[\s\S]*\}/);
      parsed = m ? JSON.parse(m[0]) : null;
    }
    if (!parsed) return sendJson(res, 502, { error: 'Could not parse synthesis', raw: content });

    return sendJson(res, 200, { synthesis: parsed, interviewCount: sessions.length });
  } catch (err) {
    return sendJson(res, 502, { error: 'Request to Anthropic failed', detail: String(err) });
  }
}

function handleConfig(req, res) {
  const env = readEnv();
  const key = env.DEEPGRAM_API_KEY;
  const hasDeepgram = !!key && key !== 'paste_your_key_here';
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ hasDeepgram, deepgramKey: hasDeepgram ? key : '' }));
}

function serveStatic(req, res) {
  let urlPath = decodeURIComponent(req.url.split('?')[0]);
  if (urlPath === '/') urlPath = '/index.html';

  // prevent path traversal
  const filePath = path.join(PUBLIC_DIR, path.normalize(urlPath).replace(/^(\.\.[/\\])+/, ''));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  fs.readFile(filePath, (err, content) => {
    if (err) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }
    noCache(res);
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream' });
    res.end(content);
  });
}

const server = http.createServer(async (req, res) => {
  noCache(res);

  if (req.url.startsWith('/api/questions') && req.method === 'POST') {
    return handleQuestions(req, res);
  }
  if (req.url.startsWith('/api/summary') && req.method === 'POST') {
    return handleSummary(req, res);
  }
  if (req.url.startsWith('/api/synthesis') && req.method === 'POST') {
    return handleSynthesis(req, res);
  }
  if (req.url.startsWith('/api/sessions')) {
    return handleSessions(req, res);
  }
  if (req.url.startsWith('/api/config') && req.method === 'GET') {
    return handleConfig(req, res);
  }
  return serveStatic(req, res);
});

server.listen(PORT, () => {
  console.log(`\n  Meeting Assistant running:  http://localhost:${PORT}\n`);
  const env = readEnv();
  console.log(`  Anthropic key: ${env.ANTHROPIC_API_KEY && env.ANTHROPIC_API_KEY !== 'paste_your_key_here' ? 'loaded ✓' : 'MISSING — add to .env'}`);
  console.log(`  Deepgram key:  ${env.DEEPGRAM_API_KEY && env.DEEPGRAM_API_KEY !== 'paste_your_key_here' ? 'loaded ✓' : 'not in .env (enter in UI)'}\n`);
});
