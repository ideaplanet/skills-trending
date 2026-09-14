import { and, asc, eq } from 'drizzle-orm';
import { closeDb, openDb } from '../db/client';
import { skill, skillView } from '../db/schema';
import type { View } from '../types';

export interface RunLatestOptions {
  dbPath: string;
  view: View;
  limit: number;
  json: boolean;
}

/**
 * 输出退出码语义:
 *   0  有数据,正常输出
 *   2  没有数据(还没 fetch 过),提示用户先 fetch
 */
export function runLatest(opts: RunLatestOptions): number {
  const db = openDb(opts.dbPath);
  try {
    const rows = db
      .select({
        rank: skillView.rank,
        skill_pk: skillView.skill_pk,
        installs: skillView.installs,
        installs_yesterday: skillView.installs_yesterday,
        change: skillView.change,
        captured_at: skillView.captured_at,
        update_count: skillView.update_count,
        view_date: skillView.view_date,
        is_official: skill.is_official,
        installs_all_time: skill.installs_all_time,
      })
      .from(skillView)
      .leftJoin(skill, eq(skillView.skill_pk, skill.pk))
      .where(
        and(eq(skillView.view, opts.view), eq(skillView.is_latest, true)),
      )
      .orderBy(asc(skillView.rank))
      .limit(opts.limit)
      .all();

    if (rows.length === 0) {
      console.error(`no data yet for ${opts.view} — run \`bun run fetch\` first`);
      return 2;
    }

    if (opts.json) {
      console.log(JSON.stringify(rows, null, 2));
      return 0;
    }

    const viewDate = rows[0]!.view_date;
    const capturedAt = new Date(rows[0]!.captured_at * 1000)
      .toISOString()
      .replace('.000Z', 'Z');
    console.log(
      `view=${opts.view}  view_date=${viewDate}  captured_at=${capturedAt}`,
    );
    console.log('');
    console.log(
      ' #   installs  change  skill                                    official  all-time',
    );
    for (const r of rows) {
      const change = r.change === null ? '-' : (r.change > 0 ? `+${r.change}` : String(r.change));
      console.log(
        `${String(r.rank).padStart(3)}  ${String(r.installs).padStart(8)}  ` +
          `${change.padStart(6)}  ${r.skill_pk.padEnd(40).slice(0, 40)}  ` +
          `${(r.is_official ? 'yes' : '-').padEnd(8)}  ` +
          `${r.installs_all_time === null ? '-' : String(r.installs_all_time)}`,
      );
    }
    return 0;
  } finally {
    closeDb(db);
  }
}
