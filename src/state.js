// Data loading module — fetches all JSON data files in parallel.
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
      if (!r.ok) throw new Error(`Failed to load ${path}: ${r.status}`);
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
