#!/usr/bin/env node
/**
 * update-prices.mjs
 *
 * Downloads NSW Valuer General property sales data and computes
 * rolling 12-month median prices + YoY growth per suburb.
 *
 * Usage:
 *   node scripts/update-prices.mjs             # use cached ZIPs if present
 *   node scripts/update-prices.mjs --force     # re-download even if cached
 *   node scripts/update-prices.mjs --verify    # print first few B-records, no write
 *
 * Data source:
 *   https://www.valuergeneral.nsw.gov.au/__psi/yearly/YYYY.zip
 *   Structure: YYYY.zip → YYYYMMDD.zip (weekly) → NNN_SALES_DATA_*.DAT (per district)
 *
 * DAT record format — only B records contain sale data:
 *   Field (0-based):
 *    0  Record type       must be "B" to process
 *    1  District code
 *    2  Property ID
 *    3  Sale counter
 *    4  Download date
 *    5  Property name
 *    6  Unit number       non-empty → apartment/unit
 *    7  House number
 *    8  Street name
 *    9  Suburb/Locality   ALL CAPS
 *   10  Postcode
 *   11  Land area
 *   12  Area type
 *   13  Contract date     YYYYMMDD
 *   14  Settlement date   YYYYMMDD
 *   15  Purchase price    integer $AUD
 *   16  Zone code
 *   17  Nature            R=Residence, V=Vacant, C=Commercial, F=Farm, I=Industrial
 *   18  Primary purpose
 *   19  Strata lot number non-empty → strata/unit title
 *   20  Component code
 *   21  Sale code
 *   22  Interest of sale
 *   23  Dealing number
 */

import { createWriteStream } from 'node:fs';
import { mkdir, access, readFile, writeFile } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import readline from 'node:readline';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import unzipper from 'unzipper';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT      = path.join(__dirname, '..');
const CACHE_DIR = path.join(ROOT, 'tmp', 'vg-cache');
const OUT_FILE  = path.join(ROOT, 'public', 'data', 'suburb-prices.json');
const BASE_URL  = 'https://www.valuergeneral.nsw.gov.au/__psi/yearly';

const MIN_PRICE = 100_000;
const MAX_PRICE = 15_000_000;
const MIN_SALES = 5;

// Field indices within a B record
const F = {
  TYPE:        0,
  UNIT_NO:     6,
  SUBURB:      9,
  CONTRACT:   13,
  SETTLEMENT: 14,
  PRICE:      15,
  NATURE:     17,
  STRATA_LOT: 19,
};

const args   = process.argv.slice(2);
const FORCE  = args.includes('--force');
const VERIFY = args.includes('--verify');

// ── Date helpers ──────────────────────────────────────────────────────────────

function parseVGDate(str) {
  // YYYYMMDD
  const s = str?.trim();
  if (!s || s.length < 8) return null;
  const y = +s.slice(0, 4), m = +s.slice(4, 6) - 1, d = +s.slice(6, 8);
  const dt = new Date(y, m, d);
  return isNaN(dt.getTime()) ? null : dt;
}

// ── Statistics ────────────────────────────────────────────────────────────────

