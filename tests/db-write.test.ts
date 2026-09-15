import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { migrate } from 'drizzle-orm/bun-sqlite/migrator';
import { and, eq } from 'drizzle-orm';
import { closeDb, openDb, type DB } from '../src/db/client';
import { skill, skillReadme, skillView } from '../src/db/schema';
import { enrichReadmes, writeBatch } from '../src/commands/fetch';
import type { ParsedRow, View } from '../src/types';

function row(overrides: Partial<ParsedRow> = {}): ParsedRow {
  return {
    pk: 'vercel-labs/skills/find-skills',
    source: 'vercel-labs/skills',
    skill_id: 'find-skills',
    name: 'find-skills',
    installs: 3392887,
    rank: 1,
    is_official: true,
    weekly_installs: null,
    installs_yesterday: null,
    change: null,
    ...overrides,
  };
}

let db: DB;

beforeEach(() => {
  db = openDb(':memory:');
  migrate(db, { migrationsFolder: './src/db/migrations' });
});
afterEach(() => closeDb(db));

describe('writeBatch — first run', () => {
  test('inserts skill and skill_view rows with is_latest=1, update_count=1', () => {
    const now = 1_789_000_000;
    writeBatch(db, {
      now,
      parsed: {
        'all-time': [row({ rank: 1 })],
        trending: [row({ rank: 3, installs: 17926, is_official: null })],
        hot: [
          row({
            pk: 'bankai-skills/superpowers/ai-image-generation',
            source: 'bankai-skills/superpowers',
            skill_id: 'ai-image-generation',
            rank: 1,
            installs: 14,
            installs_yesterday: 0,
            change: 14,
          }),
        ],
      },
    });

    const skillRows = db.select().from(skill).all();
    expect(skillRows.length).toBe(2); // find-skills + ai-image-generation
    expect(skillRows.find((s) => s.pk === 'vercel-labs/skills/find-skills')!.installs_all_time).toBe(3392887);

    const all = db.select().from(skillView).all();
    expect(all.length).toBe(3); // 1 per view
    for (const r of all) {
      expect(r.is_latest).toBe(true);
      expect(r.update_count).toBe(1);
      expect(r.first_captured_at).toBe(r.captured_at);
    }
  });

  test('same skill across views maps to one skill row', () => {
    const now = 1_789_000_000;
    const r = row();
    writeBatch(db, {
      now,
      parsed: {
        'all-time': [r],
        trending: [row({ rank: 2, installs: 100 })],
        hot: [row({ rank: 5, installs: 3, change: 3, installs_yesterday: 0 })],
      },
    });
    expect(db.select().from(skill).all().length).toBe(1);
    expect(db.select().from(skillView).all().length).toBe(3);
  });
});

describe('writeBatch — same view_date second run (UPSERT)', () => {
  test('row count unchanged; update_count incremented; first_captured_at frozen', () => {
    const t1 = 1_789_000_000;
    const t2 = t1 + 3600; // 一小时后,同一天
    writeBatch(db, {
      now: t1,
      parsed: {
        trending: [row({ rank: 1, installs: 100 })],
        'all-time': [],
        hot: [],
      },
    });
    writeBatch(db, {
      now: t2,
      parsed: {
        trending: [row({ rank: 3, installs: 250 })],
        'all-time': [],
        hot: [],
      },
    });

    const all = db
      .select()
      .from(skillView)
      .where(eq(skillView.skill_pk, 'vercel-labs/skills/find-skills'))
      .all();
    expect(all.length).toBe(1);
    const r = all[0]!;
    expect(r.is_latest).toBe(true);
    expect(r.update_count).toBe(2);
    expect(r.first_captured_at).toBe(t1);
    expect(r.captured_at).toBe(t2);
    expect(r.rank).toBe(3);
    expect(r.installs).toBe(250);
  });

  test('all-time refresh updates skill.installs_all_time', () => {
    const t1 = 1_789_000_000;
    writeBatch(db, {
      now: t1,
      parsed: {
        'all-time': [row({ installs: 1000 })],
        trending: [],
        hot: [],
      },
    });
    writeBatch(db, {
      now: t1 + 60,
      parsed: {
        'all-time': [row({ installs: 2000 })],
        trending: [],
        hot: [],
      },
    });
    const s = db
      .select()
      .from(skill)
      .where(eq(skill.pk, 'vercel-labs/skills/find-skills'))
      .all()[0]!;
    expect(s.installs_all_time).toBe(2000);
    expect(s.first_seen_at).toBe(t1);
    expect(s.last_seen_at).toBe(t1 + 60);
  });
});

