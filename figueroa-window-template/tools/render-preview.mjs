#!/usr/bin/env node
// Renders PNG previews of the template SVG with headless Chromium (Playwright):
//
//   NODE_PATH="$(npm root -g)" node tools/render-preview.mjs
//
// Optional: node tools/render-preview.mjs out.png <x> <y> <width> <height> [pixelWidth]
// renders just that part of the SVG (SVG units = points at 1:10).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { DIR, svgPath } from './build.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const SVG = svgPath(10);

async function render(browser, svgText, viewBox, pixelWidth, outFile) {
  const [, , vw, vh] = viewBox;
  const pixelHeight = Math.round((pixelWidth * vh) / vw);
  const cropped = svgText.replace(/<svg([^>]*?) width="[^"]*" height="[^"]*" viewBox="[^"]*"/,
    `<svg$1 width="${pixelWidth}" height="${pixelHeight}" viewBox="${viewBox.join(' ')}"`);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'preview-'));
  const file = path.join(tmp, 'view.svg');
  fs.writeFileSync(file, cropped);
  const page = await browser.newPage({ viewport: { width: pixelWidth, height: pixelHeight } });
  await page.goto(`file://${file}`);
  await page.screenshot({ path: outFile });
  await page.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`wrote ${outFile} (${pixelWidth} x ${pixelHeight})`);
}

const svgText = fs.readFileSync(SVG, 'utf8');
const [, , fullW, fullH] = svgText.match(/viewBox="([^"]+)"/)[1].split(' ').map(Number);
const browser = await chromium.launch();
try {
  const args = process.argv.slice(2);
  if (args.length >= 5) {
    const [out, x, y, w, h, px] = args;
    await render(browser, svgText, [x, y, w, h].map(Number), Number(px || 2400), path.resolve(out));
  } else {
    await render(browser, svgText, [0, 0, fullW, fullH], 4000, path.join(DIR, 'preview.png'));
    await render(browser, svgText, [0, 0, 2700, 1700], 2700, path.join(DIR, 'preview-detail.png'));
  }
} finally {
  await browser.close();
}
