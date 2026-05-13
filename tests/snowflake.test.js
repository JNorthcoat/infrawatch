// Regression tests for the 5-axis Infra Score (snowflake).
// Uses real public/data JSON files so scores are stable across refactors.
// Expected grades per HANDOFF.md §9: Parramatta → B, Mosman → D.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect, beforeAll } from 'vitest';
import { computeSnowflake, compositeScore, letterGrade } from '../src/scoring/snowflake.js';

const DATA_DIR = join(import.meta.dirname, '..', 'public', 'data');

function loadJSON(file) {
  return JSON.parse(readFileSync(join(DATA_DIR, file), 'utf8'));
}

let data;
beforeAll(() => {
  data = {
    P:                        loadJSON('projects.json'),
    PROJECT_IMPACT:           loadJSON('project-impact.json'),
    ELECTORATES:              loadJSON('electorates.json'),
    FED_BOUNDARIES_GEOJSON:   loadJSON('fed-boundaries.geojson'),
    STATE_BOUNDARIES_GEOJSON: loadJSON('state-boundaries.geojson'),
    SUBURBS_GEOJSON:          loadJSON('suburbs.geojson'),
  };
});

function grade(suburb) {
  const sf = computeSnowflake(suburb, data);
  return letterGrade(compositeScore(sf));
}

function score(suburb) {
  const sf = computeSnowflake(suburb, data);
  return compositeScore(sf);
}

// ── known-suburb grade fixtures ───────────────────────────────────────────────

describe('known-suburb grades (per HANDOFF.md)', () => {
  it('Parramatta → Grade B (high infra exposure)', () => {
    expect(grade('Parramatta')).toBe('B');
  });

  it('Mosman → Grade D (low infra exposure, safe seat)', () => {
    expect(grade('Mosman')).toBe('D');
  });
});

// ── relative ordering ─────────────────────────────────────────────────────────

describe('ordering: high-infra suburbs score above low-infra', () => {
  it('Parramatta scores above Mosman', () => {
    expect(score('Parramatta')).toBeGreaterThan(score('Mosman'));
  });

  it('Pyrmont scores above Mosman (Metro West corridor)', () => {
    expect(score('Pyrmont')).toBeGreaterThan(score('Mosman'));
  });

  it('Five Dock scores above Mosman (Metro West corridor)', () => {
    expect(score('Five Dock')).toBeGreaterThan(score('Mosman'));
  });
});

// ── score range invariants ────────────────────────────────────────────────────

const TEST_SUBURBS = [
  'Parramatta', 'Mosman', 'Penrith', 'Bondi', 'Five Dock',
  'Bankstown', 'Pyrmont', 'North Strathfield',
];

describe('score invariants', () => {
  TEST_SUBURBS.forEach((suburb) => {
    it(`${suburb}: all axes in [1,5]`, () => {
      const sf = computeSnowflake(suburb, data);
      const axes = ['political', 'budget', 'spend', 'momentum', 'diversity'];
      axes.forEach((ax) => {
        expect(sf[ax].score).toBeGreaterThanOrEqual(1);
        expect(sf[ax].score).toBeLessThanOrEqual(5);
      });
    });

    it(`${suburb}: composite in [1,5]`, () => {
      const c = compositeScore(computeSnowflake(suburb, data));
      expect(c).toBeGreaterThanOrEqual(1);
      expect(c).toBeLessThanOrEqual(5);
    });

    it(`${suburb}: letterGrade returns A/B/C/D`, () => {
      const g = grade(suburb);
      expect(['A', 'B', 'C', 'D']).toContain(g);
    });
  });
});

// ── no-data suburb handles gracefully ────────────────────────────────────────

describe('edge cases', () => {
  it('unknown suburb: project-dependent axes all score 1 (no catchment)', () => {
    const sf = computeSnowflake('ZZZNOPLACELIKETHIS', data);
    // budget/spend/momentum/diversity return 1 when no projects found
    ['budget', 'spend', 'momentum', 'diversity'].forEach((ax) =>
      expect(sf[ax].score).toBe(1)
    );
  });

  it('unknown suburb: political axis returns neutral (3) when centroid lookup fails', () => {
    const sf = computeSnowflake('ZZZNOPLACELIKETHIS', data);
    // No seat data resolvable → blended default = 3
    expect(sf.political.score).toBe(3);
  });
});