describe('writeBatch — new view_date flips old is_latest=0', () => {
  test('previous view_date rows become is_latest=0, new ones is_latest=1', () => {
    const day1 = Date.UTC(2026, 8, 14, 12, 0, 0) / 1000;
    const day2 = Date.UTC(2026, 8, 15, 12, 0, 0) / 1000;
    writeBatch(db, {
      now: day1,
      parsed: { trending: [row({ rank: 1 })], 'all-time': [], hot: [] },
    });
    writeBatch(db, {
      now: day2,
      parsed: { trending: [row({ rank: 5 })], 'all-time': [], hot: [] },
    });

    const day1Rows = db
      .select()
      .from(skillView)
      .where(
        and(eq(skillView.view, 'trending'), eq(skillView.view_date, '2026-09-14')),
      )
      .all();
    const day2Rows = db
      .select()
      .from(skillView)
      .where(
        and(eq(skillView.view, 'trending'), eq(skillView.view_date, '2026-09-15')),
      )
      .all();
    expect(day1Rows.length).toBe(1);
    expect(day1Rows[0]!.is_latest).toBe(false);
    expect(day2Rows.length).toBe(1);
    expect(day2Rows[0]!.is_latest).toBe(true);
  });
});

describe('writeBatch — atomic on partial failure', () => {
  test('throwing inside the batch leaves db unchanged', () => {
    writeBatch(db, {
      now: 1_789_000_000,
      parsed: { trending: [row({ rank: 1 })], 'all-time': [], hot: [] },
    });
    const before = db.select().from(skillView).all();

    // 构造一个会失败的批次:第二行 rank=null 触发 NOT NULL 约束错误
    expect(() =>
      writeBatch(db, {
        now: 1_789_000_001,
        parsed: {
          trending: [
            row({ pk: 'fresh/repo/new-skill', source: 'fresh/repo', skill_id: 'new-skill', rank: 2 }),
            { ...row({ pk: 'bad/row/oops', source: 'bad/row', skill_id: 'oops' }), rank: null as unknown as number } as ParsedRow,
          ],
          'all-time': [],
          hot: [],
        },
      }),
    ).toThrow();

    const after = db.select().from(skillView).all();
    expect(after).toEqual(before);
  });
});

describe('writeBatch — partial views do not flip is_latest', () => {
  test('empty view does not mark existing latest rows stale', () => {
    // 先写全部三个 view 的完整快照
    const t1 = Date.UTC(2026, 8, 14, 12, 0, 0) / 1000;
    writeBatch(db, {
      now: t1,
      parsed: {
        'all-time': [row({ rank: 1 })],
        trending: [row({ rank: 1 })],
        hot: [row({ rank: 1 })],
      },
    });

    // 模拟 `fetch --views trending`:只传 trending,其余为空
    const t2 = t1 + 3600;
    writeBatch(db, {
      now: t2,
      parsed: {
        'all-time': [],
        trending: [row({ rank: 2 })],
        hot: [],
      } as Record<View, ParsedRow[]>,
    });

    // all-time 和 hot 的 is_latest 必须保留为 true,不能被空数组的副作用翻成 false
    for (const v of ['all-time', 'hot'] as const) {
      const latest = db
        .select()
        .from(skillView)
        .where(and(eq(skillView.view, v), eq(skillView.is_latest, true)))
        .all();
      expect(latest.length).toBe(1);
    }
  });
});

function upsertReadme(db: DB, pk: string, content: string, fetchedAt: number) {
  db.insert(skillReadme)
    .values({
      skill_pk: pk,
      content,
      content_type: 'markdown',
      fetch_source: 'github-raw',
      source_url: `https://raw.githubusercontent.com/${pk}/SKILL.md`,
      fetched_at: fetchedAt,
    })
    .onConflictDoUpdate({
      target: skillReadme.skill_pk,
      set: { content, fetched_at: fetchedAt },
    })
    .run();
}

describe('skill_readme — upsert & FK', () => {
  test('re-fetch overwrites content, one row per skill', () => {
    const t1 = 1_789_000_000;
    writeBatch(db, {
      now: t1,
      parsed: { trending: [row()], 'all-time': [], hot: [] },
    });
    const pk = 'vercel-labs/skills/find-skills';
    upsertReadme(db, pk, 'v1 content', t1);
    upsertReadme(db, pk, 'v2 content', t1 + 60);

    const rows = db.select().from(skillReadme).all();
    expect(rows.length).toBe(1);
    expect(rows[0]!.content).toBe('v2 content');
    expect(rows[0]!.fetched_at).toBe(t1 + 60);
  });

  test('FK: readme for unknown skill is rejected', () => {
    expect(() => upsertReadme(db, 'ghost/repo/nope', 'x', 1)).toThrow();
  });
});

