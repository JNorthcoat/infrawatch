/**
 * build-modules.mjs
 * Transforms sydney-infrawatch.html into a Vite-compatible module structure.
 *
 * Outputs:
 *   src/styles/main.css   — extracted CSS
 *   src/app.js            — script section with data consts removed, boot wrapped
 *   src/state.js          — async data loader
 *   src/main.js           — entry point
 *   index.html            — thin HTML shell
 *
 * Run from project root: node scripts/build-modules.mjs
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const HTML_PATH = join(ROOT, '..', 'sydney-infrawatch.html');

const html = readFileSync(HTML_PATH, 'utf8');
console.log(`Read ${HTML_PATH} — ${(html.length / 1024 / 1024).toFixed(2)} MB\n`);

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Extract text between first occurrence of open and matching close tag. */
function extractBlock(text, openTag, closeTag) {
  const start = text.indexOf(openTag);
  if (start === -1) throw new Error(`${openTag} not found`);
  const contentStart = start + openTag.length;
  const end = text.indexOf(closeTag, contentStart);
  if (end === -1) throw new Error(`${closeTag} not found`);
  return { content: text.slice(contentStart, end), start, end: end + closeTag.length };
}

/** Extract the raw JS value (object/array literal) for a named const. */
function extractRawValue(text, varName) {
  const marker = `\nconst ${varName} = `;
  const markerIdx = text.indexOf(marker);
  if (markerIdx === -1) return null;

  const valueStart = markerIdx + marker.length;
  const opener = text[valueStart];
  if (opener !== '{' && opener !== '[') return null;

  let depth = 0;
  let inString = false;
  let stringChar = '';
  let escape = false;

  for (let i = valueStart; i < text.length; i++) {
    const c = text[i];
    if (escape) { escape = false; continue; }
    if (c === '\\' && inString) { escape = true; continue; }
    if (!inString && c === '/' && text[i + 1] === '/') {
      const nl = text.indexOf('\n', i);
      i = nl === -1 ? text.length : nl;
      continue;
    }
    if (!inString && (c === '"' || c === "'" || c === '`')) {
      inString = true; stringChar = c; continue;
    }
    if (inString && c === stringChar) { inString = false; continue; }
    if (inString) continue;
    if (c === '{' || c === '[') depth++;
    else if (c === '}' || c === ']') {
      depth--;
      if (depth === 0) {
        // Include any trailing semicolon
        let end = i + 1;
        while (end < text.length && text[end] === ';') end++;
        return { from: markerIdx, to: end };
      }
    }
  }
  return null;
}

// ── Step 1: Extract CSS ───────────────────────────────────────────────────────

const styleBlock = extractBlock(html, '<style>', '</style>');
const css = styleBlock.content.trim();
writeFileSync(join(ROOT, 'src', 'styles', 'main.css'), css + '\n', 'utf8');
console.log(`✓ src/styles/main.css (${(css.length / 1024).toFixed(1)} KB)`);

// ── Step 2: Extract script section ───────────────────────────────────────────

const scriptBlock = extractBlock(html, '<script>', '</script>');
let script = scriptBlock.content;
console.log(`  Script block: ${(script.length / 1024).toFixed(0)} KB`);

// ── Step 3: Strip extracted data const declarations ───────────────────────────
// These 13 vars have been moved to public/data/*.json
const DATA_VARS = [
  'P', 'PROJECT_IMPACT', 'ELECTORATES', 'CBD_STATIONS', 'BOOTH_DATA',
  'AMENITIES', 'SUBURB_PRICES', 'POLICY_IMPACT', 'ARTICLES',
  'SUBURBS_GEOJSON', 'FED_BOUNDARIES_GEOJSON', 'STATE_BOUNDARIES_GEOJSON',
  'COUNCILS_GEOJSON',
];

let stripped = script;
let removedCount = 0;
for (const name of DATA_VARS) {
  const loc = extractRawValue(stripped, name);
  if (!loc) {
    console.warn(`  ⚠ Could not strip const ${name}`);
    continue;
  }
  stripped = stripped.slice(0, loc.from) + stripped.slice(loc.to);
  removedCount++;
}
console.log(`✓ Stripped ${removedCount} data const declarations`);

// ── Step 4: Wrap boot sequence in export async function _boot(data) ───────────
// The boot sequence is everything from the first inline DOM call (just before // BOOT)
// to the end of the script. We detect by finding the last `buildCatBtns();` or the
// `// ntag-btn class needed` marker (whichever comes first near the end).

const bootMarkers = [
  '// ntag-btn class needed',
  'buildCatBtns();',
];
let bootStart = -1;
for (const marker of bootMarkers) {
  const idx = stripped.lastIndexOf(marker);
  if (idx !== -1) {
    if (bootStart === -1 || idx < bootStart) bootStart = idx;
  }
}

