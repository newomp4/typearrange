/* layout.js — turn a flat list of whisper words into laid-out caption
 * "arrangements" of 4–7 words each.
 *
 * Coordinate system:
 *   x, y are fractions of the video's dimensions (0..1).
 *   font `size` is a fraction of video *height* (motion-graphics convention).
 *   We convert measured pixel widths into "fraction of width" using the
 *   known video aspect ratio at layout time, so captions scale cleanly to
 *   any resolution.
 *
 * The geometry is the interesting bit. Rather than a single horizontal line
 * we build a small stacked composition:
 *
 *   1. Words keep their reading order (so captions are readable).
 *   2. Each word gets a size factor based on its importance.
 *   3. Words flow into rows, wrapping when they'd exceed the row budget
 *      OR when a "hero" (large) word appears — heros get their own row.
 *   4. Each row picks an alignment from a per-caption preset so the
 *      arrangement feels intentional, not random.
 *   5. The whole stack gets centered in the frame with a small vertical
 *      jitter chosen from the same deterministic seed.
 */
'use strict';

TA.layout = (() => {
  const U = TA.utils;

  // ------------------------------------------------------------------
  // 1. Grouping: flat words → caption groups.
  // ------------------------------------------------------------------

  const HARD_BREAKS = /[.!?]$/;
  const SOFT_BREAKS = /[,;:]$/;

  function groupWords(words, targetWords) {
    const groups = [];
    let cur = [];

    const minWords = Math.max(3, targetWords - 1);
    const maxWords = Math.min(8, targetWords + 1);

    for (let i = 0; i < words.length; i++) {
      const w = words[i];
      cur.push(w);

      const gapToNext = (i + 1 < words.length) ? words[i + 1].s - w.e : Infinity;
      const hard = HARD_BREAKS.test(w.w);
      const soft = SOFT_BREAKS.test(w.w);
      const atMax = cur.length >= maxWords;
      const longPause = gapToNext > 0.55;
      const canBreak = cur.length >= minWords;

      if (atMax || (canBreak && (hard || longPause || (soft && cur.length >= targetWords)))) {
        groups.push(cur);
        cur = [];
      }
    }
    if (cur.length) groups.push(cur);
    return groups;
  }

  // ------------------------------------------------------------------
  // 2. Preset library.
  // ------------------------------------------------------------------
  const PRESETS = ['stack-center', 'stack-left', 'stack-right', 'stagger', 'pyramid'];
  const pickPreset = rand => PRESETS[Math.floor(rand() * PRESETS.length)];

  // ------------------------------------------------------------------
  // 3. Measurement (pixel-space, then normalize to width-fraction).
  // ------------------------------------------------------------------
  const _measureCanvas = document.createElement('canvas');
  const _mctx = _measureCanvas.getContext('2d');

  /** Measure the width of a word as a fraction of video width.
   *  @param sizeNH  font size in fraction of video height
   *  @param aspect  video width / video height
   */
  function measureWidthFrac(text, fontFamily, weight, italic, sizeNH, trackingEm, aspect) {
    const REF_H = 1000;
    const REF_W = REF_H * aspect;
    const px = sizeNH * REF_H;
    _mctx.font = `${italic ? 'italic ' : ''}${weight} ${px}px ${fontFamily}`;
    const metrics = _mctx.measureText(text);
    const trackingPx = trackingEm * px * Math.max(0, text.length - 1);
    return (metrics.width + trackingPx) / REF_W;
  }

  // ------------------------------------------------------------------
  // 4. Lay out a single caption.
  // ------------------------------------------------------------------

  function layoutCaption(group, opts, seedInt) {
    const { fontFamily, baseSize, tracking, maxRowWidthFrac, sizeScale, aspect } = opts;
    const rand = U.mulberry32(seedInt);
    const preset = pickPreset(rand);

    // 4a. Typography per word.
    const items = group.map(g => {
      const display = g.w.replace(/^[,]+/, '');
      const imp = U.importance(display);
      const weight = U.weightFor(imp);
      const italic = U.italicFor(imp);
      const sizeNH = baseSize * U.sizeFactorFor(imp) * sizeScale;
      const widthFrac = measureWidthFrac(display, fontFamily, weight, italic, sizeNH, tracking, aspect);
      return { w: display, s: g.s, e: g.e, imp, weight, italic, sizeNH, widthFrac };
    });

    // 4b. Flow into rows.  (widths are fractions-of-width;
    //                       heights/sizes are fractions-of-height.)
    const rows = [];
    let row = [];
    let rowWidth = 0;
    const HERO_SIZE = baseSize * 1.25 * sizeScale;

    for (const it of items) {
      const isHero = it.sizeNH >= HERO_SIZE;
      const wouldOverflow = rowWidth + it.widthFrac > maxRowWidthFrac;

      if (row.length && (isHero || wouldOverflow)) {
        rows.push(row);
        row = [];
        rowWidth = 0;
      }
      row.push(it);
      rowWidth += it.widthFrac;

      if (isHero) {
        rows.push(row);
        row = [];
        rowWidth = 0;
      }
    }
    if (row.length) rows.push(row);

    // 4c. Vertical stacking (tight leading, ~0.92 of largest size in row).
    const lineHeights = rows.map(r => Math.max(...r.map(w => w.sizeNH)) * 0.92);
    const totalH = lineHeights.reduce((a, b) => a + b, 0);

    const verticalBias = (rand() - 0.5) * 0.06;
    let y = 0.5 - totalH / 2 + verticalBias;

    // 4d. Horizontal placement per row per preset.
    const laidOutRows = rows.map((r, rowIdx) => {
      const rowW = r.reduce((a, b) => a + b.widthFrac, 0);
      const rowH = lineHeights[rowIdx];

      let xStart;
      switch (preset) {
        case 'stack-left':
          xStart = 0.5 - maxRowWidthFrac / 2;
          break;
        case 'stack-right':
          xStart = 0.5 + maxRowWidthFrac / 2 - rowW;
          break;
        case 'stagger':
          xStart = (rowIdx % 2 === 0)
            ? 0.5 - maxRowWidthFrac / 2 * 0.85
            : 0.5 + maxRowWidthFrac / 2 * 0.85 - rowW;
          break;
        case 'pyramid': {
          const offset = (rowIdx - (rows.length - 1) / 2) * 0.015;
          xStart = 0.5 - rowW / 2 + offset;
          break;
        }
        default: // 'stack-center'
          xStart = 0.5 - rowW / 2;
      }

      const baselineY = y + rowH * 0.82;

      let x = xStart;
      const placed = r.map(it => {
        const pos = { x, baselineY, item: it };
        x += it.widthFrac;
        return pos;
      });

      y += rowH;
      return { rowIdx, baselineY, height: rowH, words: placed };
    });

    // 4e. Timing + flat word list.
    const start = items[0].s;
    const end = items[items.length - 1].e;

    return {
      start,
      end,
      preset,
      rows: laidOutRows,
      words: laidOutRows.flatMap(r => r.words.map(p => ({
        x: p.x,
        yBaseline: p.baselineY,
        w: p.item.w,
        weight: p.item.weight,
        italic: p.item.italic,
        sizeNH: p.item.sizeNH,
        widthFrac: p.item.widthFrac,
        s: p.item.s,
        e: p.item.e,
      }))),
    };
  }

  // ------------------------------------------------------------------
  // 5. Entry point.
  // ------------------------------------------------------------------

  function buildCaptions(transcriptWords, settings) {
    if (!transcriptWords?.length) return [];
    const {
      fontFamily      = 'Arial',
      wordsPerCaption = 6,
      trackingEm      = -0.06,
      sizeScale       = 1.0,
      aspect          = 16 / 9,
    } = settings;

    const baseSize       = 0.09;   // fraction of video height
    const maxRowWidthFrac = 0.86;

    const groups = groupWords(transcriptWords, wordsPerCaption);

    return groups.map((g, i) => layoutCaption(g, {
      fontFamily,
      baseSize,
      tracking: trackingEm,
      maxRowWidthFrac,
      sizeScale,
      aspect,
    }, U.hash32(`${i}-${fontFamily}-${g[0]?.w || ''}`)));
  }

  return { buildCaptions, groupWords };
})();