describe('enrichReadmes — incremental fill', () => {
  function mockFetch(log: string[], body = '# content\n') {
    return async (url: string | URL | Request): Promise<Response> => {
      log.push(String(url));
      return new Response(body, { status: 200 });
    };
  }

  test('skips cached skills, fetches only missing ones', async () => {
    const t1 = 1_789_000_000;
    const top: ParsedRow[] = [
      row({ rank: 1 }),
      row({ pk: 'a/b/c', source: 'a/b', skill_id: 'c', rank: 2 }),
    ];
    writeBatch(db, { now: t1, parsed: { trending: top, 'all-time': [], hot: [] } });
    // find-skills 已有缓存
    upsertReadme(db, 'vercel-labs/skills/find-skills', 'cached', t1);

    const urls: string[] = [];
    const origFetch = globalThis.fetch;
    globalThis.fetch = mockFetch(urls) as unknown as typeof fetch;
    try {
      await enrichReadmes(db, top, 50, t1 + 60);
    } finally {
      globalThis.fetch = origFetch;
    }

    // 只请求了 a/b/c 的 github raw,find-skills 未重复下载
    expect(urls).toEqual([
      'https://raw.githubusercontent.com/a/b/HEAD/skills/c/SKILL.md',
    ]);
    const rows = db.select().from(skillReadme).all();
    expect(rows.length).toBe(2);
    expect(rows.find((r) => r.skill_pk === 'a/b/c')!.content).toBe('# content\n');
  });

  test('all cached → zero network calls', async () => {
    const t1 = 1_789_000_000;
    const top: ParsedRow[] = [
      row({ rank: 1 }),
      row({ pk: 'a/b/c', source: 'a/b', skill_id: 'c', rank: 2 }),
    ];
    writeBatch(db, { now: t1, parsed: { trending: top, 'all-time': [], hot: [] } });
    upsertReadme(db, 'vercel-labs/skills/find-skills', 'cached', t1);
    upsertReadme(db, 'a/b/c', 'cached', t1);

    const urls: string[] = [];
    const origFetch = globalThis.fetch;
    globalThis.fetch = mockFetch(urls) as unknown as typeof fetch;
    try {
      await enrichReadmes(db, top, 50, t1 + 60);
    } finally {
      globalThis.fetch = origFetch;
    }
    expect(urls).toEqual([]);
    expect(db.select().from(skillReadme).all().length).toBe(2);
  });

  test('failed fetch is recorded as empty-content marker and skipped on next run', async () => {
    const t1 = 1_789_000_000;
    const top: ParsedRow[] = [
      row({ pk: 'a/b/c', source: 'a/b', skill_id: 'c', rank: 1 }),
    ];
    writeBatch(db, { now: t1, parsed: { trending: top, 'all-time': [], hot: [] } });

    // 第一轮:两条路都 404 → 写入空内容标记行
    const urls: string[] = [];
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL | Request): Promise<Response> => {
      urls.push(String(url));
      return new Response('404: Not Found', { status: 404 });
    }) as unknown as typeof fetch;
    try {
      await enrichReadmes(db, top, 50, t1);
    } finally {
      globalThis.fetch = origFetch;
    }
    expect(urls.length).toBe(2); // github raw + skills.sh 详情页各一次
    const markers = db.select().from(skillReadme).all();
    expect(markers.length).toBe(1);
    expect(markers[0]!.skill_pk).toBe('a/b/c');
    expect(markers[0]!.content).toBe('');
    expect(markers[0]!.fetch_source).toBe('unavailable');
    expect(markers[0]!.fetched_at).toBe(t1);

    // 第二轮(冷却期内):零网络请求
    const urls2: string[] = [];
    globalThis.fetch = mockFetch(urls2) as unknown as typeof fetch;
    try {
      await enrichReadmes(db, top, 50, t1 + 3600);
    } finally {
      globalThis.fetch = origFetch;
    }
    expect(urls2).toEqual([]);
    // 标记行仍在,不会被误判为已缓存的真实内容
    expect(db.select().from(skillReadme).all().length).toBe(1);

    // 第三轮(冷却期 7 天已过):重新尝试,这次成功 → 标记行被真实内容覆盖
    const urls3: string[] = [];
    globalThis.fetch = mockFetch(urls3) as unknown as typeof fetch;
    try {
      await enrichReadmes(db, top, 50, t1 + 8 * 24 * 3600);
    } finally {
      globalThis.fetch = origFetch;
    }
    expect(urls3.length).toBe(1); // github raw 直接命中
    const final = db.select().from(skillReadme).all();
    expect(final.length).toBe(1);
    expect(final[0]!.content).toBe('# content\n');
    expect(final[0]!.fetch_source).toBe('github-raw');
  });
});
