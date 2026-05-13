// Pure geometric utility functions — no external data dependencies.

export function _haversineKm(la1, lo1, la2, lo2) {
  const R = 6371;
  const r1 = la1 * Math.PI / 180, r2 = la2 * Math.PI / 180;
  const dr = (la2 - la1) * Math.PI / 180, dl = (lo2 - lo1) * Math.PI / 180;
  const a = Math.sin(dr / 2) ** 2 + Math.cos(r1) * Math.cos(r2) * Math.sin(dl / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export function _polygonCentroid(feat) {
  const pts = [];
  const walk = (a) => {
    if (typeof a[0] === 'number' && a.length >= 2) pts.push(a);
    else if (Array.isArray(a)) a.forEach(walk);
  };
  if (!feat || !feat.geometry || !feat.geometry.coordinates) return null;
  walk(feat.geometry.coordinates);
  if (!pts.length) return null;
  let la = 0, lo = 0;
  for (const [lng, lat] of pts) { la += lat; lo += lng; }
  return [la / pts.length, lo / pts.length]; // [lat, lng] — Leaflet order
}

export function _pointInRing(pt, ring) {
  let inside = false;
  const x = pt[0], y = pt[1];
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], yi = ring[i][1];
    const xj = ring[j][0], yj = ring[j][1];
    if (((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi))
      inside = !inside;
  }
  return inside;
}

export function _pointInFeature(pt, feat) {
  const g = feat && feat.geometry;
  if (!g) return false;
  if (g.type === 'Polygon') {
    if (!_pointInRing(pt, g.coordinates[0])) return false;
    for (let h = 1; h < g.coordinates.length; h++)
      if (_pointInRing(pt, g.coordinates[h])) return false;
    return true;
  }
  if (g.type === 'MultiPolygon') {
    for (const poly of g.coordinates) {
      if (!_pointInRing(pt, poly[0])) continue;
      let inHole = false;
      for (let h = 1; h < poly.length; h++) if (_pointInRing(pt, poly[h])) { inHole = true; break; }
      if (!inHole) return true;
    }
  }
  return false;
}

export function _findContainingElec(lngLat, gj, keys) {
  if (!gj || !gj.features) return null;
  for (const feat of gj.features) {
    if (_pointInFeature(lngLat, feat)) {
      const p = feat.properties || {};
      for (const k of keys) { if (p[k]) return String(p[k]); }
    }
  }
  return null;
}

export function _suburbCentroid(name, suburbsGeoJSON) {
  const upper = (name || '').toUpperCase();
  const feat = (suburbsGeoJSON.features || []).find(
    (f) => (f.properties && (f.properties.name || '')).toUpperCase() === upper
  );
  return feat ? _polygonCentroid(feat) : null; // [lat, lng]
}
