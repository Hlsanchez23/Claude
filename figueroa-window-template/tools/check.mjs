#!/usr/bin/env node
// Verifies the Illustrator script and the generated files:
//
//   node tools/check.mjs
//
// Runs Figueroa-Windows-Template.jsx in an ES3 sandbox against the strict mock
// Illustrator (tools/illustrator-mock.mjs) and checks the drawing it makes.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { readMeasurements, dataBlock, replaceDataBlock, runTemplate, plain } from './template-runner.mjs';
import { walk, itemBounds, offCanvas } from './illustrator-mock.mjs';
import { JSX, SCHEDULE, DEFAULT_CSV, svgPath, render } from './build.mjs';

const source = fs.readFileSync(JSX, 'utf8');
let failures = 0;
function check(name, fn) {
  try {
    fn();
    console.log(`ok    ${name}`);
  } catch (e) {
    failures++;
    console.log(`FAIL  ${name}\n      ${String(e.message).split('\n').join('\n      ')}`);
  }
}
const close = (a, b, what, tol = 1e-6) => assert.ok(Math.abs(a - b) <= tol, `${what}: ${a} != ${b}`);

// Change one SETTINGS value in the script source
function withSetting(src, key, value) {
  const re = new RegExp(`(\\n\\s+${key}: )[^,\\s]+`);
  assert.ok(re.test(src), `setting ${key} not found`);
  return src.replace(re, `$1${value}`);
}

// Rectangles of one layer, keyed by name, relative to artboard 1 (points, y down)
function rectsOf(doc, layerName) {
  const layer = doc.layers.find((l) => l.name === layerName);
  assert.ok(layer, `layer ${layerName} missing`);
  const [ox, oy] = doc.artboards[0].rect;
  const out = [];
  walk(layer, (it) => {
    if (it.kind === 'rect') out.push({ name: it.name, x: it.left - ox, y: oy - it.top, w: it.width, h: it.height, item: it });
  });
  return out;
}

function textsOf(doc, layerName) {
  const layer = doc.layers.find((l) => l.name === layerName);
  const out = [];
  walk(layer, (it) => it.kind === 'text' && out.push(it));
  return out;
}

// ---- source ---------------------------------------------------------------

check('script is plain ASCII (ExtendScript reads files without a BOM as the system code page)', () => {
  const bad = [...source].findIndex((ch) => ch.charCodeAt(0) > 127);
  assert.equal(bad, -1, `non-ASCII character at offset ${bad}`);
});

check('script parses as ES3 (the JavaScript version ExtendScript runs)', () => {
  let Linter;
  try {
    ({ Linter } = createRequire(import.meta.url)('eslint'));
  } catch {
    console.log('      (eslint not found - set NODE_PATH="$(npm root -g)" to include this check; skipped)');
    return;
  }
  const messages = new Linter({ configType: 'flat' }).verify(source, { languageOptions: { ecmaVersion: 3, sourceType: 'script' } });
  assert.deepEqual(messages.map((m) => `${m.line}:${m.column} ${m.message}`), []);
  const code = source.replace(/\/\/.*$/gm, '').replace(/'(?:\\.|[^'\\])*'/g, "''");
  assert.ok(!/,\s*[\]}]/.test(code), 'trailing comma in an array or object literal');
});

check('DATA block matches the spreadsheet', () => {
  const measured = readMeasurements(fs.readFileSync(DEFAULT_CSV, 'utf8'));
  const { api } = runTemplate(source);
  assert.deepEqual(plain(api.ROWS), measured.rows);
  assert.equal(api.SILL_MULLION, measured.sill);
  const expected = replaceDataBlock(source, dataBlock({ project: api.PROJECT, source: api.SOURCE, sill: measured.sill, rows: measured.rows }));
  assert.equal(source, expected, 'run node tools/build.mjs');
});

// ---- the default build ----------------------------------------------------

const out = render(source);
const { doc, state, layout: L, settings: S } = out;
const K = 72 / S.scale;

check('builds without errors and reports once', () => {
  assert.equal(state.documents.length, 1);
  assert.equal(state.alerts.length, 1);
  assert.match(state.alerts[0], /^Window graphics template ready/);
  assert.match(state.alerts[0], /525 panels in 15 rows, 526 artboards/);
});

check('document: CMYK, inches, 1:10 size, 0.5 in bleed (0.05 in at scale)', () => {
  assert.equal(doc.colorMode, 'DocumentColorSpace.CMYK');
  assert.equal(doc.units, 'RulerUnits.Inches');
  close(doc.width, L.width * K, 'width');
  close(doc.height, L.height * K, 'height');
  doc.bleed.forEach((b) => close(b, S.bleed * K, 'bleed'));
});

