#!/usr/bin/env node
// Rebuilds the template files from the field-measure spreadsheet:
//
//   node tools/build.mjs ["path/to/spreadsheet.csv"]
//
// Without a path it uses the "Crypto.com Arena Figueroa Entrance - Windows*.csv"
// in the repository root.
// 1. Writes the measurements into the DATA block of the .jsx
// 2. Runs that script against the mock Illustrator and saves the drawing as SVG
// 3. Writes the panel schedule (CSV)
// Then run `node tools/check.mjs` to verify everything.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readMeasurements, applyFillIns, dataBlock, replaceDataBlock, runTemplate, plain } from './template-runner.mjs';
import { documentToSvg } from './svg.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const DIR = path.resolve(HERE, '..');
const PROJECT = 'Crypto.com Arena - Figueroa Entrance';
export const REVISION = 'v3';
const NAME = `Figueroa-Windows-Template-${REVISION}`;
export const JSX = path.join(DIR, `${NAME}.jsx`);
export const SCHEDULE = path.join(DIR, `Figueroa-Windows-Panel-Schedule-${REVISION}.csv`);
export const svgPath = (scale) => path.join(DIR, `${NAME}-1to${scale}.svg`);

// Blank cells in the spreadsheet and what to use until it is corrected, e.g.
//   G31: { w: 56.75, h: 70.5, note: 'blank in the spreadsheet - drawn at 56.75" x 70.5"' }
// Each one is flagged on the template (title block, panel label, completion
// message) and in the panel schedule.
export const FILL_INS = {};

// GitHub uploads can add " (3)" etc. to the name, so look for the pattern.
export function findSpreadsheet() {
  const root = path.resolve(DIR, '..');
  const found = fs.readdirSync(root).filter((f) => /^Crypto\.com Arena Figueroa Entrance - Windows.*\.csv$/i.test(f));
  if (found.length !== 1) {
    throw new Error(`Expected one "Crypto.com Arena Figueroa Entrance - Windows*.csv" in ${root}, found ${found.length}. Pass the path instead.`);
  }
  return path.join(root, found[0]);
}

const csvCell = (v) => (/[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
const round = (v, places = 3) => Math.round(v * 10 ** places) / 10 ** places;

// Everything generated from the .jsx source (used by build and check).
export function render(source) {
  const { api } = runTemplate(source);
  const settings = plain(api.SETTINGS);
  const layout = plain(api.computeLayout(api.WALL, api.SETTINGS));
  const checks = plain(api.findChecks(api.ROWS, api.NOTES));

  const { state } = runTemplate(source, { illustratorOptions: {} });
  const doc = state.documents[0];
  const { svg } = documentToSvg(doc, {
    title: `${api.PROJECT} - Window Graphics Template ${api.REVISION} (scale 1:${settings.scale})`,
    description:
      `Generated from "${api.SOURCE}" by tools/build.mjs. Scale 1:${settings.scale}: 1 unit = 1 pt = ` +
      `${settings.scale / 72} in actual. Groups: INFO, LABELS, SAFE_AREA, TRIM, MULLIONS, BLEED (template guides) and ARTWORK.`,
  });

  const header = [
    'Panel ID', 'Row', 'Column', 'Width (in)', 'Height (in)', 'Area (sq ft)',
    'Width + bleed (in)', 'Height + bleed (in)', 'Artboard #', 'Left edge from wall left (in)', 'Top edge from wall top (in)', 'Check',
  ];
  const lines = [header.map(csvCell).join(',')];
  layout.panels.forEach((p, i) => {
    const notes = checks.filter((c) => c.id === p.id).map((c) => c.text);
    if (Math.abs(p.w * 8 - Math.round(p.w * 8)) > 1e-9) notes.push(`${p.w} is not a 1/8 in increment - verify`);
    lines.push([
      p.id, p.id[0], p.col, p.w, p.h, round((p.w * p.h) / 144, 2),
      round(p.w + 2 * settings.bleed), round(p.h + 2 * settings.bleed),
      settings.panelArtboards ? i + 2 : '', round(p.x), round(p.y), notes.join('; '),
    ].map(csvCell).join(','));
  });

  return { api, settings, layout, checks, doc, state, svg, schedule: lines.join('\r\n') + '\r\n' };
}

function main() {
  const csvPath = path.resolve(process.argv[2] || findSpreadsheet());
  const measured = readMeasurements(fs.readFileSync(csvPath, 'utf8'));
  measured.notes.forEach((note) => console.log(`note: ${note}`));
  const { wall, notes, unused } = applyFillIns(measured, FILL_INS);
  Object.entries(notes).forEach(([id, note]) => console.log(`fill-in: ${id} ${note}`));
  unused.forEach((id) => console.log(`note: FILL_INS has ${id}, but the spreadsheet now has a size for it - remove it from FILL_INS`));

  const source = replaceDataBlock(fs.readFileSync(JSX, 'utf8'),
    dataBlock({ project: PROJECT, revision: REVISION, source: path.basename(csvPath), wall, notes }));
  const settings = runTemplate(source).api.SETTINGS;
  for (const [what, values, expected] of [
    ['vertical', measured.verticalMullions, settings.verticalMullion],
    ['horizontal', measured.horizontalMullions, settings.horizontalMullion],
  ]) {
    if (values.some((v) => v !== expected)) {
      throw new Error(`Spreadsheet ${what} mullions are ${values.join(', ')} in but SETTINGS says ${expected} in.`);
    }
  }
  fs.writeFileSync(JSX, source);

  const out = render(source);
  fs.writeFileSync(svgPath(out.settings.scale), out.svg);
  fs.writeFileSync(SCHEDULE, out.schedule);

  const L = out.layout;
  console.log(`rows ${L.rows.length}, panels ${L.panels.length}, horizontal mullions ${L.horizontal.length}, ` +
    `wall ${round(L.width)} x ${round(L.height)} in, glass ${round(L.area, 1)} sq ft`);
  console.log(`rows butting together (no mullion between): ${out.api.buttedRows(out.api.WALL).join(', ') || 'none'}`);
  console.log(`row alignment: ${L.alignment}, row offsets: ${L.rows.map((r) => r.x).join(', ')}`);
  out.checks.forEach((c) => console.log(`check: ${c.id}: ${c.text}`));
  out.state.alerts.forEach((a) => console.log(`\n[Illustrator alert]\n${a}`));
  console.log(`\nwrote ${[JSX, svgPath(out.settings.scale), SCHEDULE].map((f) => path.relative(DIR, f)).join(', ')}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
