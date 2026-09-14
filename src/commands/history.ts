import { and, desc, eq, like, type SQL } from 'drizzle-orm';
import { closeDb, openDb } from '../db/client';
import { skillView } from '../db/schema';
import type { View } from '../types';

export interface RunHistoryOptions {
  dbPath: string;
  /** "source/skillId" 精确匹配;裸 "skillId" 匹配任意 source */
  skillQuery: string;
  view: View | 'all';
  limit: number;
  json: boolean;
}

/**
 * 输出退出码语义:
 *   0  有数据,正常输出
 *   2  从没见过这个技能,提示用户
 */
export function runHistory(opts: RunHistoryOptions): number {
  const db = openDb(opts.dbPath);
  try {
    // skill_pk 形如 "source/skillId"。带斜杠 → 精确匹配;
    // 裸 skillId → 匹配所有 source 下的同名技能(同一技能名可存在于多个仓库)。
    const scope: SQL = opts.skillQuery.includes('/')
      ? eq(skillView.skill_pk, opts.skillQuery)
      : like(skillView.skill_pk, `%/${opts.skillQuery}`);

    const cond =
      opts.view === 'all' ? scope : and(scope, eq(skillView.view, opts.view));

    const rows = db
      .select({
        captured_at: skillView.captured_at,
        view: skillView.view,
        view_date: skillView.view_date,
        rank: skillView.rank,
        installs: skillView.installs,
        change: skillView.change,
        update_count: skillView.update_count,
        is_latest: skillView.is_latest,
        skill_pk: skillView.skill_pk,
      })
      .from(skillView)
      .where(cond)
      .orderBy(desc(skillView.captured_at))
      .limit(opts.limit)
      .all();

    if (rows.length === 0) {
      console.error(`never seen ${opts.skillQuery} in any view`);
      return 2;
    }

    if (opts.json) {
      console.log(JSON.stringify(rows, null, 2));
      return 0;
    }

    console.log(`history for ${opts.skillQuery}`);
    console.log('');
    console.log(
      'captured_at           view       view_date   rank  installs  change  updates  latest  skill',
    );
    for (const r of rows) {
      const t = new Date(r.captured_at * 1000)
        .toISOString()
        .replace('.000Z', 'Z');
      const change =
        r.change === null ? '-' : r.change > 0 ? `+${r.change}` : String(r.change);
      console.log(
        `${t}  ${r.view.padEnd(9)}  ${r.view_date}  ` +
          `${String(r.rank).padStart(4)}  ${String(r.installs).padStart(8)}  ` +
          `${change.padStart(6)}  ${String(r.update_count).padStart(7)}  ` +
          `${r.is_latest ? '*' : ' '}       ${r.skill_pk}`,
      );
    }
    return 0;
  } finally {
    closeDb(db);
  }
}
