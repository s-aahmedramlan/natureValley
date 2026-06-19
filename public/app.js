// ---- State ----
const state = {
  yourName: '',
  theirName: '',
  deepgramKey: '',
  premeetingNotes: '',
  transcript: [],
  questions: [],
  tips: [],
  summary: null,
  savedId: null,
  questionLoading: false,
  sessionStartTime: null,
  elapsedSeconds: 0,
  lastGeneratedWordCount: 0,
};

const conns = []; // { ws, audioContext, processor, role }
let micStream = null;
let displayStream = null;
let timerInterval = null;
let questionDebounce = null;

const $ = (id) => document.getElementById(id);

// ---- Debug ----
function addDebugLog(msg) {
  const ts = new Date().toLocaleTimeString();
  const el = document.createElement('div');
  el.textContent = `[${ts}] ${msg}`;
  const c = $('debug-logs');
  c.prepend(el);
  while (c.children.length > 20) c.removeChild(c.lastChild);
  console.log(msg);
}

function updateDebugStats() {
  $('dbg-utterances').textContent = state.transcript.length;
}

// ---- Pixelate reveal animation ----
function pixelateReveal(canvas) {
  if (!canvas) return;
  const img = new Image();
  img.onload = () => {
    const w = canvas.offsetWidth;
    const h = canvas.offsetHeight;
    if (!w || !h) return;
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    const steps  = [32, 16, 8, 4, 2, 0];
    const delays = [0, 90, 170, 270, 400, 560];
    steps.forEach((size, i) => {
      setTimeout(() => {
        if (size === 0) {
          ctx.imageSmoothingEnabled = true;
          ctx.drawImage(img, 0, 0, w, h);
          return;
        }
        const tw = Math.max(1, Math.ceil(w / size));
        const th = Math.max(1, Math.ceil(h / size));
        const off = document.createElement('canvas');
        off.width = tw;
        off.height = th;
        off.getContext('2d').drawImage(img, 0, 0, tw, th);
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(off, 0, 0, tw, th, 0, 0, w, h);
      }, delays[i]);
    });
  };
  img.src = '/bg.jpg';
}

// ---- Boot + auth ----
let currentUser = null;

async function boot() {
  let cfg = {};
  try {
    cfg = await (await fetch('/api/config')).json();
  } catch {}

  if (cfg.hasDeepgram) {
    state.deepgramKey = cfg.deepgramKey;
    $('deepgram-key').style.display = 'none';
  } else {
    $('deepgram-key').style.display = 'block';
  }

  if (cfg.authRequired) {
    let me = {};
    try {
      me = await (await fetch('/api/me')).json();
    } catch {}
    if (me.user) {
      currentUser = me.user;
      showSetup();
    } else {
      showLogin(cfg.googleClientId);
      return;
    }
  } else {
    showSetup();
  }
  refreshLibraryCount();
}

function isSafari() {
  const ua = navigator.userAgent;
  return ua.includes('Safari') && !ua.includes('Chrome') && !ua.includes('Chromium') && !ua.includes('CriOS');
}


function showLogin(clientId) {
  $('setup').style.display = 'none';
  $('login').style.display = 'flex';
  pixelateReveal($('login-canvas'));
  initGoogleButton(clientId);
}

function showSetup() {
  $('login').style.display = 'none';
  $('setup').style.display = 'flex';
  pixelateReveal($('setup-canvas'));
  if (isSafari()) {
    $('safari-banner').style.display = 'flex';
    const btn = $('start-btn');
    btn.disabled = true;
    btn.style.opacity = '0.35';
    btn.style.cursor = 'not-allowed';
  }
  if (currentUser) {
    $('user-chip').style.display = 'flex';
    $('user-email').textContent = currentUser.email;
  }
}

