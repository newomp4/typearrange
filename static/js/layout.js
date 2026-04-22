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

  /** Measure a word's ink bounds in normalized fractions.
   *
   *  We use actualBoundingBoxLeft/Right — the *ink* extent — rather than
   *  `m.width` (the advance) so words hug their glyphs. Letters with
   *  generous side-bearings (capital letters, italics, bold weights) no
   *  longer leave dead air at the edges, and words with a lone descender
   *  (g/y/j) don't push neighbours further apart than their ink demands.
   *
   *  The caller positions the word by its ink-left edge (`x` = ink-left).
   *  At draw time the renderer adds `inkLeftFrac * W` to the fillText
   *  origin so the first glyph's left bearing lines up with `x`.
   */
  function measureGlyph(text, fontFamily, weight, italic, sizeNH, trackingEm, aspect) {
    const REF_H = 1000;
    const REF_W = REF_H * aspect;
    const px = sizeNH * REF_H;
    _mctx.font = `${italic ? 'italic ' : ''}${weight} ${px}px ${fontFamily}`;

    const m = _mctx.measureText(text);
    // Some browsers can return tiny negatives; clamp to 0.
    const inkLeft  = Math.max(0, m.actualBoundingBoxLeft  ?? 0);
    const inkRight = Math.max(0, m.actualBoundingBoxRight ?? m.width);
    const inkWidth = inkLeft + inkRight;

    // Letter-spacing is applied at draw time via ctx.letterSpacing, but
    // measureText on our offscreen ctx doesn't know about it. Internal
    // tracking adds len-1 gaps inside the word; first char's left bearing
    // and last char's right bearing are unaffected.
    const trackingPx = trackingEm * px * Math.max(0, text.length - 1);
    const widthFrac = (inkWidth + trackingPx) / REF_W;

    const ascent  = (m.actualBoundingBoxAscent  ?? px * 0.78) / REF_H;
    const descent = (m.actualBoundingBoxDescent ?? px * 0.22) / REF_H;

    return { widthFrac, ascent, descent, inkLeftFrac: inkLeft / REF_W };
  }

  // ------------------------------------------------------------------
  // 4. Lay out a single caption.
  // ------------------------------------------------------------------

  /** Word gap as a fraction of the caption's baseSize em.
   *  A normal printer's word-space is ~0.3em. We use ONE value per
   *  caption (not per-pair-max) so every gap in a row is the same
   *  distance — hero-scaled words used to inflate one gap while
   *  leaving the others normal, which read as uneven spacing. */
  function layoutCaption(group, opts, seedInt) {
    const {
      fontFamily, baseSize, tracking, maxRowWidthFrac, sizeScale, aspect,
      safeCX, safeCY, safeW, safeH, brandColors, wordGapEm, boring,
    } = opts;
    const rand = U.mulberry32(seedInt);
    const preset = boring ? 'stack-center' : pickPreset(rand);

    // Single consistent gap for this caption, in fractions of video width.
    const wordGap = wordGapEm * baseSize / aspect;

    // 4a. Per-word typography + measurement.
    //
    //     Boring mode intentionally bypasses the importance-driven weight
    //     and size variation — the whole point of "minimal animation" is
    //     a calm, uniform read-out, so every boring word gets the same
    //     mid-weight roman at a single size. Brand-bold still wins over
    //     boring (a flagged brand word should always be loud).
    const items = group.map(g => {
      const display = g.w.replace(/^[,]+/, '');
      const imp = U.importance(display);
      const key = U.stripPunct(display).toLowerCase();
      const brand = (brandColors && key) ? brandColors[key] : null;
      const forceBold = !!(brand && brand.bold);

      let weight, italic, sizeNH;
      if (forceBold) {
        weight = 900;
        italic = false;
        sizeNH = baseSize * (boring ? 1.1 : U.sizeFactorFor(imp)) * sizeScale;
      } else if (boring) {
        weight = 700;
        italic = false;
        sizeNH = baseSize * 1.1 * sizeScale;
      } else {
        weight = U.weightFor(imp);
        italic = U.italicFor(imp);
        sizeNH = baseSize * U.sizeFactorFor(imp) * sizeScale;
      }

      const { widthFrac, ascent, descent, inkLeftFrac } =
        measureGlyph(display, fontFamily, weight, italic, sizeNH, tracking, aspect);
      const color = brand?.color || null;
      return {
        w: display, s: g.s, e: g.e, imp, weight, italic, sizeNH,
        widthFrac, ascent, descent, inkLeftFrac, color,
      };
    });

    // 4b. Flow into rows. Account for the inter-word gap when deciding
    //     whether a word fits, otherwise the last word clips the safe-area.
    const rows = [];
    let row = [];
    let rowWidth = 0;
    const HERO_SIZE = baseSize * 1.25 * sizeScale;

    for (const it of items) {
      const isHero = it.sizeNH >= HERO_SIZE;
      const gap = row.length ? wordGap : 0;
      const wouldOverflow = rowWidth + gap + it.widthFrac > maxRowWidthFrac;

      if (row.length && (isHero || wouldOverflow)) {
        rows.push(row);
        row = [];
        rowWidth = 0;
      }
      const gapNow = row.length ? wordGap : 0;
      row.push(it);
      rowWidth += gapNow + it.widthFrac;

      if (isHero) {
        rows.push(row);
        row = [];
        rowWidth = 0;
      }
    }
    if (row.length) rows.push(row);

    // 4c. Per-row metrics + x-positions.
    //
    //     We compute x positions UP FRONT (before vertical stacking) so
    //     the clash pass in 4d can ask "do any of row N's ink columns
    //     overlap any of row N+1's ink columns?" — if not, the rows can
    //     tuck together far tighter than a generic ascent+descent gap
    //     would allow.
    const LEADING_FRAC_OF_EM = 0.04;
    const rowMetrics = rows.map(r => ({
      ascent:  Math.max(...r.map(w => w.ascent)),
      descent: Math.max(...r.map(w => w.descent)),
      emSize:  Math.max(...r.map(w => w.sizeNH)),
    }));

    const rowPlacements = rows.map((r, rowIdx) => {
      const rowW = r.reduce(
        (sum, w, i) => sum + w.widthFrac + (i > 0 ? wordGap : 0),
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
      return r.map((it, i) => {
        if (i > 0) x += wordGap;
        const pos = { x, widthFrac: it.widthFrac, ascent: it.ascent, descent: it.descent, item: it };
        x += it.widthFrac;
        return pos;
      });
    });

    // 4d. Clash-based vertical stacking.
    //
    //     For each pair of adjacent rows we check horizontal ink-column
    //     overlap between their words. Where there *is* overlap, we need
    //     `prev.descent + next.ascent` of vertical separation. Where the
    //     rows don't share any x-range, clash is 0 and the baselines can
    //     sit extremely close — producing the tight collage feel.
    function clashBetween(aWords, bWords) {
      let required = 0;
      for (const a of aWords) {
        const aL = a.x;
        const aR = a.x + a.widthFrac;
        for (const b of bWords) {
          const bL = b.x;
          const bR = b.x + b.widthFrac;
          if (Math.min(aR, bR) > Math.max(aL, bL)) {
            const need = a.descent + b.ascent;
            if (need > required) required = need;
          }
        }
      }
      return required;
    }

    // baseline[0] anchored at 0; we shift the whole stack to centre it
    // in the safe area at the end.
    const baselines = new Array(rows.length);
    baselines[0] = 0;
    for (let i = 1; i < rows.length; i++) {
      const clash = clashBetween(rowPlacements[i - 1], rowPlacements[i]);
      const leading = Math.max(rowMetrics[i - 1].emSize, rowMetrics[i].emSize) * LEADING_FRAC_OF_EM;
      // If rows don't overlap at all (clash === 0) still keep a touch of
      // airspace so baselines don't collide — scaled to em so it's
      // visually consistent across font sizes.
      const minGap = Math.max(rowMetrics[i - 1].emSize, rowMetrics[i].emSize) * 0.05;
      baselines[i] = baselines[i - 1] + Math.max(clash + leading, minGap);
    }

    // Total visual height spans the top-of-ink of row 0 to bottom-of-ink
    // of the last row.
    const totalH = baselines[rows.length - 1]
      + rowMetrics[rows.length - 1].descent
      + rowMetrics[0].ascent;

    // Vertical bias kept small so the group still reads as centred.
    const verticalBias = (rand() - 0.5) * 0.03 * safeH;

    const baselineShift = safeCY - totalH / 2 + rowMetrics[0].ascent + verticalBias;

    const laidOutRows = rows.map((r, rowIdx) => {
      const rm = rowMetrics[rowIdx];
      const baselineY = baselines[rowIdx] + baselineShift;
      const placed = rowPlacements[rowIdx].map(p => ({
        x: p.x,
        baselineY,
        ascent: p.ascent,
        descent: p.descent,
        item: p.item,
      }));
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
      boring: !!boring,
      words: laidOutRows.flatMap((r, ri) => r.words.map((p, wi) => ({
        x: p.x,
        yBaseline: p.baselineY,
        w: p.item.w,
        weight: p.item.weight,
        italic: p.item.italic,
        sizeNH: p.item.sizeNH,
        widthFrac: p.item.widthFrac,
        inkLeftFrac: p.item.inkLeftFrac || 0,
        ascent:  p.ascent,
        descent: p.descent,
        s: p.item.s,
        e: p.item.e,
        color: p.item.color,
        boring: !!boring,
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
   *  and call this whenever visual settings change.
   *
   *  Groups can carry:
   *    - `.boring = true` — each word in the group is expanded into its
   *      own 1-word caption (so only one word shows at a time), rendered
   *      with a minimal subtle-pop animation. Used for calmer moments
   *      that don't need the full motion-graphic smear.
   *    - length 0 — empty/new caption placeholder, filtered out.
   */
  function layoutCaptions(groups, settings) {
    if (!groups?.length) return [];
    const {
      fontFamily   = 'Arial',
      trackingEm   = -0.06,
      sizeScale    = 1.0,
      aspect       = 16 / 9,
      safeArea     = DEFAULT_SAFE_AREA,
      brandColors  = null,
      wordGapEm    = 0.33,
    } = settings;

    const safeW  = Math.max(0.1, safeArea.x1 - safeArea.x0);
    const safeH  = Math.max(0.1, safeArea.y1 - safeArea.y0);
    const safeCX = (safeArea.x0 + safeArea.x1) / 2;
    const safeCY = (safeArea.y0 + safeArea.y1) / 2;

    const baseSize = 0.09 * (safeH / 0.64);
    const maxRowWidthFrac = safeW * 0.98;

    // Expand boring groups into 1-word sub-groups; drop empties.
    const expanded = [];
    for (const g of groups) {
      if (!g || g.length === 0) continue;
      if (g.boring) {
        for (const w of g) {
          const single = [w];
          single.boring = true;
          expanded.push(single);
        }
      } else {
        expanded.push(g);
      }
    }

    return expanded.map((g, i) => layoutCaption(g, {
      fontFamily,
      baseSize,
      tracking: trackingEm,
      maxRowWidthFrac,
      sizeScale,
      aspect,
      safeCX, safeCY, safeW, safeH,
      brandColors,
      wordGapEm,
      boring: !!g.boring,
    }, U.hash32(`${i}-${fontFamily}-${g[0]?.w || ''}`)));
  }

  function buildCaptions(transcriptWords, settings) {
    if (!transcriptWords?.length) return [];
    const groups = groupWords(transcriptWords, settings.wordsPerCaption ?? 6);
    return layoutCaptions(groups, settings);
  }

  return { buildCaptions, layoutCaptions, groupWords, DEFAULT_SAFE_AREA };
})();
