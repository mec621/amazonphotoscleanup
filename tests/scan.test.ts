import { describe, expect, it } from 'vitest';
import { SEARCH_OFFSET_CAP } from '../src/adapter/amazon';
import { plan } from '../src/pipeline/scan';

const noop = () => {};

function fakeAdapter(perYear: Record<number, number>, monthFilterWorks: boolean, perMonth?: (year: number, month: number) => number, ascendingSortWorks = true) {
  return {
    ascendingSortWorks,
    oldestYear: async () => Math.min(...Object.keys(perYear).map(Number)),
    countPhotos: async (year?: number, month?: number) => {
      const y = perYear[year!] ?? 0;
      if (month === undefined || !monthFilterWorks) return y; // an ignored filter returns the whole year
      return perMonth ? perMonth(year!, month) : Math.floor(y / 12) + (month <= y % 12 ? 1 : 0);
    },
  };
}

describe('scan plan', () => {
  it('reads small years whole', async () => {
    const p = await plan(fakeAdapter({ 2025: 500 }, true), { kind: 'year', year: 2025 }, noop);
    expect(p).toEqual([{ key: '2025', year: 2025, count: 500, total: 500 }]);
  });

  it('splits a big year by month when the month filter works', async () => {
    const p = await plan(fakeAdapter({ 2026: 12015 }, true), { kind: 'year', year: 2026 }, noop);
    expect(p).toHaveLength(12);
    expect(p.reduce((s, r) => s + r.count, 0)).toBe(12015);
    expect(p[0]).toMatchObject({ key: '2026-01', month: 1 });
  });

  it('reads a big year from both ends when Amazon ignores the month filter', async () => {
    const p = await plan(fakeAdapter({ 2026: 12015 }, false), { kind: 'year', year: 2026 }, noop);
    expect(p).toEqual([
      { key: '2026-desc', year: 2026, month: undefined, sort: 'DESC', count: SEARCH_OFFSET_CAP, total: 12015 },
      { key: '2026-asc', year: 2026, month: undefined, sort: 'ASC', count: 12015 - SEARCH_OFFSET_CAP, total: 12015 },
    ]);
  });

  it('reads one oversized month from both ends', async () => {
    const p = await plan(fakeAdapter({ 2026: 12015 }, true, (_y, m) => (m === 7 ? 10000 : m === 8 ? 2015 : 0)), { kind: 'year', year: 2026 }, noop);
    expect(p.map((r) => r.key)).toEqual(['2026-07-desc', '2026-07-asc', '2026-08']);
  });

  it('stops with a clear error when neither the month filter nor oldest-first sort works', async () => {
    await expect(plan(fakeAdapter({ 2026: 12015 }, false, undefined, false), { kind: 'year', year: 2026 }, noop)).rejects.toThrow(/can't be split/);
  });

  it('refuses ranges too big to cover', async () => {
    await expect(plan(fakeAdapter({ 2026: 2 * SEARCH_OFFSET_CAP + 1 }, false), { kind: 'year', year: 2026 }, noop)).rejects.toThrow(/more than this scanner/);
  });

  it('plans every year from the oldest for "all photos"', async () => {
    const p = await plan(fakeAdapter({ [new Date().getUTCFullYear() - 1]: 10, [new Date().getUTCFullYear()]: 20 }, true), { kind: 'all' }, noop);
    expect(p.map((r) => r.count)).toEqual([10, 20]);
  });
});
