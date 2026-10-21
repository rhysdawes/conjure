// Native-ish services that mini-apps reach through window.host.
// Everything that needs a mic, speaker, camera or API key lives here in the
// top-level page, because the sandboxed iframe can't do those things itself.
import Anthropic from './vendor/anthropic.mjs';
import * as db from './db.js';

export const DEFAULT_MODEL = 'claude-opus-5-5';
export const DEFAULT_TTS_MODEL = 'gpt-4o-mini-tts';
export const EXPRESSIVE_VOICES = ['alloy', 'ash', 'ballad', 'coral', 'echo', 'fable', 'nova', 'onyx', 'sage', 'shimmer', 'verse'];
const TTS_CACHE = 'conjure-tts-v1';
const EXPRESSIVE_GENDER = {
  alloy: 'neutral', ash: 'male', ballad: 'male', coral: 'female', echo: 'male', fable: 'male',
  nova: 'female', onyx: 'male', sage: 'female', shimmer: 'female', verse: 'male',
};
// Web Speech doesn't expose voice gender, so label Apple's common English voices.
const SYSTEM_GENDER = {
  female: ['Samantha', 'Karen', 'Moira', 'Tessa', 'Veena', 'Serena', 'Kate', 'Martha', 'Stephanie', 'Fiona', 'Allison', 'Ava', 'Susan', 'Victoria', 'Zoe', 'Nicky', 'Catherine', 'Isha', 'Kathy', 'Shelley', 'Sandy', 'Flo', 'Grandma', 'Google UK English Female', 'Google US English'],
  male: ['Daniel', 'Arthur', 'Oliver', 'Alex', 'Fred', 'Tom', 'Aaron', 'Gordon', 'Lee', 'Rishi', 'Evan', 'Nathan', 'Jamie', 'Malcolm', 'Ralph', 'Reed', 'Rocko', 'Eddy', 'Grandpa', 'Google UK English Male'],
};
// Joke voices that ship with macOS/iOS; useless for acting or reading aloud.
const NOVELTY_VOICES = ['Albert', 'Bad News', 'Bahh', 'Bells', 'Boing', 'Bubbles', 'Cellos', 'Good News', 'Jester', 'Organ', 'Superstar', 'Trinoids', 'Whisper', 'Wobble', 'Zarvox', 'Junior', 'Ralph', 'Kathy', 'Fred'];

// Apple's retro "Eloquence" voices: usable, but robotic next to the others.
const BASIC_VOICES = ['Eddy', 'Flo', 'Grandma', 'Grandpa', 'Reed', 'Rocko', 'Sandy', 'Shelley'];

const baseVoiceName = (name) => name.replace(/\s*\(.*\)\s*$/, '').trim();

function systemVoiceGender(name) {
  const base = baseVoiceName(name);
  if (SYSTEM_GENDER.female.includes(base)) return 'female';
  if (SYSTEM_GENDER.male.includes(base)) return 'male';
  return 'unknown';
}

// ---------- Claude ----------

// A Claude Code link comes from server/conjure-server.mjs: https://host/#token.
// It runs Conjure on the user's Claude Code login instead of an API key. Links
// often get mangled on the way to the phone, so a token as the last path
// segment is accepted too.
export function parseServerLink(link) {
  const text = (link || '').replace(/\s+/g, '');
  if (!text || !URL.canParse(text)) return null;
  const url = new URL(text);
  const token = url.hash.slice(1) || url.pathname.split('/').filter(Boolean).pop() || '';
  if (token.length < 20 || !/^https?:$/.test(url.protocol)) return null;
  return { baseURL: url.origin, token };
}

export const hasClaude = (settings) => Boolean(parseServerLink(settings.serverLink) || settings.anthropicKey);

export function makeClient(settings) {
  const server = parseServerLink(settings.serverLink);
  if (server) return new Anthropic({ apiKey: server.token, baseURL: server.baseURL, dangerouslyAllowBrowser: true });
  return new Anthropic({ apiKey: settings.anthropicKey, dangerouslyAllowBrowser: true });
}

