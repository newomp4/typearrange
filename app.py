"""
TypeArrange — Flask backend.

What this does:
  1. Serves the single-page UI from ./templates/index.html.
  2. Accepts a video upload, stores it in ./uploads.
  3. Extracts the audio with ffmpeg.
  4. Runs Whisper (via faster-whisper) to transcribe the audio with
     word-level timestamps.
  5. Returns a JSON payload that the browser uses to lay out, animate
     and composite the captions on top of the video in <canvas>.

Why faster-whisper?
  It's the same Whisper model quantised with CTranslate2. On a Mac without
  a GPU it runs ~3–4× faster than openai-whisper and uses less RAM.
  Accuracy is identical for our purposes.
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import uuid
from pathlib import Path

from flask import (
    Flask,
    jsonify,
    render_template,
    request,
    send_from_directory,
    url_for,
)

# ---------------------------------------------------------------------------
# Paths — everything lives inside the project folder so deletion is clean.
# ---------------------------------------------------------------------------
PROJECT_DIR = Path(__file__).resolve().parent
UPLOADS_DIR = PROJECT_DIR / "uploads"
EXPORTS_DIR = PROJECT_DIR / "exports"
MODELS_DIR = PROJECT_DIR / "models"
FW_MODELS_DIR = MODELS_DIR / "faster-whisper"

for d in (UPLOADS_DIR, EXPORTS_DIR, MODELS_DIR, FW_MODELS_DIR):
    d.mkdir(parents=True, exist_ok=True)

# Keep Hugging Face / ctranslate2 caches local too.
os.environ.setdefault("HF_HOME", str(MODELS_DIR / "hf"))
os.environ.setdefault("XDG_CACHE_HOME", str(MODELS_DIR / "cache"))


# ---------------------------------------------------------------------------
# Whisper model — loaded lazily on first transcription so the server starts
# quickly. A lock guards first-load so concurrent requests don't race.
# ---------------------------------------------------------------------------
_model = None
_model_lock = threading.Lock()
_model_size = os.environ.get("TYPEARRANGE_MODEL", "small")


def get_model():
    global _model
    if _model is None:
        with _model_lock:
            if _model is None:
                # Local import so the server can boot even if faster-whisper
                # hasn't been installed yet (setup.sh will install it).
                from faster_whisper import WhisperModel

                print(f"[whisper] loading model '{_model_size}' …", flush=True)
                _model = WhisperModel(
                    _model_size,
                    device="cpu",
                    compute_type="int8",
                    download_root=str(FW_MODELS_DIR),
                )
                print("[whisper] model ready.", flush=True)
    return _model


# ---------------------------------------------------------------------------
# ffmpeg helpers.
# ---------------------------------------------------------------------------
def ffmpeg_bin() -> str:
    path = shutil.which("ffmpeg")
    if not path:
        raise RuntimeError(
            "ffmpeg is required but was not found on PATH. "
            "Install it with `brew install ffmpeg`."
        )
    return path


def extract_audio(video_path: Path, out_wav: Path) -> None:
    """Extract mono 16kHz PCM — the format Whisper expects."""
    cmd = [
        ffmpeg_bin(),
        "-y",
        "-i", str(video_path),
        "-vn",
        "-ac", "1",
        "-ar", "16000",
        "-f", "wav",
        str(out_wav),
    ]
    subprocess.run(cmd, check=True, capture_output=True)


# ---------------------------------------------------------------------------
# Flask app.
# ---------------------------------------------------------------------------
app = Flask(__name__, static_folder="static", template_folder="templates")
app.config["MAX_CONTENT_LENGTH"] = 2 * 1024 * 1024 * 1024  # 2 GB


@app.route("/")
def index():
    return render_template("index.html")


@app.route("/uploads/<path:name>")
def serve_upload(name: str):
    # Serve the raw uploaded video so <video> in the browser can stream it.
    return send_from_directory(UPLOADS_DIR, name, conditional=True)


@app.route("/api/transcribe", methods=["POST"])
def transcribe():
    """Receive a video file → return word-level transcript JSON.

    Response shape:
        {
          "video_url":   "/uploads/<uuid>.mp4",
          "duration":    12.34,
          "language":    "en",
          "words": [
            { "w": "hello", "s": 0.32, "e": 0.60 },
            ...
          ]
        }
    """
    if "video" not in request.files:
        return jsonify(error="no file uploaded"), 400

    f = request.files["video"]
    if not f.filename:
        return jsonify(error="empty filename"), 400

    # Keep the original extension so the browser can play it back.
    ext = Path(f.filename).suffix.lower() or ".mp4"
    token = uuid.uuid4().hex
    video_path = UPLOADS_DIR / f"{token}{ext}"
    f.save(video_path)

    # Extract audio to a temp wav.
    with tempfile.TemporaryDirectory() as tmp:
        wav_path = Path(tmp) / "audio.wav"
        try:
            extract_audio(video_path, wav_path)
        except subprocess.CalledProcessError as e:
            return (
                jsonify(
                    error="ffmpeg failed",
                    detail=e.stderr.decode("utf-8", "replace")[-800:],
                ),
                500,
            )
        except RuntimeError as e:
            return jsonify(error=str(e)), 500

        # Run Whisper. word_timestamps=True gives us per-word start/end.
        model = get_model()
        segments, info = model.transcribe(
            str(wav_path),
            word_timestamps=True,
            vad_filter=True,           # drop silence
            beam_size=1,               # fast; quality is still excellent
            language=None,             # auto-detect
        )

        words: list[dict] = []
        for seg in segments:
            if not seg.words:
                continue
            for w in seg.words:
                token_text = (w.word or "").strip()
                if not token_text:
                    continue
                words.append({
                    "w": token_text,
                    "s": float(w.start) if w.start is not None else float(seg.start),
                    "e": float(w.end) if w.end is not None else float(seg.end),
                })

    return jsonify(
        video_url=url_for("serve_upload", name=video_path.name),
        duration=float(info.duration),
        language=info.language,
        words=words,
    )


# ---------------------------------------------------------------------------
# Entrypoint.
# ---------------------------------------------------------------------------
def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=5178)
    parser.add_argument("--debug", action="store_true")
    args = parser.parse_args()

    app.run(host=args.host, port=args.port, debug=args.debug, use_reloader=False)


if __name__ == "__main__":
    main()
