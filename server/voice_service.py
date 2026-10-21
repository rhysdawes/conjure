"""Natural voices and speech-to-text for Conjure, on the server.

The iPhone's built-in voices sound robotic and Safari's speech recognition is
unreliable in home-screen apps, so Conjure sends both jobs here instead:

  POST /tts         {"text", "voice", "speed"}  -> audio/wav   (Kokoro, 24 kHz)
  POST /transcribe  raw recorded audio          -> {"text"}    (faster-whisper)
  GET  /voices                                  -> [{"name", "gender", "accent"}]

It listens on 127.0.0.1 only; conjure-server.mjs checks the token and forwards.
"""

import io
import json
import logging
import os
import threading
import time
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

# Friendly name -> (Kokoro voice id, gender, accent). British first: the user is in the UK.
VOICES = {
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


def synthesize(text, voice, speed):
    if voice not in VOICES:
        raise ValueError(f"Unknown voice {voice!r}")
    voice_id, _, accent = VOICES[voice]
    lang = "en-gb" if accent == "British" else "en-us"
    started = time.time()
    with TTS_LOCK:
        samples, sample_rate = KOKORO.create(text, voice=voice_id, speed=speed, lang=lang)
    took = time.time() - started
    log.info("tts %s %.1fs audio in %.2fs: %r", voice, len(samples) / sample_rate, took, text[:60])
    return to_wav(samples, sample_rate)


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
            self.send(200, [{"name": n, "gender": g, "accent": a} for n, (_, g, a) in VOICES.items()])
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
                self.send(200, synthesize(text, req.get("voice") or "Emma", speed), "audio/wav")
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