function initGoogleButton(clientId, tries = 0) {
  if (!window.google?.accounts?.id) {
    if (tries < 40) return setTimeout(() => initGoogleButton(clientId, tries + 1), 100);
    $('login-error').textContent = 'Could not load Google Sign-In. Check your connection.';
    $('login-error').style.display = 'block';
    return;
  }
  window.google.accounts.id.initialize({ client_id: clientId, callback: onGoogleCredential });
  window.google.accounts.id.renderButton($('google-btn'), {
    theme: 'outline',
    size: 'large',
    shape: 'pill',
    width: 300,
    text: 'continue_with',
  });
}

async function onGoogleCredential(response) {
  $('login-error').style.display = 'none';
  try {
    const res = await fetch('/api/auth/google', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ credential: response.credential }),
    });
    const data = await res.json();
    if (!res.ok) {
      $('login-error').textContent = data.error || 'Sign-in failed';
      $('login-error').style.display = 'block';
      return;
    }
    currentUser = data.user;
    showSetup();
    refreshLibraryCount();
  } catch (err) {
    $('login-error').textContent = err.message;
    $('login-error').style.display = 'block';
  }
}

async function logout() {
  try {
    await fetch('/api/logout', { method: 'POST' });
  } catch {}
  location.reload();
}

// ---- Setup ----
function showSetupError(msg) {
  const el = $('setup-error');
  el.textContent = msg;
  el.style.display = 'block';
}

async function startSession() {
  state.yourName = $('your-name').value.trim();
  state.theirName = $('their-name').value.trim();
  state.premeetingNotes = $('premeeting-notes').value;

  if (!state.yourName || !state.theirName) {
    showSetupError('Please enter both names');
    return;
  }
  if (!state.deepgramKey) state.deepgramKey = $('deepgram-key').value.trim();
  if (!state.deepgramKey) {
    showSetupError('Please enter your Deepgram API key');
    return;
  }

  try {
    addDebugLog('Requesting microphone...');
    micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    addDebugLog('Mic granted');
  } catch (err) {
    showSetupError('Microphone access denied — needed to capture your side.');
    return;
  }

  try {
    addDebugLog('Requesting tab audio — pick your meeting tab and check "Share tab audio"');
    displayStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
    const audioTracks = displayStream.getAudioTracks();
    displayStream.getVideoTracks().forEach((t) => t.stop());
    if (audioTracks.length === 0) {
      addDebugLog('No tab audio shared — only your mic will be transcribed.');
      displayStream = null;
    } else {
      addDebugLog('Tab audio granted');
    }
  } catch (err) {
    addDebugLog('Tab audio skipped — only your mic will be transcribed.');
    displayStream = null;
  }

  $('setup-error').style.display = 'none';
  $('setup').style.display = 'none';
  $('app').style.display = 'flex';
  $('questions-placeholder').textContent = `Questions appear once ${state.theirName} starts talking`;
  $('audio-status').textContent = displayStream ? '· you + them' : '· you only';

  state.sessionStartTime = Date.now();
  state.elapsedSeconds = 0;
  state.transcript = [];
  state.questions = [];
  state.tips = [];
  state.summary = null;
  state.savedId = null;
  state.lastGeneratedWordCount = 0;

  addDebugLog('Session started');

  timerInterval = setInterval(() => {
    state.elapsedSeconds++;
    const m = String(Math.floor(state.elapsedSeconds / 60)).padStart(2, '0');
    const s = String(state.elapsedSeconds % 60).padStart(2, '0');
    $('timer').textContent = `${m}:${s}`;
  }, 1000);

  startDeepgram(micStream, 'you');
  if (displayStream) startDeepgram(displayStream, 'them');
}

