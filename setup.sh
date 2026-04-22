#!/usr/bin/env bash
# TypeArrange — local setup script.
# Creates an isolated Python venv *inside* this folder so that deleting
# the folder cleans up everything. No system-wide installs.

set -e

cd "$(dirname "$0")"
PROJECT_DIR="$(pwd)"

echo "==> TypeArrange setup"
echo "    Project dir: $PROJECT_DIR"

# --- 1. Pick a Python interpreter ---------------------------------------
# Prefer 3.13 (best ML wheel support right now). Fall back to 3.12, 3.11.
PYTHON_BIN=""
for candidate in python3.13 python3.12 python3.11 python3; do
  if command -v "$candidate" >/dev/null 2>&1; then
    PYTHON_BIN="$(command -v "$candidate")"
    break
  fi
done

if [ -z "$PYTHON_BIN" ]; then
  echo "ERROR: no python3 interpreter found."
  exit 1
fi
echo "    Using interpreter: $PYTHON_BIN ($($PYTHON_BIN --version))"

# --- 2. Create venv -----------------------------------------------------
if [ ! -d "venv" ]; then
  echo "==> Creating virtual environment (venv/)"
  "$PYTHON_BIN" -m venv venv
fi

# shellcheck disable=SC1091
source venv/bin/activate
python -m pip install --upgrade pip wheel >/dev/null

# --- 3. Install Python deps --------------------------------------------
echo "==> Installing Python dependencies (this may take a few minutes the first time)"
pip install -r requirements.txt

# --- 4. Pre-download the Whisper model ---------------------------------
# We use faster-whisper's "small" model by default — a good balance between
# accuracy and speed on a Mac. The model is cached inside ./models so it
# disappears with the folder.
echo "==> Pre-downloading Whisper model (small, ~480MB)"
export HF_HOME="$PROJECT_DIR/models/hf"
export XDG_CACHE_HOME="$PROJECT_DIR/models/cache"
mkdir -p "$HF_HOME" "$XDG_CACHE_HOME"
python -c "
from faster_whisper import WhisperModel
WhisperModel('small', device='cpu', compute_type='int8', download_root='models/faster-whisper')
print('   model ready.')
"

# --- 5. ffmpeg check ----------------------------------------------------
if ! command -v ffmpeg >/dev/null 2>&1; then
  echo "WARNING: ffmpeg not found on PATH."
  echo "         Install it with:  brew install ffmpeg"
  echo "         (audio extraction needs it.)"
else
  echo "==> ffmpeg found at $(command -v ffmpeg)"
fi

echo ""
echo "==> Setup complete."
echo "    Start the app with:   ./run.sh"
