import 'dotenv/config';
import http from 'http';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import pg from 'pg';

const { Pool } = pg;
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---- Session signing ----
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

if (!process.env.SESSION_SECRET) {
  console.warn('  [warn] SESSION_SECRET not set - sessions will not survive restarts');
}

// ---- Postgres ----
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 5 });

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS sessions (
      id         TEXT        PRIMARY KEY,
      owner      TEXT        NOT NULL,
      data       JSONB       NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS sessions_owner_idx
      ON sessions (owner, created_at DESC)
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS votes (
      feature    TEXT        NOT NULL,
      voter      TEXT        NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (feature, voter)
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS usage (
      user_email      TEXT NOT NULL,
      date            DATE NOT NULL,
      questions_calls INT  NOT NULL DEFAULT 0,
      summary_calls   INT  NOT NULL DEFAULT 0,
      synthesis_calls INT  NOT NULL DEFAULT 0,
      PRIMARY KEY (user_email, date)
    )
  `);
}

// ---- Rate limiting ----
const RATE_LIMITS = { questions: 100, summary: 10, synthesis: 3 };
const RATE_MESSAGES = {
  questions: 'Daily limit reached for question suggestions (100/day). Resets at midnight UTC.',
  summary:   'Daily limit reached for session summaries (10/day). Resets at midnight UTC.',
  synthesis: 'Daily limit reached for cross-interview synthesis (3/day). Resets at midnight UTC.',
};

async function checkRateLimit(email, endpoint) {
  if (!email || email === 'local') return true; // no limit for local mode
  const today = new Date().toISOString().slice(0, 10);
  const col = `${endpoint}_calls`;
  const limit = RATE_LIMITS[endpoint];

  // Ensure row exists
  await pool.query(
    `INSERT INTO usage (user_email, date) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
    [email, today]
  );
  // Atomically increment only if under limit
  const res = await pool.query(
    `UPDATE usage SET ${col} = ${col} + 1
     WHERE user_email = $1 AND date = $2 AND ${col} < $3
     RETURNING ${col}`,
    [email, today, limit]
  );
  return res.rowCount > 0;
}

// ---- Session storage ----
async function listSessions(owner) {
  const res = await pool.query(
    'SELECT data FROM sessions WHERE owner = $1 ORDER BY created_at DESC',
    [owner]
  );
  return res.rows.map((r) => r.data);
}

async function readSession(id) {
  const safe = String(id).replace(/[^a-z0-9_-]/gi, '');
  const res = await pool.query('SELECT data FROM sessions WHERE id = $1', [safe]);
  return res.rows[0]?.data || null;
}

