import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { and, eq, sql } from 'drizzle-orm';
import { closeDb, openDb, type DB } from '../db/client';
import { skill, skillView } from '../db/schema';
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
}

/** 一次完整 fetch 流程:scrape × N → writeBatch(若非 dry-run) */
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
  } finally {
    closeDb(db);
  }

  const total = views.reduce((s, v) => s + parsed[v].length, 0);
  console.log(`→ wrote ${total} skill_view rows to ${dbPath}`);
}