// ---- Deepgram ----
function startDeepgram(stream, role) {
  addDebugLog(`Connecting Deepgram (${role})...`);
  const ws = new WebSocket(
    'wss://api.deepgram.com/v1/listen?encoding=linear16&sample_rate=16000&channels=1&model=nova-2&smart_format=true&interim_results=false',
    ['token', state.deepgramKey]
  );
  const conn = { ws, role, audioContext: null, processor: null, connected: false };
  conns.push(conn);

  const watchdog = setTimeout(() => {
    if (!conn.connected) {
      const msg = `Deepgram (${role}) not connecting — likely an invalid or out-of-credit key.`;
      addDebugLog(msg);
      $('api-error').textContent = msg;
      $('api-error').style.display = 'block';
    }
  }, 6000);

  ws.onopen = () => {
    conn.connected = true;
    clearTimeout(watchdog);
    addDebugLog(`Deepgram connected (${role})`);
    $(role === 'you' ? 'dbg-you' : 'dbg-them').textContent = 'live';
    if (role === 'you') $('rec-dot').classList.add('active');

    const audioContext = new AudioContext({ sampleRate: 16000 });
    const source = audioContext.createMediaStreamSource(stream);
    const processor = audioContext.createScriptProcessor(4096, 1, 1);
    conn.audioContext = audioContext;
    conn.processor = processor;

    const micBars = role === 'you' ? $('mic-bars') : null;
    const barEls = micBars ? Array.from(micBars.children) : [];
    const BAR_HEIGHTS = [5, 9, 13, 9, 5]; // resting shape

    processor.onaudioprocess = (e) => {
      if (ws.readyState !== WebSocket.OPEN) return;
      const f32 = e.inputBuffer.getChannelData(0);
      const i16 = new Int16Array(f32.length);
      let rms = 0;
      for (let i = 0; i < f32.length; i++) {
        i16[i] = Math.max(-32768, Math.min(32767, Math.round(f32[i] * 32767)));
        rms += f32[i] * f32[i];
      }
      ws.send(i16.buffer);

      if (micBars) {
        rms = Math.sqrt(rms / f32.length);
        const level = Math.min(1, rms * 12); // scale to 0-1
        if (level > 0.01) {
          micBars.classList.add('active');
          barEls.forEach((bar, i) => {
            const h = BAR_HEIGHTS[i] + level * (16 - BAR_HEIGHTS[i]) * (0.6 + Math.random() * 0.4);
            bar.style.height = `${h}px`;
          });
        } else {
          micBars.classList.remove('active');
          barEls.forEach((bar, i) => { bar.style.height = `${BAR_HEIGHTS[i]}px`; });
        }
      }
    };
    source.connect(processor);
    processor.connect(audioContext.destination);
  };

  ws.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);
      const alt = data.channel?.alternatives?.[0];
      const text = (alt?.transcript || '').trim();
      if (text && data.is_final) {
        addDebugLog(`[${role}] "${text}"`);
        addUtterance(text, role);
      }
    } catch (err) {
      addDebugLog(`Parse error: ${err.message}`);
    }
  };

  ws.onerror = () => addDebugLog(`Deepgram socket error (${role})`);
  ws.onclose = (e) => {
    clearTimeout(watchdog);
    addDebugLog(`Deepgram closed (${role}) code=${e.code}`);
    if (!conn.connected) {
      const msg = `Deepgram (${role}) refused the connection (code ${e.code}). Key may be invalid or out of credits.`;
      $('api-error').textContent = msg;
      $('api-error').style.display = 'block';
    }
    $(role === 'you' ? 'dbg-you' : 'dbg-them').textContent = 'off';
  };
}

// ---- Transcript ----
function addUtterance(text, speaker) {
  state.transcript.push({
    speaker,
    text,
    timestamp: Date.now() - state.sessionStartTime,
  });
  renderTranscript();
  updateDebugStats();

  const intervieweeWords = state.transcript
    .filter((t) => t.speaker === 'them')
    .reduce((n, t) => n + t.text.split(/\s+/).length, 0);

  if (intervieweeWords >= 8 && intervieweeWords > state.lastGeneratedWordCount) {
    clearTimeout(questionDebounce);
    questionDebounce = setTimeout(() => {
      state.lastGeneratedWordCount = intervieweeWords;
      generateQuestions();
    }, 2500);
  }
}

