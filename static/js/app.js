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
    wordsPerCaption: 6,
    trackingEm:      -0.06,
    posterizeFps:    12,
    squash:          0.6,
    sizeScale:       1.0,
  };

  let transcript = null;     // { words, duration, video_url, language }
  let captions = [];
  let renderer = null;

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
    rebuildCaptions();
    startLoop();

    // Auto-play muted so captions animate in immediately.
    video.muted = true;
    try { await video.play(); } catch (_) {}
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

  function rebuildCaptions() {
    if (!transcript) return;
    const aspect = (video.videoWidth && video.videoHeight)
      ? video.videoWidth / video.videoHeight
      : 16 / 9;

    captions = L.buildCaptions(transcript.words, {
      fontFamily:      settings.fontFamily,
      wordsPerCaption: settings.wordsPerCaption,
      trackingEm:      settings.trackingEm,
      sizeScale:       settings.sizeScale,
      aspect,
    });
    if (renderer) renderer.state.captions = captions;
  }

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

  scrubber.addEventListener('click', e => {
    const rect = scrubber.getBoundingClientRect();
    const u = U.clamp((e.clientX - rect.left) / rect.width, 0, 1);
    if (isFinite(video.duration)) video.currentTime = u * video.duration;
  });

  // Keyboard: space = play/pause.
  document.addEventListener('keydown', e => {
    if (e.code === 'Space' && !['INPUT', 'BUTTON'].includes(document.activeElement?.tagName)) {
      e.preventDefault();
      if (!video.paused) video.pause(); else video.play();
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
    rebuildCaptions();
  });

  wireRange('trackRange', 'trackVal', v => `${(v/1000).toFixed(3)}em`, v => {
    settings.trackingEm = v / 1000;
    applySettingsToRenderer();
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

  resetBtn.addEventListener('click', () => {
    // Go back to dropzone.
    cancelAnimationFrame(rafId);
    rafId = 0;
    video.pause();
    video.removeAttribute('src');
    video.load();
    transcript = null;
    captions = [];
    if (renderer) renderer.state.captions = [];
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