check('restores the coordinate system and alert level it changed', () => {
  assert.equal(state.coordinateSystem, 'CoordinateSystem.ARTBOARDCOORDINATESYSTEM');
  assert.equal(state.userInteractionLevel, 'UserInteractionLevel.DISPLAYALERTS');
});

check('layers: order, locking, printing', () => {
  assert.deepEqual(doc.layers.map((l) => l.name), ['INFO', 'LABELS', 'SAFE AREA', 'TRIM', 'MULLIONS', 'ARTWORK']);
  for (const l of doc.layers) {
    const art = l.name === 'ARTWORK';
    assert.equal(l.locked, !art, `${l.name} locked`);
    assert.equal(l.printable, art, `${l.name} printable`);
    assert.equal(l.visible, true, `${l.name} visible`);
  }
  assert.equal(doc.activeLayer.name, 'ARTWORK');
  assert.equal(doc.layers.at(-1).items.length, 0, 'ARTWORK starts empty');
});

check('swatches: global process colors for the template', () => {
  assert.deepEqual(doc.spots.map((s) => s.name),
    ['Template - Mullion', 'Template - Trim', 'Template - Safe Area', 'Template - Text', 'Template - Bleed']);
  doc.spots.forEach((s) => assert.equal(s.colorType, 'ColorModel.PROCESS'));
});

const trim = rectsOf(doc, 'TRIM');
const byId = new Map(trim.map((r) => [r.name, r]));
const { api } = runTemplate(source);
const ROWS = plain(api.ROWS);
const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

check('TRIM: one outline per panel at the exact spreadsheet size', () => {
  assert.equal(trim.length, 525);
  ROWS.forEach(([h, widths], r) => widths.forEach((w, c) => {
    const id = LETTERS[r] + String(c + 1).padStart(2, '0');
    const p = byId.get(id);
    assert.ok(p, `${id} missing`);
    close(p.w, w * K, `${id} width`);
    close(p.h, h * K, `${id} height`);
    assert.equal(p.item.filled, false, `${id} has a fill`);
    assert.equal(p.item.stroked, true, `${id} has no stroke`);
  }));
});

check('panels in a row: same top, 0.5 in vertical mullion between neighbours', () => {
  ROWS.forEach(([, widths], r) => {
    for (let c = 1; c < widths.length; c++) {
      const a = byId.get(LETTERS[r] + String(c).padStart(2, '0'));
      const b = byId.get(LETTERS[r] + String(c + 1).padStart(2, '0'));
      close(b.y, a.y, `${LETTERS[r]} row top`);
      close(b.x - (a.x + a.w), S.verticalMullion * K, `gap ${LETTERS[r]}${c}/${c + 1}`);
    }
  });
});

check('rows: 2.25 in horizontal mullion between rows, first row on top', () => {
  for (let r = 1; r < ROWS.length; r++) {
    const above = byId.get(`${LETTERS[r - 1]}01`);
    const below = byId.get(`${LETTERS[r]}01`);
    close(below.y - (above.y + above.h), S.horizontalMullion * K, `gap ${LETTERS[r - 1]}/${LETTERS[r]}`);
  }
  close(byId.get('A01').y, 0, 'row A at the top');
});

check('MULLIONS: vertical bars fill the gaps exactly, horizontal bars span the rows they separate', () => {
  const bars = rectsOf(doc, 'MULLIONS');
  const vertical = bars.filter((b) => b.name.startsWith('Mullion '));
  const horizontal = bars.filter((b) => b.name.startsWith('Horizontal'));
  assert.equal(vertical.length, 15 * 34);
  assert.equal(horizontal.length, 15);
  for (const v of vertical) {
    const [, a, b] = v.name.match(/^Mullion (\w+)\/(\w+)$/);
    const left = byId.get(a);
    const right = byId.get(b);
    close(v.x, left.x + left.w, `${v.name} left`);
    close(v.x + v.w, right.x, `${v.name} right`);
    close(v.y, left.y, `${v.name} top`);
    close(v.h, left.h, `${v.name} height`);
  }
  const rowBox = (r) => {
    const cells = trim.filter((p) => p.name[0] === LETTERS[r]);
    const x0 = Math.min(...cells.map((p) => p.x));
    return { x0, x1: Math.max(...cells.map((p) => p.x + p.w)), y0: cells[0].y, y1: cells[0].y + cells[0].h };
  };
  horizontal.forEach((m, i) => {
    const above = rowBox(i);
    close(m.y, above.y1, `${m.name} top`);
    close(m.h, S.horizontalMullion * K, `${m.name} height`);
    const below = i + 1 < ROWS.length ? rowBox(i + 1) : above;
    if (i + 1 < ROWS.length) close(m.y + m.h, below.y0, `${m.name} bottom`);
    close(m.x, Math.min(above.x0, below.x0), `${m.name} left`);
    close(m.x + m.w, Math.max(above.x1, below.x1), `${m.name} right`);
    assert.equal(m.item.stroked, false);
  });
});

