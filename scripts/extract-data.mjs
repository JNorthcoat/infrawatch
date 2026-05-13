/**
 * One-shot migration script: extracts all data constants from sydney-infrawatch.html
 * into individual JSON files under public/data/.
 *
 * Run from project root: node scripts/extract-data.mjs
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const HTML_PATH = join(__dirname, '..', '..', 'sydney-infrawatch.html');
const OUT_DIR = join(__dirname, '..', 'public', 'data');

const DATA_VARS = [
  { name: 'P',                      file: 'projects.json' },
  { name: 'PROJECT_IMPACT',         file: 'project-impact.json' },
  { name: 'ELECTORATES',            file: 'electorates.json' },
  { name: 'CBD_STATIONS',           file: 'cbd-stations.json' },
  { name: 'BOOTH_DATA',             file: 'booths.json' },
  { name: 'AMENITIES',              file: 'amenities.json' },
  { name: 'SUBURB_PRICES',          file: 'suburb-prices.json' },
  { name: 'POLICY_IMPACT',          file: 'policy.json' },
  { name: 'ARTICLES',               file: 'articles.json' },
  { name: 'SUBURBS_GEOJSON',        file: 'suburbs.geojson' },
  { name: 'FED_BOUNDARIES_GEOJSON', file: 'fed-boundaries.geojson' },
  { name: 'STATE_BOUNDARIES_GEOJSON', file: 'state-boundaries.geojson' },
  { name: 'COUNCILS_GEOJSON',       file: 'council-boundaries.geojson' },
];

/** Extract the raw JS value string for a named const from the full HTML text. */
function extractRawValue(text, varName) {
  // Look for `const VARNAME = ` preceded by a newline (avoids partial matches)
  const marker = `\nconst ${varName} = `;
  const markerIdx = text.indexOf(marker);
  if (markerIdx === -1) throw new Error(`Variable "${varName}" not found in HTML`);

  const valueStart = markerIdx + marker.length;
  const opener = text[valueStart];
  if (opener !== '{' && opener !== '[')
    throw new Error(`Unexpected opener "${opener}" for ${varName} at pos ${valueStart}`);

  // Walk forward tracking bracket depth, respecting strings and escape sequences.
  let depth = 0;
  let inString = false;
  let stringChar = '';
  let escape = false;

  for (let i = valueStart; i < text.length; i++) {
    const c = text[i];

    if (escape) { escape = false; continue; }
    if (c === '\\' && inString) { escape = true; continue; }

    // Skip single-line comments (// ...) to avoid false string triggers from apostrophes.
    if (!inString && c === '/' && text[i + 1] === '/') {
      const nl = text.indexOf('\n', i);
      i = nl === -1 ? text.length : nl;
      continue;
    }

    if (!inString && (c === '"' || c === "'" || c === '`')) {
      inString = true;
      stringChar = c;
      continue;
    }
    if (inString && c === stringChar) {
      inString = false;
      continue;
    }
    if (inString) continue;

    if (c === '{' || c === '[') depth++;
    else if (c === '}' || c === ']') {
      depth--;
      if (depth === 0) return text.slice(valueStart, i + 1);
    }
  }
  throw new Error(`Could not find closing bracket for "${varName}"`);
}

/** Evaluate a JS literal to a JS value (safe for data-only literals). */
function evalLiteral(raw) {
  // eslint-disable-next-line no-new-func
  return new Function(`return (${raw});`)();
}

console.log(`Reading ${HTML_PATH} ...`);
const html = readFileSync(HTML_PATH, 'utf8');
console.log(`  File size: ${(html.length / 1024 / 1024).toFixed(2)} MB\n`);

let ok = 0;
let fail = 0;

for (const { name, file } of DATA_VARS) {
  try {
    process.stdout.write(`Extracting ${name} → ${file} ... `);
    const raw = extractRawValue(html, name);
    const value = evalLiteral(raw);
    const json = JSON.stringify(value, null, 2);
    const outPath = join(OUT_DIR, file);
    writeFileSync(outPath, json, 'utf8');

    // Round-trip verification
    const roundTripped = JSON.parse(readFileSync(outPath, 'utf8'));
    const origJson = JSON.stringify(value);
    const rtJson = JSON.stringify(roundTripped);
    if (origJson !== rtJson) throw new Error('Round-trip mismatch');

    const kb = (json.length / 1024).toFixed(1);
    console.log(`OK (${kb} KB)`);
    ok++;
  } catch (err) {
    console.log(`FAILED: ${err.message}`);
    fail++;
  }
}

console.log(`\nDone: ${ok} succeeded, ${fail} failed.`);
if (fail > 0) process.exit(1);