function median(sorted) {
  const n = sorted.length;
  if (!n) return null;
  const mid = Math.floor(n / 2);
  return n % 2 === 1 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

// ── Download ──────────────────────────────────────────────────────────────────

async function downloadIfNeeded(url, dest) {
  if (!FORCE) {
    try {
      await access(dest);
      const { statSync } = await import('node:fs');
      console.log(`  Cached: ${path.basename(dest)} (${(statSync(dest).size / 1e6).toFixed(0)} MB)`);
      return;
    } catch {}
  }
  console.log(`  Downloading: ${url}`);
  const res = await fetch(url, {
    headers: { 'User-Agent': 'SydneyInfraWatch/1.0 (data pipeline)' },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  await pipeline(res.body, createWriteStream(dest));
  const { statSync } = await import('node:fs');
  console.log(`  Saved: ${path.basename(dest)} (${(statSync(dest).size / 1e6).toFixed(0)} MB)`);
}

// ── Parse a single DAT text stream into sales map ────────────────────────────

async function parseDatStream(stream, sales) {
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  for await (const line of rl) {
    const f = line.split(';');
    if (f[F.TYPE] !== 'B') continue;
    if (f.length < 20) continue;
    if (f[F.NATURE]?.trim() !== 'R') continue;                  // residential only

    const suburb = f[F.SUBURB]?.trim().toUpperCase();
    if (!suburb) continue;

    const price = parseInt(f[F.PRICE]?.trim(), 10);
    if (!Number.isFinite(price) || price < MIN_PRICE || price > MAX_PRICE) continue;

    const date = parseVGDate(f[F.CONTRACT]) ?? parseVGDate(f[F.SETTLEMENT]);
    if (!date) continue;

    const isUnit = !!(f[F.UNIT_NO]?.trim() || f[F.STRATA_LOT]?.trim());

    let list = sales.get(suburb);
    if (!list) { list = []; sales.set(suburb, list); }
    list.push({ price, ts: date.getTime(), isUnit });
  }
  rl.close();
}

// ── Parse outer yearly ZIP → inner weekly ZIPs → DAT files ───────────────────

async function parseYearlyZip(outerPath, sales, verifyMode = false) {
  const outer = await unzipper.Open.file(outerPath);
  let weekCount = 0, saleCount = 0;
  const sizeBefore = sales.size;

  for (const weekEntry of outer.files) {
    if (!weekEntry.path.toLowerCase().endsWith('.zip')) continue;

    // Buffer the inner weekly ZIP (they're ~50–400 KB each)
    const innerBuf = await new Promise((resolve, reject) => {
      const chunks = [];
      const s = weekEntry.stream();
      s.on('data', c => chunks.push(c));
      s.on('end', () => resolve(Buffer.concat(chunks)));
      s.on('error', reject);
    });

    const inner = await unzipper.Open.buffer(innerBuf);
    let weekSales = 0;

    for (const datEntry of inner.files) {
      if (!datEntry.path.toLowerCase().endsWith('.dat')) continue;

      if (verifyMode && weekCount < 1) {
        console.log(`\n  === ${weekEntry.path} / ${datEntry.path} ===`);
        const rl = readline.createInterface({ input: datEntry.stream(), crlfDelay: Infinity });
        let n = 0;
        for await (const line of rl) {
          if (line.split(';')[0] === 'B') { console.log(line); if (++n >= 3) break; }
        }
        rl.close();
        continue;
      }

      const before = [...sales.values()].reduce((a, v) => a + v.length, 0);
      await parseDatStream(datEntry.stream(), sales);
      const after = [...sales.values()].reduce((a, v) => a + v.length, 0);
      weekSales += after - before;
      saleCount += after - before;
    }

    weekCount++;
    if (!verifyMode && weekCount % 10 === 0) {
      process.stdout.write(`  ${weekCount} weeks parsed, ${saleCount.toLocaleString()} sales so far...\r`);
    }
  }

  if (!verifyMode) {
    console.log(`  ${weekCount} weeks, ${saleCount.toLocaleString()} sales from ${path.basename(outerPath)}`);
  }
}

// ── Compute per-suburb stats ──────────────────────────────────────────────────

function computeStats(sales) {
  const now     = Date.now();
  const MS_12MO = 365.25 * 24 * 3600 * 1000;
  const cut12   = now - MS_12MO;
  const cut24   = now - 2 * MS_12MO;
  const result  = {};

  for (const [suburb, records] of sales) {
    const recent = records.filter(r => r.ts >= cut12);
    const prior  = records.filter(r => r.ts >= cut24 && r.ts < cut12);
    if (recent.length < MIN_SALES) continue;

    const recentPrices = recent.map(r => r.price).sort((a, b) => a - b);
    const priorPrices  = prior.map(r => r.price).sort((a, b) => a - b);

    const med12   = median(recentPrices);
    const medPrev = prior.length >= MIN_SALES ? median(priorPrices) : null;
    const growth  = medPrev != null
      ? +((med12 - medPrev) / medPrev * 100).toFixed(1)
      : null;

    const unitCount  = recent.filter(r => r.isUnit).length;
    const type = unitCount > recent.length / 2 ? 'unit' : 'house';

    result[suburb] = { median: med12, growth12mo: growth, type };
  }
  return result;
}

// ── Merge with existing data ──────────────────────────────────────────────────

function mergeWithExisting(fresh, existing) {
  const out = {};
  for (const [suburb, old] of Object.entries(existing)) {
    out[suburb] = fresh[suburb]
      ? { growth12mo: fresh[suburb].growth12mo ?? old.growth12mo, median: fresh[suburb].median, type: fresh[suburb].type }
      : old;
  }
  for (const [suburb, data] of Object.entries(fresh)) {
    if (!out[suburb]) out[suburb] = data;
  }
  return out;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  await mkdir(CACHE_DIR, { recursive: true });

  const currentYear = new Date().getFullYear();
  const years = [currentYear - 1, currentYear - 2];
  const zipPaths = [];

  for (const year of years) {
    const dest = path.join(CACHE_DIR, `${year}.zip`);
    console.log(`\n[Year ${year}]`);
    try {
      await downloadIfNeeded(`${BASE_URL}/${year}.zip`, dest);
      zipPaths.push(dest);
    } catch (err) {
      console.warn(`  Warning: ${err.message}`);
    }
  }

  if (!zipPaths.length) { console.error('No data available.'); process.exit(1); }

  if (VERIFY) {
    for (const zp of zipPaths) await parseYearlyZip(zp, new Map(), true);
    return;
  }

  console.log('\n[Parsing sales data]');
  const sales = new Map();
  for (const zp of zipPaths) await parseYearlyZip(zp, sales);
  console.log(`  Suburbs found: ${sales.size.toLocaleString()}`);

  console.log('\n[Computing medians]');
  const fresh = computeStats(sales);
  console.log(`  Suburbs with ≥${MIN_SALES} recent sales: ${Object.keys(fresh).length}`);

  console.log('\n[Merging with existing data]');
  const existing = JSON.parse(await readFile(OUT_FILE, 'utf8'));
  const merged   = mergeWithExisting(fresh, existing);
  const updatedN = Object.keys(merged).filter(s => fresh[s]).length;
  const staleN   = Object.keys(merged).filter(s => !fresh[s]).length;
  console.log(`  Updated: ${updatedN}  Retained stale: ${staleN}`);

  const sorted = Object.fromEntries(Object.keys(merged).sort().map(k => [k, merged[k]]));
  await writeFile(OUT_FILE, JSON.stringify(sorted, null, 2) + '\n', 'utf8');
  console.log(`\n[Done] ${OUT_FILE} — ${Object.keys(sorted).length} suburbs, run: ${new Date().toISOString().slice(0, 10)}`);
}

main().catch(err => { console.error('\nFatal:', err.message); process.exit(1); });