async function writeSession(session) {
  const id = session.id || `s_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const safe = id.replace(/[^a-z0-9_-]/gi, '');
  const record = { ...session, id: safe, createdAt: session.createdAt || new Date().toISOString() };
  await pool.query(
    `INSERT INTO sessions (id, owner, data, created_at)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data`,
    [safe, record.owner || 'local', record, record.createdAt]
  );
  return record;
}

async function deleteSession(id) {
  const safe = String(id).replace(/[^a-z0-9_-]/gi, '');
  const res = await pool.query('DELETE FROM sessions WHERE id = $1', [safe]);
  return res.rowCount > 0;
}

// ---- Auth helpers ----
function parseCookies(req) {
  const out = {};
  const raw = req.headers.cookie;
  if (!raw) return out;
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i > -1) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function signSession(obj) {
  const body = Buffer.from(JSON.stringify(obj)).toString('base64url');
  const sig = crypto.createHmac('sha256', SESSION_SECRET).update(body).digest('base64url');
  return `${body}.${sig}`;
}

function verifySession(token) {
  if (!token || !token.includes('.')) return null;
  const [body, sig] = token.split('.');
  const expected = crypto.createHmac('sha256', SESSION_SECRET).update(body).digest('base64url');
  if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) {
    return null;
  }
  try {
    const obj = JSON.parse(Buffer.from(body, 'base64url').toString());
    if (obj.exp && Date.now() > obj.exp) return null;
    return obj;
  } catch {
    return null;
  }
}

function getSessionUser(req) {
  return verifySession(parseCookies(req).session);
}

function authConfigured() {
  const id = process.env.GOOGLE_CLIENT_ID;
  return !!id && id !== 'paste_your_client_id_here';
}

function getOwner(req) {
  if (!authConfigured()) return 'local';
  const u = getSessionUser(req);
  return u ? u.email : null;
}

// ---- HTTP helpers ----
const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
};

function noCache(res) {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
}

function sendJson(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => (data += chunk));
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

// ---- Prompts ----
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

const SYNTHESIS_PROMPT = `You are a customer-discovery analyst helping an early-stage founder make sense of MULTIPLE discovery interviews at once. You receive the interviewee name, a one-sentence summary, and their key pain points from each interview.

Your job: identify the top pain points that appear across multiple interviews, rank by frequency and severity, and give an honest read on what the pattern means. Be rigorous — an early founder needs the truth, not encouragement.

Return ONLY valid JSON in exactly this shape (no markdown, no preamble):
{
  "overview": "3-4 sentence narrative of what the interviews collectively reveal",
  "themes": [
    {"theme": "short name of the recurring pain point", "count": <number of interviewees who raised it>, "interviewees": ["names"], "insight": "one sentence on what it means"}
  ],
  "validated": ["pain points with strong, repeated evidence across multiple interviewees"],
  "weakOrContradictory": ["pain points mentioned only once, or that contradict each other"],
  "recommendation": "2-3 sentences: what the founder should do next — dig deeper, build, narrow segment, or pivot"
}
Order "themes" by count, highest first. Only count an interviewee toward a theme if their pain points genuinely support it. Never invent interviewees or quotes.`;

// ---- Route handlers ----
async function handleQuestions(req, res) {
  const owner = getOwner(req);
  if (owner === null) return sendJson(res, 401, { error: 'Not signed in' });
  if (!await checkRateLimit(owner, 'questions')) {
    return sendJson(res, 429, { error: RATE_MESSAGES.questions });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey || apiKey === 'paste_your_key_here') {
    return sendJson(res, 500, { error: 'ANTHROPIC_API_KEY not configured' });
  }

  let payload;
  try {
    payload = JSON.parse(await readBody(req));
  } catch {
    return sendJson(res, 400, { error: 'Invalid JSON body' });
  }

  const { intervieweeLines = '', premeetingNotes = '' } = payload;
  let system = SYSTEM_PROMPT;
  if (premeetingNotes.trim()) {
    system += `\n\nBackground context about the interviewee:\n${premeetingNotes}`;
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
        model: 'claude-sonnet-4-5',
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
      console.error(`Anthropic ${apiRes.status}:`, text.slice(0, 500));
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

    const questions = Array.isArray(parsed?.questions) ? parsed.questions.slice(0, 2) : null;
    const tips = Array.isArray(parsed?.tips) ? parsed.tips.slice(0, 3) : [];

    if (!questions || questions.length < 1) {
      return sendJson(res, 502, { error: 'Could not parse questions', raw: content });
    }

    return sendJson(res, 200, { questions, tips });
  } catch (err) {
    return sendJson(res, 502, { error: 'Request to Anthropic failed', detail: String(err) });
  }
}

async function handleSummary(req, res) {
  const owner = getOwner(req);
  if (owner === null) return sendJson(res, 401, { error: 'Not signed in' });
  if (!await checkRateLimit(owner, 'summary')) {
    return sendJson(res, 429, { error: RATE_MESSAGES.summary });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey || apiKey === 'paste_your_key_here') {
    return sendJson(res, 500, { error: 'ANTHROPIC_API_KEY not configured' });
  }

  let payload;
  try {
    payload = JSON.parse(await readBody(req));
  } catch {
    return sendJson(res, 400, { error: 'Invalid JSON body' });
  }

  const { transcript = '', premeetingNotes = '' } = payload;
  if (!transcript.trim()) return sendJson(res, 400, { error: 'Empty transcript' });

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
        model: 'claude-sonnet-4-5',
        max_tokens: 1024,
        system: SUMMARY_PROMPT,
        messages: [{ role: 'user', content: userContent }],
      }),
    });

    const text = await apiRes.text();
    if (!apiRes.ok) {
      console.error(`Anthropic ${apiRes.status}:`, text.slice(0, 500));
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

    if (!parsed || typeof parsed !== 'object') {
      return sendJson(res, 502, { error: 'Could not parse summary', raw: content });
    }

    return sendJson(res, 200, { summary: parsed });
  } catch (err) {
    return sendJson(res, 502, { error: 'Request to Anthropic failed', detail: String(err) });
  }
}

async function handleSynthesis(req, res) {
  const owner = getOwner(req);
  if (owner === null) return sendJson(res, 401, { error: 'Not signed in' });
  if (!await checkRateLimit(owner, 'synthesis')) {
    return sendJson(res, 429, { error: RATE_MESSAGES.synthesis });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey || apiKey === 'paste_your_key_here') {
    return sendJson(res, 500, { error: 'ANTHROPIC_API_KEY not configured' });
  }

  const sessions = await listSessions(owner);
  if (sessions.length === 0) {
    return sendJson(res, 400, { error: 'No saved interviews yet' });
  }

  // Send only pain points + tldr — ~90% cheaper than full transcripts
  const condensed = sessions
    .map((s, i) => {
      const sum = s.summary || {};
      const lines = [
        `INTERVIEW ${i + 1} — ${s.interviewee || 'Unknown'} (${s.date || ''})`,
      ];
      if (sum.tldr) lines.push(`Summary: ${sum.tldr}`);
      if (Array.isArray(sum.painPoints) && sum.painPoints.length) {
        lines.push(`Pain points: ${sum.painPoints.join('; ')}`);
      }
      return lines.join('\n');
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
        model: 'claude-sonnet-4-5',
        max_tokens: 1536,
        system: SYNTHESIS_PROMPT,
        messages: [
          {
            role: 'user',
            content: `Here are pain-point summaries from ${sessions.length} discovery interview${sessions.length === 1 ? '' : 's'}. Identify the top pain points across interviews:\n\n${condensed}`,
          },
        ],
      }),
    });

    const text = await apiRes.text();
    if (!apiRes.ok) {
      console.error(`Anthropic ${apiRes.status}:`, text.slice(0, 500));
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

async function handleVote(req, res) {
  const owner = getOwner(req);
  if (owner === null) return sendJson(res, 401, { error: 'Not signed in' });

  const feature = 'mac-app';

  if (req.method === 'GET') {
    const [countRes, votedRes] = await Promise.all([
      pool.query('SELECT COUNT(*) FROM votes WHERE feature = $1', [feature]),
      pool.query('SELECT 1 FROM votes WHERE feature = $1 AND voter = $2', [feature, owner]),
    ]);
    return sendJson(res, 200, {
      count: parseInt(countRes.rows[0].count, 10),
      hasVoted: votedRes.rows.length > 0,
    });
  }

  if (req.method === 'POST') {
    const votedRes = await pool.query('SELECT 1 FROM votes WHERE feature = $1 AND voter = $2', [feature, owner]);
    if (votedRes.rows.length > 0) {
      await pool.query('DELETE FROM votes WHERE feature = $1 AND voter = $2', [feature, owner]);
    } else {
      await pool.query('INSERT INTO votes (feature, voter) VALUES ($1, $2)', [feature, owner]);
    }
    const countRes = await pool.query('SELECT COUNT(*) FROM votes WHERE feature = $1', [feature]);
    const hasVoted = votedRes.rows.length === 0; // flipped since we just toggled
    return sendJson(res, 200, { count: parseInt(countRes.rows[0].count, 10), hasVoted });
  }

  return sendJson(res, 405, { error: 'Method not allowed' });
}

async function handleSessions(req, res) {
  const owner = getOwner(req);
  if (owner === null) return sendJson(res, 401, { error: 'Not signed in' });

  const urlPath = req.url.split('?')[0];
  const idMatch = urlPath.match(/^\/api\/sessions\/([^/]+)$/);

  if (idMatch) {
    const id = idMatch[1];
    const s = await readSession(id);
    if (!s || (s.owner || 'local') !== owner) return sendJson(res, 404, { error: 'Not found' });
    if (req.method === 'GET') return sendJson(res, 200, { session: s });
    if (req.method === 'DELETE') return sendJson(res, 200, { ok: await deleteSession(id) });
    return sendJson(res, 405, { error: 'Method not allowed' });
  }

  if (req.method === 'GET') {
    return sendJson(res, 200, { sessions: await listSessions(owner) });
  }
  if (req.method === 'POST') {
    let payload;
    try {
      payload = JSON.parse(await readBody(req));
    } catch {
      return sendJson(res, 400, { error: 'Invalid JSON body' });
    }
    payload.owner = owner;
    const saved = await writeSession(payload);
    return sendJson(res, 200, { session: saved });
  }
  return sendJson(res, 405, { error: 'Method not allowed' });
}

async function handleAuthGoogle(req, res) {
  if (!authConfigured()) return sendJson(res, 400, { error: 'Google login not configured' });

  let payload;
  try {
    payload = JSON.parse(await readBody(req));
  } catch {
    return sendJson(res, 400, { error: 'Invalid JSON body' });
  }

  const credential = payload.credential;
  if (!credential) return sendJson(res, 400, { error: 'Missing credential' });

  try {
    const info = await (
      await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(credential)}`)
    ).json();

    if (info.error_description || !info.sub) {
      return sendJson(res, 401, { error: 'Invalid Google token' });
    }
    if (info.aud !== process.env.GOOGLE_CLIENT_ID) {
      return sendJson(res, 401, { error: 'Token audience mismatch' });
    }

    const user = {
      email: info.email,
      name: info.name || info.email,
      picture: info.picture || '',
      exp: Date.now() + SESSION_TTL_MS,
    };
    const token = signSession(user);
    res.setHeader(
      'Set-Cookie',
      `session=${token}; HttpOnly; Path=/; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}; SameSite=Lax`
    );
    return sendJson(res, 200, { user: { email: user.email, name: user.name, picture: user.picture } });
  } catch (err) {
    return sendJson(res, 502, { error: 'Google verification failed', detail: String(err) });
  }
}

