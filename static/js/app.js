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
  const scrubber    = $('#scrubber');
  const scrubberFill = $('#scrubberFill');
  const timeLabel   = $('#timeLabel');
  const exportBtn   = $('#exportBtn');
  const resetBtn    = $('#resetBtn');

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
    renderCaptionList();
  }

  /** Re-lay out the held groups with current visual settings. */
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
      brandColors:     settings.brandColors,
      alignment:       settings.alignment,
    });
    if (renderer) renderer.state.captions = captions;
  }

  // =====================================================================
  // Caption editor (sidebar)
  //   Each Whisper-grouped caption becomes one editable row. Editing the
  //   text preserves the caption's original [start, end] span and
  //   redistributes timing evenly across the new word list — so the
  //   user can fix transcription mistakes without the audio drifting.
  // =====================================================================
  const captionListEl = document.getElementById('captionList');

  function renderCaptionList() {
    captionListEl.innerHTML = '';
    if (!groups || !groups.length) {
      const empty = document.createElement('div');
      empty.className = 'caption-empty';
      empty.textContent = 'drop a video to edit captions';
      captionListEl.appendChild(empty);
      return;
    }
    groups.forEach((g, i) => {
      const row = document.createElement('div');
      row.className = 'cap-row';
      row.dataset.idx = i;

      const time = document.createElement('span');
      time.className = 'cap-time';
      // Empty (newly-inserted) rows fall back to _start so the user can
      // see when the caption will play before typing anything.
      const startSec = g[0]?.s ?? g._start ?? 0;
      time.textContent = U.fmtTime(startSec);
      time.title = 'seek here';
      time.addEventListener('click', () => {
        if (!isFinite(video.duration)) return;
        video.currentTime = Math.max(0, startSec);
        if (video.paused) video.play().catch(() => {});
      });

      const input = document.createElement('input');
      input.type = 'text';
      input.className = 'cap-text';
      input.value = g.map(w => w.w).join(' ');
      input.placeholder = g.length ? '' : 'new caption…';
      input.spellcheck = false;
      const commit = () => {
        const current = g.map(w => w.w).join(' ');
        if (input.value !== current) updateCaptionText(i, input.value);
      };
      input.addEventListener('blur', commit);
      input.addEventListener('keydown', e => {
        if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
      });

      // "min" — toggle boring mode on this caption.
      const minBtn = document.createElement('button');
      minBtn.className = 'cap-btn cap-min' + (g.boring ? ' active' : '');
      minBtn.textContent = 'min';
      minBtn.title = 'minimal animation (1 word at a time)';
      minBtn.setAttribute('aria-pressed', g.boring ? 'true' : 'false');
      minBtn.addEventListener('click', () => {
        g.boring = !g.boring;
        minBtn.classList.toggle('active', !!g.boring);
        minBtn.setAttribute('aria-pressed', g.boring ? 'true' : 'false');
        rebuildCaptions();
      });

      // "+" — insert a new empty caption after this one.
      const addBtn = document.createElement('button');
      addBtn.className = 'cap-btn cap-add';
      addBtn.textContent = '+';
      addBtn.title = 'insert caption after';
      addBtn.addEventListener('click', () => insertCaptionAfter(i));

      // "×" — delete this caption.
      const delBtn = document.createElement('button');
      delBtn.className = 'cap-btn cap-del';
      delBtn.textContent = '×';
      delBtn.title = 'delete caption';
      delBtn.addEventListener('click', () => deleteCaption(i));

      row.appendChild(time);
      row.appendChild(input);
      row.appendChild(minBtn);
      row.appendChild(addBtn);
      row.appendChild(delBtn);
      captionListEl.appendChild(row);
    });
  }

  /** Derive [start, end] for a group — uses words if present, else the
   *  sentinel _start/_end set at insert-time. */
  function groupSpan(g) {
    if (g.length) {
      return { start: g[0].s, end: g[g.length - 1].e };
    }
    return { start: g._start ?? 0, end: g._end ?? (g._start ?? 0) + 0.5 };
  }

  function updateCaptionText(idx, text) {
    const original = groups[idx];
    if (!original) return;
    const { start, end } = groupSpan(original);
    const span = Math.max(0.1, end - start);
    const wordList = text.trim().split(/\s+/).filter(Boolean);
    if (!wordList.length) {
      // Empty input on a non-empty group — ignore (restore visible state).
      // Empty input on an already-empty group — leave the row alone so
      // the user can still type into it later.
      renderCaptionList();
      return;
    }
    const perWord = span / wordList.length;
    const next = wordList.map((w, i) => ({
      w,
      s: start + i * perWord,
      e: start + (i + 1) * perWord,
    }));
    // Preserve per-group metadata (boring flag, etc.).
    next.boring = !!original.boring;
    groups[idx] = next;
    rebuildCaptions();
  }

  function insertCaptionAfter(idx) {
    if (!groups) return;
    const current = groups[idx];
    const next    = groups[idx + 1];
    const currentEnd = current?.length ? current[current.length - 1].e : (current?._end ?? 0);
    const nextStart  = next?.length    ? next[0].s                     : (next?._start    ?? currentEnd + 1.5);
    const gap = Math.max(0.2, nextStart - currentEnd);
    // Slot the new caption into the middle 40% of the gap so it doesn't
    // butt right against its neighbours.
    const newStart = currentEnd + gap * 0.30;
    const newEnd   = currentEnd + gap * 0.70;
    const empty = [];
    empty._start = newStart;
    empty._end   = newEnd;
    empty.boring = false;
    groups.splice(idx + 1, 0, empty);
    renderCaptionList();
    // Focus the new row's input so the user can start typing immediately.
    const rows = captionListEl.querySelectorAll('.cap-row');
    rows[idx + 1]?.querySelector('.cap-text')?.focus();
    rebuildCaptions();
  }

  function deleteCaption(idx) {
    if (!groups || !groups[idx]) return;
    groups.splice(idx, 1);
    renderCaptionList();
    rebuildCaptions();
  }

  /** "+ add caption" footer — appends at end of timeline, 0.5s after the
   *  last caption or at 0 if none yet. */
  document.getElementById('captionAppend').addEventListener('click', () => {
    if (!groups) {
      // No transcript yet — nothing to append onto.
      return;
    }
    const last = groups[groups.length - 1];
    const lastEnd = last?.length
      ? last[last.length - 1].e
      : (last?._end ?? 0);
    const empty = [];
    empty._start = lastEnd + 0.3;
    empty._end   = lastEnd + 1.2;
    empty.boring = false;
    groups.push(empty);
    renderCaptionList();
    const rows = captionListEl.querySelectorAll('.cap-row');
    rows[rows.length - 1]?.querySelector('.cap-text')?.focus();
    rebuildCaptions();
  });

  /** Highlight the caption currently playing. Called from the render
   *  loop; kept cheap (linear scan, early-out on the first match). */
  let _lastActiveIdx = -2;
  function updateActiveCaption() {
    if (!groups || !groups.length) return;
    const t = video.currentTime;
    let active = -1;
    for (let i = 0; i < groups.length; i++) {
      const g = groups[i];
      const start = g.length ? g[0].s : (g._start ?? Infinity);
      const end   = g.length ? g[g.length - 1].e : (g._end ?? -Infinity);
      if (t >= start && t <= end) { active = i; break; }
    }
    if (active === _lastActiveIdx) return;
    _lastActiveIdx = active;
    const rows = captionListEl.querySelectorAll('.cap-row');
    rows.forEach((r, i) => r.classList.toggle('cap-active', i === active));
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
      updateActiveCaption();
      rafId = requestAnimationFrame(tick);
    };
    rafId = requestAnimationFrame(tick);
  }

  function updateTransport() {
    const dur = isFinite(video.duration) ? video.duration : 0;
    const cur = video.currentTime;
    if (dur > 0) {
      scrubberFill.style.width = `${(cur / dur) * 100}%`;
    }
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

  scrubber.addEventListener('click', e => {
    const rect = scrubber.getBoundingClientRect();
    const u = U.clamp((e.clientX - rect.left) / rect.width, 0, 1);
    if (isFinite(video.duration)) video.currentTime = u * video.duration;
  });

  // Keyboard shortcuts — all suppressed when focus is in an input /
  // button / textarea so we don't hijack typing or native button activation.
  document.addEventListener('keydown', e => {
    const tag = document.activeElement?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'BUTTON') return;

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
    if (renderer) renderer.state.captions = [];
    renderCaptionList();
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
