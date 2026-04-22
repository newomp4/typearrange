/* animation.js — time and transforms.
 *
 * Two ideas here:
 *
 *   (a) LOW-FPS POSTERIZATION
 *       Real animation runs at 60fps in the browser, but we quantize time
 *       to a coarse framerate (e.g. 12fps) so the motion looks stop-motion
 *       / motion-graphic.  Done by snapping:
 *           t' = floor(t * fps) / fps
 *
 *   (b) SQUASH & STRETCH POP-IN
 *       A word's transform over its animation lifetime (~300ms from the
 *       caption start) goes:
 *           scaleX:  1.45  -> 0.90  -> 1.00
 *           scaleY:  0.55  -> 1.10  -> 1.00
 *       Squash first (wide & flat), overshoot thin & tall, settle.
 *       The amount is scaled by a user-controlled "strength" parameter.
 *
 * Per-word start is staggered by a small delay after the caption's start
 * time so words cascade in — but the stagger is itself quantized to the
 * posterize fps so it still reads as stepped.
 */
'use strict';

TA.animation = (() => {
  const U = TA.utils;

  /** Default animation tuning. */
  const POP_IN_DURATION    = 0.28;   // seconds
  const STAGGER_PER_WORD   = 0.04;   // seconds

  /**
   * Snap t to the posterized framerate.
   * @param {number} t    seconds
   * @param {number} fps  snapping framerate (4..30)
   */
  function posterize(t, fps) {
    if (fps >= 60) return t;
    return Math.floor(t * fps) / fps;
  }

  /**
   * Compute per-word transform at time `t`.
   *
   * @param {object} word        word entry from layout (has s, e)
   * @param {number} captionStart  the caption's global start time
   * @param {number} wordIndex   index of this word within its caption (for stagger)
   * @param {number} t           current playback time (seconds)
   * @param {number} strength    squash-and-stretch strength 0..1
   * @returns {{ alpha:number, scaleX:number, scaleY:number }}
   */
  function transformAt(word, captionStart, wordIndex, t, strength) {
    const popStart = captionStart + wordIndex * STAGGER_PER_WORD;
    const popEnd   = popStart + POP_IN_DURATION;

    if (t < popStart) {
      return { alpha: 0, scaleX: 1, scaleY: 1 };
    }

    if (t >= popEnd) {
      // Settled. (Exit anim is handled by alpha fade past word.e.)
      return { alpha: 1, scaleX: 1, scaleY: 1 };
    }

    // Normalize t into 0..1 across pop-in.
    const u = (t - popStart) / POP_IN_DURATION;

    // Split pop-in into two phases:
    //   0.00 .. 0.55  :  squash (wide/short) -> overshoot (narrow/tall)
    //   0.55 .. 1.00  :  overshoot -> settle
    let scaleX, scaleY;
    if (u < 0.55) {
      const k = u / 0.55;
      // squash (1.45, 0.55)  ->  overshoot (0.90, 1.10)
      scaleX = U.lerp(1.45, 0.90, U.easing.outCubic(k));
      scaleY = U.lerp(0.55, 1.10, U.easing.outCubic(k));
    } else {
      const k = (u - 0.55) / 0.45;
      scaleX = U.lerp(0.90, 1.00, U.easing.outBack(k));
      scaleY = U.lerp(1.10, 1.00, U.easing.outBack(k));
    }

    // Dial strength toward 1 (no squash).
    scaleX = U.lerp(1.0, scaleX, strength);
    scaleY = U.lerp(1.0, scaleY, strength);

    // Alpha fades in quickly, front-loaded.
    const alpha = U.clamp(u / 0.35, 0, 1);

    return { alpha, scaleX, scaleY };
  }

  /**
   * Is this caption visible at time t? (Covers pop-in lead-time + exit tail.)
   */
  function captionActive(cap, t) {
    const enterLead = 0.15;
    const exitTail  = 0.05;
    return t >= cap.start - enterLead && t <= cap.end + exitTail;
  }

  /** Compute caption-level alpha — fades out near the end. */
  function captionAlpha(cap, t) {
    const fadeOut = 0.18;
    if (t > cap.end) {
      return U.clamp(1 - (t - cap.end) / fadeOut, 0, 1);
    }
    return 1;
  }

  return { posterize, transformAt, captionActive, captionAlpha };
})();
