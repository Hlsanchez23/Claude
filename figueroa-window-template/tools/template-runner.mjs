// Shared helpers for build.mjs and check.mjs: reading the spreadsheet, writing
// the DATA block of the Illustrator script, and running that script in a
// sandbox that looks like ExtendScript (ES3: no forEach/indexOf/JSON/...).
import vm from 'node:vm';
import { createIllustrator } from './illustrator-mock.mjs';

// ---- spreadsheet ---------------------------------------------------------

export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  text = text.replace(/^\uFEFF/, '');
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (ch === '"') {
        quoted = false;
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\r' || ch === '\n') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else {
      field += ch;
    }
  }
  if (field !== '' || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

const PANEL = /^(\d+(?:\.\d+)?)"?\s*(?:[xX\u00D7]\s*)?(\d+(?:\.\d+)?)"?$/;
const MULLION = /^(\d+(?:\.\d+)?)"?$/;

// Marks a horizontal mullion in the wall list (same value as MULLION in the .jsx)
export const MULLION_MARK = 'mullion';
const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const panelId = (row, col) => LETTERS[row] + String(col).padStart(2, '0');

// The spreadsheet is drawn like the wall, top to bottom: a header row of column
// numbers, rows of "W x H" panels (with the 0.5" vertical mullions in between)
// and, wherever there is one, a row of 2.25" horizontal mullions.
// Returns wall = [[height, [widths]] or MULLION_MARK, ...]. Blank panel cells are
// listed in blanks (and are null in widths) rather than skipped, so the columns
// after them keep their places.
export function readMeasurements(csvText) {
  const table = parseCsv(csvText).map((r) => r.map((c) => c.trim()));
  const numbers = table[0].filter((c, j) => j % 2 === 0);
  if (!numbers.every((c, k) => c === String(k + 1))) {
    throw new Error('Expected the first row to number the columns 1, 2, 3 ... in every other cell.');
  }
  const columns = numbers.length;
  const wall = [];
  const blanks = [];
  const notes = [];
  const verticalMullions = new Set();
  const horizontalMullions = new Set();
  let row = 0;
  table.slice(1).forEach((cells, i) => {
    const line = i + 2;
    const filled = cells.filter((c) => c !== '');
    if (!filled.length) return;
    if (filled.every((c) => MULLION.test(c))) {
      filled.forEach((c) => horizontalMullions.add(parseFloat(c)));
      wall.push(MULLION_MARK);
      return;
    }
    const widths = [];
    const heights = new Set();
    const missingX = [];
    for (let col = 1; col <= columns; col++) {
      const c = cells[(col - 1) * 2] ?? '';
      const between = cells[(col - 1) * 2 + 1] ?? '';
      if (between !== '') {
        if (col === columns || !MULLION.test(between)) {
          throw new Error(`Line ${line}: expected a mullion size between columns ${col} and ${col + 1}, got "${between}".`);
        }
        verticalMullions.add(parseFloat(between));
      }
      if (c === '') {
        blanks.push({ id: panelId(row, col), line, row, col });
        widths.push(null);
        continue;
      }
      const m = c.match(PANEL);
      if (!m) throw new Error(`Line ${line}, column ${col}: can't read "${c}" as W x H.`);
      if (!/[xX\u00D7]/.test(c)) missingX.push(c);
      widths.push(Number(m[1]));
      heights.add(Number(m[2]));
    }
    if (missingX.length) notes.push(`Line ${line}: ${missingX.length} sizes have no "x" (e.g. ${missingX[0]}) - read as W x H.`);
    if (heights.size !== 1) throw new Error(`Line ${line}: panels in one row must share a height, got ${[...heights].join(', ')}.`);
    wall.push([[...heights][0], widths]);
    row++;
  });
  return { wall, blanks, verticalMullions: [...verticalMullions], horizontalMullions: [...horizontalMullions], notes };
}

// Fills blank panel cells from fillIns ({ G31: { w, h, note } }). Returns the
// completed wall and the NOTES that flag each fill-in on the template. Throws
// if a blank has no fill-in, so a missing size can't slip through.
export function applyFillIns({ wall, blanks }, fillIns) {
  const out = wall.map((e) => (e === MULLION_MARK ? e : [e[0], [...e[1]]]));
  const rows = out.filter((e) => e !== MULLION_MARK);
  const notes = {};
  const missing = [];
  for (const b of blanks) {
    const f = fillIns[b.id];
    if (!f) {
      missing.push(`${b.id} (line ${b.line}, column ${b.col})`);
      continue;
    }
    if (f.h !== rows[b.row][0]) throw new Error(`Fill-in for ${b.id} is ${f.h}" tall but row ${b.id[0]} is ${rows[b.row][0]}".`);
    rows[b.row][1][b.col - 1] = f.w;
    notes[b.id] = f.note;
  }
  if (missing.length) {
    throw new Error(`Blank panel sizes in the spreadsheet: ${missing.join(', ')}. Fill them in, or add them to FILL_INS in tools/build.mjs.`);
  }
  const unused = Object.keys(fillIns).filter((id) => !blanks.some((b) => b.id === id));
  return { wall: out, notes, unused };
}

// ---- the DATA block inside the .jsx --------------------------------------

export function dataBlock({ project, revision, source, wall, notes }) {
  const q = (s) => `'${String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
  let row = 0;
  const entries = wall.map((e, i) => {
    const comma = i < wall.length - 1 ? ',' : '';
    if (e === MULLION_MARK) return `        MULLION${comma}`;
    return `        [${e[0]}, [${e[1].join(', ')}]]${comma || ' '} // ${LETTERS[row++]}`;
  });
  const ids = Object.keys(notes);
  const noteLines = ids.map((id, i) => `        ${id}: ${q(notes[id])}${i < ids.length - 1 ? ',' : ''}`);
  return [
    '    // @@DATA-BEGIN (generated by tools/build.mjs)',
    `    var PROJECT = ${q(project)};`,
    `    var REVISION = ${q(revision)};`,
    `    var SOURCE = ${q(source)};`,
    '    var WALL = [',
    ...entries,
    '    ];',
    ...(noteLines.length ? ['    var NOTES = {', ...noteLines, '    };'] : ['    var NOTES = {};']),
    '    // @@DATA-END',
  ].join('\n');
}

