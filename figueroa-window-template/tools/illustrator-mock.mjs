// A strict stand-in for the parts of Illustrator's ExtendScript DOM that the
// template script uses. Reading or writing anything that is not modelled here
// throws, so an API typo fails the checks instead of failing inside Illustrator.
// Everything the script draws is recorded, which is also how the SVG is made.
//
// Modelled Illustrator behaviour:
//  - scripting coordinates are y-up; artboardRect is [left, top, right, bottom]
//    in document coordinates
//  - app.coordinateSystem defaults to ARTBOARDCOORDINATESYSTEM (positions are
//    relative to the active artboard's top-left)
//  - the 16383 pt canvas is centered on the first artboard; artboards must stay on it
//  - at most 1000 artboards; no art can be added to locked or hidden layers
//  - new rectangles get the default white fill and 1 pt black stroke
//  - auto leading is 120% of the font size

import { pointTextBounds } from './text-metrics.mjs';

export const CANVAS = 16383;
const HALF = CANVAS / 2;

const INKS = { c: [0, 174, 239], m: [236, 0, 140], y: [255, 242, 0], k: [35, 31, 32] };

// Approximate on-screen RGB of a CMYK mix (multiplies the ink colors).
export function cmykToRgb(c, m, y, k) {
  const out = [255, 255, 255];
  for (const [ink, pct] of [['c', c], ['m', m], ['y', y], ['k', k]]) {
    const t = pct / 100;
    for (let i = 0; i < 3; i++) out[i] *= 1 - t * (1 - INKS[ink][i] / 255);
  }
  return out.map((v) => Math.round(v));
}

export function colorToHex(color) {
  let { c, m, y, k } = color.type === 'spot' ? color.spot.color : color;
  if (color.type === 'spot') {
    const t = color.tint / 100;
    [c, m, y, k] = [c * t, m * t, y * t, k * t];
  }
  return '#' + cmykToRgb(c, m, y, k).map((v) => v.toString(16).padStart(2, '0')).join('');
}

// Arrays coming from the script live in another realm (and may have ES5
// methods removed), so copy them before using array methods on them.
const hostArray = (v) => Array.from({ length: v.length }, (_, i) => v[i]);

