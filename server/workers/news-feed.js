/**
 * infrawatch-news — Cloudflare Worker
 *
 * GET /          → JSON array of normalised articles (cached 30 min in KV)
 * GET /?refresh  → bypass cache, re-fetch all feeds
 *
 * Article schema matches src/state.js ARTICLES format:
 *   { id, title, url, date, src, cats, sev, pids }
 */

const CACHE_KEY = 'news_v1';
const CACHE_TTL = 1800; // 30 minutes

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
};

// ── Feed definitions ──────────────────────────────────────────────────────────

const FEEDS = [
  {
    url: 'https://infrastructure.org.au/feed/',
    src: 'Infrastructure Australia',
    cats: ['infrastructure', 'policy'],
  },
  {
    url: 'https://www.governmentnews.com.au/feed/',
    src: 'Government News',
    cats: ['government', 'infrastructure'],
  },
  {
    url: 'https://www.railway-technology.com/feed/',
    src: 'Railway Technology',
    cats: ['transport', 'rail'],
  },
  {
    url: 'https://reneweconomy.com.au/feed/',
    src: 'Renew Economy',
    cats: ['energy', 'climate'],
  },
  {
    url: 'https://australianaviation.com.au/feed/',
    src: 'Australian Aviation',
    cats: ['transport', 'aviation'],
  },
];

// Keywords used to infer additional categories and severity.
const CAT_KEYWORDS = {
  transport:      ['metro', 'train', 'rail', 'bus', 'tram', 'light rail', 'airport', 'road', 'motorway', 'highway', 'tunnel'],
  housing:        ['housing', 'apartment', 'dwelling', 'rezoning', 'development', 'build-to-rent', 'affordable'],
  energy:         ['renewable', 'solar', 'wind', 'battery', 'grid', 'energy', 'electricity', 'power'],
  water:          ['water', 'dam', 'flood', 'desalination', 'catchment', 'stormwater'],
  infrastructure: ['infrastructure', 'construction', 'contract', 'tender', 'funding', 'budget'],
  government:     ['government', 'minister', 'parliament', 'policy', 'legislation', 'council'],
  property:       ['property', 'price', 'median', 'suburb', 'real estate', 'auction', 'clearance'],
};

const SEV_KEYWORDS = {
  critical: ['emergency', 'crisis', 'cancelled', 'collapsed', 'scrapped', 'billion', '$10b', '$20b'],
  high:     ['approved', 'awarded', 'opened', 'launched', 'completed', 'milestone', 'funding confirmed'],
  low:      ['opinion', 'analysis', 'review', 'profile', 'explainer'],
};

// Sydney infrastructure project names for pids matching (subset — extend as needed)
const PROJECT_NAMES = {
  1:  ['metro west', 'sydney metro west'],
  2:  ['wsa metro', 'western sydney airport metro', 'aerotropolis'],
  3:  ['wsa airport', 'western sydney airport', 'badgerys creek'],
  4:  ['metro csw', 'metro city', 'bankstown', 'sydenham'],
  5:  ['northern beaches', 'beaches link'],
  6:  ['m6', 'm6 stage 1'],
  7:  ['parramatta light rail', 'plr'],
  8:  ['northwest metro', 'metro northwest'],
  9:  ['b-line', 'bline'],
  10: ['fast rail', 'high speed rail'],
};

// ── RSS parsing ───────────────────────────────────────────────────────────────

function extractTag(xml, tag) {
  const re = new RegExp(`<${tag}[^>]*>(?:<\\!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?<\\/${tag}>`, 'i');
  const m = xml.match(re);
  return m ? m[1].trim() : '';
}

function extractAttr(xml, tag, attr) {
  const re = new RegExp(`<${tag}[^>]*\\s${attr}="([^"]*)"`, 'i');
  const m = xml.match(re);
  return m ? m[1].trim() : '';
}

function parseItems(feedXml) {
  const items = [];
  const itemRe = /<item[\s>]([\s\S]*?)<\/item>/gi;
  let m;
  while ((m = itemRe.exec(feedXml)) !== null) {
    items.push(m[1]);
  }
  return items;
}

