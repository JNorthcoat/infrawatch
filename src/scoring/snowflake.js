// 5-axis Infra Score — standalone testable module.
// All functions accept a `data` argument:
//   { P, PROJECT_IMPACT, ELECTORATES, FED_BOUNDARIES_GEOJSON, STATE_BOUNDARIES_GEOJSON, SUBURBS_GEOJSON }
//
// Higher score = better outlook on every axis (see HANDOFF.md §2).
// Score range: 1–5 integer. Letter grade: A ≥4, B ≥3, C ≥2, D <2.

import {
  _polygonCentroid, _findContainingElec, _suburbCentroid,
} from './geo.js';

// ── helpers ──────────────────────────────────────────────────────────────────

function projectsAffectingSuburb(suburb, data) {
  const { P, PROJECT_IMPACT } = data;
  const upper = (suburb || '').toUpperCase();
  const result = [];
  for (const p of (P || [])) {
    const im = (PROJECT_IMPACT || {})[p.id];
    if (!im || !im.catchmentSuburbs) continue;
    if (im.catchmentSuburbs.some((s) => (s || '').toUpperCase() === upper))
      result.push({ project: p, impact: im });
  }
  return result;
}

function clamp(score) {
  return Math.max(1, Math.min(5, Math.round(score)));
}

// ── per-axis scoring ──────────────────────────────────────────────────────────

function _scorePolitical(suburb, data) {
  const { ELECTORATES, FED_BOUNDARIES_GEOJSON, STATE_BOUNDARIES_GEOJSON, SUBURBS_GEOJSON } = data;
  const projs = projectsAffectingSuburb(suburb, data);

  let projRiskAvg = null;
  if (projs.length > 0) {
    let sumW = 0, sumWeighted = 0;
    projs.forEach(({ project: p }) => {
      const w = p.val || 1;
      sumW += w;
      sumWeighted += (p.politicalRisk != null ? p.politicalRisk : 50) * w;
    });
    projRiskAvg = sumWeighted / sumW;
  }
  let projScore = 3;
  if (projRiskAvg !== null) {
    if (projRiskAvg < 20)      projScore = 5;
    else if (projRiskAvg < 35) projScore = 4;
    else if (projRiskAvg < 55) projScore = 3;
    else if (projRiskAvg < 75) projScore = 2;
    else                       projScore = 1;
  }

  const c = SUBURBS_GEOJSON ? _suburbCentroid(suburb, SUBURBS_GEOJSON) : null;
  let seatScore = 3, fedName = null, stateName = null, fedMargin = null, stateMargin = null;
  if (c) {
    const lngLat = [c[1], c[0]];
    if (FED_BOUNDARIES_GEOJSON)
      fedName = _findContainingElec(lngLat, FED_BOUNDARIES_GEOJSON, ['districtName', 'name', 'NAME']);
    if (STATE_BOUNDARIES_GEOJSON)
      stateName = _findContainingElec(lngLat, STATE_BOUNDARIES_GEOJSON, ['districtName', 'name', 'NAME']);
    if (ELECTORATES) {
      if (fedName) {
        const e = ELECTORATES.find(
          (x) => x.level === 'Federal' && (x.name || '').toLowerCase() === fedName.toLowerCase()
        );
        if (e) fedMargin = Math.abs(e.margin || 0);
      }
      if (stateName) {
        const e = ELECTORATES.find(
          (x) => x.level === 'State' && (x.name || '').toLowerCase() === stateName.toLowerCase()
        );
        if (e) stateMargin = Math.abs(e.margin || 0);
      }
    }
    const m2s = (m) => (m === null ? 3 : m < 2 ? 1 : m < 5 ? 2 : m < 8 ? 3 : m < 12 ? 4 : 5);
    seatScore = (m2s(fedMargin) + m2s(stateMargin)) / 2;
  }

  const score = clamp(projScore * 0.6 + seatScore * 0.4);
  const seatStr = (fedName || stateName)
    ? `Fed: ${fedName || '—'}${fedMargin !== null ? ` (${fedMargin.toFixed(1)}%)` : ''}, State: ${stateName || '—'}${stateMargin !== null ? ` (${stateMargin.toFixed(1)}%)` : ''}`
    : 'Seats: unknown';
  const projStr = projs.length === 0
    ? 'no projects in catchment'
    : `${projs.length} project${projs.length > 1 ? 's' : ''}, avg politicalRisk ${(projRiskAvg || 0).toFixed(0)}/100`;
  return { score, detail: `${projStr} · ${seatStr}` };
}

