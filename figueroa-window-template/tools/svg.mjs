// Writes a document recorded by illustrator-mock.mjs as an SVG that Illustrator
// opens directly: 1 SVG unit = 1 pt, each Illustrator layer becomes a named
// group, and the object names become ids.
import { colorToHex, walk, itemBounds } from './illustrator-mock.mjs';

const n = (v) => String(Math.round(v * 1000) / 1000);

const escapeXml = (s) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export function documentToSvg(doc, { title, description, margin = 72, bleedColor = '#ed1c24' } = {}) {
  // Page = everything drawn, the artboard with its bleed, plus a margin
  const box = [Infinity, -Infinity, -Infinity, Infinity];
  const grow = (b) => {
    box[0] = Math.min(box[0], b[0]);
    box[1] = Math.max(box[1], b[1]);
    box[2] = Math.max(box[2], b[2]);
    box[3] = Math.min(box[3], b[3]);
  };
  for (const layer of doc.layers) walk(layer, (item) => item.kind !== 'group' && grow(itemBounds(item)));
  const ab = doc.artboards[0].rect;
  const [bl, bt, br, bb] = doc.bleed; // same on all sides here, order does not matter
  const bleedBox = [ab[0] - bl, ab[1] + bt, ab[2] + br, ab[3] - bb];
  grow(bleedBox);
  const [left, top, right, bottom] = [box[0] - margin, box[1] + margin, box[2] + margin, box[3] - margin];
  const width = right - left;
  const height = top - bottom;
  const X = (x) => n(x - left);
  const Y = (y) => n(top - y);

  const used = new Map();
  const id = (name) => {
    let base = String(name).trim().replace(/[^A-Za-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '') || 'item';
    if (!/^[A-Za-z_]/.test(base)) base = `_${base}`;
    const count = (used.get(base) || 0) + 1;
    used.set(base, count);
    return count === 1 ? base : `${base}_${count}`;
  };

  const out = [];
  const emit = (depth, s) => out.push('  '.repeat(depth) + s);

  function item(it, depth) {
    const idAttr = it.name ? ` id="${id(it.name)}"` : '';
    if (it.kind === 'group') {
      emit(depth, `<g${idAttr}>`);
      it.items.forEach((child) => item(child, depth + 1));
      emit(depth, '</g>');
    } else if (it.kind === 'rect') {
      const fill = it.filled ? colorToHex(it.fillColor) : 'none';
      let stroke = '';
      if (it.stroked) {
        stroke = ` stroke="${colorToHex(it.strokeColor)}" stroke-width="${n(it.strokeWidth)}"`;
        if (it.strokeDashes.length) stroke += ` stroke-dasharray="${it.strokeDashes.map(n).join(' ')}"`;
      }
      emit(depth, `<rect${idAttr} x="${X(it.left)}" y="${Y(it.top)}" width="${n(it.width)}" height="${n(it.height)}" fill="${fill}"${stroke}/>`);
    } else if (it.kind === 'text') {
      // One tspan per paragraph; auto leading = 120% of the font size
      let baseline = it.anchor[1];
      const spans = it.paragraphs.map((p, i) => {
        if (i > 0) baseline -= 1.2 * p.size;
        const anchor = p.justification.endsWith('CENTER') ? 'middle' : p.justification.endsWith('RIGHT') ? 'end' : 'start';
        const weight = /bold/i.test(p.font) ? ' font-weight="bold"' : '';
        return `<tspan x="${X(it.anchor[0])}" y="${Y(baseline)}" font-size="${n(p.size)}"${weight} text-anchor="${anchor}" fill="${colorToHex(p.fillColor)}">${escapeXml(p.text)}</tspan>`;
      });
      emit(depth, `<text${idAttr} font-family="Arial, Helvetica, sans-serif">${spans.join('')}</text>`);
    }
  }

  out.push('<?xml version="1.0" encoding="UTF-8"?>');
  out.push(`<svg xmlns="http://www.w3.org/2000/svg" version="1.1" width="${n(width / 72)}in" height="${n(height / 72)}in" viewBox="0 0 ${n(width)} ${n(height)}">`);
  if (title) emit(1, `<title>${escapeXml(title)}</title>`);
  if (description) emit(1, `<desc>${escapeXml(description)}</desc>`);
  // Layers bottom to top (doc.layers[0] is the top layer in Illustrator)
  for (const layer of [...doc.layers].reverse()) {
    emit(1, `<g id="${id(layer.name)}">`);
    layer.items.forEach((it) => item(it, 2));
    emit(1, '</g>');
  }
  // Illustrator draws the document bleed itself; in the SVG it is a red line
  emit(1, `<g id="${id('BLEED')}">`);
  emit(2, `<rect id="${id('Bleed line')}" x="${X(bleedBox[0])}" y="${Y(bleedBox[1])}" width="${n(bleedBox[2] - bleedBox[0])}" height="${n(bleedBox[1] - bleedBox[3])}" fill="none" stroke="${bleedColor}" stroke-width="1"/>`);
  emit(1, '</g>');
  out.push('</svg>');
  return { svg: out.join('\n') + '\n', page: { left, top, right, bottom, width, height } };
}
