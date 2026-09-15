import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { and, eq, sql } from 'drizzle-orm';
import { closeDb, openDb, type DB } from '../db/client';
import { skill, skillReadme, skillView } from '../db/schema';
import { scrapeSkillReadme } from '../scrape/readme';
import { scrapeView } from '../scrape/skills';
import { type ParsedRow, type View, VIEWS } from '../types';

export interface BatchInput {
  now: number; // unix seconds
  parsed: Record<View, ParsedRow[]>;
}

/**
 * 把一次抓取的几组 ParsedRow 写入 db。整个操作是单一事务:
 *   for each view:
 *     UPDATE skill_view SET is_latest=0 WHERE view=? AND is_latest=1
 *     for each row:
 *       UPSERT skill (target=pk)
 *       UPSERT skill_view (target=(view, view_date, skill_pk))
 */
export function writeBatch(db: DB, batch: BatchInput): void {
  const { now, parsed } = batch;
  const viewDate = new Date(now * 1000).toISOString().slice(0, 10);

  db.transaction((tx) => {
    for (const view of VIEWS) {
      const rows = parsed[view];
      // 如果调用方没传该 view 的数据(如 `fetch --views trending`),
      // 不能把已经存在的 is_latest 翻成 0 — 否则下次 `latest --view hot`
      // 会显示 "no data yet"。空数组 = 这次没抓 = 不动旧数据。
      if (rows.length === 0) continue;

      tx.update(skillView)
        .set({ is_latest: false })
        .where(
          and(eq(skillView.view, view), eq(skillView.is_latest, true)),
        )
        .run();

      for (const r of rows) {
        // UPSERT skill
        tx.insert(skill)
          .values({
            pk: r.pk,
            source: r.source,
            skill_id: r.skill_id,
            name: r.name,
            is_official: r.is_official,
            installs_all_time: view === 'all-time' ? r.installs : null,
            first_seen_at: now,
            last_seen_at: now,
          })
          .onConflictDoUpdate({
            target: skill.pk,
            set: {
              name: r.name,
              ...(r.is_official !== null && { is_official: r.is_official }),
              ...(view === 'all-time' && { installs_all_time: r.installs }),
              last_seen_at: now,
            },
          })
          .run();

        // UPSERT skill_view
        tx.insert(skillView)
          .values({
            skill_pk: r.pk,
            view,
            view_date: viewDate,
            rank: r.rank,
            installs: r.installs,
            installs_yesterday: r.installs_yesterday,
            change: r.change,
            weekly_installs: r.weekly_installs
              ? JSON.stringify(r.weekly_installs)
              : null,
            captured_at: now,
            first_captured_at: now,
            update_count: 1,
            is_latest: true,
          })
          .onConflictDoUpdate({
            target: [skillView.view, skillView.view_date, skillView.skill_pk],
            set: {
              rank: r.rank,
              installs: r.installs,
              installs_yesterday: r.installs_yesterday,
              change: r.change,
              weekly_installs: r.weekly_installs
                ? JSON.stringify(r.weekly_installs)
                : null,
              captured_at: now,
              update_count: sql`${skillView.update_count} + 1`,
              is_latest: true,
            },
          })
          .run();
      }
    }
  });
}

export interface RunFetchOptions {
  dbPath: string;
  views: View[];
  dryRun: boolean;
  /** >0 时额外抓取 trending 榜 Top N 的完整 SKILL.md 到 skill_readme 表 */
  withReadme?: number;
}

/** 一次完整 fetch 流程:scrape × N → writeBatch(若非 dry-run) → 可选补抓 SKILL.md */
export async function runFetch(opts: RunFetchOptions): Promise<void> {
  const { dbPath, views, dryRun } = opts;
  const now = Math.floor(Date.now() / 1000);

  const parsed: Record<View, ParsedRow[]> = {
    'all-time': [],
    'trending': [],
    'hot': [],
  };

  for (let i = 0; i < views.length; i++) {
    const view = views[i]!;
    if (i > 0) await new Promise((r) => setTimeout(r, 1000));
    const rows = await scrapeView(view);
    parsed[view] = rows;
    console.log(`✓ ${view.padEnd(9)} ${rows.length} rows`);
  }

  if (dryRun) {
    for (const v of views) {
      console.error(`--- dry-run ${v} (${parsed[v].length} rows) ---`);
      for (const r of parsed[v].slice(0, 30)) {
        console.error(
          `${String(r.rank).padStart(3)} ${String(r.installs).padStart(7)} ${r.pk}`,
        );
      }
    }
    console.log('→ dry-run, nothing written');
    return;
  }

  mkdirSync(dirname(dbPath), { recursive: true });
  const db = openDb(dbPath);
  try {
    writeBatch(db, { now, parsed });
    if (opts.withReadme && opts.withReadme > 0) {
      await enrichReadmes(db, parsed.trending, opts.withReadme, now);
    }
  } finally {
    closeDb(db);
  }

  const total = views.reduce((s, v) => s + parsed[v].length, 0);
  console.log(`→ wrote ${total} skill_view rows to ${dbPath}`);
}

