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
   * @param {object} word     word entry from layout — must include `s`
   *                          (Whisper's spoken-start timestamp). The
   *                          word pops in *when it's actually spoken*,
   *                          not on a synthetic stagger from the caption
   *                          start, so "hey welcome to the show today"
   *                          doesn't splat all six words on screen in
   *                          the first 300 ms and then sit there.
   * @param {number} t        playback time (posterized)
   * @param {number} strength 0..1 — dials smear amount (affects
   *                          scale-based variants only)
   * @param {number} dirSeed  hash int — picks variant + direction
   * @param {boolean} boring  force the subtle 97→100% pop variant
   *                          (no translation, no smear) regardless of
   *                          dirSeed; used by "minimal animation"
   *                          captions.
   * @returns {{ alpha:number, tx:number, ty:number, scaleX:number, scaleY:number }}
   *   tx / ty are in *fractions of video width/height* respectively.
   */
  /** Resolve variant from the caption's preset. Motion uses the
   *  weighted random pool, minimal + typewriter + split override. */
  function variantForPreset(preset, dirSeed) {
    switch (preset) {
      case 'minimal':    return 'pop-subtle';
      case 'typewriter': return 'typewriter';
      case 'split': {
        // Words on the left slide in from the left, words on the right
        // from the right, leaning into the "text wraps around a centre
        // object" feel. We don't know left/right from inside animation,
        // so use dirSeed parity as a proxy — it's deterministic per word.
        return ((dirSeed >>> 0) & 1) ? 'slide-right' : 'slide-left';
      }
      default:
        return pickVariant(dirSeed);
    }
  }

  function transformAt(word, t, strength, dirSeed, boring = false) {
    const popStart = word.s;
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

    // Preset-driven variant wins; `boring` is kept as a back-compat alias
    // for minimal since earlier versions used it directly.
    const preset = word.preset || (boring ? 'minimal' : 'motion');
    const variant = variantForPreset(preset, dirSeed);

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
        const s = U.lerp(1, 0.95, remain * strength);
        scaleX = s;
        scaleY = s;
        break;
      }
      case 'pop-subtle': {
        // Minimal 97% → 100% pop. Intentionally ignores `strength`.
        const s = U.lerp(0.97, 1, u);
        scaleX = s;
        scaleY = s;
        break;
      }
      case 'typewriter': {
        // Snap-up from below with linear easing — the word enters with
        // a quick, mechanical feel rather than the braking smear of
        // the motion preset. Renderer clips ink progressively
        // left-to-right via word.preset === 'typewriter' for the full
        // "carriage return" flavour.
        const linearRemain = 1 - uRaw;
        ty = -OFFSET_Y_FRAC * 0.5 * linearRemain;
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

    // Typewriter passes back a reveal fraction so the renderer can clip
    // the word to show it growing left-to-right (like a cursor walking
    // across the word). Other variants don't need it.
    const revealFrac = variant === 'typewriter' ? uRaw : 1;

    return { alpha, tx, ty, scaleX, scaleY, revealFrac };
  }

  function captionActive(cap, t) {
    // No enter-lead now that words pop in at their spoken time —
    // showing a caption before the first word is spoken just means
    // putting words on screen before they're said.
    const enterLead = 0.0;
    const exitTail  = 0.05;
    return t >= cap.start - enterLead && t <= cap.end + exitTail;
  }

  /** Fade duration in seconds. Short by design — captions are now
   *  clamped in layout so end + FADE_OUT is always <= next.start,
   *  meaning the fade completes before the next caption's first word
   *  begins popping in. */
  const FADE_OUT = 0.06;

  function captionAlpha(cap, t) {
    if (t > cap.end) return U.clamp(1 - (t - cap.end) / FADE_OUT, 0, 1);
    return 1;
  }

  return { posterize, transformAt, captionActive, captionAlpha, FADE_OUT };
})();
