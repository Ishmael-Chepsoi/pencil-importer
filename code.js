// ─────────────────────────────────────────────────────────────────────────────
// Pencil (.pen) Importer — Figma Plugin
// Supports: frame, rectangle, ellipse, text
// Fills:    solid hex, $variable refs, linear/radial gradients, image fills
// Layout:   vertical / horizontal auto-layout, absolute positioning
// Props:    cornerRadius, stroke, drop-shadow effect, padding, gap
// ─────────────────────────────────────────────────────────────────────────────

figma.showUI(__html__, { width: 340, height: 460, title: 'Pencil Importer' });

// ── Forward console output to the UI panel ────────────────────────────────
(function() {
  var _log   = console.log.bind(console);
  var _warn  = console.warn.bind(console);
  var _error = console.error.bind(console);
  function relay(level, args) {
    var text = Array.prototype.map.call(args, function(a) {
      if (a instanceof Error) return (a.stack || String(a));
      try { return (typeof a === 'object') ? JSON.stringify(a) : String(a); } catch(_) { return String(a); }
    }).join(' ');
    figma.ui.postMessage({ type: 'log', level: level, text: text });
  }
  console.log   = function() { _log.apply(console, arguments);   relay('log',   arguments); };
  console.warn  = function() { _warn.apply(console, arguments);  relay('warn',  arguments); };
  console.error = function() { _error.apply(console, arguments); relay('error', arguments); };
})();

// ── Streaming state ───────────────────────────────────────────────────────────
// Images are sent one-at-a-time from the UI to avoid hitting the message size
// limit.  We accumulate hashes here until import_end triggers node creation.
var _pendingPen    = null;
var _pendingImages = {};   // { "filename.png" | "https://…" → imageHash }
var _pendingIcons  = {};   // { "lucide/globe" → svgString }
var _totalAssets   = 0;    // total images + icons expected
var _receivedImages = 0;

figma.ui.onmessage = async function(msg) {
  if (msg.type === 'cancel') {
    figma.closePlugin();
    return;
  }

  // ── Step 1: pen data + image count ────────────────────────────────────────
  if (msg.type === 'import_start') {
    _pendingPen     = msg.pen;
    _pendingImages  = {};
    _pendingIcons   = {};
    _totalAssets    = msg.totalAssets || 0;
    _receivedImages = 0;
    // If there are no assets at all, start immediately
    if (_totalAssets === 0) {
      await _doImport();
    }
    return;
  }

  // ── Step 2: one image at a time (Uint8Array, no Array.from bloat) ─────────
  if (msg.type === 'image') {
    try {
      var img = figma.createImage(new Uint8Array(msg.bytes));
      _pendingImages[msg.name] = img.hash;
    } catch (e) {
      console.warn('createImage failed for:', msg.name, String(e));
    }
    _receivedImages++;
    if (_totalAssets > 0 && _receivedImages >= _totalAssets) {
      await _doImport();
    }
    return;
  }

  // ── Step 2b: icon SVG string ───────────────────────────────────────────────
  if (msg.type === 'icon') {
    if (msg.svgString) _pendingIcons[msg.key] = msg.svgString;
    _receivedImages++;
    if (_totalAssets > 0 && _receivedImages >= _totalAssets) {
      await _doImport();
    }
    return;
  }

  // ── Step 3: all assets sent — build Figma nodes ───────────────────────────
  if (msg.type === 'import_end') {
    // Guard: only run if _doImport hasn't already fired from the asset handlers
    if (_pendingPen) {
      await _doImport();
    }
    return;
  }
};