check('SAFE AREA: dashed outline 1 in inside every panel', () => {
  const safe = rectsOf(doc, 'SAFE AREA');
  assert.equal(safe.length, 525);
  for (const s of safe) {
    const p = byId.get(s.name.replace(' safe area', ''));
    const m = S.safeMargin * K;
    close(s.x, p.x + m, `${s.name} x`);
    close(s.y, p.y + m, `${s.name} y`);
    close(s.w, p.w - 2 * m, `${s.name} w`);
    close(s.h, p.h - 2 * m, `${s.name} h`);
    assert.ok(s.item.strokeDashes.length > 0);
  }
});

check('LABELS: ID and size text inside each panel', () => {
  const labels = textsOf(doc, 'LABELS');
  assert.equal(labels.length, 525);
  const [ox, oy] = doc.artboards[0].rect;
  for (const t of labels) {
    const id = t.name.replace(' label', '');
    const p = byId.get(id);
    const [r, c] = [LETTERS.indexOf(id[0]), Number(id.slice(1)) - 1];
    const [h, widths] = ROWS[r];
    assert.deepEqual(t.paragraphs.map((q) => q.text), [id, `${widths[c]} \u00D7 ${h}`]);
    assert.ok(t.paragraphs.every((q) => q.justification === 'Justification.CENTER'));
    const [bl, bt, br, bb] = itemBounds(t);
    const box = { x0: bl - ox, x1: br - ox, y0: oy - bt, y1: oy - bb };
    assert.ok(box.x0 >= p.x + 1 && box.x1 <= p.x + p.w - 1 && box.y0 >= p.y + 1 && box.y1 <= p.y + p.h - 1,
      `${id} label overflows its panel`);
  }
});

check('artboards: whole wall, then one per panel on its trim line', () => {
  assert.equal(doc.artboards.length, 526);
  const [ox, oy, ox2, oy2] = doc.artboards[0].rect;
  assert.equal(doc.artboards[0].name, 'Elevation');
  close(ox2 - ox, L.width * K, 'elevation width');
  close(oy - oy2, L.height * K, 'elevation height');
  L.panels.forEach((p, i) => {
    const ab = doc.artboards[i + 1];
    const t = byId.get(p.id);
    assert.equal(ab.name, p.id);
    close(ab.rect[0] - ox, t.x, `${p.id} left`);
    close(oy - ab.rect[1], t.y, `${p.id} top`);
    close(ab.rect[2] - ab.rect[0], t.w, `${p.id} width`);
    close(ab.rect[1] - ab.rect[3], t.h, `${p.id} height`);
  });
  assert.equal(doc.activeArtboard, 0);
});

check('everything sits on the Illustrator canvas', () => {
  assert.deepEqual(offCanvas(doc), []);
});

