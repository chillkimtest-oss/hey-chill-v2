// FRG-270 test
'use strict';

/* ===== QUICK MODE STATE (Web Speech API) ===== */
let recognition       = null;
let isListening       = false;
let quickFinalTranscript = '';
let silenceTimer      = null;
const SILENCE_DELAY   = 3500; // ms — auto-stop after this much silence

/* ===== BRAINSTORM MODE STATE (WebSocket + PCM audio) ===== */
let ws, audioContext, processor, source, stream;
let isBrainstormRecording  = false;
let isBrainstormProcessing = false; // after stop_recording, waiting for WS idle
let isStopping             = false; // allow final audio flush during stop
let isReplaying            = false;
let timerInterval, startTime;
let audioBuffer            = new Int16Array(0);
let wsConnected            = false;
let streamInitialized      = false;
let brainstormTranscript   = '';
let _awaitingBrainstormResult = false;

/* ===== LOCAL AUDIO PLAYBACK STATE ===== */
let replayAudioCtx    = null;  // dedicated AudioContext for playback
let replayAudioSource = null;  // current AudioBufferSourceNode
let replayAudioBuf    = null;  // decoded AudioBuffer for the loaded recording
let replayDuration    = 0;     // total duration in seconds
let replayPauseOffset = 0;     // seconds already played before the current segment
let replayStartedAt   = 0;     // replayAudioCtx.currentTime when current segment started
let replayRAF         = null;  // requestAnimationFrame id for progress updates
let isPlayingBack     = false; // true while audio is actively playing

/* ===== WAKE WORD / HANDS-FREE STATE ===== */
let wakeRecognition   = null;
let wakeWordListening = false;
let handsFreeEnabled  = false;

/* ===== URL PARAMS ===== */
const urlParams   = new URLSearchParams(window.location.search);
const autoStart   = urlParams.get('start') === '1';
let   isAutoStarted = false;

/* ===== CARD STACK STATE ===== */
let lastRecordingDurationMs = 0; // stored when recording stops, used for card metadata

/* ===== INDEXEDDB STATE ===== */
let db              = null;
let currentSessionId = null;
let sessionStartTime = null;
let chunkSeq        = 0;
let storageAvailable = false;

/* ===== DOM REFS ===== */
const quickBtn         = document.getElementById('quick-btn');
const quickRing        = document.getElementById('quick-ring');
const brainstormBtn    = document.getElementById('brainstorm-btn');
const brainstormRing   = document.getElementById('brainstorm-ring');
const micHint          = document.getElementById('mic-hint');
const liveTranscript   = document.getElementById('live-transcript');
const liveText         = document.getElementById('live-text');
const transcriptBar    = document.getElementById('transcript-bar');
const transcriptText   = document.getElementById('transcript-text');
const sendBtn          = document.getElementById('send-btn');
const discardBtn       = document.getElementById('discard-btn');
const messagesEl       = document.getElementById('messages');
const messagesEmpty    = document.getElementById('messages-empty');
const timerEl           = document.getElementById('timer');
const replayButton      = document.getElementById('replayButton');
const stopButton        = document.getElementById('stopButton');
const replayProgressWrap = document.getElementById('replay-progress-wrap');
const replayProgressFill = document.getElementById('replay-progress-fill');
const connectionStatus  = document.getElementById('connectionStatus');
const notSupported     = document.getElementById('not-supported');
const settingsBtn      = document.getElementById('settings-btn');
const modalOverlay     = document.getElementById('modal-overlay');
const modalClose       = document.getElementById('modal-close');
const webhookInput     = document.getElementById('webhook-url');
const backendUrlInput  = document.getElementById('backend-url');
const langSelect       = document.getElementById('lang-select');
const saveSettings     = document.getElementById('save-settings');
const modelSelect      = document.getElementById('modelSelect');
const handsFreeToggle  = document.getElementById('hands-free-toggle');
const wakeDot          = document.getElementById('wake-dot');

/* ===== CARD STACK DOM REFS ===== */
const cardStackView = document.getElementById('card-stack-view');
const csCards       = document.getElementById('cs-cards');
const csBackBtn     = document.getElementById('cs-back-btn');

/* ===== POST-PROCESSING DOM REFS ===== */
const postprocessBar           = document.getElementById('postprocess-bar');
const readabilityBtn           = document.getElementById('readability-btn');
const inspireBtn               = document.getElementById('inspire-btn');
const postprocessResult        = document.getElementById('postprocess-result');
const postprocessLabel         = document.getElementById('postprocess-label');
const postprocessText          = document.getElementById('postprocess-text');
const postprocessResultActions = document.getElementById('postprocess-result-actions');
const postprocessSendBtn       = document.getElementById('postprocess-send-btn');

