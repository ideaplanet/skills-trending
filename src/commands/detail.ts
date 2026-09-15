import { eq, like } from 'drizzle-orm';
import { closeDb, openDb } from '../db/client';
import { skill, skillReadme } from '../db/schema';
import { scrapeSkillReadme } from '../scrape/readme';

export interface RunDetailOptions {
  dbPath: string;
  /** "owner/repo/skillId" 精确匹配;裸 "skillId" 在库内唯一时也可 */
  skillQuery: string;
  refresh: boolean;
  json: boolean;
}

/**
 * 查看单个技能的完整 SKILL.md。
 * 库里有缓存且未 --refresh 时直接输出;否则现场抓取(github raw 优先、
 * skills.sh 详情页回退)并写入 skill_readme 表。
 *
 * 退出码:0 成功;2 技能不存在/歧义/抓取失败。
 */
export async function runDetail(opts: RunDetailOptions): Promise<number> {
  const db = openDb(opts.dbPath);
  try {
    const pk = resolveSkillPk(db, opts.skillQuery);
    if (pk === null) {
      console.error(
        `skill "${opts.skillQuery}" not found in db — run \`bun run fetch\` first, ` +
          `or pass the full "owner/repo/skillId"`,
      );
      return 2;
    }
    if (typeof pk !== 'string') {
      console.error(`"${opts.skillQuery}" matches multiple skills:`);
      for (const p of pk) console.error(`  ${p}`);
      return 2;
    }

    let stored =
      db.select().from(skillReadme).where(eq(skillReadme.skill_pk, pk)).all()[0] ??
      null;

    // 无缓存 / 上次抓取失败的空内容标记行 / --refresh → 现场抓取
    if (!stored || stored.content === '' || opts.refresh) {
      const { source, skillId } = splitPk(pk);
      const readme = await scrapeSkillReadme(source, skillId);
      if (readme === null) {
        console.error(
          `could not fetch SKILL.md for ${pk} ` +
            `(github raw 404 and skills.sh detail page has no content)`,
        );
        return 2;
      }
      const now = Math.floor(Date.now() / 1000);
      db.insert(skillReadme)
        .values({
          skill_pk: pk,
          content: readme.content,
          content_type: readme.content_type,
          fetch_source: readme.fetch_source,
          source_url: readme.source_url,
          fetched_at: now,
        })
        .onConflictDoUpdate({
          target: skillReadme.skill_pk,
          set: {
            content: readme.content,
            content_type: readme.content_type,
            fetch_source: readme.fetch_source,
            source_url: readme.source_url,
            fetched_at: now,
          },
        })
        .run();
      stored = {
        skill_pk: pk,
        content: readme.content,
        content_type: readme.content_type,
        fetch_source: readme.fetch_source,
        source_url: readme.source_url,
        fetched_at: now,
      };
      console.error(`→ fetched ${readme.content_type} from ${readme.fetch_source}`);
    }

    if (opts.json) {
      console.log(JSON.stringify(stored, null, 2));
    } else {
      console.error(`# ${stored.skill_pk}  (${stored.content_type}, ${stored.fetch_source})`);
      console.log(stored.content);
    }
    return 0;
  } finally {
    closeDb(db);
  }
}

/**
 * 把用户输入解析成库内的 skill_pk。
 * 返回:string = 唯一命中;null = 未找到;string[] = 裸名多义。
 */
function resolveSkillPk(
  db: ReturnType<typeof openDb>,
  query: string,
): string | string[] | null {
  if (query.includes('/')) {
    const hit = db
      .select({ pk: skill.pk })
      .from(skill)
      .where(eq(skill.pk, query))
      .all();
    return hit.length === 1 ? query : null;
  }
  const rows = db
    .selectDistinct({ pk: skill.pk })
    .from(skill)
    .where(like(skill.pk, `%/${query}`))
    .all();
  if (rows.length === 0) return null;
  if (rows.length === 1) return rows[0]!.pk;
  return rows.map((r) => r.pk);
}

/** pk = "owner/repo/skillId" → { source: "owner/repo", skillId } */
export function splitPk(pk: string): { source: string; skillId: string } {
  const first = pk.indexOf('/');
  const second = pk.indexOf('/', first + 1);
  if (first === -1 || second === -1) {
    throw new Error(`splitPk: malformed skill pk "${pk}"`);
  }
  return { source: pk.slice(0, second), skillId: pk.slice(second + 1) };
}
