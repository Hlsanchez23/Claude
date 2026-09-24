// Approximate Arial advance widths (1/1000 em) - enough to estimate label sizes
// for bounding boxes and fit checks without a font engine.
const REGULAR = {
  ' ': 278, '!': 278, '"': 355, '#': 556, '$': 556, '%': 889, '&': 667, "'": 191, '(': 333, ')': 333,
  '*': 389, '+': 584, ',': 278, '-': 333, '.': 278, '/': 278, ':': 278, ';': 278, '<': 584, '=': 584,
  '>': 584, '?': 556, '@': 1015, '[': 278, ']': 278, '_': 556, '|': 260, '\u00D7': 584,
  A: 667, B: 667, C: 722, D: 722, E: 667, F: 611, G: 778, H: 722, I: 278, J: 500, K: 667, L: 556, M: 833,
  N: 722, O: 778, P: 667, Q: 778, R: 722, S: 667, T: 611, U: 722, V: 667, W: 944, X: 667, Y: 667, Z: 611,
  a: 556, b: 556, c: 500, d: 556, e: 556, f: 278, g: 556, h: 556, i: 222, j: 222, k: 500, l: 222, m: 833,
  n: 556, o: 556, p: 556, q: 556, r: 333, s: 500, t: 278, u: 556, v: 500, w: 722, x: 500, y: 500, z: 500,
};
for (const d of '0123456789') REGULAR[d] = 556;

export const CAP_HEIGHT = 0.716;
export const DESCENT = 0.212;

export function textWidth(str, size, bold = false) {
  let w = 0;
  for (const ch of str) w += REGULAR[ch] ?? 600;
  return (w / 1000) * size * (bold ? 1.06 : 1);
}

// Bounding box [left, top, right, bottom] (y up, points) of point text whose
// first baseline is at anchor; paragraphs = [{ text, size, bold, justification }].
// Line spacing follows Illustrator's auto leading: 120% of the line's font size.
export function pointTextBounds(anchor, paragraphs) {
  const [ax, ay] = anchor;
  let left = Infinity, right = -Infinity, top = -Infinity, bottom = Infinity;
  let baseline = ay;
  paragraphs.forEach((p, i) => {
    if (i > 0) baseline -= 1.2 * p.size;
    const w = textWidth(p.text, p.size, p.bold);
    const x0 = p.justification.endsWith('CENTER') ? ax - w / 2 : p.justification.endsWith('RIGHT') ? ax - w : ax;
    left = Math.min(left, x0);
    right = Math.max(right, x0 + w);
    top = Math.max(top, baseline + CAP_HEIGHT * p.size);
    bottom = Math.min(bottom, baseline - DESCENT * p.size);
  });
  return [left, top, right, bottom];
}
