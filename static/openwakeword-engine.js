/**
 * openwakeword-engine.js
 *
 * Browser-global wrapper for the openWakeWord WASM engine.
 * Adapted from: openwakeword-wasm-browser v0.1.1 (MIT)
 * https://github.com/dnavarrom/openwakeword_wasm
 *
 * Requires ort.min.js (onnxruntime-web) to be loaded first, which
 * exposes `window.ort` as a global variable.
 *
 * Usage:
 *   const engine = new WakeWordEngine({ keywords: ['hey_chill'], ... });
 *   await engine.load();
 *   await engine.start();
 *   engine.on('detect', ({ keyword }) => { ... });
 *   await engine.stop();
 */
'use strict';

(function (global) {
    // ort is exposed as a global by ort.min.js loaded before this script
    /* eslint-disable no-undef */

    const MODEL_FILE_MAP = {
        alexa: 'alexa_v0.1.onnx',
        hey_mycroft: 'hey_mycroft_v0.1.onnx',
        hey_jarvis: 'hey_jarvis_v0.1.onnx',
        hey_rhasspy: 'hey_rhasspy_v0.1.onnx',
        timer: 'timer_v0.1.onnx',
        weather: 'weather_v0.1.onnx',
        // Custom: "Hey Chill" — using interim hey_mycroft model until
        // a dedicated hey_chill.onnx model is trained.
        hey_chill: 'hey_chill_interim.onnx',
    };

    const AUDIO_PROCESSOR = `
class AudioProcessor extends AudioWorkletProcessor {
    bufferSize = 1280;
    _buffer = new Float32Array(this.bufferSize);
    _pos = 0;
    process(inputs) {
        const input = inputs[0][0];
        if (input) {
            for (let i = 0; i < input.length; i++) {
                this._buffer[this._pos++] = input[i];
                if (this._pos === this.bufferSize) {
                    this.port.postMessage(this._buffer);
                    this._pos = 0;
                }
            }
        }
        return true;
    }
}
registerProcessor('audio-processor', AudioProcessor);
`;

    const createEmitter = () => {
        const listeners = new Map();
        return {
            on(event, handler) {
                if (!listeners.has(event)) listeners.set(event, new Set());
                listeners.get(event).add(handler);
                return () => this.off(event, handler);
            },
            off(event, handler) {
                const set = listeners.get(event);
                if (set) set.delete(handler);
            },
            emit(event, payload) {
                const set = listeners.get(event);
                if (!set) return;
                for (const handler of Array.from(set)) handler(payload);
            }
        };
    };

    class WakeWordEngine {
        constructor({
            keywords = ['hey_chill'],
            modelFiles = MODEL_FILE_MAP,
            baseAssetUrl = '/static/models',
            ortWasmPath,
            frameSize = 1280,
            sampleRate = 16000,
            vadHangoverFrames = 12,
            detectionThreshold = 0.5,
            cooldownMs = 2000,
            executionProviders = ['wasm'],
            embeddingWindowSize = 16,
            debug = false
        } = {}) {
            this.config = {
                keywords,
                modelFiles,
                baseAssetUrl,
                frameSize,
                sampleRate,
                vadHangoverFrames,
                detectionThreshold,
                cooldownMs,
                executionProviders,
                embeddingWindowSize,
                debug
            };
            this._setOrtPath(ortWasmPath);
            this._emitter = createEmitter();
            this._melBuffer = [];
            this._embeddingWindowSize = embeddingWindowSize;
            this._activeKeywords = new Set(keywords);
            this._vadState = { h: null, c: null };
            this._isSpeechActive = false;
            this._vadHangover = 0;
            this._mediaStream = null;
            this._audioContext = null;
            this._workletNode = null;
            this._gainNode = null;
            this._processingQueue = Promise.resolve();
            this._isDetectionCoolingDown = false;
            this._loaded = false;
        }

        on(event, handler) {
            return this._emitter.on(event, handler);
        }

        off(event, handler) {
            this._emitter.off(event, handler);
        }

        async load() {
            if (this._loaded) return;
            const sessionOptions = { executionProviders: this.config.executionProviders };
            const resolver = (file) => `${this.config.baseAssetUrl.replace(/\/+$/, '')}/${file}`;
            this._debug('Loading core models with options', sessionOptions);

            this._melspecModel = await ort.InferenceSession.create(resolver('melspectrogram.onnx'), sessionOptions);
            this._embeddingModel = await ort.InferenceSession.create(resolver('embedding_model.onnx'), sessionOptions);
            this._vadModel = await ort.InferenceSession.create(resolver('silero_vad.onnx'), sessionOptions);

            this._keywordModels = {};
            let maxWindowSize = this.config.embeddingWindowSize;
            for (const keyword of this.config.keywords) {
                const file = this.config.modelFiles[keyword];
                if (!file) {
                    throw new Error(`No model file configured for keyword "${keyword}"`);
                }
                const session = await ort.InferenceSession.create(resolver(file), sessionOptions);
                const windowSize = this._inferKeywordWindowSize(session) ?? this.config.embeddingWindowSize;
                maxWindowSize = Math.max(maxWindowSize, windowSize);
                const history = [];
                for (let i = 0; i < windowSize; i++) {
                    history.push(new Float32Array(96).fill(0));
                }
                this._keywordModels[keyword] = {
                    session,
                    scores: new Array(50).fill(0),
                    windowSize,
                    history
                };
                this._debug('Loaded keyword model', { keyword, file, windowSize });
            }
            this._embeddingWindowSize = maxWindowSize;
            this._debug('Embedding window size resolved', this._embeddingWindowSize);
            this._resetState();
            this._loaded = true;
            this._emitter.emit('ready');
        }

        async start({ deviceId, gain = 1.0 } = {}) {
            if (!this._loaded) throw new Error('Call load() before start()');
            if (this._workletNode) return;

            this._resetState();
            this._mediaStream = await navigator.mediaDevices.getUserMedia({
                audio: deviceId ? { deviceId: { exact: deviceId } } : true
            });

            this._audioContext = new AudioContext({ sampleRate: this.config.sampleRate });
            const source = this._audioContext.createMediaStreamSource(this._mediaStream);
            this._gainNode = this._audioContext.createGain();
            this._gainNode.gain.value = gain;

            const blob = new Blob([AUDIO_PROCESSOR], { type: 'application/javascript' });
            const workletURL = URL.createObjectURL(blob);
            await this._audioContext.audioWorklet.addModule(workletURL);
            this._workletNode = new AudioWorkletNode(this._audioContext, 'audio-processor');

            this._workletNode.port.onmessage = (event) => {
                const chunk = event.data;
                if (!chunk) return;
                this._processingQueue = this._processingQueue.then(() => this._processChunk(chunk)).catch((err) => {
                    this._emitter.emit('error', err);
                });
            };

            source.connect(this._gainNode);
            this._gainNode.connect(this._workletNode);
            this._workletNode.connect(this._audioContext.destination);
            this._debug('Microphone stream started', { deviceId: deviceId ?? 'default', gain });
        }

        async stop() {
            if (this._workletNode) {
                this._workletNode.port.onmessage = null;
                this._workletNode.disconnect();
                this._workletNode = null;
            }
            if (this._gainNode) {
                this._gainNode.disconnect();
                this._gainNode = null;
            }
            if (this._audioContext && this._audioContext.state !== 'closed') {
                await this._audioContext.close();
            }
            this._audioContext = null;
            if (this._mediaStream) {
                this._mediaStream.getTracks().forEach((track) => track.stop());
                this._mediaStream = null;
            }
            this._isDetectionCoolingDown = false;
            this._debug('Engine stopped and media stream closed');
        }

        setGain(value) {
            if (this._gainNode) {
                this._gainNode.gain.value = value;
            }
        }

        _resetState() {
            this._melBuffer = [];
            const vadShape = [2, 1, 64];
            if (!this._vadState.h) {
                this._vadState.h = new ort.Tensor('float32', new Float32Array(128).fill(0), vadShape);
                this._vadState.c = new ort.Tensor('float32', new Float32Array(128).fill(0), vadShape);
            } else {
                this._vadState.h.data.fill(0);
                this._vadState.c.data.fill(0);
            }
            this._isSpeechActive = false;
            this._vadHangover = 0;
            this._isDetectionCoolingDown = false;
            if (this._keywordModels) {
                for (const key of Object.keys(this._keywordModels)) {
                    this._keywordModels[key].scores.fill(0);
                    const history = this._keywordModels[key].history;
                    if (history) {
                        for (let i = 0; i < history.length; i++) {
                            history[i].fill(0);
                        }
                    }
                }
            }
            this._debug('Internal buffers reset');
        }

        async _processChunk(chunk, { emitEvents = true } = {}) {
            if (this.config.debug) {
                let peak = 0;
                let sumSquares = 0;
                for (let i = 0; i < chunk.length; i++) {
                    const sample = chunk[i];
                    sumSquares += sample * sample;
                    const abs = Math.abs(sample);
                    if (abs > peak) peak = abs;
                }
                const rms = Math.sqrt(sumSquares / chunk.length);
                this._debug('Chunk received', { rms: Number(rms.toFixed(4)), peak: Number(peak.toFixed(4)) });
            }
            const vadTriggered = await this._runVad(chunk);
            if (vadTriggered) {
                if (!this._isSpeechActive && emitEvents) this._emitter.emit('speech-start');
                this._isSpeechActive = true;
                this._vadHangover = this.config.vadHangoverFrames;
            } else if (this._isSpeechActive) {
                this._vadHangover -= 1;
                if (this._vadHangover <= 0) {
                    this._isSpeechActive = false;
                    if (emitEvents) this._emitter.emit('speech-end');
                }
            }

            await this._runInference(chunk, this._isSpeechActive, emitEvents);
        }

        async _runVad(chunk) {
            try {
                const tensor = new ort.Tensor('float32', chunk, [1, chunk.length]);
                const sr = new ort.Tensor('int64', [BigInt(this.config.sampleRate)], []);
                const res = await this._vadModel.run({ input: tensor, sr, h: this._vadState.h, c: this._vadState.c });
                this._vadState.h = res.hn;
                this._vadState.c = res.cn;
                const confidence = res.output.data[0];
                this._debug('VAD result', { confidence: Number(confidence.toFixed(3)) });
                return confidence > 0.5;
            } catch (err) {
                this._emitter.emit('error', err);
                return false;
            }
        }

        async _runInference(chunk, isSpeechActive, emitEvents) {
            const melspecTensor = new ort.Tensor('float32', chunk, [1, this.config.frameSize]);
            const melspecResults = await this._melspecModel.run({ [this._melspecModel.inputNames[0]]: melspecTensor });
            const newMelData = melspecResults[this._melspecModel.outputNames[0]].data;

            for (let j = 0; j < newMelData.length; j++) {
                newMelData[j] = newMelData[j] / 10.0 + 2.0;
            }
            for (let j = 0; j < 5; j++) {
                this._melBuffer.push(new Float32Array(newMelData.subarray(j * 32, (j + 1) * 32)));
            }

            while (this._melBuffer.length >= 76) {
                const windowFrames = this._melBuffer.slice(0, 76);
                const flattenedMel = new Float32Array(76 * 32);
                for (let j = 0; j < windowFrames.length; j++) {
                    flattenedMel.set(windowFrames[j], j * 32);
                }

                const embeddingFeeds = { [this._embeddingModel.inputNames[0]]: new ort.Tensor('float32', flattenedMel, [1, 76, 32, 1]) };
                const embeddingOut = await this._embeddingModel.run(embeddingFeeds);
                const newEmbedding = embeddingOut[this._embeddingModel.outputNames[0]].data;

                const embeddingVector = new Float32Array(newEmbedding);

                for (const name of Object.keys(this._keywordModels)) {
                    const keywordModel = this._keywordModels[name];
                    keywordModel.history.shift();
                    keywordModel.history.push(embeddingVector);

                    const flattenedEmbeddings = new Float32Array(keywordModel.windowSize * 96);
                    for (let j = 0; j < keywordModel.history.length; j++) {
                        flattenedEmbeddings.set(keywordModel.history[j], j * 96);
                    }
                    const finalInput = new ort.Tensor('float32', flattenedEmbeddings, [1, keywordModel.windowSize, 96]);
                    const results = await keywordModel.session.run({ [keywordModel.session.inputNames[0]]: finalInput });
                    const score = results[keywordModel.session.outputNames[0]].data[0];
                    keywordModel.scores.shift();
                    keywordModel.scores.push(score);
                    this._debug('Keyword score', { keyword: name, score: Number(score.toFixed(3)), windowSize: keywordModel.windowSize });

                    const keywordActive = this._activeKeywords.has(name);
                    if (emitEvents && keywordActive && score > this.config.detectionThreshold && isSpeechActive && !this._isDetectionCoolingDown) {
                        this._isDetectionCoolingDown = true;
                        this._debug('Detection emitted', { keyword: name, score });
                        this._emitter.emit('detect', { keyword: name, score, at: performance.now() });
                        setTimeout(() => { this._isDetectionCoolingDown = false; }, this.config.cooldownMs);
                    } else if (emitEvents && !keywordActive) {
                        this._debug('Detection suppressed (inactive keyword)', { keyword: name, score });
                    }
                }
                this._melBuffer.splice(0, 8);
            }
        }

        _setOrtPath(path) {
            if (path && typeof ort !== 'undefined') {
                ort.env.wasm.wasmPaths = path;
            }
        }

        _inferKeywordWindowSize(session) {
            if (!session) return undefined;
            const metadata = session.inputMetadata;
            const inputName = session.inputNames?.[0];
            if (!metadata || !inputName) return undefined;
            let meta;
            if (Array.isArray(metadata)) {
                meta = metadata.find((m) => m?.name === inputName) || metadata[0];
            } else {
                meta = metadata[inputName];
            }
            if (!meta || !meta.isTensor || !Array.isArray(meta.shape)) return undefined;
            const dim = meta.shape[1];
            return typeof dim === 'number' && Number.isFinite(dim) ? dim : undefined;
        }

        _debug(...args) {
            if (this.config.debug) {
                console.debug('[WakeWordEngine]', ...args);
            }
        }

        setActiveKeywords(keywords) {
            const next = Array.isArray(keywords) && keywords.length ? keywords : this.config.keywords;
            this._activeKeywords = new Set(next);
            this._debug('Active keywords updated', Array.from(this._activeKeywords));
        }
    }

    // Expose as browser global
    global.WakeWordEngine = WakeWordEngine;
    global.MODEL_FILE_MAP = MODEL_FILE_MAP;

})(typeof window !== 'undefined' ? window : this);