function handleMe(req, res) {
  const u = getSessionUser(req);
  return sendJson(res, 200, {
    user: u ? { email: u.email, name: u.name, picture: u.picture } : null,
  });
}

function handleLogout(req, res) {
  res.setHeader('Set-Cookie', 'session=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax');
  return sendJson(res, 200, { ok: true });
}

function handleConfig(req, res) {
  const key = process.env.DEEPGRAM_API_KEY;
  const hasDeepgram = !!key && key !== 'paste_your_key_here';
  return sendJson(res, 200, {
    hasDeepgram,
    deepgramKey: hasDeepgram ? key : '',
    authRequired: authConfigured(),
    googleClientId: authConfigured() ? process.env.GOOGLE_CLIENT_ID : '',
  });
}

function serveStatic(req, res) {
  let urlPath = decodeURIComponent(req.url.split('?')[0]);
  if (urlPath === '/') urlPath = '/index.html';

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

// ---- Router ----
const server = http.createServer(async (req, res) => {
  noCache(res);
  try {
    if (req.url.startsWith('/api/questions')   && req.method === 'POST') return await handleQuestions(req, res);
    if (req.url.startsWith('/api/summary')     && req.method === 'POST') return await handleSummary(req, res);
    if (req.url.startsWith('/api/auth/google') && req.method === 'POST') return await handleAuthGoogle(req, res);
    if (req.url.startsWith('/api/me')          && req.method === 'GET')  return handleMe(req, res);
    if (req.url.startsWith('/api/logout')      && req.method === 'POST') return handleLogout(req, res);
    if (req.url.startsWith('/api/synthesis')   && req.method === 'POST') return await handleSynthesis(req, res);
    if (req.url.startsWith('/api/sessions'))                              return await handleSessions(req, res);
    if (req.url.startsWith('/api/vote'))                                  return await handleVote(req, res);
    if (req.url.startsWith('/api/config')      && req.method === 'GET')  return handleConfig(req, res);
    return serveStatic(req, res);
  } catch (err) {
    console.error('Unhandled error:', err);
    if (!res.headersSent) sendJson(res, 500, { error: 'Internal server error' });
  }
});

// ---- Boot ----
initDb()
  .then(() => {
    server.listen(PORT, () => {
      console.log(`\n  Discovery Assistant running: http://localhost:${PORT}\n`);
      console.log(`  Anthropic key: ${process.env.ANTHROPIC_API_KEY ? 'loaded' : 'MISSING'}`);
      console.log(`  Deepgram key:  ${process.env.DEEPGRAM_API_KEY  ? 'loaded' : 'not set (enter in UI)'}`);
      console.log(`  Google login:  ${authConfigured() ? 'enabled' : 'off (set GOOGLE_CLIENT_ID to enable)'}`);
      console.log(`  Database:      connected\n`);
    });
  })
  .catch((err) => {
    console.error('Failed to connect to database:', err.message);
    process.exit(1);
  });