async function _doImport() {
  var pen    = _pendingPen;
  var images = _pendingImages;
  var icons  = _pendingIcons;
  _pendingPen    = null;  // clear so import_end guard works
  _pendingImages = {};
  _pendingIcons  = {};
  try {
    await runImport(pen, images, icons);
    figma.ui.postMessage({ type: 'done' });
  } catch (err) {
    console.error(err);
    figma.ui.postMessage({ type: 'error', message: String(err.message || err) });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// ENTRY POINT
// ─────────────────────────────────────────────────────────────────────────────

async function runImport(pen, imageMap, iconMap) {
  // imageMap is already { "filename.png" | "https://…" → imageHash }
  // Images were hashed one-by-one in the streaming handler above.
  var vars = pen.variables || {};

  // 1. Collect every unique font used in the file, then pre-load them all
  progress('Loading fonts…', 15);
  const fontSet = new Set();
  collectFonts(pen.children || [], vars, fontSet);
  fontSet.add(JSON.stringify({ family: 'Inter', style: 'Regular' }));

  await Promise.all(
    [...fontSet].map(f =>
      figma.loadFontAsync(JSON.parse(f)).catch(() => {
        // Try fallback style if specific weight is not found
        const parsed = JSON.parse(f);
        return figma.loadFontAsync({ family: parsed.family, style: 'Regular' }).catch(() => {});
      })
    )
  );

  // 3. Create all top-level nodes
  progress('Building frames…', 30);
  const created = [];
  const children = pen.children || [];
  for (let i = 0; i < children.length; i++) {
    progress('Building frames…', 30 + Math.round((i / children.length) * 65));
    const node = createNode(children[i], vars, imageMap, iconMap, null, null);
    if (node) {
      figma.currentPage.appendChild(node);
      created.push(node);
    }
  }

  // 4. Zoom to fit
  if (created.length > 0) {
    figma.viewport.scrollAndZoomIntoView(created);
  }
  figma.notify('✅ Pencil import complete!', { timeout: 3000 });
}

function progress(label, pct) {
  figma.ui.postMessage({ type: 'progress', label, pct });
}

// ─────────────────────────────────────────────────────────────────────────────
// FONT COLLECTION
// ─────────────────────────────────────────────────────────────────────────────

function collectFonts(nodes, vars, fontSet) {
  for (const node of nodes) {
    if (node.type === 'text') {
      const family = resolveVar(node.fontFamily, vars);
      const safeFamily = (typeof family === 'string' && family) ? family : 'Inter';
      const style = fontWeightToStyle(node.fontWeight, node.fontStyle);
      fontSet.add(JSON.stringify({ family: safeFamily, style }));
    }
    if (node.children) collectFonts(node.children, vars, fontSet);
  }
}

function fontWeightToStyle(weight, fontStyle) {
  const italic = fontStyle === 'italic';
  const w = String(weight || 'normal').toLowerCase();
  let name = 'Regular';
  if      (w === '100' || w === 'thin')                     name = 'Thin';
  else if (w === '200' || w === 'extralight')               name = 'Extra Light';
  else if (w === '300' || w === 'light')                    name = 'Light';
  else if (w === '400' || w === 'regular' || w === 'normal') name = 'Regular';
  else if (w === '500' || w === 'medium')                   name = 'Medium';
  else if (w === '600' || w === 'semibold')                 name = 'Semi Bold';
  else if (w === '700' || w === 'bold')                     name = 'Bold';
  else if (w === '800' || w === 'extrabold')                name = 'Extra Bold';
  else if (w === '900' || w === 'black')                    name = 'Black';

  if (italic) name = name === 'Regular' ? 'Italic' : name + ' Italic';
  return name;
}

// ─────────────────────────────────────────────────────────────────────────────
// VARIABLE RESOLUTION
// ─────────────────────────────────────────────────────────────────────────────

function resolveVar(value, vars) {
  if (typeof value === 'string' && value.startsWith('$')) {
    const key   = value.slice(1);
    const entry = vars[key];
    if (entry == null) return null;
    // Flat map  { key: "#hex" }  →  entry is the value directly
    if (typeof entry !== 'object') return entry;
    // Nested    { key: { value: "#hex" | [{value,theme},…] } }
    const val = entry.value;
    if (val == null) return null;
    // Theme-array format: [{value:"#hex", theme:{mode:"light"}}, …]
    if (Array.isArray(val)) {
      const light = val.find(function(t) { return t && t.theme && t.theme.mode === 'light'; }) || val[0];
      return light ? light.value : null;
    }
    return val;
  }
  return value;
}

// ─────────────────────────────────────────────────────────────────────────────
// COLOR PARSING
// Supports: #RGB  #RRGGBB  #RRGGBBAA
// ─────────────────────────────────────────────────────────────────────────────

function parseHex(raw) {
  if (!raw || typeof raw !== 'string') return { r: 0, g: 0, b: 0, a: 1 };
  const h = raw.replace('#', '').trim();
  if (h.length === 3) {
    return {
      r: parseInt(h[0] + h[0], 16) / 255,
      g: parseInt(h[1] + h[1], 16) / 255,
      b: parseInt(h[2] + h[2], 16) / 255,
      a: 1,
    };
  }
  if (h.length === 6) {
    return {
      r: parseInt(h.slice(0, 2), 16) / 255,
      g: parseInt(h.slice(2, 4), 16) / 255,
      b: parseInt(h.slice(4, 6), 16) / 255,
      a: 1,
    };
  }
  if (h.length === 8) {
    return {
      r: parseInt(h.slice(0, 2), 16) / 255,
      g: parseInt(h.slice(2, 4), 16) / 255,
      b: parseInt(h.slice(4, 6), 16) / 255,
      a: parseInt(h.slice(6, 8), 16) / 255,
    };
  }
  return { r: 0, g: 0, b: 0, a: 1 };
}

// ─────────────────────────────────────────────────────────────────────────────
// FILL PARSING → Figma Paint
// ─────────────────────────────────────────────────────────────────────────────

function parseFill(fill, vars, imageMap) {
  if (fill === null || fill === undefined) return null;

  // Resolve $variable references first
  const resolved = resolveVar(fill, vars);
  if (resolved === null) return null;
  fill = resolved;

  // ── Solid hex string ──────────────────────────────────────────────────────
  if (typeof fill === 'string') {
    const c = parseHex(fill);
    return { type: 'SOLID', color: { r: c.r, g: c.g, b: c.b }, opacity: c.a };
  }

  if (typeof fill !== 'object') return null;

  // Disabled fill
  if (fill.enabled === false) return null;

  // ── Image fill ────────────────────────────────────────────────────────────
  if (fill.type === 'image') {
    if (!fill.url) return null;
    // Remote URLs are stored in imageMap using the full URL as key.
    // Local paths like "./images/foo.png" are stored by filename only.
    var isRemote = fill.url.indexOf('http://') === 0 || fill.url.indexOf('https://') === 0;
    var key = isRemote
      ? fill.url
      : fill.url.replace(/^\.\/images\//, '').replace(/^images\//, '');
    var hash = imageMap[key];
    if (!hash) {
      console.warn('Image not found in imageMap:', key);
      return null;
    }
    var scaleMode =
      fill.mode === 'fit'   ? 'FIT'  :
      fill.mode === 'tile'  ? 'TILE' :
      fill.mode === 'crop'  ? 'CROP' : 'FILL';
    return { type: 'IMAGE', scaleMode, imageHash: hash };
  }

  // ── Gradient fill ─────────────────────────────────────────────────────────
  if (fill.type === 'gradient') {
    return parseGradientFill(fill, vars);
  }

  return null;
}

// Handles both a single fill value and an array of fill layers.
// Always returns a Figma Paint[].
function parseFills(rawFill, vars, imageMap) {
  if (Array.isArray(rawFill)) {
    return rawFill.map(f => parseFill(f, vars, imageMap)).filter(Boolean);
  }
  const p = parseFill(rawFill, vars, imageMap);
  return p ? [p] : [];
}

function parseGradientFill(fill, vars) {
  const rawColors = fill.colors || [];
  // Pencil sometimes stores positions on a 0–100 scale; Figma requires 0–1
  const needsNorm = rawColors.some(c => (c.position || 0) > 1);
  const stops = rawColors.map(c => {
    const colorVal = resolveVar(c.color, vars) || c.color || '#000000';
    const col = parseHex(colorVal);
    const pos = c.position != null ? c.position : 0;
    return { position: needsNorm ? pos / 100 : pos, color: { r: col.r, g: col.g, b: col.b, a: col.a } };
  });

  const rotation = fill.rotation != null ? fill.rotation : 0;

  if (fill.gradientType === 'linear') {
    return {
      type: 'GRADIENT_LINEAR',
      gradientTransform: linearGradientTransform(rotation),
      gradientStops: stops,
    };
  }

  if (fill.gradientType === 'radial') {
    return {
      type: 'GRADIENT_RADIAL',
      gradientTransform: radialGradientTransform(fill),
      gradientStops: stops,
    };
  }

  return null;
}

/**
 * Build a 2×3 affine transform for a linear gradient.
 * Pencil uses CSS-angle convention: 0° = bottom→top, 90° = left→right, 180° = top→bottom.
 */
function linearGradientTransform(angleDeg) {
  const rad = (angleDeg * Math.PI) / 180;
  // Direction vector in normalised [0,1] space
  const dx =  Math.sin(rad);
  const dy = -Math.cos(rad);
  // Start / end handles, centred on (0.5, 0.5)
  const sx = 0.5 - dx * 0.5;
  const sy = 0.5 - dy * 0.5;
  const ex = 0.5 + dx * 0.5;
  const ey = 0.5 + dy * 0.5;
  // Matrix that maps the unit segment [0,0]→[1,0] to [sx,sy]→[ex,ey]
  return [
    [ex - sx, -(ey - sy), sx],
    [ey - sy,   ex - sx,  sy],
  ];
}

/**
 * Build a 2×3 affine transform for a radial gradient.
 * Centres the ellipse at (0.5, 0.5); radii come from fill.size.
 */
function radialGradientTransform(fill) {
  const size = fill.size || {};
  const rw = ((size.width  !== undefined ? size.width  : 1)) / 2;
  const rh = ((size.height !== undefined ? size.height : 1)) / 2;
  return [
    [rw, 0,  0.5 - rw * 0.5],
    [0,  rh, 0.5 - rh * 0.5],
  ];
}

// ─────────────────────────────────────────────────────────────────────────────
// STROKE
// ─────────────────────────────────────────────────────────────────────────────

function applyStroke(node, stroke, vars) {
  if (!stroke) return;
  const rawFill = resolveVar(stroke.fill, vars) != null ? resolveVar(stroke.fill, vars) : stroke.fill;
  if (!rawFill || typeof rawFill !== 'string') return;
  const c = parseHex(rawFill);
  node.strokes = [{ type: 'SOLID', color: { r: c.r, g: c.g, b: c.b }, opacity: c.a }];
  if (typeof stroke.thickness === 'number') node.strokeWeight = stroke.thickness;
  switch (stroke.align) {
    case 'inside':  node.strokeAlign = 'INSIDE';  break;
    case 'outside': node.strokeAlign = 'OUTSIDE'; break;
    default:        node.strokeAlign = 'CENTER';  break;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// EFFECTS (drop shadow / inner shadow)
// ─────────────────────────────────────────────────────────────────────────────

function applyEffect(node, effect, vars) {
  if (!effect || effect.type !== 'shadow') return;
  const c = parseHex(effect.color || '#00000040');
  node.effects = [{
    type: effect.shadowType === 'inner' ? 'INNER_SHADOW' : 'DROP_SHADOW',
    color: { r: c.r, g: c.g, b: c.b, a: c.a },
    offset: { x: (effect.offset && effect.offset.x) || 0, y: (effect.offset && effect.offset.y) || 0 },
    radius: effect.blur   || 0,
    spread: effect.spread || 0,
    visible: true,
    blendMode: 'NORMAL',
  }];
}

// ─────────────────────────────────────────────────────────────────────────────
// CORNER RADIUS
// ─────────────────────────────────────────────────────────────────────────────

function applyCornerRadius(node, cornerRadius) {
  if (cornerRadius == null) return;
  if (typeof cornerRadius === 'number') {
    node.cornerRadius = cornerRadius;
  } else if (Array.isArray(cornerRadius)) {
    node.topLeftRadius     = cornerRadius[0] || 0;
    node.topRightRadius    = cornerRadius[1] || 0;
    node.bottomRightRadius = cornerRadius[2] || 0;
    node.bottomLeftRadius  = cornerRadius[3] || 0;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// PADDING
// ─────────────────────────────────────────────────────────────────────────────

function parsePadding(padding) {
  if (padding == null) return { top: 0, right: 0, bottom: 0, left: 0 };
  if (typeof padding === 'number') return { top: padding, right: padding, bottom: padding, left: padding };
  if (Array.isArray(padding)) {
    if (padding.length === 2) return { top: padding[0], right: padding[1], bottom: padding[0], left: padding[1] };
    if (padding.length >= 4)  return { top: padding[0], right: padding[1], bottom: padding[2], left: padding[3] };
  }
  return { top: 0, right: 0, bottom: 0, left: 0 };
}

// ─────────────────────────────────────────────────────────────────────────────
// SIZE HELPERS
// ─────────────────────────────────────────────────────────────────────────────

function isFillContainer(v) {
  return typeof v === 'string' && v.startsWith('fill_container');
}

/** Resolves a pencil size value to a concrete number, or null if it's fill/hug. */
function resolveSize(v, fallback) {
  if (typeof v === 'number') return v;
  if (isFillContainer(v) && typeof fallback === 'number') return fallback;
  return null;
}

function safeW(v, fallback) { const r = resolveSize(v, fallback); return (r != null && r > 0) ? r : 1; }
function safeH(v, fallback) { const r = resolveSize(v, fallback); return (r != null && r > 0) ? r : 1; }

// ─────────────────────────────────────────────────────────────────────────────
// ALIGN HELPERS
// ─────────────────────────────────────────────────────────────────────────────

function toCounterAlign(v) {
  if (v === 'center') return 'CENTER';
  if (v === 'flex_end' || v === 'end') return 'MAX';
  return 'MIN';
}

function toPrimaryAlign(v) {
  if (v === 'center') return 'CENTER';
  if (v === 'flex_end' || v === 'end') return 'MAX';
  if (v === 'space_between') return 'SPACE_BETWEEN';
  return 'MIN';
}

// ─────────────────────────────────────────────────────────────────────────────
// NODE DISPATCH
// ─────────────────────────────────────────────────────────────────────────────

function createNode(penNode, vars, imageMap, iconMap, parentW, parentH) {
  try {
    var node;
    switch (penNode.type) {
      case 'frame':     node = createFrame(penNode, vars, imageMap, iconMap, parentW, parentH); break;
      case 'rectangle': node = createRect(penNode, vars, imageMap, parentW, parentH);           break;
      case 'ellipse':   node = createEllipse(penNode, vars, imageMap, parentW, parentH);        break;
      case 'text':      node = createText(penNode, vars, parentW, parentH);                     break;
      case 'icon_font': node = createIconFont(penNode, vars, iconMap);                          break;
      case 'image':     node = createImageNode(penNode, vars, imageMap, parentW, parentH);      break;
      default:
        // group / unknown with children → treat as frame
        node = penNode.children ? createFrame(penNode, vars, imageMap, iconMap, parentW, parentH) : null;
    }
    // Apply opacity to every node type (0–1 in Pencil, 0–1 in Figma)
    if (node && penNode.opacity != null) {
      try { node.opacity = penNode.opacity; } catch (_) {}
    }
    return node;
  } catch (e) {
    console.error('createNode failed for', penNode.id, penNode.type, e);
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// FRAME
// ─────────────────────────────────────────────────────────────────────────────

function createFrame(penNode, vars, imageMap, iconMap, parentW, parentH) {
  const frame = figma.createFrame();
  frame.name = penNode.name || 'Frame';

  // ── Layout mode ───────────────────────────────────────────────────────────
  // Infer HORIZONTAL when gap/alignItems/justifyContent are present but no
  // explicit layout property (pencil convention for horizontal auto-layout rows).
  const hasAutoHints = penNode.gap != null || penNode.alignItems || penNode.justifyContent;
  const layoutMode =
    penNode.layout === 'vertical'   ? 'VERTICAL' :
    penNode.layout === 'horizontal' ? 'HORIZONTAL' :
    penNode.layout === 'none'       ? 'NONE' :
    hasAutoHints                    ? 'HORIZONTAL' : 'NONE';
  frame.layoutMode = layoutMode;

  // ── Size (set before adding children so Figma has a valid initial box) ────
  const w = safeW(penNode.width,  parentW);
  const h = safeH(penNode.height, parentH);
  frame.resize(w, h);

  // ── Position ──────────────────────────────────────────────────────────────
  if (penNode.x != null) frame.x = penNode.x;
  if (penNode.y != null) frame.y = penNode.y;

  // ── Clip content ──────────────────────────────────────────────────────────
  frame.clipsContent = penNode.clip !== false;

  // ── Fill ──────────────────────────────────────────────────────────────────
  frame.fills = parseFills(penNode.fill, vars, imageMap);

  // ── Corner radius ─────────────────────────────────────────────────────────
  applyCornerRadius(frame, penNode.cornerRadius);

  // ── Stroke ────────────────────────────────────────────────────────────────
  if (penNode.stroke) applyStroke(frame, penNode.stroke, vars);

  // ── Effects ───────────────────────────────────────────────────────────────
  if (penNode.effect) applyEffect(frame, penNode.effect, vars);

  // ── Auto-layout properties ────────────────────────────────────────────────
  if (layoutMode !== 'NONE') {
    if (penNode.gap != null) frame.itemSpacing = penNode.gap;

    const p = parsePadding(penNode.padding);
    frame.paddingTop    = p.top;
    frame.paddingRight  = p.right;
    frame.paddingBottom = p.bottom;
    frame.paddingLeft   = p.left;

    if (penNode.alignItems)      frame.counterAxisAlignItems = toCounterAlign(penNode.alignItems);
    if (penNode.justifyContent)  frame.primaryAxisAlignItems = toPrimaryAlign(penNode.justifyContent);

    // Frame's own sizing along its axes
    if (typeof penNode.width === 'number') {
      try { frame.layoutSizingHorizontal = 'FIXED'; } catch (_) {}
    } else if (penNode.width == null) {
      try { frame.layoutSizingHorizontal = 'HUG'; } catch (_) {}
    }

    if (typeof penNode.height === 'number') {
      try { frame.layoutSizingVertical = 'FIXED'; } catch (_) {}
    } else if (penNode.height == null) {
      try { frame.layoutSizingVertical = 'HUG'; } catch (_) {}
    }
  }

  // ── Children ──────────────────────────────────────────────────────────────
  for (const child of (penNode.children || [])) {
    const childNode = createNode(child, vars, imageMap, iconMap, w, h);
    if (!childNode) continue;

    frame.appendChild(childNode);

    // Absolute positioning (within auto-layout or absolute parents)
    if (child.layoutPosition === 'absolute') {
      try { childNode.layoutPositioning = 'ABSOLUTE'; } catch (_) {}
      // For fill_container on absolutely positioned children, stretch via constraints
      if (isFillContainer(child.width) || isFillContainer(child.height)) {
        try {
          childNode.constraints = {
            horizontal: isFillContainer(child.width)  ? 'SCALE' : 'MIN',
            vertical:   isFillContainer(child.height) ? 'SCALE' : 'MIN',
          };
        } catch (_) {}
        // Resize to fill parent
        const fw = isFillContainer(child.width)  ? w : childNode.width;
        const fh = isFillContainer(child.height) ? h : childNode.height;
        try { childNode.resize(fw > 0 ? fw : 1, fh > 0 ? fh : 1); } catch (_) {}
      }
      // Restore absolute x/y (auto-layout resets them)
      if (child.x != null) childNode.x = child.x;
      if (child.y != null) childNode.y = child.y;
    }

    // Fill-container sizing for auto-layout children
    if (layoutMode !== 'NONE' && child.layoutPosition !== 'absolute') {
      if (isFillContainer(child.width)) {
        try { childNode.layoutSizingHorizontal = 'FILL'; } catch (_) {}
      }
      if (isFillContainer(child.height)) {
        try { childNode.layoutSizingVertical = 'FILL'; } catch (_) {}
      }
      // Text nodes must never be vertically stretched by auto-layout.
      // Explicitly pin them to HUG so the content-driven height wins.
      if (child.type === 'text' && !isFillContainer(child.height)) {
        try { childNode.layoutSizingVertical = 'HUG'; } catch (_) {}
      }
    }
  }

  return frame;
}

// ─────────────────────────────────────────────────────────────────────────────
// ICON FONT (SVG)
// ─────────────────────────────────────────────────────────────────────────────

function createIconFont(penNode, vars, iconMap) {
  var family = penNode.iconFontFamily || 'lucide';
  var key    = family + '/' + penNode.iconFontName;
  var svg    = iconMap[key];
  if (!svg) {
    console.warn('Icon SVG not found:', key);
    return null;
  }
  try {
    var group = figma.createNodeFromSvg(svg);
    group.name = penNode.name || penNode.iconFontName || 'Icon';
    var w = typeof penNode.width  === 'number' ? penNode.width  : 20;
    var h = typeof penNode.height === 'number' ? penNode.height : 20;
    group.resize(w, h);
    if (penNode.x != null) group.x = penNode.x;
    if (penNode.y != null) group.y = penNode.y;
    // Tint all vector children — apply to fills or strokes depending on what
    // each vector already uses (Lucide icons are stroke-based; other families
    // may be fill-based).  If a node has neither, default to strokes.
    var fillVal = resolveVar(penNode.fill, vars);
    if (typeof fillVal === 'string') {
      var c = parseHex(fillVal);
      var paint = { type: 'SOLID', color: { r: c.r, g: c.g, b: c.b }, opacity: c.a };
      (function tint(node) {
        for (var i = 0; i < (node.children || []).length; i++) {
          var ch = node.children[i];
          var hasFills   = 'fills'   in ch && ch.fills.length   > 0;
          var hasStrokes = 'strokes' in ch && ch.strokes.length > 0;
          if (hasFills)                              try { ch.fills   = [paint]; } catch(_) {}
          if (hasStrokes)                            try { ch.strokes = [paint]; } catch(_) {}
          if (!hasFills && !hasStrokes && 'strokes' in ch) try { ch.strokes = [paint]; } catch(_) {}
          tint(ch);
        }
      })(group);
    }
    return group;
  } catch (e) {
    console.warn('createIconFont failed:', key, String(e));
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// IMAGE NODE  (type:"image" — the node itself is an image, not an image fill)
// ─────────────────────────────────────────────────────────────────────────────

function createImageNode(penNode, vars, imageMap, parentW, parentH) {
  const rect = figma.createRectangle();
  rect.name = penNode.name || 'Image';
  rect.resize(safeW(penNode.width, parentW), safeH(penNode.height, parentH));
  if (penNode.x != null) rect.x = penNode.x;
  if (penNode.y != null) rect.y = penNode.y;

  // Build a synthetic image-fill descriptor and delegate to parseFill
  const syntheticFill = { type: 'image', url: penNode.url || penNode.src || '', mode: penNode.mode };
  const paint = parseFill(syntheticFill, vars, imageMap);
  rect.fills = paint ? [paint] : [];

  applyCornerRadius(rect, penNode.cornerRadius);
  if (penNode.stroke) applyStroke(rect, penNode.stroke, vars);
  if (penNode.effect) applyEffect(rect, penNode.effect, vars);
  return rect;
}

// ─────────────────────────────────────────────────────────────────────────────
// RECTANGLE
// ─────────────────────────────────────────────────────────────────────────────

function createRect(penNode, vars, imageMap, parentW, parentH) {
  const rect = figma.createRectangle();
  rect.name = penNode.name || 'Rectangle';

  rect.resize(safeW(penNode.width, parentW), safeH(penNode.height, parentH));

  if (penNode.x != null) rect.x = penNode.x;
  if (penNode.y != null) rect.y = penNode.y;

  rect.fills = parseFills(penNode.fill, vars, imageMap);

  applyCornerRadius(rect, penNode.cornerRadius);
  if (penNode.stroke) applyStroke(rect, penNode.stroke, vars);
  if (penNode.effect) applyEffect(rect, penNode.effect, vars);

  return rect;
}

// ─────────────────────────────────────────────────────────────────────────────
// ELLIPSE
// ─────────────────────────────────────────────────────────────────────────────

function createEllipse(penNode, vars, imageMap, parentW, parentH) {
  const ellipse = figma.createEllipse();
  ellipse.name = penNode.name || 'Ellipse';

  ellipse.resize(safeW(penNode.width, parentW), safeH(penNode.height, parentH));

  if (penNode.x != null) ellipse.x = penNode.x;
  if (penNode.y != null) ellipse.y = penNode.y;

  ellipse.fills = parseFills(penNode.fill, vars, imageMap);

  if (penNode.stroke) applyStroke(ellipse, penNode.stroke, vars);
  if (penNode.effect) applyEffect(ellipse, penNode.effect, vars);

  return ellipse;
}

// ─────────────────────────────────────────────────────────────────────────────
// TEXT
// ─────────────────────────────────────────────────────────────────────────────

function createText(penNode, vars, parentW, parentH) {
  const text = figma.createText();
  text.name = penNode.name || 'Text';

  if (penNode.x != null) text.x = penNode.x;
  if (penNode.y != null) text.y = penNode.y;

  // ── Font ──────────────────────────────────────────────────────────────────
  const rawFamily = resolveVar(penNode.fontFamily, vars);
  const family = (typeof rawFamily === 'string' && rawFamily) ? rawFamily : 'Inter';
  const style  = fontWeightToStyle(penNode.fontWeight, penNode.fontStyle);

  try {
    text.fontName = { family, style };
  } catch (_) {
    try { text.fontName = { family, style: 'Regular' }; } catch (_2) {
      text.fontName = { family: 'Inter', style: 'Regular' };
    }
  }

  // ── Font size ─────────────────────────────────────────────────────────────
  if (penNode.fontSize) text.fontSize = penNode.fontSize;

  // ── Fill (color) ──────────────────────────────────────────────────────────
  const fillVal = resolveVar(penNode.fill, vars);
  if (typeof fillVal === 'string') {
    const c = parseHex(fillVal);
    text.fills = [{ type: 'SOLID', color: { r: c.r, g: c.g, b: c.b }, opacity: c.a }];
  }
  // If fill is unresolved or missing, leave Figma's default black intact
  // (setting fills=[] would make the text invisible).

  // ── Letter spacing ────────────────────────────────────────────────────────
  if (penNode.letterSpacing != null) {
    text.letterSpacing = { value: penNode.letterSpacing, unit: 'PIXELS' };
  }

  // ── Line height ───────────────────────────────────────────────────────────
  if (penNode.lineHeight != null) {
    // Pencil uses a multiplier (e.g. 1.5); Figma wants PERCENT
    text.lineHeight = { value: penNode.lineHeight * 100, unit: 'PERCENT' };
  }

  // ── Text alignment ────────────────────────────────────────────────────────
  switch (penNode.textAlign) {
    case 'center':  text.textAlignHorizontal = 'CENTER';    break;
    case 'right':   text.textAlignHorizontal = 'RIGHT';     break;
    case 'justify': text.textAlignHorizontal = 'JUSTIFIED'; break;
    default:        text.textAlignHorizontal = 'LEFT';      break;
  }

  // ── Text growth / sizing ──────────────────────────────────────────────────
  if (penNode.textGrowth === 'fixed-width') {
    // Fixed-width: height grows with content, width is fixed.
    // Resolve the initial width so Figma can calculate line-wrapping and height
    // correctly BEFORE the node is appended to its auto-layout parent.
    // Without an initial width the text defaults to 1 px, wrapping to hundreds
    // of lines, and that over-tall height can "stick" even after FILL is applied.
    let initialW = null;
    if (typeof penNode.width === 'number' && penNode.width > 0) {
      initialW = penNode.width;
    } else if (isFillContainer(penNode.width) && typeof parentW === 'number' && parentW > 0) {
      initialW = parentW;
    }
    text.textAutoResize = 'HEIGHT';
    if (initialW) {
      try { text.resize(initialW, text.height > 0 ? text.height : 20); } catch (_) {}
    }
  } else if (typeof penNode.width === 'number' && penNode.width > 0) {
    // Explicit numeric width but no textGrowth: treat as fixed-width too.
    text.textAutoResize = 'HEIGHT';
    try { text.resize(penNode.width, text.height > 0 ? text.height : 20); } catch (_) {}
  } else {
    // No width constraint: auto-size both axes.
    text.textAutoResize = 'WIDTH_AND_HEIGHT';
  }

  // ── Content (set LAST — requires font to be loaded) ───────────────────────
  text.characters = penNode.content || '';

  return text;
}