function renderTranscript() {
  const feed = $('transcript-feed');
  feed.innerHTML = '';

  if (state.transcript.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'transcript-empty';
    empty.textContent = 'Waiting for speech...';
    feed.appendChild(empty);
    return;
  }

  state.transcript.forEach((item) => {
    const line = document.createElement('div');
    line.className = 'transcript-line';

    const label = document.createElement('span');
    label.className = 'speaker-label' + (item.speaker === 'them' ? ' interviewee' : '');
    label.textContent = item.speaker === 'them' ? state.theirName : state.yourName;

    const txt = document.createElement('span');
    txt.className = 'transcript-text';
    txt.textContent = item.text;

    const flip = document.createElement('button');
    flip.className = 'flip-btn';
    flip.title = 'Reassign speaker';
    flip.textContent = '\u21C4';
    flip.onclick = (e) => {
      e.stopPropagation();
      item.speaker = item.speaker === 'them' ? 'you' : 'them';
      renderTranscript();
    };

    line.append(label, txt, flip);
    feed.appendChild(line);
  });

  feed.scrollTop = feed.scrollHeight;
}

// ---- Questions ----
function renderQuestions() {
  const container = $('questions-container');
  const placeholder = $('questions-placeholder');

  if (state.questions.length === 0 && state.transcript.filter((t) => t.speaker === 'them').length === 0) {
    placeholder.style.display = 'block';
    container.style.display = 'none';
    return;
  }

  placeholder.style.display = 'none';
  container.style.display = 'flex';
  container.innerHTML = '';

  state.questions.forEach((q, i) => {
    const card = document.createElement('div');
    card.className = 'question-card' + (q.pinned ? ' pinned' : '') + (state.questionLoading && !q.pinned ? ' updating' : '');

    const p = document.createElement('p');
    p.className = 'question-text';
    p.textContent = `${i + 1}. ${q.text}`;
    card.appendChild(p);

    if (q.pinned) {
      const badge = document.createElement('span');
      badge.className = 'pin-badge';
      badge.textContent = 'pinned';
      card.appendChild(badge);
    }

    card.onclick = () => {
      q.pinned = !q.pinned;
      addDebugLog(q.pinned ? 'Question pinned' : 'Question unpinned');
      renderQuestions();
    };

    container.appendChild(card);
  });

  const meta = document.createElement('div');
  meta.className = 'questions-meta';
  meta.innerHTML = state.questionLoading
    ? '<span class="spinner spinner-sm"></span> updating...'
    : 'click a question to pin it';
  container.appendChild(meta);
}

async function generateQuestions() {
  if (state.questionLoading) return;

  const intervieweeLines = state.transcript
    .filter((t) => t.speaker === 'them')
    .map((t) => t.text)
    .join(' ');
  if (!intervieweeLines.trim()) return;

  state.questionLoading = true;
  $('api-error').style.display = 'none';
  renderQuestions();
  addDebugLog('Asking Claude...');

  try {
    const res = await fetch('/api/questions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ intervieweeLines, premeetingNotes: state.premeetingNotes }),
    });
    const data = await res.json();

    if (!res.ok) {
      addDebugLog(data.error || `Error ${res.status}`);
      $('api-error').textContent = data.error || `Error ${res.status}`;
      $('api-error').style.display = 'block';
      return;
    }

    const incoming = data.questions || [];
    const merged = [];
    let nextIncoming = 0;
    for (let i = 0; i < 2; i++) {
      const existing = state.questions[i];
      if (existing && existing.pinned) {
        merged.push(existing);
      } else if (incoming[nextIncoming]) {
        merged.push({ text: incoming[nextIncoming], pinned: false });
        nextIncoming++;
      }
    }
    while (merged.length < 2 && incoming[nextIncoming]) {
      merged.push({ text: incoming[nextIncoming], pinned: false });
      nextIncoming++;
    }
    state.questions = merged;
    state.tips = data.tips || [];
    addDebugLog('Questions updated');
    renderTips();
  } catch (err) {
    addDebugLog(`Request failed: ${err.message}`);
    $('api-error').textContent = err.message;
    $('api-error').style.display = 'block';
  } finally {
    state.questionLoading = false;
    renderQuestions();
  }
}

