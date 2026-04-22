/* utils.js — small pure helpers shared by layout, animation, renderer.
 *
 * Everything here is side-effect free. No DOM access.
 */
'use strict';

const TA = window.TA || (window.TA = {});
TA.utils = (() => {

  /** Common English stopwords we downgrade to thin/italic. */
  const STOPWORDS = new Set([
    'a','an','the','and','or','but','if','so','as','of','to','in','on','at',
    'by','for','with','from','into','onto','about','up','down','out','over',
    'is','are','was','were','be','been','being','am','do','does','did',
    'have','has','had','will','would','can','could','should','may','might',
    'i','me','my','we','our','you','your','he','his','she','her','it','its',
    'they','them','their','this','that','these','those','there','here',
    'not','no','yes','just','now','then','than','too','very','also',
    "don't","doesn't","didn't","won't","can't","it's","that's","i'm","you're",
    "we're","they're","i've","you've","we've","they've","i'll","you'll",
  ]);

  /** Punctuation that signals emphasis. */
  const EMPHATIC_ENDS = ['!', '?'];

  /** Strip leading/trailing punctuation for classification while keeping the display form. */
  function stripPunct(w) {
    return w.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
  }

  /**
   * Score a word's "importance" from -3 (filler) to +3 (hero).
   * Maps later onto a font weight.
   */
  function importance(raw) {
    const display = raw;
    const bare = stripPunct(raw).toLowerCase();

    let score = 0;
    const len = bare.length;

    if (STOPWORDS.has(bare))            score -= 2;
    if (len <= 2)                       score -= 1;
    else if (len >= 7)                  score += 1;
    else if (len >= 5)                  score += 0.5;

    // ALL CAPS or contains an emphatic punctuation
    if (display === display.toUpperCase() && /[A-Z]/.test(display)) score += 2;
    if (EMPHATIC_ENDS.some(c => display.endsWith(c))) score += 1.5;

    // Numbers feel important visually
    if (/\d/.test(bare)) score += 1;

    return Math.max(-3, Math.min(3, score));
  }

  /** Map importance to a CSS font weight (100–900). */
  function weightFor(imp) {
    if (imp >= 2)   return 900;  // black
    if (imp >= 1)   return 800;
    if (imp >= 0.5) return 700;
    if (imp >= 0)   return 500;
    if (imp >= -1)  return 400;
    if (imp >= -2)  return 300;
    return 200;                  // thin
  }

  /** Italic for low-importance fillers — a subtle contrast. */
  function italicFor(imp) {
    return imp <= -1.5;
  }

  /** Relative type size factor per word. */
  function sizeFactorFor(imp) {
    // importance range -3..+3  ->  size factor 0.55..1.6
    const t = (imp + 3) / 6;
    return 0.55 + t * (1.6 - 0.55);
  }

  /** Deterministic PRNG (mulberry32) so layouts are reproducible per caption. */
  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /** Hash a string into a 32-bit int for seeding. */
  function hash32(str) {
    let h = 2166136261 >>> 0;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return h >>> 0;
  }

  /** Easings. Back-out gives the overshoot we use for squash/stretch settle. */
  const easing = {
    outCubic:  t => 1 - Math.pow(1 - t, 3),
    outBack:   (t, s = 1.70158) => 1 + (s + 1) * Math.pow(t - 1, 3) + s * Math.pow(t - 1, 2),
    outQuint:  t => 1 - Math.pow(1 - t, 5),
    // Circ-out: very fast start, rapid deceleration into the end.
    // The exact feel the user wanted for the smear-to-settle transition.
    outCirc:   t => Math.sqrt(1 - (t - 1) * (t - 1)),
  };

  function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
  function lerp(a, b, t)    { return a + (b - a) * t; }

  /** Format seconds → "m:ss". */
  function fmtTime(s) {
    if (!isFinite(s) || s < 0) s = 0;
    const m = Math.floor(s / 60);
    const ss = Math.floor(s % 60).toString().padStart(2, '0');
    return `${m}:${ss}`;
  }

  return {
    STOPWORDS,
    stripPunct,
    importance,
    weightFor,
    italicFor,
    sizeFactorFor,
    mulberry32,
    hash32,
    easing,
    clamp,
    lerp,
    fmtTime,
  };
})();
