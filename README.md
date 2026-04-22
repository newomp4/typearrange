# TypeArrange
*by @newomp4*

A local auto-captioning tool that lays words out as a geometric collage —
not a single row at the bottom of the frame. Important words go big and
heavy, fillers go thin/italic, everything animates in with a squash-and-
stretch pop-in at a posterized framerate, and the text inverts the video
underneath it via a blend mode.

Runs entirely on your machine. Speech → text uses a local Whisper model;
layout and rendering happen in the browser on an HTML5 canvas.

---

## Setup (one time)

```bash
cd /path/to/TypeArrange_v1
./setup.sh
```

That script:

1. Creates a Python virtual environment at `./venv`.
2. Installs Flask and `faster-whisper` *into that venv*.
3. Downloads the Whisper `small` model (~480 MB) into `./models`.

Nothing is installed globally. **Delete the folder → everything is gone.**

Dependencies the script does *not* install (because they're not pip
packages):

- **Python 3.11, 3.12, or 3.13** — already on your Mac via Homebrew.
- **ffmpeg** — needed to extract audio. Install with `brew install ffmpeg`
  if you don't have it.

## Run

```bash
./run.sh
```

That starts a local server at `http://127.0.0.1:5178` and opens the page
in your browser. Ctrl-C in the terminal to stop it.

## Using it

1. Drop a video on the dropzone (or click to pick one).
2. Wait for transcription. Status shows in the top right.
3. Tweak the panel on the right:
    - **font** — Arial or Helvetica (uses your system fonts; they're built
      in on macOS).
    - **blend under text** — `invert` uses a `difference` blend, `soft`
      uses `exclusion`, `none` is plain white text.
    - **words / caption** — how many words appear in each arrangement.
    - **tracking** — letter spacing (negative = tight, which is what the
      design calls for).
    - **posterize (fps)** — the lower, the choppier the motion.
    - **squash & stretch** — 0 = no stretch, 1 = full cartoon pop.
    - **size** — global scale for all text.
4. Press space or click play to preview.
5. Click **export .webm** to render out the composited video + original
   audio.

---

## How it works (the technical bit, demystified)

The tool has three parts:

### 1. Transcription (Python, server)

`faster-whisper` is OpenAI's Whisper model, compiled with CTranslate2 and
quantised to int8 — so it runs ~3× faster than vanilla Whisper on a CPU
Mac and uses less RAM. We give it the audio and ask for **word-level
timestamps**: for every word it tells us the start and end time in
seconds.

`ffmpeg` is only used to yank audio out of the video into a 16 kHz mono
WAV (the format Whisper expects).

### 2. Layout (JavaScript, browser — `static/js/layout.js`)

Given the flat list of timed words, the layout step:

1. **Groups them into captions** of 4–7 words. Breaks happen at hard
   punctuation (`. ! ?`), long pauses, or when it hits the max.
2. **Scores each word's "importance"** — a little heuristic based on
   stopwords, word length, punctuation, caps, digits.
3. **Picks a font weight & size** per word from the score (thin/italic
   for fillers, black for heros).
4. **Packs them into rows** — words flow left-to-right until a row would
   be too wide, then wrap. A "hero" word that's big enough gets its own
   row so it doesn't get squished next to fillers.
5. **Picks a composition preset** deterministically per caption: center
   stack, left-aligned, right-aligned, staggered (alternating rows), or
   pyramid. This is what gives each arrangement a different *shape*
   without being random slop.

Coordinates come out as normalized fractions (0..1) so they scale to any
resolution.

### 3. Rendering (JavaScript, canvas — `static/js/renderer.js`)

A `requestAnimationFrame` loop that, per frame:

1. Draws the current video frame to canvas with `drawImage`.
2. Finds captions active at the current time.
3. For each word in those captions, applies a transform (squash/stretch
   pop-in, see `animation.js`) and draws it in white with
   `ctx.globalCompositeOperation = 'difference'`. The *difference* blend
   subtracts the text color from the video, so white text inverts
   whatever was underneath. Instantly readable over anything.

### The posterized look

The animation module snaps time to a coarse framerate:

```
t' = floor(t * fps) / fps     // e.g. fps=12 → 12 steps per second
```

Even though the browser is painting at 60 Hz, the *animated values* only
change 12 times a second — so the motion looks stepped and deliberate,
like motion graphics.

### Squash & stretch

Each word's pop-in is two phases over ~280 ms:

```
phase 1 (0.00 → 0.55):   scaleX 1.45 → 0.90,  scaleY 0.55 → 1.10   (wide-short → tall-narrow)
phase 2 (0.55 → 1.00):   scaleX 0.90 → 1.00,  scaleY 1.10 → 1.00   (settle with overshoot)
```

Strength is dialable 0..1. Each word inside a caption is staggered by a
small delay from the caption's start time so the arrangement appears to
cascade.

---

## Folder layout

```
TypeArrange_v1/
├── setup.sh          # create venv, install deps, download model
├── run.sh            # start the server + open the browser
├── requirements.txt
├── app.py            # Flask backend: upload, transcribe, serve
├── templates/
│   └── index.html    # the single page
├── static/
│   ├── css/style.css
│   └── js/
│       ├── utils.js       # pure helpers: scoring, PRNG, easings
│       ├── layout.js      # group words + pack them into rows
│       ├── animation.js   # posterized timing + squash-&-stretch
│       ├── renderer.js    # canvas draw loop + blend-mode comp
│       └── app.js         # UI wiring, transport, export
├── uploads/          # the raw videos you drop (gitignored)
├── exports/          # future use
├── models/           # whisper model weights (local cache)
└── venv/             # python virtual environment
```

**Uninstall / free space:** `rm -rf /path/to/TypeArrange_v1`. That's it.

## Limitations

- Export is WebM only right now (what browser `MediaRecorder` produces
  natively). If you want MP4, convert with ffmpeg afterwards:
  `ffmpeg -i typearrange.webm -c:v libx264 -c:a aac out.mp4`.
- Font choice is limited to system fonts for now (Arial / Helvetica),
  which is fine on macOS where both are installed by default.
- First transcription is slow while the model loads (~5–10 s).
