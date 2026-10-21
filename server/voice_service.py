"""Natural voices and speech-to-text for Conjure, on the server.

The iPhone's built-in voices sound robotic and Safari's speech recognition is
unreliable in home-screen apps, so Conjure sends both jobs here instead:

  POST /tts         {"text", "voice", "direction", "speed"} -> audio (mp3 or wav)
  POST /transcribe  raw recorded audio                      -> {"text"}  (faster-whisper)
  GET  /voices                                              -> [{"name", "gender", "accent", "description"}]

Voices are ElevenLabs v3 (acted, follows direction) when CONJURE_ELEVENLABS_KEY
is set, with Kokoro on the CPU as the fallback when ElevenLabs fails or its
monthly allowance runs out. Generated ElevenLabs audio is cached on disk so a
line is only ever paid for once.

It listens on 127.0.0.1 only; conjure-server.mjs checks the token and forwards.
"""

import hashlib
import io
import json
import logging
import os
import re
import threading
import time
import urllib.error
import urllib.request
import wave
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import av
import numpy as np
import onnxruntime as ort
from faster_whisper import WhisperModel
from kokoro_onnx import Kokoro

PORT = int(os.environ.get("CONJURE_VOICE_PORT", "8767"))
MODEL_DIR = os.environ.get("CONJURE_VOICE_MODELS", os.path.expanduser("~/voice-models"))
THREADS = int(os.environ.get("CONJURE_VOICE_THREADS", "4"))
WHISPER_MODEL = os.environ.get("CONJURE_WHISPER_MODEL", "base.en")
MAX_BODY = 20 * 1024 * 1024
MAX_TEXT = 2000
ELEVEN_KEY = os.environ.get("CONJURE_ELEVENLABS_KEY", "").strip()
ELEVEN_MODEL = os.environ.get("CONJURE_ELEVENLABS_MODEL", "eleven_v3")
TTS_CACHE = os.path.expanduser("~/tts-cache")

# Friendly name -> (Kokoro voice id, gender, accent). British first: the user is in the UK.
KOKORO_VOICES = {
    "Emma": ("bf_emma", "female", "British"),
    "Isabella": ("bf_isabella", "female", "British"),
    "Alice": ("bf_alice", "female", "British"),
    "Lily": ("bf_lily", "female", "British"),
    "George": ("bm_george", "male", "British"),
    "Lewis": ("bm_lewis", "male", "British"),
    "Fable": ("bm_fable", "male", "British"),
    "Dan": ("bm_daniel", "male", "British"),
    "Heart": ("af_heart", "female", "American"),
    "Bella": ("af_bella", "female", "American"),
    "Nicole": ("af_nicole", "female", "American"),
    "Sarah": ("af_sarah", "female", "American"),
    "Michael": ("am_michael", "male", "American"),
    "Fenrir": ("am_fenrir", "male", "American"),
    "Puck": ("am_puck", "male", "American"),
    "Adam": ("am_adam", "male", "American"),
}

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("conjure-voice")


def eleven_request(path, body=None, timeout=60):
    req = urllib.request.Request(
        f"https://api.elevenlabs.io{path}",
        data=json.dumps(body).encode() if body is not None else None,
        headers={"xi-api-key": ELEVEN_KEY, "Content-Type": "application/json"},
        method="POST" if body is not None else "GET",
    )
    with urllib.request.urlopen(req, timeout=timeout) as res:
        return res.read()


def load_eleven_voices():
    """ElevenLabs' stock voices, keyed by first name, British first."""
    if not ELEVEN_KEY:
        return {}
    try:
        data = json.loads(eleven_request("/v2/voices?page_size=100&voice_type=default"))
    except (urllib.error.URLError, TimeoutError, ValueError) as err:
        log.warning("ElevenLabs voices unavailable, using Kokoro only: %s", err)
        return {}
    voices = {}
    for v in data.get("voices", []):
        labels = v.get("labels") or {}
        name = v["name"].split(" - ")[0].strip()
        voices[name] = {
            "id": v["voice_id"],
            "gender": labels.get("gender") or "unknown",
            "accent": (labels.get("accent") or "").title(),
            "description": v["name"].split(" - ", 1)[1] if " - " in v["name"] else "",
        }
    order = lambda item: (item[1]["accent"] != "British", item[1]["gender"] != "female", item[0])
    return dict(sorted(voices.items(), key=order))