/* ===== UTILITY ===== */
function escapeHtml(str) {
    return str
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function haptic(ms) {
    if (navigator.vibrate) navigator.vibrate(ms);
}

/* ===== TIMER ===== */
function startTimer() {
    clearInterval(timerInterval);
    startTime = Date.now();
    timerEl.hidden = false;
    timerEl.textContent = '00:00';
    timerInterval = setInterval(() => {
        const elapsed = Date.now() - startTime;
        const mins = Math.floor(elapsed / 60000);
        const secs = Math.floor((elapsed % 60000) / 1000);
        timerEl.textContent = `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
    }, 1000);
}

function stopTimer() {
    clearInterval(timerInterval);
    timerEl.hidden = true;
}

/* ===== LIVE TRANSCRIPT AREA ===== */
function showLiveTranscript(text, mode) {
    liveTranscript.hidden = false;
    liveTranscript.classList.toggle('brainstorm-mode', mode === 'brainstorm');
    if (text) {
        liveText.textContent = text;
        liveText.classList.add('has-text');
    } else {
        liveText.textContent = mode === 'quick' ? 'Listening…' : 'Recording…';
        liveText.classList.remove('has-text');
    }
}

function updateLiveText(text) {
    if (text) {
        liveText.textContent = text;
        liveText.classList.add('has-text');
        if (isBrainstormProcessing) {
            liveTranscript.scrollTop = liveTranscript.scrollHeight;
        }
    } else {
        liveText.textContent = isListening ? 'Listening…' : 'Recording…';
        liveText.classList.remove('has-text');
    }
}

function hideLiveTranscript() {
    liveTranscript.hidden = true;
    liveText.textContent = 'Listening…';
    liveText.classList.remove('has-text');
}

/* ===== TRANSCRIPT BAR ===== */
function showTranscriptBar(text, source) {
    transcriptText.textContent = text;
    transcriptBar.dataset.source = source || 'quick';
    transcriptBar.hidden = false;

    // Show / reset post-processing for Brainstorm mode
    const isBrainstorm = source === 'brainstorm';
    postprocessBar.hidden = !isBrainstorm;
    postprocessResult.hidden = true;
    postprocessResultActions.hidden = true;
    postprocessText.textContent = '';
    readabilityBtn.textContent = 'Readability';
    inspireBtn.textContent = 'Inspire';
    readabilityBtn.disabled = false;
    inspireBtn.disabled = false;
}

function hideTranscriptBar() {
    transcriptBar.hidden = true;
    transcriptText.textContent = '';
    // Reset post-processing state
    postprocessBar.hidden = true;
    postprocessResult.hidden = true;
    postprocessResultActions.hidden = true;
    postprocessText.textContent = '';
}

/* ===== CARD STACK ===== */

/** Build a single card element and append it to cs-cards. */
function buildCard({ type, label, text, meta }) {
    const words    = text.trim().split(/\s+/);
    const preview  = words.slice(0, 15).join(' ') + (words.length > 15 ? '…' : '');

    const card = document.createElement('div');
    card.className = 'cs-card';
    card.dataset.type = type;
    card.setAttribute('role', 'listitem');

    card.innerHTML = `
      <div class="cs-card-header" role="button" tabindex="0"
           aria-expanded="false" aria-controls="cs-body-${type}">
        <span class="cs-card-label">${escapeHtml(label)}</span>
        <span class="cs-card-preview">${escapeHtml(preview)}</span>
        <span class="cs-card-chevron" aria-hidden="true">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"
               stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="6 9 12 15 18 9"/>
          </svg>
        </span>
      </div>
      <div class="cs-card-body" id="cs-body-${type}" role="region">
        <div class="cs-card-body-inner">
          <div class="cs-card-meta">
            ${meta.map(m => `<span>${escapeHtml(m)}</span>`).join('')}
          </div>
          <div class="cs-card-text">${escapeHtml(text)}</div>
          <div class="cs-card-actions">
            <button class="cs-action-btn" data-action="readability" disabled>Readability</button>
            <button class="cs-action-btn" data-action="inspire" disabled>Inspire</button>
            <button class="cs-action-btn" data-action="copy" disabled>Copy</button>
            <button class="cs-action-btn" data-action="send" disabled>Send</button>
          </div>
        </div>
      </div>
    `;

    const header = card.querySelector('.cs-card-header');

    function toggleCard() {
        const isExpanded = card.classList.contains('cs-expanded');
        // Collapse all other cards (accordion)
        csCards.querySelectorAll('.cs-card.cs-expanded').forEach(c => {
            if (c !== card) {
                c.classList.remove('cs-expanded');
                c.querySelector('.cs-card-header').setAttribute('aria-expanded', 'false');
            }
        });
        card.classList.toggle('cs-expanded', !isExpanded);
        header.setAttribute('aria-expanded', String(!isExpanded));
    }

    header.addEventListener('click', toggleCard);
    header.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleCard(); }
    });

    return card;
}

/** Formats milliseconds as "m:ss" duration string. */
function formatDuration(ms) {
    const totalSecs = Math.round(ms / 1000);
    const mins = Math.floor(totalSecs / 60);
    const secs = totalSecs % 60;
    return `${mins}:${String(secs).padStart(2, '0')}`;
}

/** Show the Card Stack view with the given brainstorm transcript. */
function showCardStack(text, durationMs) {
    // Clear previous cards
    csCards.innerHTML = '';

    const wordCount = text.trim().split(/\s+/).filter(Boolean).length;
    const durationStr = durationMs > 0 ? formatDuration(durationMs) : null;
    const meta = [
        durationStr ? `${durationStr}` : null,
        `${wordCount} word${wordCount !== 1 ? 's' : ''}`,
    ].filter(Boolean);

    const card = buildCard({ type: 'transcript', label: 'Transcript', text, meta });
    csCards.appendChild(card);

    // Start expanded since it's the only card
    card.classList.add('cs-expanded');
    card.querySelector('.cs-card-header').setAttribute('aria-expanded', 'true');

    // Slide in
    cardStackView.hidden = false;
    // Force a reflow so the transition fires
    void cardStackView.offsetWidth;
    cardStackView.classList.add('cs-visible');
}

/** Hide the Card Stack view and return to main screen. */
function hideCardStack() {
    cardStackView.classList.remove('cs-visible');
    // Wait for the slide-out animation, then hide
    cardStackView.addEventListener('transitionend', function onEnd() {
        cardStackView.removeEventListener('transitionend', onEnd);
        cardStackView.hidden = true;
        csCards.innerHTML = '';
    }, { once: true });
}

/** Immediately hide the card stack without animation (used when recording restarts). */
function hideCardStackInstant() {
    cardStackView.classList.remove('cs-visible');
    cardStackView.hidden = true;
    csCards.innerHTML = '';
}

csBackBtn.addEventListener('click', hideCardStack);

/* ===== MESSAGE HISTORY ===== */
function addMessage(text, timestamp, status) {
    messagesEmpty.style.display = 'none';
    const el = document.createElement('div');
    el.className = `message ${status}`;
    const timeStr = new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const statusLabel = { sending: 'Sending…', sent: 'Sent', error: 'Failed', 'no-webhook': 'No webhook' };
    el.innerHTML = `
        <p class="message-text">${escapeHtml(text)}</p>
        <div class="message-meta">
            <span class="message-time">${timeStr}</span>
            <span class="message-status">${statusLabel[status] || status}</span>
        </div>
    `;
    messagesEl.appendChild(el);
    el.scrollIntoView({ behavior: 'smooth', block: 'end' });
    return el;
}

function updateMessageStatus(el, status) {
    el.className = `message ${status}`;
    const statusEl = el.querySelector('.message-status');
    const labels = { sent: 'Sent', error: 'Failed', 'no-webhook': 'No webhook set' };
    if (statusEl) statusEl.textContent = labels[status] || status;
}

/* ===== WEBHOOK SEND ===== */
async function sendMessage(text, source) {
    const webhookUrl = localStorage.getItem('webhookUrl') || '';
    const timestamp  = new Date().toISOString();
    const payload    = { text, source, timestamp };
    const msgEl      = addMessage(text, timestamp, 'sending');

    if (!webhookUrl) {
        updateMessageStatus(msgEl, 'no-webhook');
        return;
    }

    try {
        const res = await fetch(webhookUrl, {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify(payload),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        updateMessageStatus(msgEl, 'sent');
    } catch (err) {
        console.warn('Webhook error:', err);
        updateMessageStatus(msgEl, 'error');
    }
}

/* ===== TRANSCRIPT BAR ACTIONS ===== */
sendBtn.addEventListener('click', async () => {
    const text   = transcriptText.textContent.trim();
    const source = transcriptBar.dataset.source || 'quick';
    if (!text) return;
    hideTranscriptBar();
    await sendMessage(text, source);
});

discardBtn.addEventListener('click', () => {
    hideTranscriptBar();
});

/* ===== BRAINSTORM POST-PROCESSING ===== */

function getBackendBaseUrl() {
    const backendUrl = localStorage.getItem('brainwaveBackendUrl') || '';
    if (backendUrl) {
        try {
            const url = new URL(backendUrl);
            return `${url.protocol}//${url.host}`;
        } catch (_) { /* fall through to default */ }
    }
    return `${window.location.protocol}//${window.location.host}`;
}

let _postprocessedContent = '';

async function runPostProcess(endpoint, label, activeBtn) {
    const text = transcriptText.textContent.trim();
    if (!text) return;

    // Reset result area
    _postprocessedContent = '';
    postprocessText.textContent = '';
    postprocessLabel.textContent = label;
    postprocessResultActions.hidden = true;

    // Disable both buttons; show loading on the active one
    readabilityBtn.disabled = true;
    inspireBtn.disabled = true;
    const origLabel = activeBtn.textContent;
    activeBtn.textContent = 'Processing…';

    // Show the result area (empty initially so user sees it appeared)
    postprocessResult.hidden = false;

    try {
        const response = await fetch(`${getBackendBaseUrl()}${endpoint}`, {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify({ text }),
        });

        if (!response.ok) throw new Error(`HTTP ${response.status}`);

        const reader  = response.body.getReader();
        const decoder = new TextDecoder();

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            _postprocessedContent += decoder.decode(value, { stream: true });
            postprocessText.textContent = _postprocessedContent;
        }

        // Streaming complete — show Send button
        postprocessResultActions.hidden = false;

    } catch (err) {
        console.error('Post-processing error:', err);
        postprocessText.textContent = 'Error: could not process. Check connection and try again.';
    } finally {
        activeBtn.textContent = origLabel;
        readabilityBtn.disabled = false;
        inspireBtn.disabled = false;
    }
}