function _scoreBudget(suburb, data) {
  const projs = projectsAffectingSuburb(suburb, data);
  if (projs.length === 0) return { score: 1, detail: 'No active projects in catchment' };

  const statusBoost = (status) => {
    if (!status) return 0.80;
    const t = status.toLowerCase();
    if (t.includes('operational'))        return 1.10;
    if (t.includes('under construction')) return 1.10;
    if (t.includes('opening'))            return 1.05;
    if (t.includes('procurement'))        return 0.90;
    if (t.includes('planning'))           return 0.70;
    if (t.includes('concept'))            return 0.50;
    return 0.80;
  };

  let sumW = 0, sumWeighted = 0;
  projs.forEach(({ project: p }) => {
    const w = p.val || 1;
    const commit = (p.prob || 50) * statusBoost(p.status);
    sumW += w;
    sumWeighted += commit * w;
  });
  const avgCommit = sumWeighted / sumW;

  let score;
  if (avgCommit > 90)      score = 5;
  else if (avgCommit > 70) score = 4;
  else if (avgCommit > 50) score = 3;
  else if (avgCommit > 30) score = 2;
  else                     score = 1;

  return {
    score,
    detail: `${projs.length} project${projs.length > 1 ? 's' : ''}, cost-weighted commitment ${avgCommit.toFixed(0)}/100`,
  };
}

function _scoreSpend(suburb, data) {
  const projs = projectsAffectingSuburb(suburb, data);
  if (projs.length === 0) return { score: 1, detail: 'No projects in catchment' };

  let totalSpend = 0;
  projs.forEach(({ project: p, impact: im }) => {
    const catchSize = (im.catchmentSuburbs || []).length || 1;
    totalSpend += (p.val || 0) / catchSize;
  });

  let score;
  if (totalSpend > 3000)      score = 5;
  else if (totalSpend > 1500) score = 4;
  else if (totalSpend > 500)  score = 3;
  else if (totalSpend > 100)  score = 2;
  else                        score = 1;

  const fmt = totalSpend >= 1000
    ? `$${(totalSpend / 1000).toFixed(1)}B`
    : `$${totalSpend.toFixed(0)}M`;
  return {
    score,
    detail: `~${fmt} attributable spend across ${projs.length} project${projs.length > 1 ? 's' : ''}`,
  };
}

function _scoreMomentum(suburb, data) {
  const projs = projectsAffectingSuburb(suburb, data);
  if (projs.length === 0) return { score: 1, detail: 'No projects in catchment' };

  const NOW = 2026;
  let sumW = 0, sumMom = 0;
  projs.forEach(({ project: p }) => {
    const w = p.val || 1;
    const yr = parseInt(p.year) || (NOW + 10);
    const yearsOut = yr - NOW;

    const t = (p.status || '').toLowerCase();
    let activeness;
    if (t.includes('under construction'))  activeness = 1.00;
    else if (t.includes('opening'))        activeness = 0.95;
    else if (t.includes('procurement'))    activeness = 0.75;
    else if (t.includes('planning'))       activeness = 0.50;
    else if (t.includes('concept'))        activeness = 0.25;
    else if (t.includes('operational'))    activeness = 0.30;
    else                                   activeness = 0.50;

    let proximity;
    if (yearsOut <= 0)        proximity = 0.40;
    else if (yearsOut <= 3)   proximity = 1.00;
    else if (yearsOut <= 7)   proximity = 0.75;
    else if (yearsOut <= 15)  proximity = 0.50;
    else                      proximity = 0.25;

    const probFrac = (p.prob || 50) / 100;
    sumW += w;
    sumMom += activeness * proximity * probFrac * w;
  });
  const avgMom = sumMom / sumW;

  let score;
  if (avgMom > 0.60)      score = 5;
  else if (avgMom > 0.42) score = 4;
  else if (avgMom > 0.27) score = 3;
  else if (avgMom > 0.13) score = 2;
  else                    score = 1;

  return {
    score,
    detail: `Momentum index ${(avgMom * 100).toFixed(0)}/100 (status × horizon × probability)`,
  };
}

function _scoreDiversity(suburb, data) {
  const projs = projectsAffectingSuburb(suburb, data);
  if (projs.length === 0) return { score: 1, detail: 'No projects in catchment' };

  const cats = new Set();
  projs.forEach(({ project: p }) => { if (p.cat) cats.add(p.cat); });
  const n = cats.size;
  return {
    score: n >= 5 ? 5 : n,
    detail: `${n} project type${n !== 1 ? 's' : ''}: ${[...cats].join(', ') || '—'}`,
  };
}

// ── public API ────────────────────────────────────────────────────────────────

/**
 * Compute the 5-axis Infra Score for a suburb.
 * @param {string} suburb - Suburb name (case-insensitive)
 * @param {object} data   - { P, PROJECT_IMPACT, ELECTORATES, FED_BOUNDARIES_GEOJSON,
 *                            STATE_BOUNDARIES_GEOJSON, SUBURBS_GEOJSON }
 * @returns {{ suburb, political, budget, spend, momentum, diversity }}
 */
export function computeSnowflake(suburb, data) {
  return {
    suburb,
    political: _scorePolitical(suburb, data),
    budget:    _scoreBudget(suburb, data),
    spend:     _scoreSpend(suburb, data),
    momentum:  _scoreMomentum(suburb, data),
    diversity: _scoreDiversity(suburb, data),
  };
}

export function compositeScore(sf) {
  const axes = ['political', 'budget', 'spend', 'momentum', 'diversity'];
  const sum = axes.reduce((acc, k) => acc + sf[k].score, 0);
  return sum / axes.length;
}

export function letterGrade(composite) {
  if (composite >= 4.0) return 'A';
  if (composite >= 3.0) return 'B';
  if (composite >= 2.0) return 'C';
  return 'D';
}
