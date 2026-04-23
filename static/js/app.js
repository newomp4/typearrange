/* app.js — top-level controller. Wires the UI to the modules and runs
 * the playback/render loop.
 */
'use strict';

(() => {
  const U = TA.utils;
  const L = TA.layout;
  const R = TA.renderer;

  // -------- DOM refs ---------------------------------------------------
  const $ = sel => document.querySelector(sel);
  const dropzone    = $('#dropzone');
  const fileInput   = $('#fileInput');
  const pickFile    = $('#pickFile');
  const preview     = $('#preview');
  const video       = $('#video');
  const canvas      = $('#canvas');
  const status      = $('#status');
  const playBtn     = $('#playBtn');
  const timeLabel   = $('#timeLabel');
  const exportBtn   = $('#exportBtn');
  const resetBtn    = $('#resetBtn');

  // New bottom-dock elements — timeline + inspector replace the old
  // cramped sidebar caption list.
  const timelineEl         = $('#timeline');
  const timelineInnerEl    = $('#timelineInner');
  const timelineRulerEl    = $('#timelineRuler');
  const timelineTrackEl    = $('#timelineTrack');
  const timelinePlayheadEl = $('#timelinePlayhead');
  const timelineSelboxEl   = $('#timelineSelbox');
  const dockInspectorEl    = $('#dockInspector');

  // -------- Global settings --------------------------------------------
  const settings = {
    fontFamily:      'Arial',
    blendMode:       'difference',
    /** 'left' | 'center' | 'right' | 'mixed' — where captions cluster
     *  inside the safe area. Center is the default; mixed rotates
     *  across center/left/right (no longer touches the old stagger
     *  preset, which scattered rows within a single caption). */
    alignment:       'center',
    wordsPerCaption: 6,
    trackingEm:      -0.06,
    wordGapEm:       0.33,
    posterizeFps:    12,
    squash:          0.6,
    sizeScale:       1.0,
    safeArea:        { ...TA.layout.DEFAULT_SAFE_AREA },
    /** Split-preset "object" gap — the rectangular region where a
     *  central subject is framed in the video. The split layout places
     *  the first half of each caption's words to the left of this box
     *  and the rest to the right, letting the subject visually separate
     *  the phrase. */
    splitGap:        { x0: 0.40, y0: 0.30, x1: 0.60, y1: 0.70 },
    /** Brand presets: map of bare-lowercase word → { color, bold }.
     *  Persisted to localStorage so presets survive reloads. Layout
     *  applies the colour per-word (still composited through the blend
     *  mode) and forces weight 900 when `bold` is true. */
    brandColors:     {},
  };

  // -------- Brand presets persistence ---------------------------------
  const BRAND_STORAGE_KEY = 'typearrange.brandColors.v1';

  /** Normalise a parsed brand-colour map into the { color, bold } shape.
   *  Accepts the legacy shape (word → "#hex") too, so exports from older
   *  versions still import cleanly. */
  function normalizeBrandMap(parsed) {
    const out = {};
    if (!parsed || typeof parsed !== 'object') return out;
    for (const [k, v] of Object.entries(parsed)) {
      const key = String(k).trim().toLowerCase();
      if (!key) continue;
      if (typeof v === 'string') {
        out[key] = { color: v, bold: false };
      } else if (v && typeof v === 'object') {
        out[key] = {
          color: typeof v.color === 'string' ? v.color : null,
          bold:  !!v.bold,
        };
      }
    }
    return out;
  }

  function loadBrandPresets() {
    try {
      const raw = localStorage.getItem(BRAND_STORAGE_KEY);
      if (!raw) return;
      settings.brandColors = normalizeBrandMap(JSON.parse(raw));
    } catch (e) {
      console.warn('brand presets: failed to load', e);
    }
  }

  function saveBrandPresets() {
    try {
      localStorage.setItem(BRAND_STORAGE_KEY, JSON.stringify(settings.brandColors));
    } catch (e) {
      console.warn('brand presets: failed to save', e);
    }
  }

  loadBrandPresets();

  let transcript = null;     // { words, duration, video_url, language }
  /** Caption groups (2-D list of {w, s, e}). Held in app state rather
   *  than recomputed each rebuild so user edits in the captions panel
   *  survive visual-setting changes. Regenerated only when the source
   *  transcript changes or wordsPerCaption changes. */
  let groups = null;
  let captions = [];
  let renderer = null;
  let safeAreaCtl = null;
  let splitGapCtl = null;

  // =====================================================================
  // 1. Upload + transcription
  // =====================================================================

  function setStatus(text, busy = false) {
    status.textContent = text;
    status.classList.toggle('busy', busy);
  }

  async function handleFile(file) {
    if (!file) return;
    if (!file.type.startsWith('video/')) {
      setStatus('not a video');
      return;
    }

    setStatus('uploading…', true);
    const fd = new FormData();
    fd.append('video', file);

    let data;
    try {
      const resp = await fetch('/api/transcribe', { method: 'POST', body: fd });
      if (!resp.ok) {
        const err = await resp.json().catch(() => ({}));
        throw new Error(err.error || `server ${resp.status}`);
      }
      setStatus('transcribing…', true);
      data = await resp.json();
    } catch (e) {
      console.error(e);
      setStatus(`error: ${e.message}`);
      return;
    }

    transcript = data;
    setStatus(`${data.words.length} words · ${data.language}`);

    if (!data.words.length) {
      setStatus('no speech detected');
    }

    // Make sure fonts are actually loaded before we measure anything,
    // otherwise text widths come out wrong.
    try {
      await Promise.all([
        document.fonts.load('900 48px Arial'),
        document.fonts.load('200 48px Arial'),
        document.fonts.load('900 48px Helvetica'),
        document.fonts.load('200 48px Helvetica'),
      ]);
    } catch (_) { /* fonts API missing or font not found — continue */ }

    // Load the video.
    video.src = data.video_url;
    await new Promise(res => {
      video.addEventListener('loadedmetadata', res, { once: true });
    });

    // Force a frame to decode so drawImage has something to paint.
    try {
      video.currentTime = 0;
      await new Promise((res, rej) => {
        const to = setTimeout(res, 800); // don't hang forever
        video.addEventListener('seeked', () => { clearTimeout(to); res(); }, { once: true });
      });
    } catch (_) {}

    dropzone.classList.add('hidden');
    preview.classList.remove('hidden');
    exportBtn.disabled = false;

    // Initial layout + renderer.
    initRenderer();
    initSafeArea();
    rebuildGroups();
    rebuildCaptions();
    startLoop();

    // Auto-play muted so captions animate in immediately.
    video.muted = true;
    try { await video.play(); } catch (_) {}
  }

  function initSafeArea() {
    if (safeAreaCtl) return;
    const wrap = document.getElementById('canvasWrap');
    const box  = document.getElementById('safeBox');
    safeAreaCtl = TA.safeArea.attach(wrap, box, (next) => {
      settings.safeArea = next;
      rebuildCaptions();
    });
    // Apply initial state.
    safeAreaCtl.set(settings.safeArea);
  }

  /** Attach drag/snap behaviour to the split-preset "object" box. It's
   *  hidden from the DOM until a caption flips to split; we still wire
   *  it up lazily on first show so dragging works immediately. */
  function initSplitGap() {
    if (splitGapCtl) return;
    const wrap = document.getElementById('canvasWrap');
    const box  = document.getElementById('splitGapBox');
    splitGapCtl = TA.safeArea.attach(wrap, box, (next) => {
      settings.splitGap = next;
      rebuildCaptions();
    });
    splitGapCtl.set(settings.splitGap);
  }

  /** Show/hide the split-gap overlay based on whether any caption is
   *  using the split preset. Keeps the viewer uncluttered for videos
   *  that aren't using it. */
  function updateSplitGapUI() {
    const el = document.getElementById('splitGap');
    if (!el) return;
    const anySplit = groups?.some(g => g?.preset === 'split');
    if (anySplit) {
      el.hidden = false;
      initSplitGap();
    } else {
      el.hidden = true;
    }
  }

  function initRenderer() {
    if (renderer) return;
    renderer = R.create(canvas, video);
    applySettingsToRenderer();
  }

  function applySettingsToRenderer() {
    if (!renderer) return;
    renderer.set({
      fontFamily:   settings.fontFamily,
      blendMode:    settings.blendMode,
      posterizeFps: settings.posterizeFps,
      squash:       settings.squash,
      trackingEm:   settings.trackingEm,
    });
  }

  /** Regenerate caption groups from the raw transcript. Throws away any
   *  user edits — only called on fresh transcription or when
   *  wordsPerCaption changes. */
  function rebuildGroups() {
    if (!transcript) return;
    groups = L.groupWords(transcript.words, settings.wordsPerCaption);
    clearSelection();
    renderTimeline();
    renderInspector();
    updateSplitGapUI();
  }

  /** Re-lay out the held groups with current visual settings.
   *  Also refreshes the timeline blocks — preset colour-coding, block
   *  text, and selection state all track the live groups array. */
  function rebuildCaptions() {
    if (!groups) return;
    const aspect = (video.videoWidth && video.videoHeight)
      ? video.videoWidth / video.videoHeight
      : 16 / 9;

    captions = L.layoutCaptions(groups, {
      fontFamily:      settings.fontFamily,
      trackingEm:      settings.trackingEm,
      wordGapEm:       settings.wordGapEm,
      sizeScale:       settings.sizeScale,
      aspect,
      safeArea:        settings.safeArea,
      splitGap:        settings.splitGap,
      brandColors:     settings.brandColors,
      alignment:       settings.alignment,
    });
    if (renderer) renderer.state.captions = captions;
    renderTimelineBlocks();
  }

  // =====================================================================
  // Timeline + inspector — new bottom-dock caption editor.
  //
  //   Each caption renders as a block on a horizontal timeline scaled to
  //   video.duration. Clicking a block selects it (seeks the playhead)
  //   and populates the inspector below with a roomy editor. The
  //   inspector is a function of `selectedIdx` and the live `groups`
  //   array — whenever groups or selection changes we re-render it
  //   from scratch, so we never have to reconcile stale node refs.
  // =====================================================================
  const CAPTION_PRESETS = ['motion', 'minimal', 'typewriter', 'split'];

  /** Multi-selection state. `selection` is the set of selected caption
   *  indices; `anchorIdx` is the last single-click (for shift-range).
   *  `selectedIdx` is a *derived* primary (lowest index in set, or -1)
   *  kept around so code that cares about "the one selected caption"
   *  still reads naturally. Sync via syncSelectedIdx() after any
   *  selection mutation. */
  let selection  = new Set();
  let anchorIdx  = -1;
  let selectedIdx = -1;

  function syncSelectedIdx() {
    if (!selection.size) { selectedIdx = -1; return; }
    let min = Infinity;
    for (const i of selection) if (i < min) min = i;
    selectedIdx = min;
  }

  function replaceSelection(idx) {
    selection = new Set([idx]);
    anchorIdx = idx;
    syncSelectedIdx();
  }
  function toggleSelection(idx) {
    if (selection.has(idx)) selection.delete(idx);
    else                    selection.add(idx);
    anchorIdx = idx;
    syncSelectedIdx();
  }
  function rangeSelection(idx) {
    if (anchorIdx < 0) { replaceSelection(idx); return; }
    const lo = Math.min(anchorIdx, idx);
    const hi = Math.max(anchorIdx, idx);
    selection = new Set();
    for (let i = lo; i <= hi; i++) selection.add(i);
    syncSelectedIdx();
  }
  function clearSelection() {
    selection = new Set();
    anchorIdx = -1;
    selectedIdx = -1;
  }

  /** Timeline zoom (1 = fit-to-width, max 20×). Stored as a number and
   *  applied to --timeline-zoom on the inner container. */
  let zoom = 1;
  const ZOOM_MIN = 1;
  const ZOOM_MAX = 20;
  const ZOOM_STEP = 1.5;

  function setZoom(next, { centerOnPlayhead = true } = {}) {
    const clamped = U.clamp(next, ZOOM_MIN, ZOOM_MAX);
    if (clamped === zoom) return;
    zoom = clamped;
    timelineInnerEl.style.setProperty('--timeline-zoom', zoom);
    renderTimelineRuler();
    if (centerOnPlayhead) scrollToPlayhead();
  }

  function scrollToPlayhead() {
    if (!isFinite(video?.duration) || video.duration <= 0) return;
    const pct = video.currentTime / video.duration;
    const innerW = timelineInnerEl.offsetWidth;
    const viewW  = timelineEl.clientWidth;
    const target = pct * innerW - viewW / 2;
    timelineEl.scrollLeft = U.clamp(target, 0, Math.max(0, innerW - viewW));
  }

  /** Derive [start, end] for a group — uses words if present, else the
   *  sentinel _start/_end set at insert-time. */
  function groupSpan(g) {
    if (g.length) {
      return { start: g[0].s, end: g[g.length - 1].e };
    }
    return { start: g._start ?? 0, end: g._end ?? (g._start ?? 0) + 0.5 };
  }

  function groupPreset(g) {
    return g.preset || (g.boring ? 'minimal' : 'motion');
  }

  function renderTimelineRuler() {
    timelineRulerEl.innerHTML = '';
    const dur = video.duration;
    if (!isFinite(dur) || dur <= 0) return;
    // Pick a tick step that gives ~6–12 labels across the duration.
    let step;
    if (dur <= 10)       step = 1;
    else if (dur <= 30)  step = 5;
    else if (dur <= 120) step = 10;
    else if (dur <= 600) step = 30;
    else                 step = 60;
    for (let t = 0; t <= dur + 1e-3; t += step) {
      const tick = document.createElement('span');
      tick.className = 'ruler-tick';
      tick.style.left = `${(t / dur) * 100}%`;
      tick.textContent = U.fmtTime(t);
      timelineRulerEl.appendChild(tick);
    }
  }

  /** Pixel-width of the "grab the edge" hotzones on each block. Near
   *  either end, pointerdown starts a resize drag; anywhere else
   *  starts a move drag (or, if the pointer doesn't move, stays a click). */
  const BLOCK_EDGE_ZONE_PX = 8;

  /** Minimum duration of a caption after resize so the user can't
   *  collapse a block to zero width by mistake. */
  const MIN_CAPTION_DURATION = 0.15;

  /** Smallest neighbour gap the drag respects, in seconds. */
  const NEIGHBOUR_GAP = 0.05;

  function renderTimelineBlocks() {
    timelineTrackEl.innerHTML = '';
    const dur = video.duration;
    if (!isFinite(dur) || dur <= 0 || !groups?.length) {
      const empty = document.createElement('div');
      empty.className = 'timeline-empty';
      empty.textContent = groups?.length
        ? 'no duration yet'
        : 'drop a video to see the timeline';
      timelineTrackEl.appendChild(empty);
      return;
    }
    groups.forEach((g, i) => {
      const block = document.createElement('div');
      block.className = 'cap-block';
      block.dataset.preset = groupPreset(g);
      if (!g.length) block.classList.add('empty');
      if (selection.has(i)) block.classList.add('selected');

      const span = groupSpan(g);
      const leftPct  = U.clamp(span.start / dur, 0, 1) * 100;
      const widthPct = Math.max(0.4, U.clamp((span.end - span.start) / dur, 0, 1) * 100);
      block.style.left  = `${leftPct}%`;
      block.style.width = `${widthPct}%`;
      block.textContent = g.length ? g.map(w => w.w).join(' ') : '+ new caption';
      block.title = `${U.fmtTime(span.start)}–${U.fmtTime(span.end)}  ${g.length ? '' : '(empty — click to fill)'}\nclick to edit · drag to move · drag edges to resize`;

      // Cursor hint — ew-resize near the edges, default elsewhere.
      block.addEventListener('mousemove', ev => {
        const rect = block.getBoundingClientRect();
        const fromLeft  = ev.clientX - rect.left;
        const fromRight = rect.right - ev.clientX;
        block.style.cursor =
          (fromLeft < BLOCK_EDGE_ZONE_PX || fromRight < BLOCK_EDGE_ZONE_PX)
            ? 'ew-resize' : 'pointer';
      });

      attachBlockDrag(block, i);
      timelineTrackEl.appendChild(block);
    });
  }

  /** Wire a block so pointerdown either drags (move / resize-start /
   *  resize-end) or — if the pointer never moves past a threshold —
   *  selects the caption. Using pointer events means mouse + touch +
   *  pen all work. */
  function attachBlockDrag(block, idx) {
    block.addEventListener('pointerdown', downEvent => {
      const g = groups?.[idx];
      const dur = video.duration;
      if (!g || !isFinite(dur) || dur <= 0) return;

      // Figure out which drag mode based on where the pointer went down.
      const rect = block.getBoundingClientRect();
      const fromLeft  = downEvent.clientX - rect.left;
      const fromRight = rect.right - downEvent.clientX;
      let mode;
      if (fromLeft  < BLOCK_EDGE_ZONE_PX)      mode = 'resize-start';
      else if (fromRight < BLOCK_EDGE_ZONE_PX) mode = 'resize-end';
      else                                     mode = 'move';

      const timelineRect = timelineEl.getBoundingClientRect();
      const origSpan = groupSpan(g);
      const origWords = g.length ? g.map(w => ({ s: w.s, e: w.e })) : null;
      const origMeta = { start: g._start, end: g._end };
      const startX = downEvent.clientX;
      let dragged = false;

      downEvent.preventDefault();
      downEvent.stopPropagation();

      function applyDrag(dt) {
        applyBlockTimingChange(idx, mode, dt, origSpan, origWords, origMeta, dur);
        renderTimelineBlocks();
        if (idx === selectedIdx) renderInspector();
        // Keep the layouter in sync while dragging so playback reflects
        // the new timing in real time.
        rebuildCaptions();
      }

      function onMove(ev) {
        const dx = ev.clientX - startX;
        if (!dragged && Math.abs(dx) > 3) dragged = true;
        if (!dragged) return;
        const dt = (dx / timelineRect.width) * dur;
        applyDrag(dt);
      }

      function onUp(ev) {
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        if (dragged) return;
        // Click — modifier keys decide selection mode.
        if (ev.metaKey || ev.ctrlKey) {
          toggleSelection(idx);
          renderTimelineBlocks();
          renderInspector();
        } else if (ev.shiftKey) {
          rangeSelection(idx);
          renderTimelineBlocks();
          renderInspector();
        } else {
          // Plain click: single-select + seek + preview.
          selectCaption(idx, { seek: true, play: false });
        }
      }

      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
    });
  }

  /** Apply a drag delta to a caption's per-word timings.
   *  - 'move'          shifts every word by the same dt.
   *  - 'resize-start'  anchors the caption's end, scales the left side.
   *  - 'resize-end'    anchors the caption's start, scales the right.
   *  Neighbours are respected — a caption can't be dragged past the
   *  previous caption's end or the next caption's start (minus a small
   *  gap so they don't collide). */
  function applyBlockTimingChange(idx, mode, dt, origSpan, origWords, origMeta, dur) {
    const g = groups[idx];
    if (!g) return;
    const prev = groups[idx - 1];
    const next = groups[idx + 1];
    const prevEnd   = prev
      ? (prev.length ? prev[prev.length - 1].e : (prev._end ?? 0))
      : 0;
    const nextStart = next
      ? (next.length ? next[0].s : (next._start ?? dur))
      : dur;

    const os = origSpan.start;
    const oe = origSpan.end;
    const oldSpan = Math.max(0.0001, oe - os);

    if (mode === 'move') {
      const minStart = prevEnd + NEIGHBOUR_GAP;
      const maxEnd   = nextStart - NEIGHBOUR_GAP;
      // Clamp dt so the caption can't be pushed past either neighbour.
      let dtClamped = dt;
      dtClamped = Math.max(dtClamped, minStart - os);
      dtClamped = Math.min(dtClamped, maxEnd - oe);

      if (origWords) {
        for (let i = 0; i < g.length; i++) {
          g[i].s = origWords[i].s + dtClamped;
          g[i].e = origWords[i].e + dtClamped;
        }
      }
      g._start = (origMeta.start ?? os) + dtClamped;
      g._end   = (origMeta.end   ?? oe) + dtClamped;
      return;
    }

    if (mode === 'resize-start') {
      const minStart = prevEnd + NEIGHBOUR_GAP;
      const maxStart = oe - MIN_CAPTION_DURATION;
      const newStart = U.clamp(os + dt, minStart, maxStart);
      const newSpan  = oe - newStart;
      if (origWords) {
        for (let i = 0; i < g.length; i++) {
          const relS = (origWords[i].s - os) / oldSpan;
          const relE = (origWords[i].e - os) / oldSpan;
          g[i].s = newStart + relS * newSpan;
          g[i].e = newStart + relE * newSpan;
        }
      }
      g._start = newStart;
      g._end   = oe;
      return;
    }

    if (mode === 'resize-end') {
      const maxEnd = nextStart - NEIGHBOUR_GAP;
      const minEnd = os + MIN_CAPTION_DURATION;
      const newEnd = U.clamp(oe + dt, minEnd, maxEnd);
      const newSpan = newEnd - os;
      if (origWords) {
        for (let i = 0; i < g.length; i++) {
          const relS = (origWords[i].s - os) / oldSpan;
          const relE = (origWords[i].e - os) / oldSpan;
          g[i].s = os + relS * newSpan;
          g[i].e = os + relE * newSpan;
        }
      }
      g._start = os;
      g._end   = newEnd;
    }
  }

  function renderTimeline() {
    renderTimelineRuler();
    renderTimelineBlocks();
    // Re-evaluate which block is currently playing after a re-render.
    _lastPlayingIdx = -2;
    updatePlayingBlock();
  }

  function renderInspector() {
    dockInspectorEl.innerHTML = '';
    // Hidden state — the inspector row collapses out of the dock grid
    // (HTML `hidden` attribute) so the timeline gets its space.
    if (!groups || selection.size === 0) {
      dockInspectorEl.hidden = true;
      return;
    }
    dockInspectorEl.hidden = false;

    // Bulk-edit mode for multi-selection: compact row with count + the
    // actions that make sense in bulk (cycle preset for each, delete all).
    // Text editing and per-caption timestamp don't translate to bulk, so
    // they're hidden until the user drops back to a single selection.
    if (selection.size > 1) {
      const countField = document.createElement('div');
      countField.className = 'insp-field';
      countField.innerHTML = `<span class="insp-label">selection</span>
                              <span class="insp-time">${selection.size} captions</span>`;

      const presetField = document.createElement('div');
      presetField.className = 'insp-field';
      presetField.innerHTML = '<span class="insp-label">style</span>';
      const cycleBtn = document.createElement('button');
      cycleBtn.className = 'insp-preset';
      cycleBtn.dataset.preset = 'motion';
      cycleBtn.textContent = 'cycle preset';
      cycleBtn.title = 'advance each selected caption one preset forward';
      cycleBtn.addEventListener('click', () => {
        for (const i of selection) {
          const cg = groups[i];
          if (!cg) continue;
          const idx = CAPTION_PRESETS.indexOf(groupPreset(cg));
          cg.preset = CAPTION_PRESETS[(idx + 1) % CAPTION_PRESETS.length];
          delete cg.boring;
        }
        rebuildCaptions();
        renderTimelineBlocks();
        renderInspector();
        updateSplitGapUI();
      });
      presetField.appendChild(cycleBtn);

      const actionsField = document.createElement('div');
      actionsField.className = 'insp-field';
      actionsField.innerHTML = '<span class="insp-label">actions</span>';
      const actionsRow = document.createElement('div');
      actionsRow.className = 'insp-actions';
      const delAllBtn = document.createElement('button');
      delAllBtn.className = 'insp-btn danger';
      delAllBtn.textContent = '×';
      delAllBtn.title = `delete all ${selection.size} selected captions`;
      delAllBtn.addEventListener('click', deleteSelected);
      actionsRow.appendChild(delAllBtn);
      actionsField.appendChild(actionsRow);

      dockInspectorEl.appendChild(countField);
      dockInspectorEl.appendChild(presetField);
      dockInspectorEl.appendChild(actionsField);
      return;
    }

    const g = groups[selectedIdx];
    if (!g) {
      dockInspectorEl.hidden = true;
      return;
    }
    const span = groupSpan(g);

    // Time — click to seek.
    const timeField = document.createElement('div');
    timeField.className = 'insp-field';
    timeField.innerHTML = '<span class="insp-label">time</span>';
    const timeVal = document.createElement('span');
    timeVal.className = 'insp-time';
    timeVal.textContent = U.fmtTime(span.start);
    timeVal.title = 'seek here';
    timeVal.addEventListener('click', () => {
      if (!isFinite(video.duration)) return;
      video.currentTime = Math.max(0, span.start);
      if (video.paused) video.play().catch(() => {});
    });
    timeField.appendChild(timeVal);

    // Text — big input that takes the remaining width.
    const textField = document.createElement('div');
    textField.className = 'insp-field grow';
    textField.innerHTML = '<span class="insp-label">text</span>';
    const textInput = document.createElement('input');
    textInput.type = 'text';
    textInput.className = 'insp-text';
    textInput.value = g.map(w => w.w).join(' ');
    textInput.placeholder = g.length ? '' : 'type caption words…';
    textInput.spellcheck = false;
    const commit = () => {
      const current = (groups[selectedIdx] || []).map(w => w.w).join(' ');
      if (textInput.value !== current) {
        updateCaptionText(selectedIdx, textInput.value);
      }
    };
    textInput.addEventListener('blur', commit);
    textInput.addEventListener('keydown', e => {
      if (e.key === 'Enter') { e.preventDefault(); textInput.blur(); }
    });
    textField.appendChild(textInput);

    // Preset cycle — large button showing current preset by name.
    const presetField = document.createElement('div');
    presetField.className = 'insp-field';
    presetField.innerHTML = '<span class="insp-label">style</span>';
    const cur = groupPreset(g);
    const presetBtn = document.createElement('button');
    presetBtn.className = 'insp-preset';
    presetBtn.dataset.preset = cur;
    presetBtn.textContent = cur;
    presetBtn.title = 'caption style — click to cycle';
    presetBtn.addEventListener('click', () => {
      const cg = groups[selectedIdx];
      if (!cg) return;
      const idx = CAPTION_PRESETS.indexOf(groupPreset(cg));
      const next = CAPTION_PRESETS[(idx + 1) % CAPTION_PRESETS.length];
      cg.preset = next;
      delete cg.boring;   // legacy flag loses to explicit preset
      rebuildCaptions();
      renderTimeline();
      renderInspector();
      updateSplitGapUI();
      // Auto-preview — seek to the caption's start and play.
      const seekTo = cg.length ? cg[0].s : (cg._start ?? null);
      if (seekTo != null && isFinite(video.duration)) {
        video.currentTime = Math.max(0, seekTo - 0.1);
        if (video.paused) video.play().catch(() => {});
      }
    });
    presetField.appendChild(presetBtn);

    // Actions — insert after, delete.
    const actionsField = document.createElement('div');
    actionsField.className = 'insp-field';
    actionsField.innerHTML = '<span class="insp-label">actions</span>';
    const actionsRow = document.createElement('div');
    actionsRow.className = 'insp-actions';

    const addBtn = document.createElement('button');
    addBtn.className = 'insp-btn';
    addBtn.textContent = '+';
    addBtn.title = 'insert caption after';
    addBtn.addEventListener('click', () => {
      const newIdx = selectedIdx + 1;
      insertCaptionAfter(selectedIdx);
      selectCaption(newIdx, { seek: false, play: false, focusText: true });
    });

    const delBtn = document.createElement('button');
    delBtn.className = 'insp-btn danger';
    delBtn.textContent = '×';
    delBtn.title = 'delete caption';
    delBtn.addEventListener('click', () => {
      deleteCaption(selectedIdx);
      clearSelection();
      renderTimeline();
      renderInspector();
      updateSplitGapUI();
    });

    actionsRow.appendChild(addBtn);
    actionsRow.appendChild(delBtn);
    actionsField.appendChild(actionsRow);

    dockInspectorEl.appendChild(timeField);
    dockInspectorEl.appendChild(textField);
    dockInspectorEl.appendChild(presetField);
    dockInspectorEl.appendChild(actionsField);
  }

  /** Public selection helper — used by block clicks, insert/delete, and
   *  keyboard shortcuts. Replaces any existing multi-selection with
   *  just this caption. */
  function selectCaption(idx, { seek = true, play = false, focusText = false } = {}) {
    if (!groups || idx < 0 || idx >= groups.length) {
      clearSelection();
    } else {
      replaceSelection(idx);
    }
    const g = groups?.[selectedIdx];
    if (g && seek && isFinite(video.duration)) {
      const seekTo = g.length ? g[0].s : (g._start ?? 0);
      video.currentTime = Math.max(0, seekTo);
      if (play && video.paused) video.play().catch(() => {});
    }
    renderTimeline();
    renderInspector();
    if (focusText) {
      dockInspectorEl.querySelector('.insp-text')?.focus();
    }
  }

  function updateCaptionText(idx, text) {
    const original = groups[idx];
    if (!original) return;
    const { start, end } = groupSpan(original);
    const span = Math.max(0.1, end - start);
    const wordList = text.trim().split(/\s+/).filter(Boolean);
    if (!wordList.length) {
      // Empty input on a non-empty group — ignore. An empty input on an
      // already-empty placeholder group leaves the slot alone so the
      // user can type later.
      renderTimeline();
      renderInspector();
      return;
    }
    const perWord = span / wordList.length;
    const next = wordList.map((w, i) => ({
      w,
      s: start + i * perWord,
      e: start + (i + 1) * perWord,
    }));
    // Preserve per-group metadata (preset, legacy boring flag, etc.).
    next.boring = !!original.boring;
    if (original.preset) next.preset = original.preset;
    groups[idx] = next;
    rebuildCaptions();
    renderTimeline();
    renderInspector();
  }

  function insertCaptionAfter(idx) {
    if (!groups) return;
    const current = groups[idx];
    const next    = groups[idx + 1];
    const currentEnd = current?.length ? current[current.length - 1].e : (current?._end ?? 0);
    const nextStart  = next?.length    ? next[0].s                     : (next?._start    ?? currentEnd + 1.5);
    const gap = Math.max(0.2, nextStart - currentEnd);
    const newStart = currentEnd + gap * 0.30;
    const newEnd   = currentEnd + gap * 0.70;
    const empty = [];
    empty._start = newStart;
    empty._end   = newEnd;
    empty.boring = false;
    groups.splice(idx + 1, 0, empty);
    rebuildCaptions();
    renderTimeline();
  }

  function deleteCaption(idx) {
    if (!groups || !groups[idx]) return;
    groups.splice(idx, 1);
    rebuildCaptions();
  }

  /** Remove every caption currently in `selection`. Walks highest → lowest
   *  so splice indexes stay valid. Clears selection at the end. */
  function deleteSelected() {
    if (!groups || selection.size === 0) return;
    const idxs = [...selection].sort((a, b) => b - a);
    for (const i of idxs) groups.splice(i, 1);
    clearSelection();
    rebuildCaptions();
    renderTimeline();
    renderInspector();
    updateSplitGapUI();
  }

  /** Split the caption whose time range contains the playhead into two
   *  halves at the first word boundary ≥ playhead. Premiere's Cmd+K. */
  function cutAtPlayhead() {
    if (!groups?.length) return;
    const t = video.currentTime;
    if (!isFinite(t)) return;
    const idx = groups.findIndex(g => {
      const span = groupSpan(g);
      return t >= span.start && t <= span.end;
    });
    if (idx < 0) return;
    const g = groups[idx];
    if (!g.length || g.length < 2) return; // can't split empty / single-word
    // First word whose start time is at or after the playhead becomes
    // the head of the second half.
    let k = g.findIndex(w => w.s >= t);
    if (k <= 0) k = 1;                     // keep at least one word in first half
    if (k >= g.length) return;             // playhead is past every word — no split

    const first  = Array.from(g.slice(0, k));
    const second = Array.from(g.slice(k));
    // Preserve per-group metadata on both halves.
    if (g.preset) { first.preset = g.preset; second.preset = g.preset; }
    if (g.boring) { first.boring = true;     second.boring = true;     }

    groups.splice(idx, 1, first, second);
    // Select both halves so the user sees what happened.
    selection = new Set([idx, idx + 1]);
    anchorIdx = idx;
    syncSelectedIdx();
    rebuildCaptions();
    renderTimeline();
    renderInspector();
    updateSplitGapUI();
  }

  /** "+ caption" in the dock topbar — appends at the end of the
   *  timeline and auto-selects the new slot so the user can type. */
  document.getElementById('captionAppend').addEventListener('click', () => {
    if (!groups) return;
    const last = groups[groups.length - 1];
    const lastEnd = last?.length
      ? last[last.length - 1].e
      : (last?._end ?? 0);
    const empty = [];
    empty._start = lastEnd + 0.3;
    empty._end   = lastEnd + 1.2;
    empty.boring = false;
    groups.push(empty);
    rebuildCaptions();
    selectCaption(groups.length - 1, { seek: false, play: false, focusText: true });
  });

  // Timeline background pointerdown:
  //   - no movement → scrub to that time (old "click to seek" behaviour)
  //   - movement    → draw a selection box; captions whose time range
  //                   overlaps the box get selected
  // Modifier keys on pointerup decide how the new selection merges:
  //   plain      → replace current selection
  //   Cmd/Ctrl   → union with current
  //   Shift      → union with current (shift-drag is "add to range")
  // Blocks stopPropagation in their own pointerdown, so this only
  // runs on empty timeline area.
  timelineEl.addEventListener('pointerdown', e => {
    if (!isFinite(video.duration) || video.duration <= 0) return;
    if (e.button !== 0) return;
    const innerRect = timelineInnerEl.getBoundingClientRect();
    const startFrac = U.clamp((e.clientX - innerRect.left) / innerRect.width, 0, 1);
    const startY    = e.clientY;
    let moved = false;

    function fracAt(clientX) {
      return U.clamp((clientX - innerRect.left) / innerRect.width, 0, 1);
    }

    function onMove(ev) {
      const dx = Math.abs(ev.clientX - e.clientX);
      const dy = Math.abs(ev.clientY - startY);
      if (!moved && (dx > 3 || dy > 3)) {
        moved = true;
        timelineSelboxEl.hidden = false;
      }
      if (!moved) return;
      const curFrac = fracAt(ev.clientX);
      const left  = Math.min(startFrac, curFrac) * 100;
      const width = Math.abs(curFrac - startFrac) * 100;
      timelineSelboxEl.style.left  = `${left}%`;
      timelineSelboxEl.style.width = `${width}%`;
    }

    function onUp(ev) {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      if (!moved) {
        // Scrub. Modifier-less click on empty timeline = clear selection.
        video.currentTime = startFrac * video.duration;
        if (!(ev.shiftKey || ev.metaKey || ev.ctrlKey)) {
          clearSelection();
          renderTimelineBlocks();
          renderInspector();
        }
        return;
      }
      // Drag-box selection.
      timelineSelboxEl.hidden = true;
      timelineSelboxEl.style.width = '0%';
      const curFrac = fracAt(ev.clientX);
      const timeMin = Math.min(startFrac, curFrac) * video.duration;
      const timeMax = Math.max(startFrac, curFrac) * video.duration;
      const hits = new Set();
      if (groups) {
        groups.forEach((g, i) => {
          const span = groupSpan(g);
          // Any overlap between [span.start, span.end] and [timeMin, timeMax].
          if (span.start < timeMax && span.end > timeMin) hits.add(i);
        });
      }
      if (ev.metaKey || ev.ctrlKey || ev.shiftKey) {
        for (const i of hits) selection.add(i);
      } else {
        selection = hits;
      }
      // Anchor = first (lowest-idx) hit so subsequent shift-clicks extend
      // from that point, which matches the feel of drag-then-shift-click.
      anchorIdx = hits.size ? Math.min(...hits) : -1;
      syncSelectedIdx();
      renderTimelineBlocks();
      renderInspector();
    }

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  });

  /** Highlight the currently-playing block on the timeline.
   *  Cheap linear scan, only mutates the DOM when the active index
   *  actually changes. */
  let _lastPlayingIdx = -2;
  function updatePlayingBlock() {
    if (!groups?.length) return;
    const t = video.currentTime;
    let active = -1;
    for (let i = 0; i < groups.length; i++) {
      const span = groupSpan(groups[i]);
      if (t >= span.start && t <= span.end) { active = i; break; }
    }
    if (active === _lastPlayingIdx) return;
    _lastPlayingIdx = active;
    const blocks = timelineTrackEl.querySelectorAll('.cap-block');
    blocks.forEach((b, i) => b.classList.toggle('cap-playing', i === active));
  }

  function updateTimelinePlayhead() {
    if (!isFinite(video.duration) || video.duration <= 0) {
      timelinePlayheadEl.hidden = true;
      return;
    }
    timelinePlayheadEl.hidden = false;
    const pct = video.currentTime / video.duration;
    timelinePlayheadEl.style.left = `${pct * 100}%`;

    // Auto-pan while playing so the playhead stays on-screen when zoomed
    // in. Only nudges when the playhead actually leaves the viewport —
    // otherwise user-initiated scrolls aren't yanked around.
    if (zoom > 1 && !video.paused) {
      const innerW = timelineInnerEl.offsetWidth;
      const viewW  = timelineEl.clientWidth;
      const phX    = pct * innerW;
      const scrollL = timelineEl.scrollLeft;
      if (phX < scrollL || phX > scrollL + viewW) {
        timelineEl.scrollLeft = U.clamp(
          phX - viewW / 2, 0, Math.max(0, innerW - viewW),
        );
      }
    }
  }

  // =====================================================================
  // Brand colors (sidebar)
  // =====================================================================
  const brandListEl    = document.getElementById('brandList');
  const brandAddWordEl = document.getElementById('brandAddWord');
  const brandAddColorEl = document.getElementById('brandAddColor');
  const brandAddBtn    = document.getElementById('brandAdd');

  function renderBrandList() {
    brandListEl.innerHTML = '';
    const entries = Object.entries(settings.brandColors);
    entries.forEach(([word, entry]) => {
      const row = document.createElement('div');
      row.className = 'brand-row';

      const wi = document.createElement('input');
      wi.type = 'text';
      wi.className = 'brand-word';
      wi.value = word;
      wi.spellcheck = false;
      wi.addEventListener('change', () => {
        const next = wi.value.trim().toLowerCase();
        if (!next || next === word) return;
        delete settings.brandColors[word];
        settings.brandColors[next] = entry;
        saveBrandPresets();
        renderBrandList();
        rebuildCaptions();
      });

      const ci = document.createElement('input');
      ci.type = 'color';
      ci.className = 'brand-color';
      ci.value = entry.color || '#ffffff';
      ci.addEventListener('input', () => {
        entry.color = ci.value;
        saveBrandPresets();
        rebuildCaptions();
      });

      const boldBtn = document.createElement('button');
      boldBtn.className = 'brand-bold' + (entry.bold ? ' active' : '');
      boldBtn.textContent = 'B';
      boldBtn.setAttribute('aria-pressed', entry.bold ? 'true' : 'false');
      boldBtn.setAttribute('aria-label', `toggle bold for ${word}`);
      boldBtn.addEventListener('click', () => {
        entry.bold = !entry.bold;
        boldBtn.classList.toggle('active', entry.bold);
        boldBtn.setAttribute('aria-pressed', entry.bold ? 'true' : 'false');
        saveBrandPresets();
        rebuildCaptions();
      });

      const del = document.createElement('button');
      del.className = 'brand-del';
      del.textContent = '×';
      del.setAttribute('aria-label', `remove ${word}`);
      del.addEventListener('click', () => {
        delete settings.brandColors[word];
        saveBrandPresets();
        renderBrandList();
        rebuildCaptions();
      });

      row.appendChild(wi);
      row.appendChild(ci);
      row.appendChild(boldBtn);
      row.appendChild(del);
      brandListEl.appendChild(row);
    });
  }

  function addBrandColor() {
    const w = brandAddWordEl.value.trim().toLowerCase();
    if (!w) return;
    settings.brandColors[w] = {
      color: brandAddColorEl.value,
      bold: false,
    };
    brandAddWordEl.value = '';
    saveBrandPresets();
    renderBrandList();
    rebuildCaptions();
  }
  brandAddBtn.addEventListener('click', addBrandColor);
  brandAddWordEl.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); addBrandColor(); }
  });

  // Export / import the brand library so presets travel between
  // browsers, videos, or teammates.
  const brandExportBtn   = document.getElementById('brandExport');
  const brandImportBtn   = document.getElementById('brandImport');
  const brandImportInput = document.getElementById('brandImportInput');

  brandExportBtn.addEventListener('click', () => {
    const blob = new Blob(
      [JSON.stringify(settings.brandColors, null, 2)],
      { type: 'application/json' },
    );
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'typearrange-brands.json';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });

  brandImportBtn.addEventListener('click', () => brandImportInput.click());
  brandImportInput.addEventListener('change', async () => {
    const f = brandImportInput.files?.[0];
    if (!f) return;
    try {
      const text = await f.text();
      const incoming = normalizeBrandMap(JSON.parse(text));
      // Merge rather than replace so the user doesn't lose presets they
      // already have locally.
      Object.assign(settings.brandColors, incoming);
      saveBrandPresets();
      renderBrandList();
      rebuildCaptions();
    } catch (e) {
      console.error('brand import failed', e);
      setStatus(`import failed: ${e.message}`);
    }
    brandImportInput.value = '';
  });

  renderBrandList();

  // Collapsible brand panel — keeps the brand library out of the way
  // once the user has built up a long list. Collapsed state is
  // remembered across reloads.
  const BRAND_COLLAPSED_KEY = 'typearrange.brandsCollapsed.v1';
  const brandSection = document.getElementById('brandSection');
  const brandToggle  = document.getElementById('brandToggle');

  function setBrandCollapsed(collapsed) {
    brandSection.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
    brandToggle.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
    try { localStorage.setItem(BRAND_COLLAPSED_KEY, collapsed ? '1' : '0'); }
    catch (_) { /* storage disabled — just don't persist */ }
  }

  try {
    if (localStorage.getItem(BRAND_COLLAPSED_KEY) === '1') {
      setBrandCollapsed(true);
    }
  } catch (_) {}

  brandToggle.addEventListener('click', () => {
    const isCollapsed = brandSection.getAttribute('aria-expanded') === 'false';
    setBrandCollapsed(!isCollapsed);
  });

  // =====================================================================
  // 2. Drop zone
  // =====================================================================
  ['dragenter', 'dragover'].forEach(ev =>
    dropzone.addEventListener(ev, e => {
      e.preventDefault();
      dropzone.classList.add('drag');
    })
  );
  ['dragleave', 'drop'].forEach(ev =>
    dropzone.addEventListener(ev, e => {
      e.preventDefault();
      dropzone.classList.remove('drag');
    })
  );
  dropzone.addEventListener('drop', e => {
    const f = e.dataTransfer?.files?.[0];
    if (f) handleFile(f);
  });
  dropzone.addEventListener('click', () => fileInput.click());
  pickFile.addEventListener('click', e => { e.stopPropagation(); fileInput.click(); });
  fileInput.addEventListener('change', () => handleFile(fileInput.files[0]));

  // =====================================================================
  // 3. Render loop
  // =====================================================================
  let rafId = 0;
  function startLoop() {
    if (rafId) return;
    const tick = () => {
      if (renderer) renderer.draw(video.currentTime);
      updateTransport();
      updateTimelinePlayhead();
      updatePlayingBlock();
      rafId = requestAnimationFrame(tick);
    };
    rafId = requestAnimationFrame(tick);
  }

  function updateTransport() {
    const dur = isFinite(video.duration) ? video.duration : 0;
    const cur = video.currentTime;
    timeLabel.textContent = `${U.fmtTime(cur)} / ${U.fmtTime(dur)}`;
    playBtn.textContent = video.paused ? '▶' : '❚❚';
  }

  // =====================================================================
  // 4. Transport controls
  // =====================================================================
  playBtn.addEventListener('click', () => {
    if (video.paused) video.play(); else video.pause();
  });

  // Mute toggle. Autoplay requires the video to start muted; this lets
  // the user actually hear the clip once it's loaded.
  const muteBtn = document.getElementById('muteBtn');
  function refreshMuteBtn() {
    const muted = video.muted;
    muteBtn.classList.toggle('is-muted', muted);
    muteBtn.setAttribute('aria-pressed', muted ? 'true' : 'false');
    muteBtn.title = muted ? 'unmute' : 'mute';
  }
  muteBtn.addEventListener('click', () => {
    video.muted = !video.muted;
    refreshMuteBtn();
  });
  video.addEventListener('volumechange', refreshMuteBtn);

  // Keyboard shortcuts — all suppressed when focus is in an input /
  // button / textarea so we don't hijack typing or native button activation.
  document.addEventListener('keydown', e => {
    const tag = document.activeElement?.tagName;
    const inField = tag === 'INPUT' || tag === 'TEXTAREA';

    // Cmd/Ctrl+K — cut at playhead (Premiere-style add-edit). Allowed
    // even from a field because it never conflicts with typing, and
    // users reach for it while an input happens to be focused.
    if ((e.metaKey || e.ctrlKey) && (e.key === 'k' || e.key === 'K')) {
      e.preventDefault();
      cutAtPlayhead();
      return;
    }

    if (inField || tag === 'BUTTON') return;

    // Space: play/pause.
    if (e.code === 'Space') {
      e.preventDefault();
      if (video.paused) video.play(); else video.pause();
      return;
    }

    // Arrow keys: scrub by 3s. Shift-arrow jumps by 10s for a larger step.
    if (e.code === 'ArrowLeft' || e.code === 'ArrowRight') {
      if (!isFinite(video.duration)) return;
      e.preventDefault();
      const step = (e.shiftKey ? 10 : 3) * (e.code === 'ArrowRight' ? 1 : -1);
      video.currentTime = U.clamp(video.currentTime + step, 0, video.duration);
      return;
    }

    // M: toggle mute.
    if (e.key === 'm' || e.key === 'M') {
      e.preventDefault();
      video.muted = !video.muted;
      refreshMuteBtn();
      return;
    }

    // Zoom: + zooms in, - zooms out, 0 resets. Accept '=' too (same
    // physical key as '+' without shift on most layouts).
    if (e.key === '+' || e.key === '=') {
      e.preventDefault();
      setZoom(zoom * ZOOM_STEP);
      return;
    }
    if (e.key === '-' || e.key === '_') {
      e.preventDefault();
      setZoom(zoom / ZOOM_STEP);
      return;
    }
    if (e.key === '0') {
      e.preventDefault();
      setZoom(1);
      return;
    }

    // Delete / Backspace: remove every selected caption.
    if (e.key === 'Delete' || e.key === 'Backspace') {
      if (selection.size === 0) return;
      e.preventDefault();
      deleteSelected();
      return;
    }

    // Escape: clear selection (also hides the inspector row).
    if (e.key === 'Escape') {
      if (selection.size === 0) return;
      e.preventDefault();
      clearSelection();
      renderTimelineBlocks();
      renderInspector();
      return;
    }
  });

  // =====================================================================
  // 5. Panel controls
  // =====================================================================

  // Segmented controls.
  function wireSeg(el, onChange) {
    el.addEventListener('click', e => {
      const btn = e.target.closest('.seg-item');
      if (!btn) return;
      el.querySelectorAll('.seg-item').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      onChange(btn.dataset.val);
    });
  }
  wireSeg($('#fontSeg'), v => {
    settings.fontFamily = v;
    applySettingsToRenderer();
    rebuildCaptions();
  });
  wireSeg($('#blendSeg'), v => {
    settings.blendMode = v;
    applySettingsToRenderer();
  });
  wireSeg($('#alignSeg'), v => {
    settings.alignment = v;
    rebuildCaptions();
  });

  // Range controls.
  function wireRange(id, labelId, fmt, onChange) {
    const el  = document.getElementById(id);
    const lab = document.getElementById(labelId);
    el.addEventListener('input', () => {
      const v = parseFloat(el.value);
      lab.textContent = fmt(v);
      onChange(v);
    });
  }

  wireRange('wordsRange', 'wordsVal', v => `${v}`, v => {
    settings.wordsPerCaption = v;
    // Regroup from the raw transcript — wipes any in-panel caption edits.
    rebuildGroups();
    rebuildCaptions();
  });

  wireRange('trackRange', 'trackVal', v => `${(v/1000).toFixed(3)}em`, v => {
    settings.trackingEm = v / 1000;
    applySettingsToRenderer();
    rebuildCaptions();
  });

  wireRange('wordGapRange', 'wordGapVal', v => `${(v/100).toFixed(2)}em`, v => {
    settings.wordGapEm = v / 100;
    rebuildCaptions();
  });

  wireRange('fpsRange', 'fpsVal', v => `${v}`, v => {
    settings.posterizeFps = v;
    applySettingsToRenderer();
  });

  wireRange('squashRange', 'squashVal', v => (v / 100).toFixed(2), v => {
    settings.squash = v / 100;
    applySettingsToRenderer();
  });

  wireRange('sizeRange', 'sizeVal', v => `${(v/100).toFixed(2)}×`, v => {
    settings.sizeScale = v / 100;
    rebuildCaptions();
  });

  // Safe-area controls.
  const toggleSafeBtn = document.getElementById('toggleSafeBtn');
  const resetSafeBtn  = document.getElementById('resetSafeBtn');
  const safeAreaEl    = document.getElementById('safeArea');
  let safeVisible = true;
  toggleSafeBtn.addEventListener('click', () => {
    safeVisible = !safeVisible;
    safeAreaEl.style.display = safeVisible ? '' : 'none';
    toggleSafeBtn.textContent = safeVisible ? 'hide box' : 'show box';
  });
  resetSafeBtn.addEventListener('click', () => {
    if (!safeAreaCtl) return;
    safeAreaCtl.set({ ...TA.layout.DEFAULT_SAFE_AREA });
  });

  resetBtn.addEventListener('click', () => {
    // Go back to dropzone.
    cancelAnimationFrame(rafId);
    rafId = 0;
    video.pause();
    video.removeAttribute('src');
    video.load();
    transcript = null;
    groups = null;
    captions = [];
    clearSelection();
    setZoom(1, { centerOnPlayhead: false });
    if (renderer) renderer.state.captions = [];
    renderTimeline();
    renderInspector();
    updateSplitGapUI();
    preview.classList.add('hidden');
    dropzone.classList.remove('hidden');
    exportBtn.disabled = true;
    setStatus('idle');
  });

  // =====================================================================
  // 6. Export (MediaRecorder → .webm)
  //    Captures the <canvas> + original audio track, writes a WebM file.
  // =====================================================================
  exportBtn.addEventListener('click', async () => {
    if (!transcript) return;

    setStatus('exporting…', true);
    exportBtn.disabled = true;

    // Rewind & play.
    video.currentTime = 0;
    video.muted = false;

    // Build a stream: video from canvas, audio captured from the <video>
    // element.  captureStream() on HTMLMediaElement returns its audio
    // track(s) in all current browsers.
    const canvasStream = canvas.captureStream(60);
    const mediaStream  = new MediaStream(canvasStream.getVideoTracks());
    try {
      const audioTracks = video.captureStream().getAudioTracks();
      audioTracks.forEach(t => mediaStream.addTrack(t));
    } catch (e) {
      console.warn('No audio capture available:', e);
    }

    // Pick the best codec Chrome/Safari both understand.
    const candidates = [
      'video/webm;codecs=vp9,opus',
      'video/webm;codecs=vp8,opus',
      'video/webm',
    ];
    const mimeType = candidates.find(c => MediaRecorder.isTypeSupported(c)) || 'video/webm';

    const chunks = [];
    const rec = new MediaRecorder(mediaStream, { mimeType, videoBitsPerSecond: 8_000_000 });
    rec.ondataavailable = e => { if (e.data && e.data.size) chunks.push(e.data); };

    const done = new Promise(res => rec.onstop = res);
    rec.start(200);

    await video.play();
    await new Promise(res => video.addEventListener('ended', res, { once: true }));
    rec.stop();
    await done;

    const blob = new Blob(chunks, { type: mimeType });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'typearrange.webm';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);

    setStatus('exported');
    exportBtn.disabled = false;
  });

  // =====================================================================
  // Done.
  // =====================================================================
  setStatus('idle');
})();
