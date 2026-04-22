/* safearea.js — draggable rectangle that constrains where captions go.
 *
 * The rectangle is stored in *normalized video fractions* (0..1 for both
 * x and y).  Corner handles let you resize from any corner; edge hotspots
 * let you drag a single side.  Values snap to a fixed set of guide lines
 * (thirds / halves / edges) when you drag within ~2% of them, which makes
 * it easy to line up common compositions.
 *
 * Usage:
 *     const sa = TA.safeArea.attach(canvasWrapEl, boxEl, onChange)
 *     sa.get() // => {x0, y0, x1, y1}
 *     sa.set({x0, y0, x1, y1})
 */
'use strict';

TA.safeArea = (() => {
  const U = TA.utils;

  const SNAP_POINTS = [0, 1/3, 0.5, 2/3, 1];
  const SNAP_THRESHOLD = 0.02;
  const MIN_SIZE = 0.15;   // can't shrink below 15% of a dimension

  function snap(value) {
    for (const p of SNAP_POINTS) {
      if (Math.abs(value - p) < SNAP_THRESHOLD) return p;
    }
    return value;
  }

  /** Attach drag behaviour to `box` inside `wrap`. */
  function attach(wrap, box, onChange) {
    const state = { x0: 0.08, y0: 0.18, x1: 0.92, y1: 0.82 };

    function render() {
      box.style.left   = (state.x0 * 100).toFixed(3) + '%';
      box.style.top    = (state.y0 * 100).toFixed(3) + '%';
      box.style.width  = ((state.x1 - state.x0) * 100).toFixed(3) + '%';
      box.style.height = ((state.y1 - state.y0) * 100).toFixed(3) + '%';
    }

    function pointerToFrac(evt) {
      const rect = wrap.getBoundingClientRect();
      return {
        x: U.clamp((evt.clientX - rect.left) / rect.width,  0, 1),
        y: U.clamp((evt.clientY - rect.top)  / rect.height, 0, 1),
      };
    }

    function beginDrag(handleTarget) {
      const corner = handleTarget.dataset.corner;
      const edge   = handleTarget.dataset.edge;
      const startState = { ...state };

      function onMove(evt) {
        const { x, y } = pointerToFrac(evt);

        // Apply to the correct edges of the rect.
        let x0 = startState.x0, y0 = startState.y0;
        let x1 = startState.x1, y1 = startState.y1;

        if (corner === 'tl')      { x0 = snap(x); y0 = snap(y); }
        else if (corner === 'tr') { x1 = snap(x); y0 = snap(y); }
        else if (corner === 'bl') { x0 = snap(x); y1 = snap(y); }
        else if (corner === 'br') { x1 = snap(x); y1 = snap(y); }
        else if (edge === 't')    { y0 = snap(y); }
        else if (edge === 'b')    { y1 = snap(y); }
        else if (edge === 'l')    { x0 = snap(x); }
        else if (edge === 'r')    { x1 = snap(x); }

        // Enforce min size and that x0 < x1, y0 < y1.
        if (x1 - x0 < MIN_SIZE) {
          if (corner?.includes('l') || edge === 'l') x0 = x1 - MIN_SIZE;
          else x1 = x0 + MIN_SIZE;
        }
        if (y1 - y0 < MIN_SIZE) {
          if (corner?.startsWith('t') || edge === 't') y0 = y1 - MIN_SIZE;
          else y1 = y0 + MIN_SIZE;
        }

        state.x0 = U.clamp(x0, 0, 1);
        state.y0 = U.clamp(y0, 0, 1);
        state.x1 = U.clamp(x1, 0, 1);
        state.y1 = U.clamp(y1, 0, 1);

        render();
        onChange({ ...state });
      }

      function onUp() {
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        document.body.style.userSelect = '';
      }

      document.body.style.userSelect = 'none';
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
    }

    box.addEventListener('pointerdown', evt => {
      const t = evt.target;
      if (t.matches('.handle') || t.matches('.edge')) {
        evt.preventDefault();
        evt.stopPropagation();
        beginDrag(t);
      }
    });

    render();

    return {
      get: () => ({ ...state }),
      set: (next) => { Object.assign(state, next); render(); onChange({ ...state }); },
      render,
    };
  }

  return { attach };
})();