export function createIllustrator(options = {}) {
  const opt = {
    version: '28.7.1',
    origin: [0, 0],            // document coordinates of the first artboard's top-left
    fonts: ['ArialMT', 'Arial-BoldMT', 'MyriadPro-Regular', 'MyriadPro-Bold'],
    presets: ['Art & Illustration', 'Film & Video', 'Mobile', 'Print', 'Web'],
    addDocumentFails: false,   // simulate app.documents.addDocument() throwing
    bleedUnsupported: false,   // simulate a DocumentPreset without bleed properties
    ...options,
  };
  const records = new WeakMap(); // script-facing proxy -> internal record
  const state = { documents: [], active: null, alerts: [], menuCommands: [] };

  const fail = (msg) => {
    throw new Error(`Illustrator mock: ${msg}`);
  };

  function strict(name, target) {
    return new Proxy(target, {
      get(t, p) {
        if (typeof p === 'symbol' || p in t) return t[p];
        return fail(`${name} has no property "${String(p)}"`);
      },
      set(t, p, v) {
        if (!(p in t)) fail(`${name} has no property "${String(p)}" to set`);
        const d = Object.getOwnPropertyDescriptor(t, p);
        if (d && d.get && !d.set) fail(`${name}.${String(p)} is read-only`);
        t[p] = v;
        return true;
      },
    });
  }

  function register(proxy, rec) {
    records.set(proxy, rec);
    rec.proxy = proxy;
    return rec;
  }

  function collection(name, list, methods) {
    const t = { typename: name, ...methods };
    Object.defineProperty(t, 'length', { get: () => list().length, enumerable: true });
    return new Proxy(t, {
      get(target, p) {
        if (typeof p === 'string' && /^\d+$/.test(p)) {
          const items = list();
          if (+p >= items.length) fail(`${name}[${p}] is out of range (length ${items.length})`);
          return items[+p].proxy;
        }
        if (typeof p === 'symbol' || p in target) return target[p];
        return fail(`${name} has no property "${String(p)}"`);
      },
      set(target, p) {
        return fail(`cannot set ${name}.${String(p)}`);
      },
    });
  }

  const enumeration = (name, keys) => strict(name, Object.fromEntries(keys.map((k) => [k, `${name}.${k}`])));
  const DocumentColorSpace = enumeration('DocumentColorSpace', ['CMYK', 'RGB']);
  const CoordinateSystem = enumeration('CoordinateSystem', ['DOCUMENTCOORDINATESYSTEM', 'ARTBOARDCOORDINATESYSTEM']);
  const UserInteractionLevel = enumeration('UserInteractionLevel', ['DISPLAYALERTS', 'DONTDISPLAYALERTS']);
  const RulerUnits = enumeration('RulerUnits', ['Centimeters', 'Inches', 'Millimeters', 'Picas', 'Pixels', 'Points', 'Qs', 'Unknown']);
  const DocumentRasterResolution = enumeration('DocumentRasterResolution', ['ScreenResolution', 'MediumResolution', 'HighResolution']);
  const Justification = enumeration('Justification', ['LEFT', 'CENTER', 'RIGHT', 'FULLJUSTIFY']);
  const ColorModel = enumeration('ColorModel', ['PROCESS', 'REGISTRATION', 'SPOT']);
  const enumValues = (keys, name) => keys.map((k) => `${name}.${k}`);
  const JUSTIFICATIONS = enumValues(['LEFT', 'CENTER', 'RIGHT', 'FULLJUSTIFY'], 'Justification');
  const COORDINATE_SYSTEMS = enumValues(['DOCUMENTCOORDINATESYSTEM', 'ARTBOARDCOORDINATESYSTEM'], 'CoordinateSystem');
  const INTERACTION_LEVELS = enumValues(['DISPLAYALERTS', 'DONTDISPLAYALERTS'], 'UserInteractionLevel');
  const COLOR_MODELS = enumValues(['PROCESS', 'REGISTRATION', 'SPOT'], 'ColorModel');

  state.coordinateSystem = CoordinateSystem.ARTBOARDCOORDINATESYSTEM;
  state.userInteractionLevel = UserInteractionLevel.DISPLAYALERTS;

  const WHITE = { type: 'cmyk', c: 0, m: 0, y: 0, k: 0 };
  const BLACK = { type: 'cmyk', c: 0, m: 0, y: 0, k: 100 };

  const percent = (v, what) => {
    if (typeof v !== 'number' || !(v >= 0 && v <= 100)) fail(`${what} must be 0-100, got ${v}`);
    return v;
  };

  // Colors are copied when assigned, as in Illustrator; a SpotColor keeps a
  // live link to its swatch.
  function colorValue(v, what) {
    const r = records.get(v);
    if (!r || (r.type !== 'cmyk' && r.type !== 'spot')) fail(`${what} must be a CMYKColor or SpotColor`);
    if (r.type === 'cmyk') return { type: 'cmyk', c: r.c, m: r.m, y: r.y, k: r.k };
    if (!r.spot) fail(`${what}: SpotColor.spot was never set`);
    return { type: 'spot', spot: r.spot, tint: r.tint };
  }

  function CMYKColor() {
    const rec = { type: 'cmyk', c: 0, m: 0, y: 0, k: 0 };
    const proxy = strict('CMYKColor', {
      typename: 'CMYKColor',
      get cyan() { return rec.c; },
      set cyan(v) { rec.c = percent(v, 'cyan'); },
      get magenta() { return rec.m; },
      set magenta(v) { rec.m = percent(v, 'magenta'); },
      get yellow() { return rec.y; },
      set yellow(v) { rec.y = percent(v, 'yellow'); },
      get black() { return rec.k; },
      set black(v) { rec.k = percent(v, 'black'); },
    });
    return register(proxy, rec).proxy;
  }

  function SpotColor() {
    const rec = { type: 'spot', spot: null, tint: 100 };
    const proxy = strict('SpotColor', {
      typename: 'SpotColor',
      get spot() { return rec.spot ? rec.spot.proxy : null; },
      set spot(v) {
        const s = records.get(v);
        if (!s || s.kind !== 'spot') fail('SpotColor.spot must be a Spot from document.spots');
        rec.spot = s;
      },
      get tint() { return rec.tint; },
      set tint(v) { rec.tint = percent(v, 'tint'); },
    });
    return register(proxy, rec).proxy;
  }

  function DocumentPreset() {
    const rec = {
      kind: 'preset',
      typename: 'DocumentPreset',
      title: 'Untitled',
      width: 612,
      height: 792,
      units: RulerUnits.Points,
      colorMode: DocumentColorSpace.CMYK,
      rasterResolution: DocumentRasterResolution.HighResolution,
      numArtboards: 1,
      documentBleedLink: true,
      documentBleedOffsetRect: [0, 0, 0, 0],
    };
    if (opt.bleedUnsupported) {
      delete rec.documentBleedLink;
      delete rec.documentBleedOffsetRect;
    }
    return register(strict('DocumentPreset', rec), rec).proxy;
  }

  // ---- documents -----------------------------------------------------------

  function toDocument(doc, x, y) {
    if (state.coordinateSystem === CoordinateSystem.DOCUMENTCOORDINATESYSTEM) return [x, y];
    const ab = doc.artboards[doc.activeArtboard].rect;
    return [x + ab[0], y + ab[1]];
  }

  function checkRect(doc, rect, what) {
    if (!rect || rect.length !== 4) fail(`${what} must be [left, top, right, bottom]`);
    const r = hostArray(rect);
    if (!r.every((v) => typeof v === 'number' && Number.isFinite(v))) fail(`${what} has a non-numeric value: ${r}`);
    const [l, t, rt, b] = r;
    if (!(rt - l >= 1 && t - b >= 1)) fail(`${what} must be at least 1 pt wide and tall (y is up): ${r}`);
    const [cl, ct, cr, cb] = doc.canvas;
    const eps = 1e-6;
    if (l < cl - eps || rt > cr + eps || t > ct + eps || b < cb - eps) fail(`${what} is off the canvas: ${r}`);
    return r;
  }

  function makeArtboard(doc, name, rect) {
    const rec = { kind: 'artboard', name, rect: checkRect(doc, rect, 'artboardRect') };
    const proxy = strict('Artboard', {
      typename: 'Artboard',
      get name() { return rec.name; },
      set name(v) { rec.name = String(v); },
      get artboardRect() { return rec.rect.slice(); },
      set artboardRect(v) { rec.rect = checkRect(doc, v, 'artboardRect'); },
    });
    return register(proxy, rec);
  }

  function makeSpot(doc) {
    const rec = { kind: 'spot', name: `New Color Swatch ${doc.spots.length + 1}`, color: { ...WHITE }, colorType: ColorModel.SPOT };
    const proxy = strict('Spot', {
      typename: 'Spot',
      get name() { return rec.name; },
      set name(v) {
        if (doc.spots.some((s) => s !== rec && s.name === String(v))) fail(`a swatch named "${v}" already exists`);
        rec.name = String(v);
      },
      get color() { return fail('reading Spot.color is not modelled'); },
      set color(v) {
        const c = colorValue(v, 'Spot.color');
        if (c.type !== 'cmyk') fail('Spot.color must be a process color');
        rec.color = c;
      },
      get colorType() { return rec.colorType; },
      set colorType(v) {
        if (!COLOR_MODELS.includes(v)) fail(`colorType must be a ColorModel, got ${v}`);
        rec.colorType = v;
      },
    });
    return register(proxy, rec);
  }

  function containerApi(owner, doc) {
    const editable = () => {
      for (let n = owner; n; n = n.parent) {
        if (n.kind === 'layer' && (n.locked || !n.visible)) fail(`cannot add art to locked or hidden layer "${n.name}"`);
      }
    };
    const finite = (vals, what) => {
      if (!vals.every((v) => typeof v === 'number' && Number.isFinite(v))) fail(`${what} needs finite numbers, got ${vals}`);
    };
    return {
      pathItems: collection('PathItems', () => owner.items.filter((i) => i.kind === 'rect'), {
        rectangle(top, left, width, height) {
          editable();
          finite([top, left, width, height], 'pathItems.rectangle()');
          if (!(width > 0 && height > 0)) fail(`rectangle() size must be positive: ${width} x ${height}`);
          const [x, y] = toDocument(doc, left, top);
          const r = makeRect(owner, x, y, width, height);
          owner.items.push(r);
          return r.proxy;
        },
      }),
      textFrames: collection('TextFrames', () => owner.items.filter((i) => i.kind === 'text'), {
        pointText(anchor) {
          editable();
          if (!anchor || anchor.length !== 2) fail('textFrames.pointText() needs [x, y]');
          const a = hostArray(anchor);
          finite(a, 'textFrames.pointText()');
          const [x, y] = toDocument(doc, a[0], a[1]);
          const t = makeText(owner, x, y);
          owner.items.push(t);
          return t.proxy;
        },
      }),
      groupItems: collection('GroupItems', () => owner.items.filter((i) => i.kind === 'group'), {
        add() {
          editable();
          const g = makeGroup(owner, doc);
          owner.items.push(g);
          return g.proxy;
        },
      }),
    };
  }

  const named = (rec) => ({
    get name() { return rec.name; },
    set name(v) { rec.name = String(v); },
  });

  function makeLayer(doc, name) {
    const rec = { kind: 'layer', doc, parent: null, name, locked: false, printable: true, visible: true, items: [] };
    const t = {
      typename: 'Layer',
      ...containerApi(rec, doc),
      get locked() { return rec.locked; },
      set locked(v) { rec.locked = !!v; },
      get printable() { return rec.printable; },
      set printable(v) { rec.printable = !!v; },
      get visible() { return rec.visible; },
      set visible(v) { rec.visible = !!v; },
    };
    Object.defineProperties(t, Object.getOwnPropertyDescriptors(named(rec)));
    return register(strict('Layer', t), rec);
  }

  function makeGroup(parent, doc) {
    const rec = { kind: 'group', parent, name: '', items: [] };
    const t = { typename: 'GroupItem', ...containerApi(rec, doc) };
    Object.defineProperties(t, Object.getOwnPropertyDescriptors(named(rec)));
    return register(strict('GroupItem', t), rec);
  }

  function makeRect(parent, left, top, width, height) {
    const rec = {
      kind: 'rect', parent, name: '', left, top, width, height,
      filled: true, fillColor: WHITE, stroked: true, strokeColor: BLACK, strokeWidth: 1, strokeDashes: [],
    };
    const t = {
      typename: 'PathItem',
      get filled() { return rec.filled; },
      set filled(v) { rec.filled = !!v; },
      get fillColor() { return fail('reading fillColor is not modelled'); },
      set fillColor(v) { rec.fillColor = colorValue(v, 'fillColor'); },
      get stroked() { return rec.stroked; },
      set stroked(v) { rec.stroked = !!v; },
      get strokeColor() { return fail('reading strokeColor is not modelled'); },
      set strokeColor(v) { rec.strokeColor = colorValue(v, 'strokeColor'); },
      get strokeWidth() { return rec.strokeWidth; },
      set strokeWidth(v) {
        if (typeof v !== 'number' || !(v >= 0 && v <= 1000)) fail(`strokeWidth must be 0-1000 pt, got ${v}`);
        rec.strokeWidth = v;
      },
      get strokeDashes() { return rec.strokeDashes.slice(); },
      set strokeDashes(v) {
        const a = hostArray(v);
        if (!a.every((n) => typeof n === 'number' && n >= 0)) fail(`strokeDashes must be numbers, got ${a}`);
        rec.strokeDashes = a;
      },
    };
    Object.defineProperties(t, Object.getOwnPropertyDescriptors(named(rec)));
    return register(strict('PathItem', t), rec);
  }

  function makeText(parent, x, y) {
    const rec = {
      kind: 'text', parent, name: '', anchor: [x, y],
      paragraphs: [{ text: '', size: 12, font: 'MyriadPro-Regular', fillColor: BLACK, justification: Justification.LEFT }],
    };
    const range = (paras, label) => strict(label, {
      typename: 'TextRange',
      characterAttributes: strict('CharacterAttributes', {
        typename: 'CharacterAttributes',
        get size() { return paras()[0].size; },
        set size(v) {
          if (typeof v !== 'number' || !(v >= 0.1 && v <= 1296)) fail(`font size must be 0.1-1296 pt, got ${v}`);
          for (const p of paras()) p.size = v;
        },
        get textFont() { return fail('reading textFont is not modelled'); },
        set textFont(v) {
          const f = records.get(v);
          if (!f || f.kind !== 'font') fail('textFont must come from app.textFonts');
          for (const p of paras()) p.font = f.name;
        },
        get fillColor() { return fail('reading fillColor is not modelled'); },
        set fillColor(v) {
          const c = colorValue(v, 'fillColor');
          for (const p of paras()) p.fillColor = c;
        },
      }),
      paragraphAttributes: strict('ParagraphAttributes', {
        typename: 'ParagraphAttributes',
        get justification() { return paras()[0].justification; },
        set justification(v) {
          if (!JUSTIFICATIONS.includes(v)) fail(`justification must be a Justification, got ${v}`);
          for (const p of paras()) p.justification = v;
        },
      }),
    });
    const textRange = range(() => rec.paragraphs, 'TextRange');
    const paragraphs = new Proxy({ typename: 'Paragraphs' }, {
      get(t, p) {
        if (p === 'length') return rec.paragraphs.length;
        if (typeof p === 'string' && /^\d+$/.test(p)) {
          if (+p >= rec.paragraphs.length) fail(`paragraphs[${p}] is out of range`);
          const para = rec.paragraphs[+p];
          return range(() => [para], 'TextRange');
        }
        if (typeof p === 'symbol' || p in t) return t[p];
        return fail(`Paragraphs has no property "${String(p)}"`);
      },
      set(t, p) {
        return fail(`cannot set Paragraphs.${String(p)}`);
      },
    });
    const t = {
      typename: 'TextFrame',
      get contents() { return rec.paragraphs.map((p) => p.text).join('\r'); },
      set contents(v) {
        const lines = String(v).split(/\r\n|\r|\n/);
        if (lines.some((l) => l === '')) fail('empty paragraphs are not modelled (Illustrator may skip them in .paragraphs)');
        const first = rec.paragraphs[0];
        rec.paragraphs = lines.map((text) => ({ ...first, text }));
      },
      get textRange() { return textRange; },
      get paragraphs() { return paragraphs; },
    };
    Object.defineProperties(t, Object.getOwnPropertyDescriptors(named(rec)));
    return register(strict('TextFrame', t), rec);
  }

  function makeDocument({ title, width, height, colorMode, units, bleed }) {
    for (const v of [width, height]) {
      if (typeof v !== 'number' || !(v >= 1 && v <= CANVAS)) fail(`document size must be 1-${CANVAS} pt, got ${width} x ${height}`);
    }
    const [ox, oy] = opt.origin;
    const doc = { kind: 'document', title, width, height, colorMode, units, bleed, layers: [], artboards: [], spots: [], activeArtboard: 0 };
    doc.canvas = [ox + width / 2 - HALF, oy - height / 2 + HALF, ox + width / 2 + HALF, oy - height / 2 - HALF];
    doc.artboards.push(makeArtboard(doc, 'Artboard 1', [ox, oy, ox + width, oy - height]));
    doc.layers.push(makeLayer(doc, 'Layer 1'));
    doc.activeLayer = doc.layers[0];

    const layers = collection('Layers', () => doc.layers, {
      add() {
        const l = makeLayer(doc, `Layer ${doc.layers.length + 1}`);
        doc.layers.unshift(l); // new layers go on top
        doc.activeLayer = l;
        return l.proxy;
      },
    });
    const artboards = collection('Artboards', () => doc.artboards, {
      add(rect) {
        if (doc.artboards.length >= 1000) fail('Illustrator allows at most 1000 artboards');
        const a = makeArtboard(doc, `Artboard ${doc.artboards.length + 1}`, rect);
        doc.artboards.push(a);
        return a.proxy;
      },
      setActiveArtboardIndex(i) {
        if (!(Number.isInteger(i) && i >= 0 && i < doc.artboards.length)) fail(`artboard index ${i} is out of range`);
        doc.activeArtboard = i;
      },
      getActiveArtboardIndex() {
        return doc.activeArtboard;
      },
    });
    const spots = collection('Spots', () => doc.spots, {
      add() {
        const s = makeSpot(doc);
        doc.spots.push(s);
        return s.proxy;
      },
    });
    const proxy = strict('Document', {
      typename: 'Document',
      get name() { return doc.title; },
      get layers() { return layers; },
      get artboards() { return artboards; },
      get spots() { return spots; },
      get activeLayer() { return doc.activeLayer.proxy; },
      set activeLayer(v) {
        const l = records.get(v);
        if (!l || l.kind !== 'layer' || l.doc !== doc) fail('activeLayer must be a layer of this document');
        doc.activeLayer = l;
      },
      get rulerUnits() { return doc.units; },
      get documentColorSpace() { return doc.colorMode; },
    });
    register(proxy, doc);
    state.documents.push(doc);
    state.active = doc;
    return proxy;
  }

  const textFonts = strict('TextFonts', {
    typename: 'TextFonts',
    getByName(name) {
      if (!opt.fonts.includes(name)) throw new Error('No such element');
      const rec = { kind: 'font', name };
      return register(strict('TextFont', { typename: 'TextFont', get name() { return name; } }), rec).proxy;
    },
  });

  const documents = collection('Documents', () => state.documents, {
    add(colorSpace, width, height) {
      return makeDocument({ title: `Untitled-${state.documents.length + 1}`, width, height, colorMode: colorSpace, units: RulerUnits.Points, bleed: [0, 0, 0, 0] });
    },
    addDocument(presetName, preset) {
      if (opt.addDocumentFails) throw new Error('addDocument failed (simulated)');
      if (!opt.presets.includes(presetName)) fail(`unknown startup preset "${presetName}"`);
      const p = records.get(preset);
      if (!p || p.kind !== 'preset') fail('addDocument() needs a DocumentPreset');
      const bleed = p.documentBleedOffsetRect ? hostArray(p.documentBleedOffsetRect) : [0, 0, 0, 0];
      return makeDocument({ title: p.title, width: p.width, height: p.height, colorMode: p.colorMode, units: p.units, bleed });
    },
  });

  const app = strict('Application', {
    typename: 'Application',
    get name() { return 'Adobe Illustrator'; },
    get version() { return opt.version; },
    get documents() { return documents; },
    get activeDocument() { return state.active ? state.active.proxy : fail('no document is open'); },
    get startupPresetsList() { return opt.presets.slice(); },
    get textFonts() { return textFonts; },
    get coordinateSystem() { return state.coordinateSystem; },
    set coordinateSystem(v) {
      if (!COORDINATE_SYSTEMS.includes(v)) fail(`coordinateSystem must be a CoordinateSystem, got ${v}`);
      state.coordinateSystem = v;
    },
    get userInteractionLevel() { return state.userInteractionLevel; },
    set userInteractionLevel(v) {
      if (!INTERACTION_LEVELS.includes(v)) fail(`userInteractionLevel must be a UserInteractionLevel, got ${v}`);
      state.userInteractionLevel = v;
    },
    executeMenuCommand(cmd) {
      state.menuCommands.push(String(cmd));
    },
    redraw() {},
  });

  const globals = {
    app,
    alert: (msg) => {
      state.alerts.push(String(msg));
    },
    DocumentColorSpace,
    CoordinateSystem,
    UserInteractionLevel,
    RulerUnits,
    DocumentRasterResolution,
    Justification,
    ColorModel,
    DocumentPreset,
    CMYKColor,
    SpotColor,
  };
  return { globals, state };
}

// ---- helpers for reading what was drawn ----------------------------------

export function walk(container, fn, path = []) {
  for (const item of container.items) {
    fn(item, path);
    if (item.kind === 'group') walk(item, fn, [...path, item]);
  }
}

export function itemBounds(item) {
  if (item.kind === 'rect') return [item.left, item.top, item.left + item.width, item.top - item.height];
  if (item.kind === 'text') {
    return pointTextBounds(item.anchor, item.paragraphs.map((p) => ({
      text: p.text, size: p.size, bold: /bold/i.test(p.font), justification: p.justification,
    })));
  }
  return null;
}

// Everything drawn must sit on the canvas (Illustrator rejects or clips art beyond it).
export function offCanvas(doc) {
  const problems = [];
  const [cl, ct, cr, cb] = doc.canvas;
  for (const layer of doc.layers) {
    walk(layer, (item) => {
      const b = itemBounds(item);
      if (b && (b[0] < cl || b[2] > cr || b[1] > ct || b[3] < cb)) problems.push(`${layer.name}/${item.name || item.kind}`);
    });
  }
  return problems;
}
