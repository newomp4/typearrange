/* renderer.js — draws the composited frame (video + animated captions).
 *
 * Each frame:
 *   1. Clear the canvas.
 *   2. Paint the current video frame via drawImage(video).
 *   3. For each caption currently active at time t, for each word:
 *        - apply the word's squash/stretch transform
 *        - set the chosen blend mode (e.g. 'difference')
 *        - fillText in white
 *      The blend mode is what inverts the video under the letters.
 *
 * We call this from a requestAnimationFrame loop but the *time* fed to the
 * animation module is posterized (snapped to low fps) to get the
 * motion-graphic chop.
 */
'use strict';

TA.renderer = (() => {
  const U = TA.utils;
  const A = TA.animation;

  /**
   * @param {HTMLCanvasElement} canvas
   * @param {HTMLVideoElement}  video
   */
  function create(canvas, video) {
    const ctx = canvas.getContext('2d', { alpha: false });

    // State that lives with this renderer instance.
    const state = {
      captions:      [],
      fontFamily:    'Arial',
      blendMode:     'difference',
      posterizeFps:  12,
      squash:        0.6,
      trackingEm:    -0.06,
      /** Optional extra debug drawing */
      showBounds:    false,
    };

    /** Size the canvas' drawing surface to the video's intrinsic dimensions
     *  and tell the wrapper element what aspect-ratio to maintain, so the
     *  safe-area overlay lines up with the visible canvas. */
    function syncSize() {
      if (!video.videoWidth || !video.videoHeight) return false;
      if (canvas.width === video.videoWidth && canvas.height === video.videoHeight) {
        return true;
      }
      canvas.width  = video.videoWidth;
      canvas.height = video.videoHeight;
      const wrap = canvas.parentElement;
      if (wrap) {
        wrap.style.aspectRatio = `${video.videoWidth} / ${video.videoHeight}`;
      }
      return true;
    }

    let _loggedOnce = false;

    /** Main draw function — call with the *display* time (can differ from video.currentTime during export/scrub). */
    function draw(displayTime) {
      if (!syncSize()) {
        // Give canvas some fallback size so the user sees *something*.
        if (!canvas.width) {
          canvas.width = 1280;
          canvas.height = 720;
        }
        ctx.fillStyle = '#111';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        return;
      }

      const W = canvas.width;
      const H = canvas.height;
      const t = A.posterize(displayTime, state.posterizeFps);

      if (!_loggedOnce) {
        _loggedOnce = true;
        console.log(
          '[renderer] first draw  W=' + W + '  H=' + H +
          '  captions=' + state.captions.length +
          '  videoReadyState=' + video.readyState +
          '  blend=' + state.blendMode +
          '  font=' + state.fontFamily
        );
        if (state.captions[0]) {
          const c0 = state.captions[0];
          console.log('[renderer] caption#0 words=' + c0.words.length + '  start=' + c0.start.toFixed(2) + '  end=' + c0.end.toFixed(2) + '  preset=' + c0.preset);
          console.log('[renderer] first word:', JSON.stringify(c0.words[0], null, 0));
        }
      }

      // 1. Paint the video.
      try {
        ctx.drawImage(video, 0, 0, W, H);
      } catch (e) {
        // Video may not be ready yet — draw black.
        ctx.fillStyle = '#000';
        ctx.fillRect(0, 0, W, H);
      }

      // 2. Find active captions and composite them.
      const active = state.captions.filter(cap => A.captionActive(cap, t));
      if (!active.length) return;

      // Set composite op once per draw pass (it resets via save/restore).
      // fillStyle is set per-word below so brand-coloured words can tint
      // through the same blend mode as white words.
      ctx.save();
      const op = state.blendMode === 'none' ? 'source-over' : state.blendMode;
      ctx.globalCompositeOperation = op;
      ctx.textBaseline = 'alphabetic';
      ctx.textAlign = 'left';

      // Enable letter-spacing via the newish Canvas API when available.
      // Falls back to the tracking baked into layout if unsupported.
      if ('letterSpacing' in ctx) {
        ctx.letterSpacing = `${state.trackingEm}em`;
      }

      for (const cap of active) {
        const capAlpha = A.captionAlpha(cap, t);
        if (capAlpha <= 0) continue;

        for (let i = 0; i < cap.words.length; i++) {
          const wd = cap.words[i];
          const { alpha, tx, ty, scaleX, scaleY } =
            A.transformAt(wd, cap.start, i, t, state.squash, wd.dirSeed || i);
          if (alpha <= 0) continue;

          const fontPx = wd.sizeNH * H;
          const x  = wd.x * W;
          const y  = wd.yBaseline * H;
          const wPx = wd.widthFrac * W;

          // Pivot at the word's visual center (for the stretch) and add
          // the animation offset (which is in normalized width/height).
          const cx   = x + wPx / 2;
          const cy   = y - fontPx * 0.4;
          const txPx = tx * W;
          const tyPx = ty * H;

          ctx.save();
          ctx.globalAlpha = alpha * capAlpha;
          ctx.fillStyle = wd.color || '#ffffff';

          // Order: translate(pivot + offset) → scale → translate(-pivot) →
          // fillText at (x, y). Result: pure translation by (tx, ty) plus
          // a stretch around the pivot.
          ctx.translate(cx + txPx, cy + tyPx);
          ctx.scale(scaleX, scaleY);
          ctx.translate(-cx, -cy);

          ctx.font = `${wd.italic ? 'italic ' : ''}${wd.weight} ${fontPx}px ${state.fontFamily}, "Helvetica Neue", sans-serif`;
          ctx.fillText(wd.w, x, y);
          ctx.restore();

          if (state.showBounds) {
            ctx.save();
            ctx.globalCompositeOperation = 'source-over';
            ctx.strokeStyle = 'rgba(255,0,255,0.5)';
            ctx.lineWidth = 1;
            ctx.strokeRect(x, y - fontPx * 0.8, wPx, fontPx);
            ctx.restore();
          }
        }
      }

      ctx.restore();
    }

    return {
      state,
      draw,
      syncSize,
      /** Convenience setter. */
      set(patch) { Object.assign(state, patch); },
    };
  }

  return { create };
})();
