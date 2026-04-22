#!/usr/bin/env bash
# TypeArrange — start the local server.

set -e
cd "$(dirname "$0")"
PROJECT_DIR="$(pwd)"

if [ ! -d "venv" ]; then
  echo "venv/ not found. Run ./setup.sh first."
  exit 1
fi

# shellcheck disable=SC1091
source venv/bin/activate

# Keep every cache local to the project folder.
export HF_HOME="$PROJECT_DIR/models/hf"
export XDG_CACHE_HOME="$PROJECT_DIR/models/cache"

PORT="${PORT:-5178}"
URL="http://127.0.0.1:${PORT}"

echo "==> TypeArrange running at $URL"
echo "    Press Ctrl-C to stop."

# Open the browser after a tiny delay so the server is up.
( sleep 1.2 && open "$URL" ) &

exec python app.py --port "$PORT"