/** 抓取失败后的冷却期:冷却期内不再重试,过后允许再试一次(技能可能后来变得可获取) */
const MISS_RETRY_AFTER_SEC = 7 * 24 * 3600;

/**
 * 给 trending Top N 补抓完整 SKILL.md(github raw 优先、详情页回退),
 * 只处理尚无缓存的技能(增量填充,CI 每次运行不必重复下载):
 *   - 已有缓存(content 非空)的跳过;
 *   - 抓取失败过的在 skill_readme 里留空内容标记行,冷却期内跳过;
 *   - 成功后标记行被真实内容覆盖。
 * 单条失败只告警,不中断整体流程。
 * 需要刷新单个技能的缓存用 `detail --skill <pk> --refresh`。
 */
export async function enrichReadmes(
  db: DB,
  trending: ParsedRow[],
  topN: number,
  now: number,
): Promise<void> {
  const targets = trending.slice(0, topN);
  // pk → { content, fetched_at };content 为空串即"上次抓取失败"的标记行
  const stored = new Map(
    db
      .select({
        pk: skillReadme.skill_pk,
        content: skillReadme.content,
        at: skillReadme.fetched_at,
      })
      .from(skillReadme)
      .all()
      .map((r) => [r.pk, r]),
  );

  let cachedCount = 0;
  let cooldown = 0;
  const pending: ParsedRow[] = [];
  for (const r of targets) {
    const s = stored.get(r.pk);
    if (s && s.content !== '') {
      cachedCount++;
      continue;
    }
    if (s && now - s.at < MISS_RETRY_AFTER_SEC) {
      cooldown++;
      continue;
    }
    pending.push(r);
  }
  if (pending.length === 0) {
    console.log(
      `✓ readme    0 pending, ${cachedCount} cached, ${cooldown} in cooldown (top ${targets.length})`,
    );
    return;
  }

  let ok = 0;
  let failed = 0;
  for (let i = 0; i < pending.length; i++) {
    const r = pending[i]!;
    if (i > 0) await new Promise((res) => setTimeout(res, 400));
    let readme: Awaited<ReturnType<typeof scrapeSkillReadme>>;
    try {
      readme = await scrapeSkillReadme(r.source, r.skill_id);
    } catch (e) {
      readme = null;
      console.warn(`  ⚠ readme failed: ${r.pk} (${e instanceof Error ? e.message : e})`);
    }
    if (readme === null) {
      failed++;
      upsertReadme(db, {
        skill_pk: r.pk,
        content: '',
        content_type: 'none',
        fetch_source: 'unavailable',
        source_url: `https://raw.githubusercontent.com/${r.source}/HEAD/skills/${r.skill_id}/SKILL.md`,
        fetched_at: now,
      });
      console.warn(
        `  ⚠ readme unavailable: ${r.pk} (retry after ${MISS_RETRY_AFTER_SEC / 86400}d)`,
      );
      continue;
    }
    upsertReadme(db, {
      skill_pk: r.pk,
      content: readme.content,
      content_type: readme.content_type,
      fetch_source: readme.fetch_source,
      source_url: readme.source_url,
      fetched_at: now,
    });
    ok++;
  }
  console.log(
    `✓ readme    ${ok} fetched, ${failed} failed (recorded), ` +
      `${cachedCount} cached, ${cooldown} in cooldown (top ${targets.length})`,
  );
}

function upsertReadme(db: DB, v: typeof skillReadme.$inferInsert): void {
  db.insert(skillReadme)
    .values(v)
    .onConflictDoUpdate({ target: skillReadme.skill_pk, set: v })
    .run();
}