readabilityBtn.addEventListener('click', () => {
    runPostProcess('/api/v1/readability', 'Readability', readabilityBtn);
});

inspireBtn.addEventListener('click', () => {
    runPostProcess('/api/v1/correctness', 'Inspire', inspireBtn);
});

postprocessSendBtn.addEventListener('click', async () => {
    const text = _postprocessedContent.trim();
    if (!text) return;
    hideTranscriptBar();
    await sendMessage(text, 'brainstorm');
});

/* ===== SETTINGS MODAL ===== */
settingsBtn.addEventListener('click', openSettings);
modalClose.addEventListener('click', closeSettings);
modalOverlay.addEventListener('click', (e) => { if (e.target === modalOverlay) closeSettings(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeSettings(); });

saveSettings.addEventListener('click', () => {
    const url = webhookInput.value.trim();
    localStorage.setItem('webhookUrl', url);

    const backendUrl = backendUrlInput.value.trim();
    if (backendUrl) {
        localStorage.setItem('brainwaveBackendUrl', backendUrl);
    } else {
        localStorage.removeItem('brainwaveBackendUrl');
    }

    const lang     = langSelect.value;
    const prevLang = localStorage.getItem('recognitionLang') || '';
    if (lang !== prevLang) {
        if (lang) {
            localStorage.setItem('recognitionLang', lang);
        } else {
            localStorage.removeItem('recognitionLang');
        }
        // Re-init recognition so new language takes effect immediately
        if (!isListening) initRecognition();
        // Re-init wake recognition for new language too
        if (!wakeWordListening) initWakeRecognition();
    }

    const newHandsFree = handsFreeToggle ? handsFreeToggle.checked : false;
    if (newHandsFree !== handsFreeEnabled) {
        setHandsFree(newHandsFree);
    }

    if (modelSelect) {
        localStorage.setItem('brainstormModel', modelSelect.value);
    }

    closeSettings();
});

function openSettings() {
    webhookInput.value    = localStorage.getItem('webhookUrl') || '';
    backendUrlInput.value = localStorage.getItem('brainwaveBackendUrl') || '';
    langSelect.value      = localStorage.getItem('recognitionLang') || '';
    if (handsFreeToggle) handsFreeToggle.checked = handsFreeEnabled;
    if (modelSelect) modelSelect.value = localStorage.getItem('brainstormModel') || 'gpt-realtime-mini-2025-12-15';
    modalOverlay.hidden   = false;
    webhookInput.focus();
}

function closeSettings() {
    modalOverlay.hidden = true;
}

/* ===================================================
   QUICK MODE — Web Speech API
   No WebSocket. No backend. Browser-only.
   =================================================== */

const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;

function getRecognitionLang() {
    return localStorage.getItem('recognitionLang') || navigator.language || 'en-US';
}

function initRecognition() {
    if (!SpeechRecognition) return;

    recognition = new SpeechRecognition();
    recognition.continuous      = true;
    recognition.interimResults  = true;
    recognition.lang            = getRecognitionLang();
    recognition.maxAlternatives = 1;

    recognition.onstart = () => {
        isListening      = true;
        quickFinalTranscript = '';
        showLiveTranscript('', 'quick');
        quickBtn.classList.add('recording');
        quickRing.classList.add('recording');
        quickBtn.setAttribute('aria-pressed', 'true');
        brainstormBtn.disabled = true;
        replayButton.disabled  = true;
        micHint.textContent = 'Listening… tap Quick to stop';
        micHint.classList.add('active');
        micHint.classList.remove('brainstorm-active', 'processing');
    };

    recognition.onresult = (event) => {
        let interim = '';
        for (let i = event.resultIndex; i < event.results.length; i++) {
            const result = event.results[i];
            if (result.isFinal) {
                quickFinalTranscript += result[0].transcript + ' ';
            } else {
                interim += result[0].transcript;
            }
        }
        const displayText = (quickFinalTranscript + interim).trim();
        updateLiveText(displayText);
        resetSilenceTimer();
    };

    recognition.onerror = (event) => {
        if (event.error !== 'no-speech') {
            console.warn('Speech recognition error:', event.error);
        }
        stopQuickMode();
    };

    recognition.onend = () => {
        // If we didn't stop manually, recognition auto-stopped
        if (isListening) {
            finishQuickRecording();
        }
    };
}

function resetSilenceTimer() {
    clearTimeout(silenceTimer);
    silenceTimer = setTimeout(() => {
        if (isListening) stopQuickMode();
    }, SILENCE_DELAY);
}

function startQuickMode() {
    if (isListening || isBrainstormRecording || isBrainstormProcessing || isReplaying) return;
    if (!recognition) {
        alert('Speech recognition is not available in this browser.');
        return;
    }
    hideTranscriptBar();
    // Stop any active local playback
    if (isPlayingBack) stopLocalPlayback();
    // Stop wake word listener if running (can't run both concurrently)
    if (wakeWordListening) stopWakeWordListening();
    try {
        recognition.start();
    } catch (e) {
        console.warn('Could not start recognition:', e);
        initRecognition();
        try { recognition.start(); } catch (_) {}
    }
    resetSilenceTimer();
}

function stopQuickMode() {
    clearTimeout(silenceTimer);
    // Mark as not listening BEFORE calling recognition.stop() so that
    // recognition.onend doesn't also call finishQuickRecording()
    isListening = false;
    if (recognition) {
        try { recognition.stop(); } catch (_) {}
    }
    finishQuickRecording();
}

function finishQuickRecording() {
    isListening = false;
    clearTimeout(silenceTimer);
    quickBtn.classList.remove('recording');
    quickRing.classList.remove('recording');
    quickBtn.setAttribute('aria-pressed', 'false');
    brainstormBtn.disabled = false;
    micHint.textContent    = '';
    micHint.classList.remove('active');
    hideLiveTranscript();
    updateReplayButtonState();

    const text = quickFinalTranscript.trim();
    quickFinalTranscript = '';
    if (text) {
        showTranscriptBar(text, 'quick');
    }

    // Resume hands-free wake word listening
    if (handsFreeEnabled) {
        setTimeout(startWakeWordListening, 400);
    }
}

quickBtn.addEventListener('click', () => {
    haptic(50);
    if (isListening) {
        stopQuickMode();
    } else if (!isBrainstormRecording && !isBrainstormProcessing && !isReplaying) {
        startQuickMode();
    }
});

/* ===================================================
   WAKE WORD DETECTION — always-on "Hey Chill" listener
   =================================================== */

function matchesWakeWord(text) {
    const t = text.toLowerCase().trim();
    // Fuzzy patterns: "hey chill", "hey chil", "a chill", "hay chill", etc.
    return /\b(hey|hay|a)\s+chil{1,2}\b/.test(t);
}

function initWakeRecognition() {
    if (!SpeechRecognition) return;

    wakeRecognition = new SpeechRecognition();
    wakeRecognition.continuous      = true;
    wakeRecognition.interimResults  = true;
    wakeRecognition.lang            = getRecognitionLang();
    wakeRecognition.maxAlternatives = 3;

    wakeRecognition.onresult = (event) => {
        for (let i = event.resultIndex; i < event.results.length; i++) {
            const result = event.results[i];
            for (let j = 0; j < result.length; j++) {
                if (matchesWakeWord(result[j].transcript)) {
                    handleWakeWordDetected();
                    return;
                }
            }
        }
    };

    wakeRecognition.onerror = (event) => {
        if (event.error === 'not-allowed' || event.error === 'service-not-allowed') {
            console.warn('Wake word mic denied:', event.error);
            wakeWordListening = false;
            updateWakeDot();
            return;
        }
        // Transient error — will be restarted by onend handler
    };

    wakeRecognition.onend = () => {
        wakeWordListening = false;
        updateWakeDot();
        // Auto-restart when not in an active mode
        if (handsFreeEnabled && !isListening && !isBrainstormRecording && !isBrainstormProcessing) {
            setTimeout(startWakeWordListening, 300);
        }
    };
}

function startWakeWordListening() {
    if (!SpeechRecognition || !handsFreeEnabled) return;
    if (isListening || isBrainstormRecording || isBrainstormProcessing) return;
    if (wakeWordListening) return;

    if (!wakeRecognition) initWakeRecognition();

    try {
        wakeRecognition.start();
        wakeWordListening = true;
        updateWakeDot();
    } catch (e) {
        console.warn('Could not start wake recognition:', e);
        wakeWordListening = false;
        // Re-init and try once more next cycle
        initWakeRecognition();
    }
}

function stopWakeWordListening() {
    wakeWordListening = false;
    updateWakeDot();
    if (wakeRecognition) {
        try { wakeRecognition.stop(); } catch (_) {}
    }
}

function handleWakeWordDetected() {
    stopWakeWordListening();
    if (!isListening && !isBrainstormRecording && !isBrainstormProcessing && !isReplaying) {
        haptic(50);
        startQuickMode();
    }
}

function updateWakeDot() {
    if (!wakeDot) return;
    wakeDot.hidden = !(handsFreeEnabled && wakeWordListening);
}

function setHandsFree(enabled) {
    handsFreeEnabled = enabled;
    localStorage.setItem('handsFreeEnabled', enabled ? '1' : '0');
    if (enabled) {
        startWakeWordListening();
    } else {
        stopWakeWordListening();
    }
    updateWakeDot();
}

/* ===================================================
   BRAINSTORM MODE — WebSocket + PCM16 audio streaming
   =================================================== */

function getWebSocketUrl() {
    const backendUrl = localStorage.getItem('brainwaveBackendUrl') || '';
    if (backendUrl) {
        try {
            const url    = new URL(backendUrl);
            const wsProto = url.protocol === 'https:' ? 'wss:' : 'ws:';
            return `${wsProto}//${url.host}/api/v1/ws`;
        } catch (_) { /* fall through to default */ }
    }
    const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
    return `${proto}://${window.location.host}/api/v1/ws`;
}

function updateConnectionStatus(status) {
    connectionStatus.className = 'ws-dot';
    switch (status) {
        case 'connected':
            connectionStatus.classList.add('connected');
            connectionStatus.title = 'Connected';
            break;
        case 'connecting':
            connectionStatus.classList.add('connecting');
            connectionStatus.title = 'Connecting…';
            break;
        case 'idle':
            connectionStatus.classList.add('idle');
            connectionStatus.title = 'Ready';
            break;
        default:
            connectionStatus.title = 'Disconnected';
    }
}

function initializeWebSocket() {
    ws = new WebSocket(getWebSocketUrl());

    ws.onopen = () => {
        wsConnected = true;
        updateConnectionStatus('idle');
        if (autoStart && !isBrainstormRecording && !isAutoStarted) {
            isAutoStarted = true;
            startBrainstormRecording();
        }
    };

    ws.onerror = (error) => {
        console.error('WebSocket error:', error);
        updateConnectionStatus('disconnected');
    };

    ws.onmessage = (event) => {
        const data = JSON.parse(event.data);
        switch (data.type) {
            case 'status':
                updateConnectionStatus(data.status);
                if (data.status === 'idle') {
                    stopTimer();
                    if (_awaitingBrainstormResult) {
                        _awaitingBrainstormResult = false;
                        isBrainstormProcessing    = false;
                        quickBtn.disabled         = false;
                        brainstormBtn.disabled    = false;
                        micHint.textContent       = '';
                        micHint.classList.remove('active', 'brainstorm-active', 'processing');
                        hideLiveTranscript();
                        updateReplayButtonState();
                        const finalText = brainstormTranscript.trim();
                        brainstormTranscript = '';
                        if (finalText) {
                            showCardStack(finalText, lastRecordingDurationMs);
                        }
                        // Resume hands-free after brainstorm completes
                        if (handsFreeEnabled) {
                            setTimeout(startWakeWordListening, 400);
                        }
                    }
                }
                break;

            case 'text':
                if (data.isNewResponse) {
                    brainstormTranscript = data.content;
                } else {
                    brainstormTranscript += data.content;
                }
                if (isBrainstormProcessing) {
                    updateLiveText(brainstormTranscript);
                }
                break;

            case 'error':
                alert(data.content);
                updateConnectionStatus('idle');
                _awaitingBrainstormResult = false;
                isBrainstormProcessing    = false;
                quickBtn.disabled         = false;
                brainstormBtn.disabled    = false;
                micHint.textContent       = '';
                micHint.classList.remove('active', 'brainstorm-active', 'processing');
                hideLiveTranscript();
                brainstormTranscript = '';
                updateReplayButtonState();
                if (handsFreeEnabled) {
                    setTimeout(startWakeWordListening, 400);
                }
                break;
        }
    };

    ws.onclose = () => {
        wsConnected            = false;
        isBrainstormRecording  = false;
        isStopping             = false;
        updateConnectionStatus('disconnected');
        brainstormBtn.classList.remove('recording');
        brainstormRing.classList.remove('recording');
        brainstormBtn.setAttribute('aria-pressed', 'false');
        // Reconnect automatically
        setTimeout(initializeWebSocket, 1000);
    };
}

/* ===== Audio processing ===== */
function createAudioProcessor() {
    processor = audioContext.createScriptProcessor(4096, 1, 1);
    processor.onaudioprocess = async (e) => {
        if (!isBrainstormRecording && !isStopping) return;

        const inputData = e.inputBuffer.getChannelData(0);
        const pcmData   = new Int16Array(inputData.length);
        for (let i = 0; i < inputData.length; i++) {
            pcmData[i] = Math.max(-32768, Math.min(32767, Math.floor(inputData[i] * 32767)));
        }

        const combined = new Int16Array(audioBuffer.length + pcmData.length);
        combined.set(audioBuffer);
        combined.set(pcmData, audioBuffer.length);
        audioBuffer = combined;

        if (audioBuffer.length >= 24000) {
            const sendBuffer = audioBuffer.slice(0, 24000);
            audioBuffer      = audioBuffer.slice(24000);

            if (ws.readyState === WebSocket.OPEN) {
                ws.send(sendBuffer.buffer);

                if (storageAvailable && currentSessionId && sessionStartTime) {
                    const deltaMs = performance.now() - sessionStartTime;
                    await appendChunk(currentSessionId, {
                        seq: chunkSeq++, deltaMs,
                        kind: 'audio', payload: sendBuffer.buffer, byteLength: sendBuffer.byteLength,
                    });
                }
            }
        }
    };
    return processor;
}

async function initAudio(audioStream) {
    if (audioContext && audioContext.state !== 'closed') {
        try { await audioContext.close(); } catch (_) {}
    }
    audioContext = new (window.AudioContext || window.webkitAudioContext)();
    source       = audioContext.createMediaStreamSource(audioStream);
    processor    = createAudioProcessor();
    source.connect(processor);
    processor.connect(audioContext.destination);
    if (audioContext.state === 'suspended') await audioContext.resume();
}

function cleanupAudioResources() {
    if (stream) {
        stream.getTracks().forEach(t => t.stop());
        stream = null;
    }
    if (audioContext && audioContext.state !== 'closed') {
        audioContext.close().catch(() => {});
        audioContext = null;
    }
    source            = null;
    processor         = null;
    streamInitialized = false;
}

async function startBrainstormRecording() {
    if (isBrainstormRecording || isListening || isBrainstormProcessing || isReplaying) return;

    if (!ws || ws.readyState !== WebSocket.OPEN) {
        alert('WebSocket is not connected. Please wait or check the backend URL in Settings.');
        return;
    }

    // Pause wake word listening while brainstorm is active
    if (wakeWordListening) stopWakeWordListening();

    // Stop any active local playback
    if (isPlayingBack) stopLocalPlayback();

    try {
        brainstormTranscript = '';
        hideTranscriptBar();
        hideCardStackInstant();

        // Re-use existing stream if still alive, else reinit
        let streamActive = false;
        try {
            streamActive = streamInitialized && stream && stream.active &&
                           stream.getTracks().every(t => t.readyState === 'live');
        } catch (_) { streamActive = false; }

        if (!streamActive) {
            cleanupAudioResources();
            stream = await navigator.mediaDevices.getUserMedia({
                audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
            });
            streamInitialized = true;
        }

        if (!audioContext || audioContext.state === 'closed') {
            await initAudio(stream);
        } else if (audioContext.state === 'suspended') {
            await audioContext.resume();
        }

        isBrainstormRecording = true;
        if (storageAvailable) await createSession();

        const selectedModel = modelSelect ? modelSelect.value : 'gpt-realtime-mini-2025-12-15';
        ws.send(JSON.stringify({ type: 'start_recording', model: selectedModel }));

        startTimer();
        brainstormBtn.classList.add('recording');
        brainstormRing.classList.add('recording');
        brainstormBtn.setAttribute('aria-pressed', 'true');
        quickBtn.disabled    = true;
        replayButton.disabled = true;
        micHint.textContent  = 'Recording… tap Brainstorm to stop';
        micHint.classList.add('active', 'brainstorm-active');
        micHint.classList.remove('processing');
        showLiveTranscript('', 'brainstorm');

    } catch (error) {
        console.error('Error starting Brainstorm:', error);
        isBrainstormRecording = false;
        alert('Error accessing microphone: ' + error.message);
    }
}

async function stopBrainstormRecording() {
    if (!isBrainstormRecording) return;

    isStopping               = true;
    isBrainstormRecording    = false;
    const durationMs         = sessionStartTime ? performance.now() - sessionStartTime : 0;
    lastRecordingDurationMs  = durationMs;

    stopTimer();
    brainstormBtn.classList.remove('recording');
    brainstormRing.classList.remove('recording');
    brainstormBtn.setAttribute('aria-pressed', 'false');
    brainstormBtn.disabled = true; // keep disabled until WS idle

    micHint.textContent = 'Processing…';
    micHint.classList.remove('brainstorm-active');
    micHint.classList.add('processing');

    // Allow any in-flight onaudioprocess callbacks to complete
    await new Promise(resolve => setTimeout(resolve, 100));

    // Flush remaining audio buffer
    if (audioBuffer.length > 0 && ws.readyState === WebSocket.OPEN) {
        const sendBuffer = audioBuffer.slice();
        ws.send(sendBuffer.buffer);
        if (storageAvailable && currentSessionId && sessionStartTime) {
            const deltaMs = performance.now() - sessionStartTime;
            await appendChunk(currentSessionId, {
                seq: chunkSeq++, deltaMs,
                kind: 'audio', payload: sendBuffer.buffer, byteLength: sendBuffer.byteLength,
            });
        }
        audioBuffer = new Int16Array(0);
    }

    isStopping = false;

    // Small delay to ensure all audio sent before stop signal
    await new Promise(resolve => setTimeout(resolve, 500));
    ws.send(JSON.stringify({ type: 'stop_recording' }));

    if (storageAvailable && currentSessionId) {
        await completeSession(currentSessionId, durationMs);
        currentSessionId  = null;
        sessionStartTime  = null;
        chunkSeq          = 0;
        invalidateReplayBuffer();
    }

    // Switch to processing state — WS idle handler will finish the flow
    isBrainstormProcessing    = true;
    _awaitingBrainstormResult = true;
    liveText.textContent      = 'Processing…';
    liveText.classList.remove('has-text');
}

brainstormBtn.addEventListener('click', () => {
    haptic(50);
    if (isBrainstormRecording) {
        stopBrainstormRecording();
    } else if (!isListening && !isBrainstormProcessing && !isReplaying) {
        startBrainstormRecording();
    }
});

/* ===================================================
   REPLAY — local audio playback of stored recording
   =================================================== */

/** Assemble PCM16 chunks from IndexedDB into a Web Audio AudioBuffer. */
async function buildReplayAudioBuffer() {
    const session = await getLatestCompletedSession();
    if (!session) return null;
    const chunks      = await getSessionChunks(session.id);
    const audioChunks = chunks.filter(c => c.kind === 'audio' && c.payload);
    if (audioChunks.length === 0) return null;

    const SAMPLE_RATE = session.sampleRate || 24000;
    let totalSamples  = 0;
    for (const chunk of audioChunks) totalSamples += new Int16Array(chunk.payload).length;

    // AudioBuffer constructor (Chrome 55+, FF 53+, Safari 14.1+)
    const audioBuf    = new AudioBuffer({ numberOfChannels: 1, length: totalSamples, sampleRate: SAMPLE_RATE });
    const channelData = audioBuf.getChannelData(0);
    let offset = 0;
    for (const chunk of audioChunks) {
        const pcm = new Int16Array(chunk.payload);
        for (let i = 0; i < pcm.length; i++) channelData[offset++] = pcm[i] / 32768;
    }
    return audioBuf;
}

function _replaySetPlayIcon(playing) {
    const playIcon  = replayButton.querySelector('.replay-icon-play');
    const pauseIcon = replayButton.querySelector('.replay-icon-pause');
    if (playIcon)  playIcon.hidden  = playing;
    if (pauseIcon) pauseIcon.hidden = !playing;
}

function _replayTickProgress() {
    if (!isPlayingBack || !replayAudioCtx) return;
    const elapsed = (replayAudioCtx.currentTime - replayStartedAt) + replayPauseOffset;
    const pct = replayDuration > 0 ? Math.min(elapsed / replayDuration, 1) : 0;
    if (replayProgressFill) replayProgressFill.style.width = (pct * 100).toFixed(2) + '%';
    if (pct < 1) replayRAF = requestAnimationFrame(_replayTickProgress);
}

async function _ensureReplayAudioCtx() {
    if (!replayAudioCtx || replayAudioCtx.state === 'closed') {
        replayAudioCtx = new (window.AudioContext || window.webkitAudioContext)();
    }
    if (replayAudioCtx.state === 'suspended') await replayAudioCtx.resume();
}

function _replayOnEnded() {
    isPlayingBack     = false;
    isReplaying       = false;
    replayAudioSource = null;
    replayPauseOffset = 0;
    replayStartedAt   = 0;
    cancelAnimationFrame(replayRAF);
    if (replayProgressFill) replayProgressFill.style.width = '0%';
    _replaySetPlayIcon(false);
    stopButton.hidden = true;
    replayButton.classList.remove('replay-playing');
    if (replayProgressWrap) replayProgressWrap.hidden = true;
    updateReplayButtonState();
}

async function toggleLocalPlayback() {
    if (isBrainstormRecording || isListening || isBrainstormProcessing) return;

    if (isPlayingBack) {
        // Pause: record elapsed time and stop source
        replayPauseOffset += replayAudioCtx.currentTime - replayStartedAt;
        if (replayAudioSource) {
            replayAudioSource.onended = null;
            replayAudioSource.stop();
            replayAudioSource = null;
        }
        cancelAnimationFrame(replayRAF);
        isPlayingBack = false;
        isReplaying   = false;
        _replaySetPlayIcon(false);
        replayButton.classList.remove('replay-playing');
        replayButton.title = 'Resume playback';
        return;
    }

    // Load buffer on first play (or after stop cleared it)
    if (!replayAudioBuf) {
        replayButton.disabled = true;
        replayButton.title    = 'Loading…';
        try {
            replayAudioBuf = await buildReplayAudioBuffer();
        } catch (e) {
            console.error('Failed to build audio buffer:', e);
            replayButton.disabled = false;
            updateReplayButtonState();
            return;
        }
        if (!replayAudioBuf) {
            updateReplayButtonState();
            return;
        }
        replayDuration = replayAudioBuf.duration;
    }

    // Restart from beginning if we've reached the end
    if (replayPauseOffset >= replayDuration) {
        replayPauseOffset = 0;
        if (replayProgressFill) replayProgressFill.style.width = '0%';
    }

    try {
        await _ensureReplayAudioCtx();
        const src = replayAudioCtx.createBufferSource();
        src.buffer = replayAudioBuf;
        src.connect(replayAudioCtx.destination);
        src.onended = _replayOnEnded;

        replayAudioSource = src;
        replayStartedAt   = replayAudioCtx.currentTime;
        isPlayingBack     = true;
        isReplaying       = true;

        src.start(0, replayPauseOffset);

        _replaySetPlayIcon(true);
        replayButton.classList.add('replay-playing');
        replayButton.disabled = false;
        replayButton.title    = 'Pause playback';
        stopButton.hidden     = false;
        if (replayProgressWrap) replayProgressWrap.hidden = false;
        replayRAF = requestAnimationFrame(_replayTickProgress);
    } catch (e) {
        console.error('Playback error:', e);
        isPlayingBack = false;
        isReplaying   = false;
        updateReplayButtonState();
    }
}

function stopLocalPlayback() {
    if (replayAudioSource) {
        replayAudioSource.onended = null;
        try { replayAudioSource.stop(); } catch (_) {}
        replayAudioSource = null;
    }
    cancelAnimationFrame(replayRAF);
    isPlayingBack     = false;
    isReplaying       = false;
    replayPauseOffset = 0;  // reset to start; buffer stays cached for fast re-play
    if (replayProgressFill) replayProgressFill.style.width = '0%';
    _replaySetPlayIcon(false);
    if (replayProgressWrap) replayProgressWrap.hidden = true;
    stopButton.hidden = true;
    replayButton.classList.remove('replay-playing');
    replayButton.title = 'Play last recording';
    updateReplayButtonState();
}

/** Called when a new recording is completed — invalidate the cached buffer. */
function invalidateReplayBuffer() {
    replayAudioBuf = null;
    if (!isPlayingBack) {
        replayPauseOffset = 0;
        if (replayProgressFill) replayProgressFill.style.width = '0%';
    }
}

replayButton.onclick = toggleLocalPlayback;
stopButton.onclick   = stopLocalPlayback;

function updateReplayButtonState() {
    if (!replayButton) return;

    if (!storageAvailable) {
        replayButton.disabled = true;
        replayButton.title    = 'Local storage not available';
        return;
    }
    if (isBrainstormRecording || isListening || isBrainstormProcessing) {
        replayButton.disabled = true;
        stopButton.hidden     = true;
        return;
    }
    if (isPlayingBack) {
        replayButton.disabled = false;
        replayButton.title    = 'Pause playback';
        return;
    }

    getLatestCompletedSession().then(session => {
        if (!isPlayingBack) {
            replayButton.disabled = !session;
            if (session) {
                replayButton.title         = replayPauseOffset > 0 ? 'Resume playback' : 'Play last recording';
                replayButton.dataset.state = 'available';
            } else {
                replayButton.title         = 'No recording to replay';
                replayButton.dataset.state = '';
            }
        }
    });
}

/* ===================================================
   INDEXEDDB — stores PCM16 chunks for replay
   =================================================== */

function createDBStores(event) {
    const d = event.target.result;
    if (!d.objectStoreNames.contains('sessions')) {
        const s = d.createObjectStore('sessions', { keyPath: 'id', autoIncrement: true });
        s.createIndex('status',    'status',    { unique: false });
        s.createIndex('createdAt', 'createdAt', { unique: false });
    }
    if (!d.objectStoreNames.contains('chunks')) {
        const c = d.createObjectStore('chunks', { keyPath: 'id', autoIncrement: true });
        c.createIndex('sessionId', 'sessionId', { unique: false });
        c.createIndex('seq',       'seq',       { unique: false });
    }
}

async function initIndexedDB() {
    return new Promise((resolve) => {
        const request = indexedDB.open('brainwave-replay', 1);

        request.onerror = () => {
            console.warn('IndexedDB not available, replay disabled');
            storageAvailable = false;
            resolve(false);
        };

        request.onsuccess = () => {
            db = request.result;
            if (!db.objectStoreNames.contains('sessions') || !db.objectStoreNames.contains('chunks')) {
                db.close();
                const del = indexedDB.deleteDatabase('brainwave-replay');
                del.onsuccess = () => {
                    const reopen = indexedDB.open('brainwave-replay', 1);
                    reopen.onsuccess       = () => { db = reopen.result; storageAvailable = true; updateReplayButtonState(); resolve(true); };
                    reopen.onerror         = () => { storageAvailable = false; resolve(false); };
                    reopen.onupgradeneeded = createDBStores;
                };
                del.onerror = () => { storageAvailable = false; resolve(false); };
                return;
            }
            storageAvailable = true;
            updateReplayButtonState();
            resolve(true);
        };

        request.onupgradeneeded = createDBStores;
    });
}

async function createSession() {
    if (!db) return null;
    return new Promise((resolve, reject) => {
        const tx    = db.transaction(['sessions'], 'readwrite');
        const store = tx.objectStore('sessions');
        const req   = store.add({ createdAt: new Date(), status: 'recording', sampleRate: 24000, channelCount: 1, durationMs: 0 });
        req.onsuccess = () => {
            currentSessionId  = req.result;
            sessionStartTime  = performance.now();
            chunkSeq          = 0;
            appendChunk(currentSessionId, { seq: 0, deltaMs: 0, kind: 'start', payload: null, byteLength: 0 });
            resolve(currentSessionId);
        };
        req.onerror = () => reject(req.error);
    });
}

async function appendChunk(sessionId, chunk) {
    if (!db || !sessionId) return;
    return new Promise((resolve) => {
        const tx    = db.transaction(['chunks'], 'readwrite');
        const store = tx.objectStore('chunks');
        const req   = store.add({ sessionId, seq: chunk.seq, deltaMs: chunk.deltaMs, kind: chunk.kind, payload: chunk.payload, byteLength: chunk.byteLength });
        req.onsuccess = () => resolve();
        req.onerror   = () => resolve(); // don't fail recording on storage error
    });
}

async function completeSession(sessionId, durationMs) {
    if (!db || !sessionId) return;
    return new Promise((resolve) => {
        const tx            = db.transaction(['sessions', 'chunks'], 'readwrite');
        const sessionsStore = tx.objectStore('sessions');
        const chunksStore   = tx.objectStore('chunks');
        const req           = sessionsStore.get(sessionId);
        req.onsuccess = () => {
            const sess = req.result;
            sess.status    = 'completed';
            sess.durationMs = durationMs;
            sessionsStore.put(sess);
            chunksStore.add({ sessionId, seq: chunkSeq++, deltaMs: durationMs, kind: 'stop', payload: null, byteLength: 0 });
            enforceQuota({ maxSessions: 5 });
            resolve();
        };
        req.onerror = () => resolve();
    });
}

async function enforceQuota({ maxSessions }) {
    if (!db) return;
    const tx            = db.transaction(['sessions', 'chunks'], 'readwrite');
    const sessionsStore = tx.objectStore('sessions');
    const sessions      = [];
    sessionsStore.index('createdAt').openCursor().onsuccess = (event) => {
        const cursor = event.target.result;
        if (cursor) { sessions.push(cursor.value); cursor.continue(); }
        else {
            sessions.sort((a, b) => a.createdAt - b.createdAt);
            while (sessions.length > maxSessions) deleteSession(sessions.shift().id);
        }
    };
}

async function deleteSession(sessionId) {
    if (!db) return;
    const tx            = db.transaction(['sessions', 'chunks'], 'readwrite');
    const sessionsStore = tx.objectStore('sessions');
    const chunksStore   = tx.objectStore('chunks');
    chunksStore.index('sessionId').openKeyCursor(IDBKeyRange.only(sessionId)).onsuccess = (event) => {
        const cursor = event.target.result;
        if (cursor) { chunksStore.delete(cursor.primaryKey); cursor.continue(); }
    };
    sessionsStore.delete(sessionId);
}

async function getLatestCompletedSession() {
    if (!db) return null;
    return new Promise((resolve) => {
        const tx    = db.transaction(['sessions'], 'readonly');
        const req   = tx.objectStore('sessions').index('status').getAll('completed');
        req.onsuccess = () => {
            const sessions = req.result;
            if (!sessions.length) { resolve(null); return; }
            sessions.sort((a, b) => b.createdAt - a.createdAt);
            resolve(sessions[0]);
        };
        req.onerror = () => resolve(null);
    });
}

async function getSessionChunks(sessionId) {
    if (!db || !sessionId) return [];
    return new Promise((resolve) => {
        const tx  = db.transaction(['chunks'], 'readonly');
        const req = tx.objectStore('chunks').index('sessionId').getAll(sessionId);
        req.onsuccess = () => {
            const chunks = req.result;
            chunks.sort((a, b) => a.seq - b.seq);
            resolve(chunks);
        };
        req.onerror = () => resolve([]);
    });
}

/* ===== KEYBOARD SHORTCUT ===== */
document.addEventListener('keydown', (event) => {
    if (event.code === 'Space') {
        const el = document.activeElement;
        if (!el.tagName.match(/INPUT|TEXTAREA|SELECT/) && !el.isContentEditable) {
            event.preventDefault();
            if (isListening) {
                stopQuickMode();
            } else if (isBrainstormRecording) {
                stopBrainstormRecording();
            } else if (!isBrainstormProcessing && !isReplaying) {
                startQuickMode();
            }
        }
    }
});

/* ===== INIT ===== */
document.addEventListener('DOMContentLoaded', async () => {
    await initIndexedDB();

    if (!SpeechRecognition) {
        notSupported.hidden = false;
        quickBtn.disabled   = true;
        quickBtn.title      = 'Speech recognition not supported in this browser';
    } else {
        initRecognition();
        initWakeRecognition();

        // Restore hands-free setting
        handsFreeEnabled = localStorage.getItem('handsFreeEnabled') === '1';
        if (handsFreeEnabled) {
            startWakeWordListening();
        }
    }

    // Restore brainstorm model selection
    if (modelSelect) {
        modelSelect.value = localStorage.getItem('brainstormModel') || 'gpt-realtime-mini-2025-12-15';
    }

    initializeWebSocket();
});