function parseDate(str) {
  if (!str) return new Date();
  const d = new Date(str);
  return isNaN(d.getTime()) ? new Date() : d;
}

function slugId(url) {
  // Stable 8-char hash from URL
  let h = 0;
  for (let i = 0; i < url.length; i++) {
    h = ((h << 5) - h + url.charCodeAt(i)) | 0;
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

// ── Category / severity inference ─────────────────────────────────────────────

function inferCats(text, baseCats) {
  const lower = text.toLowerCase();
  const cats = new Set(baseCats);
  for (const [cat, keywords] of Object.entries(CAT_KEYWORDS)) {
    if (keywords.some((kw) => lower.includes(kw))) cats.add(cat);
  }
  return [...cats].slice(0, 4);
}

function inferSev(text) {
  const lower = text.toLowerCase();
  for (const [sev, keywords] of Object.entries(SEV_KEYWORDS)) {
    if (keywords.some((kw) => lower.includes(kw))) return sev;
  }
  return 'medium';
}

function inferPids(text) {
  const lower = text.toLowerCase();
  const pids = [];
  for (const [id, names] of Object.entries(PROJECT_NAMES)) {
    if (names.some((n) => lower.includes(n))) pids.push(Number(id));
  }
  return pids;
}

// ── Feed fetching ─────────────────────────────────────────────────────────────

async function fetchFeed(feed) {
  try {
    const res = await fetch(feed.url, {
      headers: { 'User-Agent': 'InfraWatch/1.0 (+https://infrawatch.sydney)' },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return [];
    const xml = await res.text();
    const items = parseItems(xml);

    return items.slice(0, 15).map((item) => {
      const title = extractTag(item, 'title');
      const url = extractTag(item, 'link') || extractAttr(item, 'link', 'href');
      const pubDate = extractTag(item, 'pubDate') || extractTag(item, 'dc:date') || extractTag(item, 'published');
      const description = extractTag(item, 'description') || extractTag(item, 'content:encoded') || '';
      const combined = `${title} ${description}`;

      return {
        id: slugId(url || title),
        title: title || '(no title)',
        url: url || '',
        date: parseDate(pubDate).toISOString(),
        src: feed.src,
        cats: inferCats(combined, feed.cats),
        sev: inferSev(combined),
        pids: inferPids(combined),
      };
    }).filter((a) => a.title && a.url);
  } catch {
    return [];
  }
}

async function fetchAllFeeds() {
  const results = await Promise.allSettled(FEEDS.map(fetchFeed));
  const articles = results
    .filter((r) => r.status === 'fulfilled')
    .flatMap((r) => r.value);

  // Deduplicate by id, sort newest first
  const seen = new Set();
  return articles
    .filter((a) => { if (seen.has(a.id)) return false; seen.add(a.id); return true; })
    .sort((a, b) => new Date(b.date) - new Date(a.date))
    .slice(0, 60);
}

// ── Worker entry point ────────────────────────────────────────────────────────

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS });
    }

    const url = new URL(request.url);
    const forceRefresh = url.searchParams.has('refresh');

    // Try cache first
    if (!forceRefresh && env.NEWS_CACHE) {
      const cached = await env.NEWS_CACHE.get(CACHE_KEY);
      if (cached) {
        const payload = JSON.parse(cached);
        return new Response(JSON.stringify(payload), {
          headers: { ...CORS, 'X-Cache': 'HIT', 'X-Updated': payload._updated },
        });
      }
    }

    // Fetch fresh
    const articles = await fetchAllFeeds();
    const payload = { articles, _updated: new Date().toISOString(), _count: articles.length };

    // Store in KV (best-effort)
    if (env.NEWS_CACHE) {
      await env.NEWS_CACHE.put(CACHE_KEY, JSON.stringify(payload), { expirationTtl: CACHE_TTL });
    }

    return new Response(JSON.stringify(payload), {
      headers: { ...CORS, 'X-Cache': 'MISS', 'X-Updated': payload._updated },
    });
  },
};
