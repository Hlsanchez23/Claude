#!/usr/bin/env node
// Rebuilds the template files from the field-measure spreadsheet:
//
//   node tools/build.mjs ["path/to/spreadsheet.csv"]
//
// 1. Writes the measurements into the DATA block of Figueroa-Windows-Template.jsx
// 2. Runs that script against the mock Illustrator and saves the drawing as SVG
// 3. Writes the panel schedule (CSV)
// Then run `node tools/check.mjs` to verify everything.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readMeasurements, dataBlock, replaceDataBlock, runTemplate, plain } from './template-runner.mjs';
import { documentToSvg } from './svg.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const DIR = path.resolve(HERE, '..');
export const JSX = path.join(DIR, 'Figueroa-Windows-Template.jsx');
export const SCHEDULE = path.join(DIR, 'Figueroa-Windows-Panel-Schedule.csv');
export const DEFAULT_CSV = path.resolve(DIR, '..', 'Crypto.com Arena Figueroa Entrance - Windows.csv');
const PROJECT = 'Crypto.com Arena - Figueroa Entrance';

export const svgPath = (scale) => path.join(DIR, `Figueroa-Windows-Template-1to${scale}.svg`);

const csvCell = (v) => (/[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
const round = (v, places = 3) => Math.round(v * 10 ** places) / 10 ** places;

// Everything generated from the .jsx source (used by build and check).
export function render(source) {
  const { api } = runTemplate(source);
  const settings = plain(api.SETTINGS);
  const layout = plain(api.computeLayout(api.ROWS, api.SETTINGS, api.SILL_MULLION));
  const outliers = plain(api.findOutliers(api.ROWS, 3));

  const { state } = runTemplate(source, { illustratorOptions: {} });
  const doc = state.documents[0];
  const { svg } = documentToSvg(doc, {
    title: `${api.PROJECT} - Window Graphics Template (scale 1:${settings.scale})`,
    description:
      `Generated from "${api.SOURCE}" by tools/build.mjs. Scale 1:${settings.scale}: 1 unit = 1 pt = ` +
      `${settings.scale / 72} in actual. Groups: INFO, LABELS, SAFE_AREA, TRIM, MULLIONS, BLEED (template guides) and ARTWORK.`,
  });

  const flagged = new Map(outliers.map((o) => [o.id, `Width ${o.w} but column ${o.col} is ${o.above} above and ${o.below} below - verify (typo?)`]));
  const header = [
    'Panel ID', 'Row', 'Column', 'Width (in)', 'Height (in)', 'Area (sq ft)',
    `Width + bleed (in)`, `Height + bleed (in)`, 'Artboard #', 'Left edge from wall left (in)', 'Top edge from wall top (in)', 'Check',
  ];
  const lines = [header.map(csvCell).join(',')];
  layout.panels.forEach((p, i) => {
    const checks = [];
    if (flagged.has(p.id)) checks.push(flagged.get(p.id));
    if (Math.abs(p.w * 8 - Math.round(p.w * 8)) > 1e-9) checks.push(`${p.w} is not a 1/8 in increment - verify`);
    lines.push([
      p.id, p.id[0], p.col, p.w, p.h, round((p.w * p.h) / 144, 2),
      round(p.w + 2 * settings.bleed), round(p.h + 2 * settings.bleed),
      settings.panelArtboards ? i + 2 : '', round(p.x), round(p.y), checks.join('; '),
    ].map(csvCell).join(','));
  });

  return { api, settings, layout, outliers, doc, state, svg, schedule: lines.join('\r\n') + '\r\n' };
}

function main() {
  const csvPath = path.resolve(process.argv[2] || DEFAULT_CSV);
  const measured = readMeasurements(fs.readFileSync(csvPath, 'utf8'));
  measured.notes.forEach((note) => console.log(`note: ${note}`));

  let source = fs.readFileSync(JSX, 'utf8');
  const before = runTemplate(source).api.SETTINGS;
  for (const [what, values, expected] of [
    ['vertical', measured.verticalMullions, before.verticalMullion],
    ['horizontal', measured.horizontalMullions, before.horizontalMullion],
  ]) {
    if (values.some((v) => v !== expected)) {
      throw new Error(`Spreadsheet ${what} mullions are ${values.join(', ')} in but SETTINGS says ${expected} in.`);
    }
  }

  source = replaceDataBlock(source, dataBlock({ project: PROJECT, source: path.basename(csvPath), sill: measured.sill, rows: measured.rows }));
  fs.writeFileSync(JSX, source);

  const out = render(source);
  fs.writeFileSync(svgPath(out.settings.scale), out.svg);
  fs.writeFileSync(SCHEDULE, out.schedule);

  const L = out.layout;
  console.log(`rows ${L.rows.length}, panels ${L.panels.length}, wall ${round(L.width)} x ${round(L.height)} in, glass ${round(L.area, 1)} sq ft`);
  console.log(`row alignment: ${L.alignment}, row offsets: ${L.rows.map((r) => r.x).join(', ')}`);
  out.outliers.forEach((o) => console.log(`check: ${o.id} = ${o.w} (above ${o.above}, below ${o.below})`));
  out.state.alerts.forEach((a) => console.log(`\n[Illustrator alert]\n${a}`));
  console.log(`\nwrote ${path.relative(DIR, JSX)}, ${path.relative(DIR, svgPath(out.settings.scale))}, ${path.relative(DIR, SCHEDULE)}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