ELEVEN_VOICES = load_eleven_voices()
log.info("ElevenLabs: %s", f"{len(ELEVEN_VOICES)} voices, model {ELEVEN_MODEL}" if ELEVEN_VOICES else "off")


def load_models():
    opts = ort.SessionOptions()
    opts.intra_op_num_threads = THREADS
    opts.inter_op_num_threads = 1
    session = ort.InferenceSession(
        os.path.join(MODEL_DIR, "kokoro-v1.0.onnx"), sess_options=opts, providers=["CPUExecutionProvider"]
    )
    kokoro = Kokoro.from_session(session, os.path.join(MODEL_DIR, "voices-v1.0.bin"))
    whisper = WhisperModel(
        WHISPER_MODEL, device="cpu", compute_type="int8", cpu_threads=THREADS,
        download_root=os.path.join(MODEL_DIR, "whisper"),
    )
    return kokoro, whisper


KOKORO, WHISPER = load_models()
TTS_LOCK = threading.Lock()
STT_LOCK = threading.Lock()


def to_wav(samples, sample_rate):
    pcm = (np.clip(samples, -1.0, 1.0) * 32767).astype("<i2").tobytes()
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sample_rate)
        w.writeframes(pcm)
    return buf.getvalue()


def public_voices():
    if ELEVEN_VOICES:
        return [{"name": n, **{k: v[k] for k in ("gender", "accent", "description")}} for n, v in ELEVEN_VOICES.items()]
    return [{"name": n, "gender": g, "accent": a, "description": ""} for n, (_, g, a) in KOKORO_VOICES.items()]


def closest(name, catalogue, gender_accent):
    """A voice from `catalogue` for `name`: itself, else one with the same gender and accent.

    Apps save the voices they cast, so a name from the other engine (say a Kokoro
    voice cast before ElevenLabs was switched on) still gets a sensible match.
    """
    if name in catalogue:
        return name
    gender, accent = gender_accent(name)
    for candidate in catalogue:
        g, a = gender_accent(candidate, catalogue)
        if g == gender and a == accent:
            return candidate
    for candidate in catalogue:
        if gender_accent(candidate, catalogue)[0] == gender:
            return candidate
    return next(iter(catalogue))


def gender_accent(name, catalogue=None):
    if name in ELEVEN_VOICES and catalogue is not KOKORO_VOICES:
        return ELEVEN_VOICES[name]["gender"], ELEVEN_VOICES[name]["accent"]
    if name in KOKORO_VOICES:
        return KOKORO_VOICES[name][1], KOKORO_VOICES[name][2]
    if name in ELEVEN_VOICES:
        return ELEVEN_VOICES[name]["gender"], ELEVEN_VOICES[name]["accent"]
    return "female", "British"


def direction_tag(direction):
    """Script direction -> a short v3 audio tag. Tags cost characters, so keep it to a few words."""
    words = re.sub(r"[\[\]()]", "", direction or "").strip()
    if not words:
        return ""
    short = ", ".join(p.strip() for p in words.split(",")[:2] if p.strip())
    return f"[{short[:40].rstrip()}] "


def synthesize_eleven(text, voice, direction):
    name = closest(voice, ELEVEN_VOICES, gender_accent)
    spoken = direction_tag(direction) + text
    key = hashlib.sha256(json.dumps([ELEVEN_MODEL, name, spoken]).encode()).hexdigest()
    path = os.path.join(TTS_CACHE, f"{key}.mp3")
    if os.path.exists(path):
        with open(path, "rb") as f:
            return f.read()
    started = time.time()
    audio = eleven_request(
        f"/v1/text-to-speech/{ELEVEN_VOICES[name]['id']}?output_format=mp3_44100_128",
        {"text": spoken, "model_id": ELEVEN_MODEL},
    )
    os.makedirs(TTS_CACHE, exist_ok=True)
    with open(path, "wb") as f:
        f.write(audio)
    log.info("eleven %s %d chars in %.2fs: %r", name, len(spoken), time.time() - started, spoken[:70])
    return audio


