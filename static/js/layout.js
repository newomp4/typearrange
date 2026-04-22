/* layout.js — turn a flat list of whisper words into laid-out caption
 * "arrangements" of 4–7 words each.
 *
 * Coordinate system:
 *   x, y are fractions of the video's dimensions (0..1).
 *   font `size` is a fraction of video *height*.
 *   Widths are *fractions of video width* (we convert using the aspect
 *   ratio at layout time).
 *
 * Row packing uses the glyphs' real ascent/descent returned by
 * Canvas2D.measureText, not the nominal em-size — that lets us pack rows
 * flush with a tiny leading gap without the tops of one row touching the
 * descenders of the row above.
 *
 * All text is centered inside an optional `safeArea` rectangle (also in
 * normalized fractions). If the UI hasn't set one, the default fills
 * most of the frame (7% margin all around).
 */
'use strict';

TA.layout = (() => {
  const U = TA.utils;

  // ------------------------------------------------------------------
  // 1. Grouping.
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
  // 2. Presets.
  // ------------------------------------------------------------------
  const PRESETS = ['stack-center', 'stack-left', 'stack-right', 'stagger', 'pyramid'];
  const pickPreset = rand => PRESETS[Math.floor(rand() * PRESETS.length)];

  // ------------------------------------------------------------------
  // 3. Measurement.
  // ------------------------------------------------------------------
  const _measureCanvas = document.createElement('canvas');
  const _mctx = _measureCanvas.getContext('2d');

  /** Measure width + glyph ascent/descent, all in normalized fractions. */
  function measureGlyph(text, fontFamily, weight, italic, sizeNH, trackingEm, aspect) {
    const REF_H = 1000;
    const REF_W = REF_H * aspect;
    const px = sizeNH * REF_H;
    _mctx.font = `${italic ? 'italic ' : ''}${weight} ${px}px ${fontFamily}`;

    const m = _mctx.measureText(text);
    const trackingPx = trackingEm * px * Math.max(0, text.length - 1);
    const widthFrac = (m.width + trackingPx) / REF_W;

    // actualBoundingBox* gives the ink-bounds of the rendered glyphs.
    // Fall back to approximations if the browser somehow doesn't expose them.
    const ascent  = (m.actualBoundingBoxAscent  ?? px * 0.78) / REF_H;
    const descent = (m.actualBoundingBoxDescent ?? px * 0.22) / REF_H;

    return { widthFrac, ascent, descent };
  }

  // ------------------------------------------------------------------
  // 4. Lay out a single caption.
  // ------------------------------------------------------------------

  /** Visual air between adjacent words on a row, as a fraction of the
   *  larger neighbour's em. A normal printer's word-space is ~0.3em; we
   *  skew a little wider (0.33) so the collage doesn't run together when
   *  bold and thin words sit beside each other. */
  const WORD_GAP_EM = 0.33;
  const wordGapFrac = (a, b, aspect) =>
    WORD_GAP_EM * Math.max(a.sizeNH, b.sizeNH) / aspect;

  function layoutCaption(group, opts, seedInt) {
    const {
      fontFamily, baseSize, tracking, maxRowWidthFrac, sizeScale, aspect,
      safeCX, safeCY, safeW, safeH, brandColors,
    } = opts;
    const rand = U.mulberry32(seedInt);
    const preset = pickPreset(rand);

    // 4a. Per-word typography + measurement.
    const items = group.map(g => {
      const display = g.w.replace(/^[,]+/, '');
      const imp = U.importance(display);
      const weight = U.weightFor(imp);
      const italic = U.italicFor(imp);
      const sizeNH = baseSize * U.sizeFactorFor(imp) * sizeScale;
      const { widthFrac, ascent, descent } =
        measureGlyph(display, fontFamily, weight, italic, sizeNH, tracking, aspect);
      // Brand colors match the bare, lowercased word — so "Robinhood," and
      // "robinhood" both hit the same entry in the map.
      const key = U.stripPunct(display).toLowerCase();
      const color = (brandColors && key && brandColors[key]) || null;
      return { w: display, s: g.s, e: g.e, imp, weight, italic, sizeNH, widthFrac, ascent, descent, color };
    });

    // 4b. Flow into rows. Account for the inter-word gap when deciding
    //     whether a word fits, otherwise the last word clips the safe-area.
    const rows = [];
    let row = [];
    let rowWidth = 0;
    const HERO_SIZE = baseSize * 1.25 * sizeScale;

    for (const it of items) {
      const isHero = it.sizeNH >= HERO_SIZE;
      const gap = row.length ? wordGapFrac(row[row.length - 1], it, aspect) : 0;
      const wouldOverflow = rowWidth + gap + it.widthFrac > maxRowWidthFrac;

      if (row.length && (isHero || wouldOverflow)) {
        rows.push(row);
        row = [];
        rowWidth = 0;
      }
      const gapNow = row.length ? wordGapFrac(row[row.length - 1], it, aspect) : 0;
      row.push(it);
      rowWidth += gapNow + it.widthFrac;

      if (isHero) {
        rows.push(row);
        row = [];
        rowWidth = 0;
      }
    }
    if (row.length) rows.push(row);

    // 4c. Per-row metrics using *actual* ascent/descent.
    //     With that we can use a very tight leading: the gap between the
    //     descenders of row N and the ascenders of row N+1 is just a
    //     small fraction of the em.
    const LEADING_FRAC_OF_EM = 0.04;   // ~4% of the row's em as airspace
    const rowMetrics = rows.map(r => ({
      ascent:  Math.max(...r.map(w => w.ascent)),
      descent: Math.max(...r.map(w => w.descent)),
      emSize:  Math.max(...r.map(w => w.sizeNH)),
    }));

    // Total height = sum of (ascent + descent) + leading between rows.
    let totalH = 0;
    rowMetrics.forEach((rm, i) => {
      totalH += rm.ascent + rm.descent;
      if (i < rowMetrics.length - 1) {
        totalH += Math.max(rowMetrics[i].emSize, rowMetrics[i + 1].emSize) * LEADING_FRAC_OF_EM;
      }
    });

    // Vertical bias kept small so words still look "centered" in the box.
    const verticalBias = (rand() - 0.5) * 0.03 * safeH;

    // Start baseline for row 0: top of the safe-area, plus first row's ascent.
    const topY = safeCY - totalH / 2 + verticalBias;
    let nextTop = topY;

    // 4d. Place rows.
    const laidOutRows = rows.map((r, rowIdx) => {
      const rm = rowMetrics[rowIdx];
      const baselineY = nextTop + rm.ascent;

      // Row width now includes the cumulative word-gap between neighbours.
      const rowW = r.reduce(
        (sum, w, i) => sum + w.widthFrac + (i > 0 ? wordGapFrac(r[i - 1], w, aspect) : 0),
        0,
      );
      let xStart;
      switch (preset) {
        case 'stack-left':
          xStart = safeCX - maxRowWidthFrac / 2;
          break;
        case 'stack-right':
          xStart = safeCX + maxRowWidthFrac / 2 - rowW;
          break;
        case 'stagger':
          xStart = (rowIdx % 2 === 0)
            ? safeCX - maxRowWidthFrac / 2 * 0.85
            : safeCX + maxRowWidthFrac / 2 * 0.85 - rowW;
          break;
        case 'pyramid': {
          const offset = (rowIdx - (rows.length - 1) / 2) * 0.012;
          xStart = safeCX - rowW / 2 + offset;
          break;
        }
        default: // 'stack-center'
          xStart = safeCX - rowW / 2;
      }

      let x = xStart;
      const placed = r.map((it, i) => {
        if (i > 0) x += wordGapFrac(r[i - 1], it, aspect);
        const pos = { x, baselineY, ascent: it.ascent, descent: it.descent, item: it };
        x += it.widthFrac;
        return pos;
      });

      // Advance to next row: this row's descent + leading.
      nextTop = baselineY + rm.descent;
      if (rowIdx < rows.length - 1) {
        nextTop += Math.max(rm.emSize, rowMetrics[rowIdx + 1].emSize) * LEADING_FRAC_OF_EM;
      }
      return { rowIdx, baselineY, height: rm.ascent + rm.descent, words: placed };
    });

    // 4e. Timing + flat word list with direction seeds.
    const start = items[0].s;
    const end = items[items.length - 1].e;

    return {
      start,
      end,
      preset,
      rows: laidOutRows,
      words: laidOutRows.flatMap((r, ri) => r.words.map((p, wi) => ({
        x: p.x,
        yBaseline: p.baselineY,
        w: p.item.w,
        weight: p.item.weight,
        italic: p.item.italic,
        sizeNH: p.item.sizeNH,
        widthFrac: p.item.widthFrac,
        ascent:  p.ascent,
        descent: p.descent,
        s: p.item.s,
        e: p.item.e,
        color: p.item.color,
        // Per-word direction seed: alternates by row, flipped per caption,
        // so within a caption words come from varied sides but it still
        // reads as intentional.
        dirSeed: (seedInt ^ (ri * 2654435761) ^ wi) >>> 0,
      }))),
    };
  }

  // ------------------------------------------------------------------
  // 5. Entry point.
  // ------------------------------------------------------------------

  const DEFAULT_SAFE_AREA = { x0: 0.08, y0: 0.18, x1: 0.92, y1: 0.82 };

  /** Lay out already-grouped captions. Split out from buildCaptions so
   *  the UI can hold its own mutable group list (for edited captions)
   *  and call this whenever visual settings change. */
  function layoutCaptions(groups, settings) {
    if (!groups?.length) return [];
    const {
      fontFamily   = 'Arial',
      trackingEm   = -0.06,
      sizeScale    = 1.0,
      aspect       = 16 / 9,
      safeArea     = DEFAULT_SAFE_AREA,
      brandColors  = null,
    } = settings;

    const safeW  = Math.max(0.1, safeArea.x1 - safeArea.x0);
    const safeH  = Math.max(0.1, safeArea.y1 - safeArea.y0);
    const safeCX = (safeArea.x0 + safeArea.x1) / 2;
    const safeCY = (safeArea.y0 + safeArea.y1) / 2;

    const baseSize = 0.09 * (safeH / 0.64);
    const maxRowWidthFrac = safeW * 0.98;

    return groups.map((g, i) => layoutCaption(g, {
      fontFamily,
      baseSize,
      tracking: trackingEm,
      maxRowWidthFrac,
      sizeScale,
      aspect,
      safeCX, safeCY, safeW, safeH,
      brandColors,
    }, U.hash32(`${i}-${fontFamily}-${g[0]?.w || ''}`)));
  }

  function buildCaptions(transcriptWords, settings) {
    if (!transcriptWords?.length) return [];
    const groups = groupWords(transcriptWords, settings.wordsPerCaption ?? 6);
    return layoutCaptions(groups, settings);
  }

  return { buildCaptions, layoutCaptions, groupWords, DEFAULT_SAFE_AREA };
})();