// ---- Tips ----
function renderTips() {
  const el = $('tips-content');
  if (!state.tips.length) {
    el.innerHTML = '<div class="tips-empty">Domain facts will appear here as you talk.</div>';
    return;
  }
  el.innerHTML = '';
  state.tips.forEach((tip) => {
    const card = document.createElement('div');
    card.className = 'tip-card';
    card.textContent = tip;
    el.appendChild(card);
  });
}

// ---- Stop / Download ----
function stopSession() {
  conns.forEach((c) => {
    try { c.processor?.disconnect(); } catch {}
    if (c.audioContext && c.audioContext.state !== 'closed') {
      c.audioContext.close().catch(() => {});
    }
    try { c.ws?.close(); } catch {}
  });
  if (micStream) micStream.getTracks().forEach((t) => t.stop());
  if (displayStream) displayStream.getTracks().forEach((t) => t.stop());
  if (timerInterval) clearInterval(timerInterval);
  $('rec-dot').classList.remove('active');
  $('audio-status').textContent = '· stopped';
  addDebugLog('Stopped');

  $('summary-overlay').style.display = 'flex';
  const m = String(Math.floor(state.elapsedSeconds / 60)).padStart(2, '0');
  const s = String(state.elapsedSeconds % 60).padStart(2, '0');
  $('summary-meta').textContent = `${state.theirName} · ${m}:${s} · ${state.transcript.length} lines`;
  generateSummary();
}

async function generateSummary() {
  const body = $('summary-body');

  if (state.transcript.length === 0) {
    body.innerHTML = '<div class="summary-loading">No transcript captured — nothing to summarize.</div>';
    return;
  }

  body.innerHTML = '<div class="loading-state"><div class="spinner"></div><span>Analyzing the conversation...</span></div>';

  try {
    const res = await fetch('/api/summary', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ transcript: buildMarkdown(), premeetingNotes: state.premeetingNotes }),
    });
    const data = await res.json();
    if (!res.ok) {
      body.innerHTML = `<div class="summary-error">Could not generate summary: ${data.error || res.status}</div>`;
      addDebugLog(`Summary failed: ${data.error || res.status}`);
      return;
    }
    state.summary = data.summary;
    renderSummary(data.summary);
    addDebugLog('Summary generated');
    saveSession();
  } catch (err) {
    body.innerHTML = `<div class="summary-error">Could not generate summary: ${err.message}</div>`;
    addDebugLog(`Summary error: ${err.message}`);
  }
}

const SUMMARY_SECTIONS = [
  ['painPoints', 'Pain points'],
  ['jobsToBeDone', 'Jobs to be done'],
  ['currentSolutions', 'Current solutions & workarounds'],
  ['signals', 'Demand signals'],
  ['risks', 'Risks & disconfirming signals'],
  ['quotes', 'Notable quotes'],
  ['followUps', 'Follow-ups for next time'],
];

function renderSummary(sum) {
  const body = $('summary-body');
  body.innerHTML = '';

  if (sum.tldr) {
    const tldr = document.createElement('div');
    tldr.className = 'summary-tldr';
    tldr.textContent = sum.tldr;
    body.appendChild(tldr);
  }

  SUMMARY_SECTIONS.forEach(([key, label]) => {
    const items = sum[key];
    if (!Array.isArray(items) || items.length === 0) return;

    const sec = document.createElement('div');
    sec.className = 'summary-section';

    const h = document.createElement('div');
    h.className = 'summary-section-title';
    h.textContent = label;
    sec.appendChild(h);

    const ul = document.createElement('ul');
    ul.className = 'summary-list' + (key === 'quotes' ? ' summary-quotes' : '');
    items.forEach((item) => {
      const li = document.createElement('li');
      li.textContent = key === 'quotes' ? `"${item}"` : item;
      ul.appendChild(li);
    });
    sec.appendChild(ul);
    body.appendChild(sec);
  });
}