let bodyCode, bootCode;
if (bootStart === -1) {
  console.warn('  ⚠ Could not find boot sequence marker — app.js will need manual boot wrapping');
  bodyCode = stripped;
  bootCode = '';
} else {
  bodyCode = stripped.slice(0, bootStart).trimEnd();
  bootCode = stripped.slice(bootStart).trimEnd();
}

// Data assignment block — assigns state module values to local vars
const dataAssign = DATA_VARS.map(v => `  ${v} = _data.${v};`).join('\n');

const preamble = `// Generated by scripts/build-modules.mjs — do not edit by hand.
// Original: sydney-infrawatch.html
import { loadAll as _loadAll } from './state.js';

// Data vars — populated by _boot() via the state module
let ${DATA_VARS.join(', ')};

// Expose key scoring functions for tests
`;

const bootFn = `
export async function _boot() {
  const _data = await _loadAll();
${dataAssign}

  // ── Original boot sequence ──
${bootCode.split('\n').map(l => '  ' + l).join('\n')}
}
`;

const appJs = preamble + '\n' + bodyCode + '\n' + bootFn;
writeFileSync(join(ROOT, 'src', 'app.js'), appJs, 'utf8');
console.log(`✓ src/app.js (${(appJs.length / 1024).toFixed(0)} KB)`);

// ── Step 5: Write src/state.js ────────────────────────────────────────────────

const stateJs = `// Data loading module — fetches all JSON data files in parallel.
// All paths are relative to Vite's public/ root.

const FILES = {
  P:                      '/data/projects.json',
  PROJECT_IMPACT:         '/data/project-impact.json',
  ELECTORATES:            '/data/electorates.json',
  CBD_STATIONS:           '/data/cbd-stations.json',
  BOOTH_DATA:             '/data/booths.json',
  AMENITIES:              '/data/amenities.json',
  SUBURB_PRICES:          '/data/suburb-prices.json',
  POLICY_IMPACT:          '/data/policy.json',
  ARTICLES:               '/data/articles.json',
  SUBURBS_GEOJSON:        '/data/suburbs.geojson',
  FED_BOUNDARIES_GEOJSON: '/data/fed-boundaries.geojson',
  STATE_BOUNDARIES_GEOJSON: '/data/state-boundaries.geojson',
  COUNCILS_GEOJSON:       '/data/council-boundaries.geojson',
};

let _cache = null;

export async function loadAll() {
  if (_cache) return _cache;
  const entries = await Promise.all(
    Object.entries(FILES).map(async ([key, path]) => {
      const r = await fetch(path);
      if (!r.ok) throw new Error(\`Failed to load \${path}: \${r.status}\`);
      return [key, await r.json()];
    })
  );
  _cache = Object.fromEntries(entries);

  // ARTICLES have date strings — convert to Date objects to match original behaviour
  if (_cache.ARTICLES) {
    _cache.ARTICLES = _cache.ARTICLES.map(a => ({
      ...a,
      date: new Date(a.date),
    }));
  }

  return _cache;
}
`;

writeFileSync(join(ROOT, 'src', 'state.js'), stateJs, 'utf8');
console.log('✓ src/state.js');

// ── Step 6: Write src/main.js ─────────────────────────────────────────────────

const mainJs = `import { _boot } from './app.js';

_boot().catch(err => {
  console.error('InfraWatch boot failed:', err);
  document.body.innerHTML = \`<div style="color:#FF6677;padding:2rem;font-family:monospace">
    Boot error: \${err.message}<br><small>\${err.stack}</small>
  </div>\`;
});
`;

writeFileSync(join(ROOT, 'src', 'main.js'), mainJs, 'utf8');
console.log('✓ src/main.js');

// ── Step 7: Build index.html ──────────────────────────────────────────────────
// Take the original HTML skeleton: everything before <style> and after </script>,
// replace <style>...</style> with a CSS link, replace <script>...</script> with module script.

const beforeStyle = html.slice(0, styleBlock.start).trimEnd();
const afterStyleBeforeScript = html.slice(styleBlock.end, scriptBlock.start).trimEnd();
const afterScript = html.slice(scriptBlock.end).trimEnd();

const indexHtml = `${beforeStyle}
<link rel="stylesheet" href="/src/styles/main.css">
${afterStyleBeforeScript}
<script type="module" src="/src/main.js"></script>
${afterScript}
`;

writeFileSync(join(ROOT, 'index.html'), indexHtml, 'utf8');
console.log('✓ index.html');

console.log('\nDone. Run: npm run dev');
