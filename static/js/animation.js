/* animation.js — time and transforms.
 *
 * Two ideas here:
 *
 *   (a) LOW-FPS POSTERIZATION
 *       Browser paints at 60fps but we snap the *time* we feed to the
 *       animation math to a coarser framerate. This gives the stepped,
 *       stop-motion / motion-graphic feel:
 *           t' = floor(t * fps) / fps
 *
 *   (b) ENTRANCE VARIANTS
 *       Each word picks one of several entrance styles deterministically
 *       from its dirSeed. Positional slides dominate (the word travels
 *       into its target from an offset with no scale), and scale-based
 *       styles — a subtle pop and the original x-smear — appear as
 *       flavour so no two consecutive words land the same way.
 *
 *       All variants share the same timing window: u goes 0→1 across
 *       POP_IN_DURATION using easeOutCirc (fast start, hard brake). The
 *       "remain" factor (1-u) is what each variant multiplies against
 *       its own offset/scale peaks so the word always settles at target.
 */
'use strict';

TA.animation = (() => {
  const U = TA.utils;

  /** Default animation tuning. */
  const POP_IN_DURATION    = 0.30;   // seconds total entrance→settle
  const STAGGER_PER_WORD   = 0.045;  // seconds between words in a caption

  /** Offset peaks (fractions of video width / height). */
  const OFFSET_X_FRAC      = 0.09;
  const OFFSET_Y_FRAC      = 0.055;

  /** Peak scale smear values at strength = 1.0. */
  const MAX_STRETCH        = 1.90;
  const MAX_SQUISH         = 0.70;

  /** Variant table: weighted so positional slides dominate and scale
   *  styles (pop / x-smear) are a flavour accent rather than the default.
   *  Weights don't need to sum to any particular total. */
  const VARIANTS = [
    { name: 'slide-left',  weight: 3 },
    { name: 'slide-right', weight: 3 },
    { name: 'slide-up',    weight: 2 },
    { name: 'slide-down',  weight: 2 },
    { name: 'pop',         weight: 2 },  // subtle 95% → 100%
    { name: 'smear-x',     weight: 1 },  // the original x-stretch smear
  ];
  const _VARIANT_TOTAL = VARIANTS.reduce((s, v) => s + v.weight, 0);

  function pickVariant(seed) {
    // Map the 32-bit seed to [0, total) deterministically.
    let r = ((seed >>> 0) / 0x100000000) * _VARIANT_TOTAL;
    for (const v of VARIANTS) {
      r -= v.weight;
      if (r <= 0) return v.name;
    }
    return VARIANTS[0].name;
  }

  /** Snap t to the posterized framerate. */
  function posterize(t, fps) {
    if (fps >= 60) return t;
    return Math.floor(t * fps) / fps;
  }

  /**
   * Compute per-word transform at time `t`.
   *
   * @param {object} word         word entry from layout
   * @param {number} captionStart caption's global start time
   * @param {number} wordIndex    index of this word within its caption
   * @param {number} t            playback time (posterized)
   * @param {number} strength     0..1 — dials smear amount (affects
   *                              scale-based variants only)
   * @param {number} dirSeed      hash int — picks variant + direction
   * @param {boolean} boring      force the subtle 97→100% pop variant
   *                              (no translation, no smear) regardless
   *                              of dirSeed; used by "minimal animation"
   *                              captions.
   * @returns {{ alpha:number, tx:number, ty:number, scaleX:number, scaleY:number }}
   *   tx / ty are in *fractions of video width/height* respectively.
   */
  function transformAt(word, captionStart, wordIndex, t, strength, dirSeed, boring = false) {
    const popStart = captionStart + wordIndex * STAGGER_PER_WORD;
    const popEnd   = popStart + POP_IN_DURATION;

    if (t < popStart) {
      return { alpha: 0, tx: 0, ty: 0, scaleX: 1, scaleY: 1 };
    }
    if (t >= popEnd) {
      return { alpha: 1, tx: 0, ty: 0, scaleX: 1, scaleY: 1 };
    }

    const uRaw = (t - popStart) / POP_IN_DURATION;
    const u = U.easing.outCirc(uRaw);
    const remain = 1 - u;

    const variant = boring ? 'pop-subtle' : pickVariant(dirSeed);

    let tx = 0, ty = 0, scaleX = 1, scaleY = 1;

    switch (variant) {
      case 'slide-left':
        tx = -OFFSET_X_FRAC * remain;
        break;
      case 'slide-right':
        tx =  OFFSET_X_FRAC * remain;
        break;
      case 'slide-up':
        ty = -OFFSET_Y_FRAC * remain;
        break;
      case 'slide-down':
        ty =  OFFSET_Y_FRAC * remain;
        break;
      case 'pop': {
        // Subtle 95% → 100% scale, no translation. Strength dials
        // intensity so the smear slider affects this variant too.
        const s = U.lerp(1, 0.95, remain * strength);
        scaleX = s;
        scaleY = s;
        break;
      }
      case 'pop-subtle': {
        // Minimal 97% → 100% pop. Intentionally ignores `strength` —
        // boring mode is the "calm" setting, so it should stay calm
        // even when the user has the smear slider cranked.
        const s = U.lerp(0.97, 1, u);
        scaleX = s;
        scaleY = s;
        break;
      }
      case 'smear-x': {
        const dir = ((dirSeed >>> 1) & 1) ? 1 : -1;
        tx = -dir * OFFSET_X_FRAC * remain;
        scaleX = U.lerp(1, MAX_STRETCH, remain * strength);
        scaleY = U.lerp(1, MAX_SQUISH,  remain * strength);
        break;
      }
    }

    const alpha = U.clamp(uRaw / 0.3, 0, 1);

    return { alpha, tx, ty, scaleX, scaleY };
  }

  function captionActive(cap, t) {
    const enterLead = 0.15;
    const exitTail  = 0.05;
    return t >= cap.start - enterLead && t <= cap.end + exitTail;
  }

  function captionAlpha(cap, t) {
    const fadeOut = 0.18;
    if (t > cap.end) return U.clamp(1 - (t - cap.end) / fadeOut, 0, 1);
    return 1;
  }

  return { posterize, transformAt, captionActive, captionAlpha };
})();