function buildSummaryMarkdown() {
  const sum = state.summary;
  const date = new Date(state.sessionStartTime).toISOString().split('T')[0];
  let md = `# Discovery debrief — ${state.theirName}\nDate: ${date}\nInterviewer: ${state.yourName}\n\n`;
  if (!sum) return md + '_No summary generated._\n';

  if (sum.tldr) md += `## TL;DR\n${sum.tldr}\n\n`;
  SUMMARY_SECTIONS.forEach(([key, label]) => {
    const items = sum[key];
    if (!Array.isArray(items) || items.length === 0) return;
    md += `## ${label}\n`;
    items.forEach((item) => {
      md += key === 'quotes' ? `> ${item}\n\n` : `- ${item}\n`;
    });
    if (key !== 'quotes') md += '\n';
  });
  return md;
}

function downloadSummary() {
  const date = new Date(state.sessionStartTime).toISOString().split('T')[0];
  const blob = new Blob([buildSummaryMarkdown()], { type: 'text/markdown' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `debrief-${state.theirName.replace(/\s+/g, '-').toLowerCase()}-${date}.md`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  addDebugLog('Summary downloaded');
}

function buildMarkdown() {
  const date = new Date(state.sessionStartTime).toISOString().split('T')[0];
  const m = String(Math.floor(state.elapsedSeconds / 60)).padStart(2, '0');
  const s = String(state.elapsedSeconds % 60).padStart(2, '0');
  let md = `# Discovery call transcript\n`;
  md += `Date: ${date}\nInterviewer: ${state.yourName}\nInterviewee: ${state.theirName}\nDuration: ${m}:${s}\n\n---\n\n## Transcript\n\n`;
  state.transcript.forEach((item) => {
    const mins = String(Math.floor(item.timestamp / 60000)).padStart(2, '0');
    const secs = String(Math.floor((item.timestamp % 60000) / 1000)).padStart(2, '0');
    const speaker = item.speaker === 'them' ? state.theirName : state.yourName;
    md += `**[${mins}:${secs}] ${speaker}:** ${item.text}\n\n`;
  });
  return md;
}

function downloadTranscript() {
  const date = new Date(state.sessionStartTime).toISOString().split('T')[0];
  const blob = new Blob([buildMarkdown()], { type: 'text/markdown' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `discovery-${state.theirName.replace(/\s+/g, '-').toLowerCase()}-${date}.md`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  addDebugLog('Transcript downloaded');
}

// ---- Persistence ----
async function saveSession() {
  if (state.savedId || state.transcript.length === 0) return;
  const record = {
    date: new Date(state.sessionStartTime).toISOString().split('T')[0],
    interviewer: state.yourName,
    interviewee: state.theirName,
    premeetingNotes: state.premeetingNotes,
    durationSeconds: state.elapsedSeconds,
    lineCount: state.transcript.length,
    transcript: state.transcript,
    summary: state.summary,
  };
  try {
    const res = await fetch('/api/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(record),
    });
    const data = await res.json();
    state.savedId = data.session?.id;
    addDebugLog('Saved to library');
    refreshLibraryCount();
  } catch (err) {
    addDebugLog(`Save failed: ${err.message}`);
  }
}

async function refreshLibraryCount() {
  try {
    const data = await (await fetch('/api/sessions')).json();
    $('library-count').textContent = (data.sessions || []).length;
  } catch {}
}

// ---- Library view ----
async function openLibrary() {
  $('setup').style.display = 'none';
  $('library').style.display = 'block';
  $('synthesis-panel').style.display = 'none';
  $('library-list').innerHTML = '<div class="library-empty">Loading...</div>';
  try {
    const data = await (await fetch('/api/sessions')).json();
    renderLibrary(data.sessions || []);
  } catch (err) {
    $('library-list').innerHTML = `<div class="library-empty">Could not load library: ${err.message}</div>`;
  }
}

function closeLibrary() {
  $('library').style.display = 'none';
  $('setup').style.display = 'flex';
  pixelateReveal($('setup-canvas'));
}

function renderLibrary(sessions) {
  const list = $('library-list');
  $('library-sub').textContent = sessions.length
    ? `${sessions.length} saved discovery ${sessions.length === 1 ? 'call' : 'calls'}`
    : 'Your saved discovery calls';
  $('synthesize-btn').disabled = sessions.length < 1;

  if (sessions.length === 0) {
    list.innerHTML = '<div class="library-empty">No interviews saved yet. Finish a call and it lands here automatically.</div>';
    return;
  }

  list.innerHTML = '';
  sessions.forEach((s) => {
    const card = document.createElement('div');
    card.className = 'session-card';

    const painCount = s.summary?.painPoints?.length || 0;
    const mins = Math.round((s.durationSeconds || 0) / 60);

    card.innerHTML = `
      <div class="session-main">
        <div class="session-name">${escapeHtml(s.interviewee || 'Unknown')}</div>
        <div class="session-tldr">${escapeHtml(s.summary?.tldr || 'No summary')}</div>
        <div class="session-meta">${s.date || ''} · ${mins} min · ${s.lineCount || 0} lines · ${painCount} pain point${painCount === 1 ? '' : 's'}</div>
      </div>
      <button class="session-del" title="Delete">x</button>
    `;

    card.querySelector('.session-main').onclick = () => openSession(s.id);
    card.querySelector('.session-del').onclick = (e) => {
      e.stopPropagation();
      deleteSavedSession(s.id, card);
    };
    list.appendChild(card);
  });
}

async function openSession(id) {
  try {
    const data = await (await fetch(`/api/sessions/${id}`)).json();
    const s = data.session;
    if (!s) return;
    state.sessionStartTime = new Date(s.createdAt || Date.now()).getTime();
    state.yourName = s.interviewer;
    state.theirName = s.interviewee;
    state.elapsedSeconds = s.durationSeconds || 0;
    state.transcript = s.transcript || [];
    state.summary = s.summary;
    state.savedId = s.id;

    $('summary-overlay').style.display = 'flex';
    const m = String(Math.floor(state.elapsedSeconds / 60)).padStart(2, '0');
    const sec = String(state.elapsedSeconds % 60).padStart(2, '0');
    $('summary-meta').textContent = `${s.interviewee} · ${m}:${sec} · ${state.transcript.length} lines`;
    if (s.summary) renderSummary(s.summary);
    else $('summary-body').innerHTML = '<div class="summary-loading">No summary was saved for this call.</div>';
  } catch (err) {
    addDebugLog(`Open failed: ${err.message}`);
  }
}

async function deleteSavedSession(id, card) {
  try {
    await fetch(`/api/sessions/${id}`, { method: 'DELETE' });
    card.remove();
    refreshLibraryCount();
    const remaining = $('library-list').querySelectorAll('.session-card').length;
    if (remaining === 0) renderLibrary([]);
  } catch (err) {
    addDebugLog(`Delete failed: ${err.message}`);
  }
}

// ---- Cross-interview synthesis ----
async function runSynthesis() {
  const panel = $('synthesis-panel');
  panel.style.display = 'block';
  panel.innerHTML = '<div class="loading-state"><div class="spinner"></div><span>Finding patterns across your interviews...</span></div>';
  panel.scrollIntoView({ behavior: 'smooth' });

  try {
    const res = await fetch('/api/synthesis', { method: 'POST' });
    const data = await res.json();
    if (!res.ok) {
      panel.innerHTML = `<div class="synthesis-error">${data.error || 'Synthesis failed'}</div>`;
      return;
    }
    renderSynthesis(data.synthesis, data.interviewCount);
  } catch (err) {
    panel.innerHTML = `<div class="synthesis-error">${err.message}</div>`;
  }
}

function renderSynthesis(syn, count) {
  const panel = $('synthesis-panel');
  panel.innerHTML = '';

  const head = document.createElement('div');
  head.className = 'synthesis-head';
  head.textContent = `Synthesis across ${count} interview${count === 1 ? '' : 's'}`;
  panel.appendChild(head);

  if (syn.overview) {
    const ov = document.createElement('div');
    ov.className = 'synthesis-overview';
    ov.textContent = syn.overview;
    panel.appendChild(ov);
  }

  if (Array.isArray(syn.themes) && syn.themes.length) {
    const sec = document.createElement('div');
    sec.className = 'synthesis-section';
    sec.innerHTML = '<div class="synthesis-section-title">Recurring themes</div>';
    const maxCount = Math.max(...syn.themes.map((t) => t.count || 1));
    syn.themes.forEach((t) => {
      const row = document.createElement('div');
      row.className = 'theme-row';
      const pct = Math.round(((t.count || 1) / maxCount) * 100);
      row.innerHTML = `
        <div class="theme-bar-wrap">
          <div class="theme-bar" style="width:${pct}%"></div>
          <div class="theme-label">${escapeHtml(t.theme || '')}</div>
          <div class="theme-count">${t.count || 0}x</div>
        </div>
        <div class="theme-insight">${escapeHtml(t.insight || '')}${
        Array.isArray(t.interviewees) && t.interviewees.length
          ? ` <span class="theme-who">— ${t.interviewees.map(escapeHtml).join(', ')}</span>`
          : ''
      }</div>
      `;
      sec.appendChild(row);
    });
    panel.appendChild(sec);
  }

  const listSection = (title, items, cls) => {
    if (!Array.isArray(items) || !items.length) return;
    const sec = document.createElement('div');
    sec.className = 'synthesis-section';
    const ul = items
      .map((i) => `<li>${cls === 'quote' ? '"' + escapeHtml(i) + '"' : escapeHtml(i)}</li>`)
      .join('');
    sec.innerHTML = `<div class="synthesis-section-title">${title}</div><ul class="synthesis-list ${cls || ''}">${ul}</ul>`;
    panel.appendChild(sec);
  };

  listSection('Validated patterns', syn.validated);
  listSection('Weak or contradictory', syn.weakOrContradictory);
  listSection('Top quotes', syn.topQuotes, 'quote');

  if (syn.recommendation) {
    const rec = document.createElement('div');
    rec.className = 'synthesis-rec';
    rec.innerHTML = `<div class="synthesis-section-title">Recommended next move</div><div class="synthesis-rec-text">${escapeHtml(syn.recommendation)}</div>`;
    panel.appendChild(rec);
  }
}

function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ---- Wire up ----
$('start-btn').addEventListener('click', startSession);
$('open-library').addEventListener('click', openLibrary);
$('library-back').addEventListener('click', closeLibrary);
$('synthesize-btn').addEventListener('click', runSynthesis);
$('logout-btn').addEventListener('click', logout);
$('stop-btn').addEventListener('click', stopSession);
$('export-btn').addEventListener('click', downloadTranscript);
$('dl-transcript').addEventListener('click', downloadTranscript);
$('dl-summary').addEventListener('click', downloadSummary);
$('summary-close').addEventListener('click', () => {
  $('summary-overlay').style.display = 'none';
});
$('new-session').addEventListener('click', () => location.reload());
$('debug-toggle').addEventListener('click', () => {
  const body = $('debug-body');
  body.style.display = body.style.display === 'none' ? 'block' : 'none';
});
['your-name', 'their-name', 'deepgram-key'].forEach((id) => {
  $(id).addEventListener('keypress', (e) => {
    if (e.key === 'Enter') startSession();
  });
});

boot();
