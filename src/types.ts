export type View = 'all-time' | 'trending' | 'hot';

export const VIEWS: readonly View[] = ['all-time', 'trending', 'hot'] as const;

/**
 * skills.sh RSC payload 里一条技能的原始形态。
 * 三个视图共有的字段:source / skillId / name / installs;
 * 其余字段按视图出现(all-time: weeklyInstalls/isOfficial, hot: installsYesterday/change)。
 */
export interface RawSkill {
  source: string;              // e.g. "vercel-labs/skills"
  skillId: string;             // e.g. "find-skills"
  name: string;                // 通常与 skillId 相同
  installs: number;            // 该视图口径下的安装量
  weeklyInstalls?: number[];   // all-time 视图:最近若干天的日安装量
  isOfficial?: boolean;
  installsYesterday?: number;  // hot 视图
  change?: number;             // hot 视图:相对昨天的增量
}

/**
 * 一行从 skills.sh 解析出来的数据,尚未写入数据库。
 * 命名与 skill / skill_view 表字段保持一致,方便直接落表。
 */
export interface ParsedRow {
  pk: string;                  // "source/skillId",全局唯一
  source: string;              // owner/repo
  skill_id: string;            // 技能名
  name: string;
  installs: number;            // 该视图口径下的安装量
  rank: number;                // 1..N,按 payload 顺序
  is_official: boolean | null;
  weekly_installs: number[] | null;   // 仅 all-time 视图
  installs_yesterday: number | null;  // 仅 hot 视图
  change: number | null;              // 仅 hot 视图
}

export class ParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ParseError';
  }
}
