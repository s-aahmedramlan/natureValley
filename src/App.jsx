import React, { useState, useEffect, useRef, useCallback } from 'react';
import './App.css';

export default function MeetingAssistant() {
  const [phase, setPhase] = useState('setup');
  const [yourName, setYourName] = useState('');
  const [theirName, setTheirName] = useState('');
  const [deepgramApiKey, setDeepgramApiKey] = useState(sessionStorage.getItem('deepgram_api_key') || '');
  const [premeetingNotes, setPremeetingNotes] = useState('');

  const [isRecording, setIsRecording] = useState(false);
  const [transcript, setTranscript] = useState([]);
  const [questions, setQuestions] = useState(null);
  const [questionsUpdatedAt, setQuestionsUpdatedAt] = useState(null);
  const [questionLoading, setQuestionLoading] = useState(false);
  const [sessionStartTime, setSessionStartTime] = useState(null);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [error, setError] = useState(null);
  const [apiError, setApiError] = useState(null);
  const [debugLogs, setDebugLogs] = useState([]);

  const addDebugLog = (msg) => {
    const timestamp = new Date().toLocaleTimeString();
    const log = `[${timestamp}] ${msg}`;
    setDebugLogs((prev) => [log, ...prev].slice(0, 15));
    console.log(msg);
  };

  const deepgramWebSocketRef = useRef(null);
  const audioStreamRef = useRef(null);
  const audioContextRef = useRef(null);
  const processorRef = useRef(null);
  const currentSpeakerRef = useRef('them');
  const questionDebounceRef = useRef(null);
  const timerIntervalRef = useRef(null);
  const transcriptEndRef = useRef(null);
  const sessionStartTimeRef = useRef(null);
  const generateQuestionsRef = useRef(null);

  // Initialize Deepgram WebSocket with raw PCM audio via AudioContext
  const initializeDeepgram = useCallback(async () => {
    if (!deepgramApiKey) {
      addDebugLog('❌ Deepgram API key missing');
      setError('Deepgram API key missing');
      return;
    }

    try {
      addDebugLog('🎤 Requesting microphone access...');
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      audioStreamRef.current = stream;
      addDebugLog('✓ Microphone access granted');

      addDebugLog('🔗 Connecting to Deepgram...');
      const ws = new WebSocket(
        `wss://api.deepgram.com/v1/listen?encoding=linear16&sample_rate=16000&channels=1&model=nova-2&smart_format=true&interim_results=false`,
        ['token', deepgramApiKey]
      );

      ws.onopen = () => {
        addDebugLog('✅ Deepgram WebSocket connected');
        setIsRecording(true);

        // Use AudioContext to capture raw PCM at 16kHz — avoids codec mismatch
        const audioContext = new AudioContext({ sampleRate: 16000 });
        audioContextRef.current = audioContext;

        const source = audioContext.createMediaStreamSource(stream);
        // ScriptProcessor is deprecated but works everywhere without extra files
        const processor = audioContext.createScriptProcessor(4096, 1, 1);
        processorRef.current = processor;

        processor.onaudioprocess = (e) => {
          if (ws.readyState !== WebSocket.OPEN) return;
          const float32 = e.inputBuffer.getChannelData(0);
          // Convert float32 → int16 (linear16)
          const int16 = new Int16Array(float32.length);
          for (let i = 0; i < float32.length; i++) {
            int16[i] = Math.max(-32768, Math.min(32767, Math.round(float32[i] * 32767)));
          }
          ws.send(int16.buffer);
        };

        source.connect(processor);
        processor.connect(audioContext.destination);
        addDebugLog('▶️ Recording started, sending PCM audio to Deepgram');
      };

      ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);

          if (data.channel && data.channel.alternatives && data.channel.alternatives[0]) {
            const transcriptText = data.channel.alternatives[0].transcript;

            if (transcriptText && transcriptText.trim()) {
              addDebugLog(`📝 "${transcriptText}" (final: ${data.is_final})`);
            }

            if (transcriptText && transcriptText.trim() && data.is_final) {
              const wordCount = transcriptText.trim().split(/\s+/).length;
              const speaker = currentSpeakerRef.current;
              const now = Date.now();
              const startTime = sessionStartTimeRef.current || now;

              const newEntry = {
                speaker,
                text: transcriptText.trim(),
                timestamp: now - startTime,
                isFinal: true,
              };

              addDebugLog(`🗣️ [${speaker}] ${wordCount} words added`);

              setTranscript((prev) => {
                const updated = [...prev, newEntry];

                if (speaker === 'them' && wordCount > 8 && generateQuestionsRef.current) {
                  generateQuestionsRef.current(updated);
                }

                return updated;
              });

              // Alternate speaker after each utterance
              currentSpeakerRef.current = speaker === 'them' ? 'you' : 'them';
            }
          }
        } catch (parseErr) {
          addDebugLog(`❌ Parse error: ${parseErr.message}`);
        }
      };

      ws.onerror = () => {
        addDebugLog('❌ Deepgram WebSocket error (check API key)');
        setError('Deepgram connection error — check your API key');
      };

      ws.onclose = (event) => {
        addDebugLog(`⛔ Deepgram closed (code: ${event.code})`);
        setIsRecording(false);
      };

      deepgramWebSocketRef.current = ws;
    } catch (err) {
      addDebugLog(`❌ Microphone error: ${err.message}`);
      setError(`Could not access microphone: ${err.message}`);
    }
  }, [deepgramApiKey]);

  // Timer
  useEffect(() => {
    if (phase !== 'recording') return;

    timerIntervalRef.current = setInterval(() => {
      setElapsedSeconds((prev) => prev + 1);
    }, 1000);

    return () => clearInterval(timerIntervalRef.current);
  }, [phase]);

  // Auto-scroll transcript
  useEffect(() => {
    transcriptEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [transcript]);

  const generateQuestions = useCallback(
    async (currentTranscript) => {
      if (questionLoading) {
        addDebugLog('⏳ Questions already loading, skipping...');
        return;
      }

      if (questionDebounceRef.current) {
        clearTimeout(questionDebounceRef.current);
      }

      setApiError(null);
      setQuestionLoading(true);

      const intervieweeLines = currentTranscript
        .filter((item) => item.speaker === 'them')
        .map((item) => item.text)
        .join(' ');

      if (!intervieweeLines.trim()) {
        addDebugLog('⚠️ No interviewee lines yet');
        setQuestionLoading(false);
        return;
      }

      addDebugLog(`🤖 Calling Claude for questions...`);

      try {
        let systemPrompt = `You are a neutral observer in a customer discovery interview. Your only job is to help the interviewer probe deeper into problems the interviewee mentions.

Rules:
- Read only what the INTERVIEWEE has said
- Generate exactly 2 follow-up questions
- Each question must be grounded in something specific the interviewee actually said
- Questions must be open-ended: explore problems, friction, workarounds, costs, or unmet needs
- Never lead — don't imply a solution or reference any product
- Never ask "why don't you just..." type questions
- Tone: curious, conversational, direct
- Output ONLY a valid JSON array of exactly 2 strings. No preamble, no markdown, no explanation.
Example: ["What happens when that breaks down?", "Who's responsible for fixing it today?"]`;

        if (premeetingNotes.trim()) {
          systemPrompt += `\n\nBackground context about the interviewee (use this to inform your questions about known pain points and priorities):\n${premeetingNotes}`;
        }

        const response = await fetch('/api/anthropic/v1/messages', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model: 'claude-sonnet-4-6',
            max_tokens: 256,
            system: systemPrompt,
            messages: [
              {
                role: 'user',
                content: `Based on this interviewee's statements, generate exactly 2 follow-up questions:\n\n${intervieweeLines}`,
              },
            ],
          }),
        });

        if (!response.ok) {
          const errText = await response.text();
          if (response.status === 401) {
            addDebugLog('❌ 401 — Anthropic API key is invalid. Get one at console.anthropic.com');
            throw new Error('Invalid Anthropic API key (401) — check console.anthropic.com');
          }
          addDebugLog(`❌ API Error ${response.status}: ${errText.slice(0, 120)}`);
          throw new Error(`API error: ${response.status}`);
        }

        const data = await response.json();
        const content = data.content[0].text;
        addDebugLog('✅ Claude responded');

        try {
          const parsed = JSON.parse(content);
          if (Array.isArray(parsed) && parsed.length === 2) {
            addDebugLog('✓ Questions generated');
            setQuestions(parsed);
            setQuestionsUpdatedAt(Date.now());
          } else {
            addDebugLog(`❌ Invalid response: ${content}`);
            setApiError('Invalid question format');
          }
        } catch (e) {
          addDebugLog(`❌ Parse error: ${e.message}`);
          setApiError('Failed to parse questions');
        }
      } catch (err) {
        addDebugLog(`❌ API failed: ${err.message}`);
        setApiError(err.message || 'Failed to generate questions');
      } finally {
        setQuestionLoading(false);
      }
    },
    [questionLoading, premeetingNotes]
  );

  const handleStartSession = () => {
    if (!yourName.trim() || !theirName.trim()) {
      setError('Please enter both names');
      return;
    }

    if (!deepgramApiKey.trim()) {
      setError('Please enter your Deepgram API key');
      return;
    }

    sessionStorage.setItem('deepgram_api_key', deepgramApiKey);

    const now = Date.now();
    sessionStartTimeRef.current = now;

    setError(null);
    setDebugLogs([]);
    addDebugLog(`🎙️ Starting: You="${yourName}", Them="${theirName}"`);

    setPhase('recording');
    setSessionStartTime(now);
    setElapsedSeconds(0);
    setTranscript([]);
    setQuestions(null);
    currentSpeakerRef.current = 'them';

    initializeDeepgram();
  };

  // Keep generateQuestionsRef in sync so the WebSocket closure always calls the latest version
  useEffect(() => {
    generateQuestionsRef.current = generateQuestions;
  }, [generateQuestions]);

  const handleStop = () => {
    if (processorRef.current) {
      processorRef.current.disconnect();
      processorRef.current = null;
    }
    if (audioContextRef.current) {
      audioContextRef.current.close();
      audioContextRef.current = null;
    }
    if (deepgramWebSocketRef.current) {
      deepgramWebSocketRef.current.close();
    }
    if (audioStreamRef.current) {
      audioStreamRef.current.getTracks().forEach((track) => track.stop());
    }
    setPhase('stopped');
  };

  const handleFlipSpeaker = (index) => {
    setTranscript((prev) =>
      prev.map((item, i) =>
        i === index
          ? { ...item, speaker: item.speaker === 'them' ? 'you' : 'them' }
          : item
      )
    );
  };

  const exportTranscript = () => {
    const date = new Date(sessionStartTime).toISOString().split('T')[0];
    const duration = `${Math.floor(elapsedSeconds / 60)
      .toString()
      .padStart(2, '0')}:${(elapsedSeconds % 60).toString().padStart(2, '0')}`;

    let markdown = `# Discovery call transcript
Date: ${date}
Interviewer: ${yourName}
Interviewee: ${theirName}
Duration: ${duration}

---

## Transcript

`;

    transcript.forEach((item) => {
      const mins = Math.floor(item.timestamp / 60000);
      const secs = Math.floor((item.timestamp % 60000) / 1000);
      const timeStr = `${mins.toString().padStart(2, '0')}:${secs
        .toString()
        .padStart(2, '0')}`;
      const speaker = item.speaker === 'them' ? theirName : yourName;
      markdown += `**[${timeStr}]** **${speaker}**: ${item.text}\n\n`;
    });

    const blob = new Blob([markdown], { type: 'text/markdown' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `discovery-${theirName
      .replace(/\s+/g, '-')
      .toLowerCase()}-${date}.md`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const copyToClipboard = () => {
    const date = new Date(sessionStartTime).toISOString().split('T')[0];
    const duration = `${Math.floor(elapsedSeconds / 60)
      .toString()
      .padStart(2, '0')}:${(elapsedSeconds % 60).toString().padStart(2, '0')}`;

    let markdown = `# Discovery call transcript
Date: ${date}
Interviewer: ${yourName}
Interviewee: ${theirName}
Duration: ${duration}

---

## Transcript

`;

    transcript.forEach((item) => {
      const mins = Math.floor(item.timestamp / 60000);
      const secs = Math.floor((item.timestamp % 60000) / 1000);
      const timeStr = `${mins.toString().padStart(2, '0')}:${secs
        .toString()
        .padStart(2, '0')}`;
      const speaker = item.speaker === 'them' ? theirName : yourName;
      markdown += `**[${timeStr}]** **${speaker}**: ${item.text}\n\n`;
    });

    navigator.clipboard.writeText(markdown);
  };

  if (error && phase === 'setup') {
    return (
      <div className="error-container">
        <div className="error-content">
          <p>{error}</p>
        </div>
      </div>
    );
  }

  if (phase === 'setup') {
    return (
      <div className="setup-container">
        <div className="setup-card">
          {error && <div className="error-alert">{error}</div>}

          <div className="form-group">
            <input
              type="text"
              placeholder="Your name"
              value={yourName}
              onChange={(e) => setYourName(e.target.value)}
              onKeyPress={(e) => e.key === 'Enter' && handleStartSession()}
              className="form-input"
            />

            <input
              type="text"
              placeholder="Their name"
              value={theirName}
              onChange={(e) => setTheirName(e.target.value)}
              onKeyPress={(e) => e.key === 'Enter' && handleStartSession()}
              className="form-input"
            />

            <input
              type="password"
              placeholder="Deepgram API key"
              value={deepgramApiKey}
              onChange={(e) => setDeepgramApiKey(e.target.value)}
              onKeyPress={(e) => e.key === 'Enter' && handleStartSession()}
              className="form-input"
            />

            <div>
              <label className="form-label">Pre-meeting notes (optional)</label>
              <textarea
                placeholder="e.g., Company size, industry, known pain points, priorities..."
                value={premeetingNotes}
                onChange={(e) => setPremeetingNotes(e.target.value)}
                className="form-textarea"
                rows="4"
              />
            </div>

            <button onClick={handleStartSession} className="submit-btn">
              Start session →
            </button>
          </div>
        </div>
      </div>
    );
  }

  const mins = Math.floor(elapsedSeconds / 60)
    .toString()
    .padStart(2, '0');
  const secs = (elapsedSeconds % 60).toString().padStart(2, '0');
  const timeStr = `${mins}:${secs}`;

  return (
    <div className="main-container">
      <div className="app-panel">
        <div className="top-bar">
          <div className="top-bar-left">
            <div className={`recording-dot ${isRecording ? 'active' : ''}`} />
            <span className="timer">{timeStr}</span>
          </div>

          <div className="top-bar-right">
            <button onClick={handleStop} className="btn">
              Stop
            </button>
            <button onClick={exportTranscript} className="btn">
              Export
            </button>
          </div>
        </div>

        <div className="questions-section">
          <div className="section-label">Ask Next</div>

          {!theirName || transcript.filter((t) => t.speaker === 'them').length === 0 ? (
            <div className="questions-placeholder">
              Questions appear once {theirName || 'they'} starts talking
            </div>
          ) : (
            <div className="questions-container">
              {questionLoading ? (
                <>
                  <div className="skeleton-box" />
                  <div className="skeleton-box" />
                </>
              ) : questions ? (
                <>
                  {questions.map((q, i) => (
                    <div key={i} className="question-card">
                      <p className="question-text">
                        {i + 1}. {q}
                      </p>
                    </div>
                  ))}
                </>
              ) : null}

              {questions && (
                <div className="questions-timestamp">
                  updated{' '}
                  {questionsUpdatedAt
                    ? `${Math.round((Date.now() - questionsUpdatedAt) / 1000)}s ago`
                    : 'just now'}
                </div>
              )}
            </div>
          )}

          {apiError && <div className="api-error">{apiError}</div>}
        </div>

        <div className="transcript-section">
          <div className="section-label">Live</div>

          <div className="transcript-feed">
            {transcript.length === 0 ? (
              <div className="transcript-empty">Waiting for speech...</div>
            ) : (
              transcript.map((item, index) => (
                <div key={index} className="transcript-line">
                  <span
                    className={`speaker-label ${
                      item.speaker === 'them' ? 'interviewee' : ''
                    }`}
                  >
                    {item.speaker === 'them' ? 'them' : 'you'}
                  </span>
                  <span className="transcript-text">{item.text}</span>
                  <button
                    onClick={() => handleFlipSpeaker(index)}
                    className="flip-btn"
                  >
                    ↔
                  </button>
                </div>
              ))
            )}
            <div ref={transcriptEndRef} />
          </div>
        </div>

        {phase === 'stopped' && (
          <div className="bottom-bar">
            <button onClick={copyToClipboard} className="copy-btn">
              Copy to clipboard
            </button>
          </div>
        )}
      </div>

      {/* Debug Panel */}
      {phase === 'recording' && (
        <div style={{
          position: 'fixed',
          bottom: 20,
          right: 20,
          width: '300px',
          maxHeight: '350px',
          backgroundColor: '#161A20',
          border: '1px solid #2A2D33',
          borderRadius: '6px',
          padding: '12px',
          fontSize: '10px',
          fontFamily: 'monospace',
          color: '#E8E8E8',
          overflowY: 'auto',
          zIndex: 1000,
          boxShadow: '0 4px 12px rgba(0,0,0,0.3)'
        }}>
          <div style={{fontSize: '11px', fontWeight: 'bold', marginBottom: '8px', color: '#4F8EF7'}}>🔧 Debug</div>
          <div style={{marginBottom: '8px', paddingBottom: '8px', borderBottom: '1px solid #2A2D33', fontSize: '10px'}}>
            <div>Recording: {isRecording ? '🔴 ON' : '⚫ OFF'}</div>
            <div>Utterances: {transcript.length}</div>
            <div>Questions: {questions ? '✓ ' + questions.length : '—'}</div>
          </div>
          <div style={{fontSize: '9px', color: '#5A5E66', marginBottom: '4px'}}>Logs:</div>
          {debugLogs.map((log, i) => (
            <div key={i} style={{marginTop: '2px', whiteSpace: 'pre-wrap', wordBreak: 'break-word', color: '#5A5E66', lineHeight: '1.2'}}>
              {log}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