def synthesize_kokoro(text, voice, speed):
    name = closest(voice, KOKORO_VOICES, gender_accent)
    voice_id, _, accent = KOKORO_VOICES[name]
    lang = "en-gb" if accent == "British" else "en-us"
    started = time.time()
    with TTS_LOCK:
        samples, sample_rate = KOKORO.create(text, voice=voice_id, speed=speed, lang=lang)
    took = time.time() - started
    log.info("kokoro %s %.1fs audio in %.2fs: %r", name, len(samples) / sample_rate, took, text[:60])
    return to_wav(samples, sample_rate)


def synthesize(text, voice, direction, speed):
    """-> (audio bytes, content type). ElevenLabs first; Kokoro if it fails or is used up."""
    if ELEVEN_VOICES:
        try:
            return synthesize_eleven(text, voice, direction), "audio/mpeg"
        except urllib.error.HTTPError as err:
            detail = err.read().decode("utf-8", "replace")[:300]
            log.warning("ElevenLabs failed (%s), falling back to Kokoro: %s", err.code, detail)
        except (urllib.error.URLError, TimeoutError) as err:
            log.warning("ElevenLabs unreachable, falling back to Kokoro: %s", err)
    return synthesize_kokoro(text, voice, speed), "audio/wav"


def decode_16k(audio_bytes):
    """Any recording (iPhone AAC/MP4, WebM, WAV) -> 16 kHz mono float32, as Whisper wants.

    Decoded here rather than by faster-whisper, whose own decoder calls a PyAV
    option that current PyAV releases no longer have.
    """
    resampler = av.AudioResampler(format="s16", layout="mono", rate=16000)
    chunks = []
    with av.open(io.BytesIO(audio_bytes), mode="r") as container:
        for frame in container.decode(audio=0):
            for out in resampler.resample(frame):
                chunks.append(out.to_ndarray().reshape(-1))
        for out in resampler.resample(None):
            chunks.append(out.to_ndarray().reshape(-1))
    if not chunks:
        return np.zeros(0, dtype=np.float32)
    return np.concatenate(chunks).astype(np.float32) / 32768.0


def transcribe(audio_bytes):
    started = time.time()
    samples = decode_16k(audio_bytes)
    if samples.size < 1600:
        return ""
    with STT_LOCK:
        segments, _ = WHISPER.transcribe(samples, language="en", beam_size=1, condition_on_previous_text=False)
        text = " ".join(s.text.strip() for s in segments).strip()
    log.info("stt %.1fs audio in %.2fs: %r", samples.size / 16000, time.time() - started, text[:80])
    return text


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        return

    def send(self, status, body, content_type="application/json"):
        if isinstance(body, (dict, list)):
            body = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def body(self):
        length = int(self.headers.get("Content-Length") or 0)
        if length > MAX_BODY:
            raise ValueError("Request too large")
        return self.rfile.read(length)

    def do_GET(self):
        if self.path == "/voices":
            self.send(200, public_voices())
        elif self.path == "/health":
            self.send(200, {"ok": True})
        else:
            self.send(404, {"error": "not found"})

    def do_POST(self):
        try:
            if self.path == "/tts":
                req = json.loads(self.body())
                text = str(req.get("text", "")).strip()[:MAX_TEXT]
                if not text:
                    raise ValueError("No text to speak")
                speed = min(max(float(req.get("speed") or 1.0), 0.5), 2.0)
                default = next(iter(ELEVEN_VOICES or KOKORO_VOICES))
                audio, kind = synthesize(text, str(req.get("voice") or default), str(req.get("direction") or ""), speed)
                self.send(200, audio, kind)
            elif self.path == "/transcribe":
                self.send(200, {"text": transcribe(self.body())})
            else:
                self.send(404, {"error": "not found"})
        except ValueError as err:
            log.warning("bad request %s: %s", self.path, err)
            self.send(400, {"error": str(err)})
        except Exception as err:
            log.exception("failed %s", self.path)
            self.send(500, {"error": f"{type(err).__name__}: {err}"})


if __name__ == "__main__":
    log.info("Conjure voice service on 127.0.0.1:%d (%d threads, whisper %s)", PORT, THREADS, WHISPER_MODEL)
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
