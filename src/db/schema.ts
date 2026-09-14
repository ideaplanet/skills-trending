import {
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';

/**
 * 技能维表:每个 (source, skillId) 一行,跨视图共享。
 * pk = "source/skillId",例如 "vercel-labs/skills/find-skills"。
 */
export const skill = sqliteTable('skill', {
  pk: text('pk').primaryKey(),
  source: text('source').notNull(),             // owner/repo
  skill_id: text('skill_id').notNull(),         // 技能名
  name: text('name').notNull(),
  is_official: integer('is_official', { mode: 'boolean' }),
  installs_all_time: integer('installs_all_time'), // 最近一次 all-time 视图的全量安装数
  first_seen_at: integer('first_seen_at').notNull(),
  last_seen_at: integer('last_seen_at').notNull(),
});

/**
 * 视图快照表:每视图每天一份排行榜。
 * view_date 是抓取时刻的 UTC 日期;同一天重复抓取会 UPSERT 到同一行
 * (update_count 递增),跨天则插入新行并把旧行 is_latest 翻 0。
 */
export const skillView = sqliteTable(
  'skill_view',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    skill_pk: text('skill_pk')
      .notNull()
      .references(() => skill.pk),
    view: text('view', {
      enum: ['all-time', 'trending', 'hot'],
    }).notNull(),
    view_date: text('view_date').notNull(),
    rank: integer('rank').notNull(),
    installs: integer('installs').notNull(),        // 该视图口径的安装量
    installs_yesterday: integer('installs_yesterday'), // 仅 hot
    change: integer('change'),                          // 仅 hot
    weekly_installs: text('weekly_installs'),           // 仅 all-time,JSON 数组文本
    captured_at: integer('captured_at').notNull(),
    first_captured_at: integer('first_captured_at').notNull(),
    update_count: integer('update_count').notNull().default(1),
    is_latest: integer('is_latest', { mode: 'boolean' })
      .notNull()
      .default(true),
  },
  (t) => ({
    uqSlot: uniqueIndex('uq_skill_view_slot').on(
      t.view,
      t.view_date,
      t.skill_pk,
    ),
    idxLatest: index('idx_skill_view_latest').on(t.view, t.is_latest, t.rank),
    idxSkillHist: index('idx_skill_view_skill').on(
      t.skill_pk,
      t.view,
      t.captured_at,
    ),
  }),
);

// 类型导出供其他模块使用
export type Skill = typeof skill.$inferSelect;
export type NewSkill = typeof skill.$inferInsert;
export type SkillView = typeof skillView.$inferSelect;
export type NewSkillView = typeof skillView.$inferInsert;
