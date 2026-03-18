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

/* ===== WAKE WORD / HANDS-FREE STATE ===== */
let wakeRecognition   = null;
let wakeWordListening = false;
let handsFreeEnabled  = false;

/* ===== URL PARAMS ===== */
const urlParams   = new URLSearchParams(window.location.search);
const autoStart   = urlParams.get('start') === '1';
let   isAutoStarted = false;

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
const timerEl          = document.getElementById('timer');
const replayButton     = document.getElementById('replayButton');
const connectionStatus = document.getElementById('connectionStatus');
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
                            showTranscriptBar(finalText, 'brainstorm');
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

    try {
        brainstormTranscript = '';
        hideTranscriptBar();

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

    isStopping            = true;
    isBrainstormRecording = false;
    const durationMs      = sessionStartTime ? performance.now() - sessionStartTime : 0;

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
   REPLAY — sends stored IndexedDB audio through WS
   =================================================== */

async function replayLastRecording() {
    if (isBrainstormRecording || isReplaying || isListening || isBrainstormProcessing) return;

    const session = await getLatestCompletedSession();
    if (!session) {
        alert('No completed recording found to replay.');
        return;
    }

    isReplaying              = true;
    quickBtn.disabled        = true;
    brainstormBtn.disabled   = true;
    replayButton.disabled    = true;
    replayButton.classList.add('replaying');
    brainstormTranscript     = '';

    try {
        hideTranscriptBar();
        const chunks = await getSessionChunks(session.id);
        if (chunks.length === 0) throw new Error('No audio chunks found for session');

        // Wait for WS if needed
        if (!wsConnected || ws.readyState !== WebSocket.OPEN) {
            await new Promise(resolve => {
                const check = setInterval(() => {
                    if (wsConnected && ws.readyState === WebSocket.OPEN) { clearInterval(check); resolve(); }
                }, 100);
            });
        }

        const selectedModel = modelSelect ? modelSelect.value : 'gpt-realtime-mini-2025-12-15';
        ws.send(JSON.stringify({ type: 'start_recording', model: selectedModel }));
        await new Promise(resolve => setTimeout(resolve, 200));

        for (const chunk of chunks.filter(c => c.kind === 'audio' && c.payload)) {
            if (ws.readyState === WebSocket.OPEN) {
                ws.send(chunk.payload);
            } else {
                throw new Error('WebSocket closed during replay');
            }
        }

        ws.send(JSON.stringify({ type: 'stop_recording' }));

        isBrainstormProcessing    = true;
        _awaitingBrainstormResult = true;
        micHint.textContent       = 'Processing replay…';
        micHint.classList.add('active', 'processing');
        micHint.classList.remove('brainstorm-active');
        showLiveTranscript('Processing replay…', 'brainstorm');

    } catch (error) {
        console.error('Replay error:', error);
        alert('Error replaying recording: ' + error.message);
        isBrainstormProcessing    = false;
        _awaitingBrainstormResult = false;
        micHint.textContent       = '';
        micHint.classList.remove('active', 'processing');
        quickBtn.disabled        = false;
        brainstormBtn.disabled   = false;
    } finally {
        isReplaying = false;
        replayButton.classList.remove('replaying');
        updateReplayButtonState();
        // quickBtn/brainstormBtn re-enabled by WS idle handler if processing started
        if (!isBrainstormProcessing) {
            quickBtn.disabled      = false;
            brainstormBtn.disabled = false;
        }
    }
}

replayButton.onclick = replayLastRecording;

function updateReplayButtonState() {
    if (!replayButton) return;

    if (!storageAvailable) {
        replayButton.disabled = true;
        replayButton.title    = 'Local storage not available';
        return;
    }
    if (isBrainstormRecording || isReplaying || isListening || isBrainstormProcessing) {
        replayButton.disabled = true;
        return;
    }

    getLatestCompletedSession().then(session => {
        if (!isReplaying) {
            replayButton.disabled = !session;
            replayButton.title    = session ? 'Replay last recording' : 'No recording to replay';
            replayButton.classList.remove('replaying');
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
