import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'bun:test';
import { fetchViewRsc, scrapeView, type FetchImpl } from '../src/scrape/skills';
import { HttpRetryable } from '../src/scrape/skills';
import { ParseError, type ParsedRow, type View } from '../src/types';

const fixtures: Record<View, string> = {
  'all-time': readFileSync('tests/fixtures/rsc-all-time.txt', 'utf-8'),
  trending: readFileSync('tests/fixtures/rsc-trending.txt', 'utf-8'),
  hot: readFileSync('tests/fixtures/rsc-hot.txt', 'utf-8'),
};

function res(body: string, status = 200): Response {
  return new Response(body, { status });
}

describe('scrapeView — mocked fetch', () => {
  test('returns parsed rows for each view', async () => {
    for (const view of ['all-time', 'trending', 'hot'] as const) {
      const f: FetchImpl = async (url) => {
        expect(url).toBe(`https://www.skills.sh/${view === 'all-time' ? '' : view}`);
        return res(fixtures[view]);
      };
      const rows = await scrapeView(view, { fetchImpl: f });
      expect(rows.length).toBe(12);
      expect(rows[0]!.rank).toBe(1);
    }
  });

  test('sends RSC: 1 header', async () => {
    let sawHeader: unknown;
    const f: FetchImpl = async (_url, init) => {
      sawHeader = (init?.headers as Record<string, string>)?.RSC;
      return res(fixtures.trending);
    };
    await scrapeView('trending', { fetchImpl: f });
    expect(sawHeader).toBe('1');
  });

  test('retries on 429 then succeeds', async () => {
    let calls = 0;
    const f: FetchImpl = async () => {
      calls++;
      if (calls < 3) return res('rate limited', 429);
      return res(fixtures.trending);
    };
    const rows = await scrapeView('trending', {
      fetchImpl: f,
      baseMs: 1,
    });
    expect(calls).toBe(3);
    expect(rows.length).toBe(12);
  });

  test('does not retry on 404', async () => {
    let calls = 0;
    const f: FetchImpl = async () => {
      calls++;
      return res('not found', 404);
    };
    await expect(
      scrapeView('trending', { fetchImpl: f, baseMs: 1 }),
    ).rejects.toThrow('HTTP 404');
    expect(calls).toBe(1);
  });

  test('throws ParseError-ish error when payload view mismatches', async () => {
    const f: FetchImpl = async () => res(fixtures.hot); // hot 冒充 trending
    await expect(
      scrapeView('trending', { fetchImpl: f }),
    ).rejects.toThrow(ParseError);
  });
});

describe('fetchViewRsc — retry classification', () => {
  test('exposes HttpRetryable for 5xx', async () => {
    const f: FetchImpl = async () => res('boom', 503);
    await expect(
      fetchViewRsc('hot', { fetchImpl: f, tries: 1 }),
    ).rejects.toBeInstanceOf(HttpRetryable);
  });
});

describe('ParsedRow shape', () => {
  test('hot rows carry change/installs_yesterday', async () => {
    const f: FetchImpl = async () => res(fixtures.hot);
    const rows: ParsedRow[] = await scrapeView('hot', { fetchImpl: f });
    expect(rows[0]!.change).not.toBeNull();
    expect(rows[0]!.installs_yesterday).not.toBeNull();
  });
});