// Shared request fields: adaptive thinking is the default on Opus 5.5, and the
// server-side fallback re-runs a refused request on a suitable model.
export function baseRequest(settings) {
  return {
    model: settings.model || DEFAULT_MODEL,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
  };
}

function dataUrlParts(dataUrl) {
  const m = /^data:([^;,]+);base64,(.*)$/s.exec(dataUrl || '');
  if (!m) throw new Error('A file was not a base64 data URL');
  return { mediaType: m[1], data: m[2] };
}

function fileBlock(file) {
  const { mediaType, data } = dataUrlParts(file.dataUrl || file);
  if (mediaType === 'application/pdf') {
    return { type: 'document', source: { type: 'base64', media_type: mediaType, data } };
  }
  if (!mediaType.startsWith('image/')) throw new Error(`Unsupported file type for AI: ${mediaType}`);
  return { type: 'image', source: { type: 'base64', media_type: mediaType, data } };
}

export function textOf(message) {
  return message.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
}

export function extractJson(text) {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fenced ? fenced[1] : text;
  const start = body.search(/[[{]/);
  const end = Math.max(body.lastIndexOf('}'), body.lastIndexOf(']'));
  if (start === -1 || end < start) throw new Error('The AI reply did not contain JSON');
  return JSON.parse(body.slice(start, end + 1));
}

async function runAi(settings, opts) {
  if (!hasClaude(settings)) throw new Error('Conjure isn’t connected to Claude. Add your Claude Code link in Conjure settings.');
  if (!opts.prompt) throw new Error('host.ai needs a prompt');
  const client = makeClient(settings);
  const content = [...(opts.files || []).map(fileBlock), { type: 'text', text: String(opts.prompt) }];
  const effort = ['low', 'medium', 'high'].includes(opts.effort) ? opts.effort : 'medium';
  const stream = client.beta.messages.stream({
    ...baseRequest(settings),
    max_tokens: Math.min(Math.max(Number(opts.maxTokens) || 16000, 256), 64000),
    output_config: { effort },
    ...(opts.system ? { system: String(opts.system) } : {}),
    messages: [{ role: 'user', content }],
  });
  const message = await stream.finalMessage();
  if (message.stop_reason === 'refusal') throw new Error('Claude declined this request.');
  const text = textOf(message);
  if (message.stop_reason === 'max_tokens') {
    console.warn('host.ai reply hit maxTokens and was cut off');
    if (opts.json) throw new Error('The AI reply was too long and got cut off. Try a higher maxTokens.');
  }
  return opts.json ? extractJson(text) : text;
}

// ---------- Audio plumbing ----------

function silentWavDataUrl() {
  const sampleRate = 8000;
  const samples = 800;
  const buf = new ArrayBuffer(44 + samples * 2);
  const v = new DataView(buf);
  const str = (o, s) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  str(0, 'RIFF'); v.setUint32(4, 36 + samples * 2, true); str(8, 'WAVE');
  str(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, sampleRate, true); v.setUint32(28, sampleRate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  str(36, 'data'); v.setUint32(40, samples * 2, true);
  let bin = '';
  new Uint8Array(buf).forEach((b) => { bin += String.fromCharCode(b); });
  return 'data:audio/wav;base64,' + btoa(bin);
}

async function sha256(text) {
  const bytes = new TextEncoder().encode(text);
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export class AudioServices {
  constructor(getSettings) {
    this.getSettings = getSettings;
    this.unlocked = false;
    // One persistent <audio> element: once played inside a tap, iOS lets it play
    // again later without a tap, and unlike Web Audio it ignores the silent switch.
    this.player = new Audio();
    this.player.setAttribute('playsinline', '');
    this.silent = silentWavDataUrl();
    this.inflight = new Map();
    this.stopSpeech = null;
    this.stopListen = null;
    this.audioCtx = null;
    this.wakeLock = null;
    this.wantAwake = false;
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && this.wantAwake) this.keepAwake(true);
    });
  }

  // Must be called synchronously inside a user tap.
  unlock() {
    if (this.unlocked) return;
    this.unlocked = true;
    this.player.src = this.silent;
    this.player.play().catch((err) => console.warn('Audio unlock failed:', err));
    if ('speechSynthesis' in window) {
      const u = new SpeechSynthesisUtterance(' ');
      u.volume = 0;
      speechSynthesis.speak(u);
    }
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (Ctx) {
      this.audioCtx = new Ctx();
      this.audioCtx.resume().catch((err) => console.warn('AudioContext resume failed:', err));
    }
  }

  // ---- voices ----

  async systemVoices() {
    if (!('speechSynthesis' in window)) return [];
    let voices = speechSynthesis.getVoices();
    if (!voices.length) {
      await new Promise((resolve) => {
        speechSynthesis.addEventListener('voiceschanged', resolve, { once: true });
        setTimeout(resolve, 1500);
      });
      voices = speechSynthesis.getVoices();
    }
    const locale = navigator.language || 'en-GB';
    const lang = locale.slice(0, 2);
    const quality = (v) => {
      if (/premium/i.test(v.name + v.voiceURI)) return 'premium';
      if (/enhanced/i.test(v.name + v.voiceURI)) return 'enhanced';
      return BASIC_VOICES.includes(baseVoiceName(v.name)) ? 'basic' : 'default';
    };
    const rank = { premium: 0, enhanced: 1, default: 2, basic: 3 };
    const localeFirst = (v) => (v.lang.replace('_', '-') === locale ? 0 : 1);
    return voices
      .filter((v) => v.lang.startsWith(lang) && !NOVELTY_VOICES.includes(baseVoiceName(v.name)))
      .map((v) => ({ name: v.name, lang: v.lang, quality: quality(v), gender: systemVoiceGender(v.name) }))
      .sort((a, b) => rank[a.quality] - rank[b.quality] || localeFirst(a) - localeFirst(b) || a.name.localeCompare(b.name));
  }

  // Natural voices (Kokoro) from the user's Conjure server, when they have one.
  async naturalVoices() {
    const server = parseServerLink(this.getSettings().serverLink);
    if (!server) return [];
    if (this.naturalCache && this.naturalCache.baseURL === server.baseURL) return this.naturalCache.list;
    try {
      const res = await fetch(`${server.baseURL}/v1/voices`, { headers: { 'x-api-key': server.token } });
      if (!res.ok) {
        console.warn(`Natural voices unavailable (${res.status})`);
        return [];
      }
      const list = await res.json();
      this.naturalCache = { baseURL: server.baseURL, list };
      return list;
    } catch (err) {
      console.warn('Natural voices unavailable:', err);
      return [];
    }
  }

  // The "expressive" tier is the server's natural voices when there's a server,
  // otherwise OpenAI's when there's a key; mini-apps don't need to know which.
  async voices() {
    const s = this.getSettings();
    const natural = await this.naturalVoices();
    const openai = s.openaiKey ? EXPRESSIVE_VOICES : [];
    const expressiveInfo = natural.length
      ? natural.map(({ name, gender, accent }) => ({ name, gender, accent }))
      : openai.map((name) => ({ name, gender: EXPRESSIVE_GENDER[name], accent: 'American' }));
    return {
      expressive: expressiveInfo.map((v) => v.name),
      expressiveInfo,
      system: await this.systemVoices(),
    };
  }

  // Which engine speaks this line: 'natural' (server), 'openai' or 'system'.
  async engineFor(opts) {
    const s = this.getSettings();
    const natural = (await this.naturalVoices()).map((v) => v.name);
    if (opts.voice && natural.includes(opts.voice)) return 'natural';
    if (opts.voice && s.openaiKey && EXPRESSIVE_VOICES.includes(opts.voice)) return 'openai';
    const systemVoice = opts.voice && 'speechSynthesis' in window && speechSynthesis.getVoices().some((v) => v.name === opts.voice);
    if (systemVoice) return 'system';
    if (natural.length) return 'natural';
    return s.openaiKey ? 'openai' : 'system';
  }

  // ---- speaking ----

  stopSpeaking() {
    if (this.stopSpeech) this.stopSpeech();
    this.stopSpeech = null;
  }

  async speak(opts) {
    this.stopSpeaking();
    const text = String(opts.text || '').trim();
    if (!text) return;
    const engine = await this.engineFor(opts);
    if (engine === 'system') {
      await this.speakSystem(text, opts);
    } else {
      const blob = await this.expressiveAudio(text, opts, engine);
      await this.playBlob(blob);
    }
  }

  async prefetch(opts) {
    const text = String(opts.text || '').trim();
    if (!text) return;
    const engine = await this.engineFor(opts);
    if (engine === 'system') return;
    this.expressiveAudio(text, opts, engine).catch((err) => console.warn('Speech prefetch failed:', err));
  }

  async naturalVoiceFor(opts) {
    const names = (await this.naturalVoices()).map((v) => v.name);
    if (opts.voice && names.includes(opts.voice)) return opts.voice;
    const preferred = this.getSettings().defaultVoice;
    return names.includes(preferred) ? preferred : names[0];
  }

  async expressiveAudio(text, opts, engine) {
    const s = this.getSettings();
    const rate = Math.min(Math.max(Number(opts.rate) || 1, 0.5), 2);
    let request;
    if (engine === 'natural') {
      const server = parseServerLink(s.serverLink);
      const voice = await this.naturalVoiceFor(opts);
      const direction = String(opts.direction || '');
      request = {
        id: ['natural', voice, rate, direction, text],
        url: `${server.baseURL}/v1/tts`,
        headers: { 'x-api-key': server.token, 'Content-Type': 'application/json' },
        body: { text, voice, direction, speed: rate },
        type: 'audio/wav',
      };
    } else {
      const voice = EXPRESSIVE_VOICES.includes(opts.voice) ? opts.voice : (EXPRESSIVE_VOICES.includes(s.defaultVoice) ? s.defaultVoice : 'coral');
      const model = s.ttsModel || DEFAULT_TTS_MODEL;
      const instructions = opts.direction
        ? `Perform this line as an actor. Direction: ${opts.direction}`
        : 'Natural, conversational delivery, like a scene partner reading opposite an actor.';
      request = {
        id: [model, voice, instructions, text],
        url: 'https://api.openai.com/v1/audio/speech',
        headers: { Authorization: `Bearer ${s.openaiKey}`, 'Content-Type': 'application/json' },
        body: { model, voice, input: text, instructions, response_format: 'mp3' },
        type: 'audio/mpeg',
      };
    }
    const key = await sha256(JSON.stringify(request.id));
    if (this.inflight.has(key)) return this.inflight.get(key);
    const job = (async () => {
      const url = `https://tts.conjure.local/${key}`;
      const cache = 'caches' in window ? await caches.open(TTS_CACHE) : null;
      const hit = cache && await cache.match(url);
      if (hit) return hit.blob();
      const res = await fetch(request.url, { method: 'POST', headers: request.headers, body: JSON.stringify(request.body) });
      if (!res.ok) {
        const detail = await res.text();
        throw new Error(`Voice failed (${res.status}): ${detail.slice(0, 300)}`);
      }
      const blob = await res.blob();
      const type = res.headers.get('Content-Type') || request.type;
      if (cache) await cache.put(url, new Response(blob, { headers: { 'Content-Type': type } }));
      return blob;
    })();
    this.inflight.set(key, job);
    const forget = () => this.inflight.delete(key);
    job.then(forget, forget);
    return job;
  }

  playBlob(blob) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(blob);
      const p = this.player;
      const finish = (err) => {
        p.onended = null;
        p.onerror = null;
        URL.revokeObjectURL(url);
        this.stopSpeech = null;
        if (err) reject(err);
        else resolve();
      };
      p.onended = () => finish();
      p.onerror = () => finish(new Error('Could not play the voice audio'));
      this.stopSpeech = () => { p.pause(); finish(); };
      p.src = url;
      p.play().catch((err) => finish(new Error(`Playback was blocked (${err.name}). Tap the screen once and try again.`)));
    });
  }

  async speakSystem(text, opts) {
    if (!('speechSynthesis' in window)) throw new Error('This browser has no built-in speech');
    const voices = speechSynthesis.getVoices();
    const voice = opts.voice ? voices.find((v) => v.name === opts.voice) : null;
    const rate = Math.min(Math.max(Number(opts.rate) || 1, 0.5), 2);
    const pitch = Math.min(Math.max(Number(opts.pitch) || 1, 0.5), 2);
    return new Promise((resolve) => {
      const u = new SpeechSynthesisUtterance(text);
      if (voice) u.voice = voice;
      u.lang = voice ? voice.lang : (opts.lang || navigator.language || 'en-GB');
      u.rate = rate;
      u.pitch = pitch;
      // iOS sometimes never fires 'end'; a generous watchdog stops a hang.
      const watchdog = setTimeout(() => finish(), 6000 + (text.length * 150) / rate);
      const finish = () => {
        clearTimeout(watchdog);
        this.stopSpeech = null;
        resolve();
      };
      u.onend = finish;
      u.onerror = (e) => { console.warn('Speech error:', e.error); finish(); };
      this.stopSpeech = () => { speechSynthesis.cancel(); finish(); };
      speechSynthesis.cancel();
      speechSynthesis.speak(u);
    });
  }

  // ---- listening ----

  stopListening() {
    if (this.stopListen) this.stopListen();
  }

  async listen(opts, emit) {
    this.stopListening();
    const silenceMs = Math.min(Math.max(Number(opts.silenceMs) || 1200, 300), 10000);
    const maxMs = Math.min(Math.max(Number(opts.maxMs) || 90000, 2000), 600000);
    const lang = opts.lang || navigator.language || 'en-GB';
    // With a Conjure server, record the mic ourselves and transcribe there:
    // Safari's own recognition often hears nothing in home-screen apps.
    const server = parseServerLink(this.getSettings().serverLink);
    if (server) return this.listenAndTranscribe(server, { silenceMs, maxMs }, emit);
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (SR && !this.recognitionBroken) {
      const result = await this.listenWithRecognition(SR, { silenceMs, maxMs, lang }, emit);
      if (!result.fallback) return result;
    }
    return this.listenWithLevel({ silenceMs, maxMs }, emit);
  }

  listenWithRecognition(SR, { silenceMs, maxMs, lang }, emit) {
    return new Promise((resolve) => {
      const rec = new SR();
      rec.lang = lang;
      rec.continuous = true;
      rec.interimResults = true;
      const started = performance.now();
      let committed = '';
      let session = '';
      let heard = false;
      let lastActivity = started;
      let done = false;

      const text = () => `${committed} ${session}`.replace(/\s+/g, ' ').trim();
      const finish = (reason, extra = {}) => {
        if (done) return;
        done = true;
        clearInterval(timer);
        this.stopListen = null;
        rec.onend = null;
        rec.abort();
        resolve({ transcript: text(), heard, reason, ...extra });
      };

      rec.onresult = (e) => {
        session = [...e.results].map((r) => r[0].transcript).join(' ');
        heard = true;
        lastActivity = performance.now();
        emit('transcript', { text: text() });
      };
      rec.onspeechstart = () => { heard = true; lastActivity = performance.now(); };
      rec.onerror = (e) => {
        if (e.error === 'no-speech' || e.error === 'aborted') return;
        console.warn('Speech recognition error:', e.error);
        if (e.error === 'not-allowed' || e.error === 'service-not-allowed' || e.error === 'audio-capture') {
          if (!heard) {
            this.recognitionBroken = true;
            finish('error', { fallback: true });
            return;
          }
        }
        finish('error', { error: `Speech recognition: ${e.error}` });
      };
      // Safari ends sessions on its own after a pause; restart and keep the text.
      rec.onend = () => {
        if (done) return;
        committed = text();
        session = '';
        start();
      };
      const start = () => {
        try {
          rec.start();
        } catch (err) {
          console.warn('Speech recognition could not start:', err);
          finish(heard ? 'silence' : 'error', heard ? {} : { error: err.message, fallback: true });
        }
      };
      const timer = setInterval(() => {
        const now = performance.now();
        if (heard && now - lastActivity >= silenceMs) finish('silence');
        else if (now - started >= maxMs) finish('max');
      }, 100);
      this.stopListen = () => finish('stopped');
      start();
    });
  }

  async openMic() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      throw new Error('This browser cannot use the microphone');
    }
    try {
      return await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    } catch (err) {
      console.warn('Microphone unavailable:', err);
      if (err.name === 'NotAllowedError') throw new Error('Microphone access is off. Allow it for Conjure (iPhone Settings → Safari → Microphone, or the prompt) and try again.');
      throw new Error(`Couldn’t open the microphone (${err.name}: ${err.message})`);
    }
  }

  // Voice-activity detection on the mic level, optionally recording what was said.
  // Resolves { heard, reason, audio? } once the speaker has gone quiet.
  async listenWithLevel({ silenceMs, maxMs, record = false }, emit) {
    let stream;
    try {
      stream = await this.openMic();
    } catch (err) {
      return { transcript: '', heard: false, reason: 'error', error: err.message };
    }
    if (!this.audioCtx) this.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (this.audioCtx.state !== 'running') await this.audioCtx.resume();
    const source = this.audioCtx.createMediaStreamSource(stream);
    const analyser = this.audioCtx.createAnalyser();
    analyser.fftSize = 1024;
    source.connect(analyser);
    const samples = new Float32Array(analyser.fftSize);

    let recorder = null;
    const chunks = [];
    if (record && window.MediaRecorder) {
      const type = ['audio/mp4', 'audio/webm;codecs=opus', 'audio/webm'].find((t) => MediaRecorder.isTypeSupported(t));
      recorder = new MediaRecorder(stream, type ? { mimeType: type } : undefined);
      recorder.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
      recorder.start(250);
    }

    return new Promise((resolve) => {
      const started = performance.now();
      let floor = 0.005;
      let calibrating = true;
      let loudMs = 0;
      let heard = false;
      let lastLoud = started;
      let done = false;
      const release = () => {
        source.disconnect();
        stream.getTracks().forEach((t) => t.stop());
      };
      const finish = (reason) => {
        if (done) return;
        done = true;
        clearInterval(timer);
        this.stopListen = null;
        if (!recorder || recorder.state === 'inactive') {
          release();
          resolve({ transcript: '', heard, reason });
          return;
        }
        recorder.onstop = () => {
          release();
          const audio = chunks.length ? new Blob(chunks, { type: recorder.mimeType || chunks[0].type }) : null;
          resolve({ transcript: '', heard, reason, audio });
        };
        recorder.stop();
      };
      const timer = setInterval(() => {
        analyser.getFloatTimeDomainData(samples);
        let sum = 0;
        for (const s of samples) sum += s * s;
        const rms = Math.sqrt(sum / samples.length);
        const now = performance.now();
        if (calibrating) {
          floor = Math.max(floor * 0.8 + rms * 0.2, 0.003);
          if (now - started > 300) calibrating = false;
          return;
        }
        const threshold = Math.max(floor * 3, 0.012);
        emit('level', { level: Math.min(rms / (threshold * 4), 1) });
        if (rms > threshold) {
          loudMs += 50;
          lastLoud = now;
          // A bump or click isn't speech: need ~150ms of sound before counting it.
          if (loudMs >= 150) heard = true;
        }
        if (heard && now - lastLoud >= silenceMs) finish('silence');
        else if (now - started >= maxMs) finish('max');
      }, 50);
      this.stopListen = () => finish('stopped');
    });
  }

  async listenAndTranscribe(server, { silenceMs, maxMs }, emit) {
    const result = await this.listenWithLevel({ silenceMs, maxMs, record: true }, emit);
    const { audio, ...rest } = result;
    if (!result.heard || !audio) return rest;
    try {
      const res = await fetch(`${server.baseURL}/v1/transcribe`, {
        method: 'POST',
        headers: { 'x-api-key': server.token, 'Content-Type': audio.type || 'audio/mp4' },
        body: audio,
      });
      if (!res.ok) throw new Error(`transcription failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
      const { text } = await res.json();
      if (text) emit('transcript', { text });
      return { ...rest, transcript: text || '' };
    } catch (err) {
      console.warn('Transcription failed:', err);
      return { ...rest, transcriptError: err.message };
    }
  }

  // ---- screen ----

  // Best effort: resolves true if the screen will stay on. A refusal (low power
  // mode, unsupported browser) isn't the app's fault, so it's logged, not thrown.
  async keepAwake(on) {
    this.wantAwake = on;
    if (!('wakeLock' in navigator)) return false;
    try {
      if (on && !this.wakeLock) {
        this.wakeLock = await navigator.wakeLock.request('screen');
        this.wakeLock.addEventListener('release', () => { this.wakeLock = null; });
      } else if (!on && this.wakeLock) {
        await this.wakeLock.release();
        this.wakeLock = null;
      }
    } catch (err) {
      console.warn('Screen wake lock unavailable:', err);
      return false;
    }
    return on;
  }
}

// ---------- Files ----------

export async function downscaleImage(file, maxDim = 1600) {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, maxDim / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  const dataUrl = canvas.toDataURL('image/jpeg', 0.82);
  return { name: file.name.replace(/\.\w+$/, '') + '.jpg', type: 'image/jpeg', size: Math.round(dataUrl.length * 0.75), dataUrl };
}

export function readAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve({ name: file.name, type: file.type, size: file.size, dataUrl: r.result });
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });
}

// ---------- Bridge ----------

// Connects one running mini-app iframe to the services above.
export class Bridge {
  constructor({ iframe, app, audio, getSettings, pickFiles, onReport }) {
    this.iframe = iframe;
    this.app = app;
    this.audio = audio;
    this.getSettings = getSettings;
    this.pickFiles = pickFiles;
    this.onReport = onReport;
    this.onMessage = (e) => this.handle(e);
    window.addEventListener('message', this.onMessage);
  }

  dispose() {
    window.removeEventListener('message', this.onMessage);
    this.audio.stopSpeaking();
    this.audio.stopListening();
    this.audio.keepAwake(false).catch((err) => console.warn('Releasing wake lock failed:', err));
  }

  post(msg) {
    if (this.iframe.contentWindow) this.iframe.contentWindow.postMessage({ __conjure: 1, ...msg }, '*');
  }

  emit(event, data) {
    this.post({ event, data });
  }

  async handle(e) {
    if (e.source !== this.iframe.contentWindow) return;
    const m = e.data;
    if (!m || !m.__conjure) return;
    if (m.report) {
      this.onReport(m.report);
      return;
    }
    try {
      const result = await this.dispatch(m.method, m.args || {});
      this.post({ id: m.id, result });
    } catch (err) {
      console.error(`host.${m.method} failed:`, err);
      this.post({ id: m.id, error: err && err.message ? err.message : String(err) });
    }
  }

  dataKey(key) {
    return `data:${this.app.id}:${String(key)}`;
  }

  async dispatch(method, a) {
    switch (method) {
      case 'ai': return runAi(this.getSettings(), a);
      case 'pickFiles': return this.pickFiles(a);
      case 'speak': return this.audio.speak(a);
      case 'prefetchSpeech': return this.audio.prefetch(a);
      case 'stopSpeaking': return this.audio.stopSpeaking();
      case 'voices': return this.audio.voices();
      case 'listen': return this.audio.listen(a, (event, data) => this.emit(event, data));
      case 'stopListening': return this.audio.stopListening();
      case 'keepAwake': return this.audio.keepAwake(a.on);
      case 'storage.get': return db.get(this.dataKey(a.key));
      case 'storage.set': return db.set(this.dataKey(a.key), a.value);
      case 'storage.remove': return db.del(this.dataKey(a.key));
      case 'storage.keys': {
        const prefix = `data:${this.app.id}:`;
        return (await db.keysWithPrefix(prefix)).map((k) => k.slice(prefix.length));
      }
      default: throw new Error(`Unknown host method: ${method}`);
    }
  }
}