export function replaceDataBlock(source, block) {
  const re = / {4}\/\/ @@DATA-BEGIN[^\n]*\n[\s\S]*?\/\/ @@DATA-END/;
  if (!re.test(source)) throw new Error('DATA markers not found in the .jsx');
  return source.replace(re, block);
}

// ---- running the script --------------------------------------------------

// Remove what ExtendScript (ES3) doesn't have, so the script can't lean on it.
const EXTENDSCRIPT_BUILTINS = `
(function (g) {
  function drop(o, names) { for (var i = 0; i < names.length; i++) { try { delete o[names[i]]; } catch (e) {} } }
  drop(Array.prototype, ['forEach', 'map', 'filter', 'reduce', 'reduceRight', 'some', 'every', 'indexOf', 'lastIndexOf',
    'find', 'findIndex', 'findLast', 'findLastIndex', 'includes', 'fill', 'flat', 'flatMap', 'keys', 'values', 'entries',
    'at', 'copyWithin', 'toSorted', 'toReversed', 'toSpliced', 'with']);
  drop(Array, ['isArray', 'from', 'of']);
  drop(Object, ['keys', 'values', 'entries', 'create', 'assign', 'freeze', 'isFrozen', 'seal', 'getPrototypeOf',
    'defineProperty', 'defineProperties', 'getOwnPropertyNames', 'getOwnPropertyDescriptor', 'fromEntries']);
  drop(String.prototype, ['trim', 'trimStart', 'trimEnd', 'trimLeft', 'trimRight', 'includes', 'startsWith', 'endsWith',
    'repeat', 'padStart', 'padEnd', 'at', 'codePointAt', 'normalize', 'replaceAll', 'matchAll']);
  drop(Function.prototype, ['bind']);
  drop(Date, ['now']);
  drop(Date.prototype, ['toISOString', 'toJSON']);
  drop(Number, ['isFinite', 'isNaN', 'isInteger', 'parseFloat', 'parseInt', 'EPSILON']);
  drop(Math, ['trunc', 'sign', 'log10', 'log2', 'hypot', 'cbrt', 'fround', 'clz32', 'imul']);
  drop(g, ['JSON', 'Map', 'Set', 'WeakMap', 'WeakSet', 'Promise', 'Symbol', 'Proxy', 'Reflect']);
})(this);
`;

// Runs the .jsx source. With illustratorOptions it runs against the mock
// Illustrator (and builds the document); without, it only defines the script's
// functions. Returns { api, state }.
export function runTemplate(source, { illustratorOptions, es3 = true } = {}) {
  const context = vm.createContext({});
  if (es3) vm.runInContext(EXTENDSCRIPT_BUILTINS, context);
  let state = null;
  if (illustratorOptions) {
    const mock = createIllustrator(illustratorOptions);
    Object.assign(context, mock.globals);
    state = mock.state;
  }
  vm.runInContext(source, context, { filename: 'template.jsx' });
  return { api: context.WINDOW_TEMPLATE, state };
}

// Plain copies of values from the sandbox realm.
export const plain = (v) => JSON.parse(JSON.stringify(v));
