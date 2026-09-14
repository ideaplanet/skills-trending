import { Database } from 'bun:sqlite';
import { drizzle, type BunSQLiteDatabase } from 'drizzle-orm/bun-sqlite';
import * as schema from './schema';

export type DB = BunSQLiteDatabase<typeof schema> & { $raw: Database };

/**
 * 打开一个 SQLite 数据库。传 ':memory:' 可用于测试。
 * 返回的 db 上挂了 $raw 暴露 bun:sqlite 原生句柄,便于事务/PRAGMA。
 */
export function openDb(path: string): DB {
  const raw = new Database(path);
  raw.exec('PRAGMA journal_mode = WAL;');
  raw.exec('PRAGMA foreign_keys = ON;');
  const db = drizzle(raw, { schema }) as unknown as DB;
  db.$raw = raw;
  return db;
}

export function closeDb(db: DB) {
  // 先把 WAL 数据 checkpoint 回主 db 文件并清空 -wal,
  // 这样 CI/脚本 commit 的 data/skills.db 永远包含所有数据,
  // 也避免遗留 -wal/-shm 文件污染仓库。
  // `:memory:` 数据库不存在 WAL 文件;TRUNCATE 在该模式下也是安全的 no-op。
  try {
    db.$raw.exec('PRAGMA wal_checkpoint(TRUNCATE);');
  } catch {
    // 已经被关闭或不支持的边缘情况,close 本身仍然要执行。
  }
  db.$raw.close();
}