check('title block flags the suspicious widths B28 and E28', () => {
  const notes = textsOf(doc, 'INFO').find((t) => t.name === 'Notes');
  const last = notes.paragraphs.at(-1).text;
  assert.match(last, /^CHECK BEFORE PRODUCTION/);
  assert.match(last, /B28 is 57"/);
  assert.match(last, /E28 is 57"/);
});

check('row offsets are the least-squares fit of the vertical mullions (the pivot mullion stays within 3 in)', () => {
  const pos = ROWS.map((row, r) => row[1].slice(0, -1).map((_, c) => {
    const p = byId.get(LETTERS[r] + String(c + 1).padStart(2, '0'));
    return (p.x + p.w) / K;
  }));
  const cols = pos[0].length;
  const avg = [...Array(cols).keys()].map((c) => pos.reduce((s, row) => s + row[c], 0) / pos.length);
  pos.forEach((row, r) => {
    const meanDeviation = row.reduce((s, x, c) => s + (x - avg[c]), 0) / cols;
    // offsets are rounded to 1/16 in, and so are the rows the averages come from
    assert.ok(Math.abs(meanDeviation) <= 1 / 16 + 1e-9, `row ${LETTERS[r]} is ${meanDeviation.toFixed(3)} in off the best fit`);
  });
  // The columns narrow toward the bottom, so the mullions fan out around a pivot near the middle
  const spread = avg.map((a, c) => Math.max(...pos.map((row) => Math.abs(row[c] - a))));
  const pivot = spread.indexOf(Math.min(...spread));
  assert.ok(pivot > cols / 4 && pivot < (3 * cols) / 4, `pivot mullion after column ${pivot + 1} is not near the middle`);
  assert.ok(spread[pivot] < 3, `pivot mullion after column ${pivot + 1} strays ${spread[pivot].toFixed(2)} in`);
});

// ---- variants -------------------------------------------------------------

function build(src, illustratorOptions = {}) {
  const run = runTemplate(src, { illustratorOptions });
  return { doc: run.state.documents[0], state: run.state };
}

check('same drawing wherever Illustrator puts the first artboard', () => {
  const moved = build(source, { origin: [3000, -1234.5] }).doc;
  const a = rectsOf(doc, 'TRIM');
  const b = rectsOf(moved, 'TRIM');
  a.forEach((r, i) => ['x', 'y', 'w', 'h'].forEach((k) => close(b[i][k], r[k], `${r.name}.${k}`)));
  assert.deepEqual(offCanvas(moved), []);
});

check('firstRowIsTop: false puts row A at the bottom', () => {
  const flipped = build(withSetting(source, 'firstRowIsTop', 'false')).doc;
  const t = new Map(rectsOf(flipped, 'TRIM').map((r) => [r.name, r]));
  assert.ok(t.get('A01').y > t.get('O01').y);
  close(t.get('O01').y, S.horizontalMullion * K, 'sill mullion now on top');
});

check('rowAlignment left / center / right', () => {
  for (const mode of ['left', 'center', 'right']) {
    const d = build(withSetting(source, 'rowAlignment', `'${mode}'`)).doc;
    const rows = new Map();
    for (const r of rectsOf(d, 'TRIM')) {
      const e = rows.get(r.name[0]) || { x0: Infinity, x1: -Infinity };
      rows.set(r.name[0], { x0: Math.min(e.x0, r.x), x1: Math.max(e.x1, r.x + r.w) });
    }
    const ends = [...rows.values()];
    const key = mode === 'left' ? (e) => e.x0 : mode === 'right' ? (e) => e.x1 : (e) => (e.x0 + e.x1) / 2;
    ends.forEach((e) => close(key(e), key(ends[0]), `${mode} aligned`, 0.0625 * K + 1e-6));
  }
});

check('panelArtboards: false makes a single artboard', () => {
  const d = build(withSetting(source, 'panelArtboards', 'false')).doc;
  assert.equal(d.artboards.length, 1);
});

check('fallbacks: missing fonts, no bleed support, addDocument failing, old Illustrator', () => {
  assert.equal(build(source, { fonts: [] }).doc.artboards.length, 526);
  for (const opts of [{ bleedUnsupported: true }, { addDocumentFails: true }]) {
    const { state: s } = build(source, opts);
    assert.match(s.alerts[0], /Set the bleed by hand/);
  }
  const old = build(source, { version: '21.1.0' });
  assert.equal(old.doc.artboards.length, 1);
  assert.match(old.state.alerts[0], /needs Illustrator CC 2018/);
});

check('a scale that cannot fit the canvas stops with a message', () => {
  const { state: s } = build(withSetting(source, 'scale', '5'));
  assert.equal(s.documents.length, 0);
  assert.match(s.alerts[0], /does not fit/);
});

// ---- generated files ------------------------------------------------------

check('SVG and panel schedule are up to date', () => {
  assert.equal(fs.readFileSync(svgPath(S.scale), 'utf8'), out.svg, 'run node tools/build.mjs');
  assert.equal(fs.readFileSync(SCHEDULE, 'utf8'), out.schedule, 'run node tools/build.mjs');
});

check('panel schedule: 525 panels, sizes and bleed sizes', () => {
  const lines = out.schedule.trim().split('\r\n').slice(1).map((l) => l.split(','));
  assert.equal(lines.length, 525);
  for (const [id, row, col, w, h, , wb, hb, ab] of lines) {
    const p = L.panels.find((q) => q.id === id);
    assert.equal(row, id[0]);
    assert.equal(Number(col), p.col);
    assert.equal(Number(w), p.w);
    assert.equal(Number(h), p.h);
    close(Number(wb), p.w + 2 * S.bleed, `${id} width + bleed`, 1e-3);
    close(Number(hb), p.h + 2 * S.bleed, `${id} height + bleed`, 1e-3);
    assert.equal(Number(ab), L.panels.indexOf(p) + 2);
  }
});

console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exitCode = failures ? 1 : 0;
