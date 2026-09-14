import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { migrate } from 'drizzle-orm/bun-sqlite/migrator';
import { openDb, closeDb } from './client';

/**
 * 应用 src/db/migrations 下所有未运行的迁移。
 * 默认目标 db: data/skills.db (路径不存在会自动创建目录)。
 * 可通过 `bun src/db/migrate.ts <path>` 指定其他路径(测试用)。
 */
const target = process.argv[2] ?? 'data/skills.db';
mkdirSync(dirname(target), { recursive: true });

const db = openDb(target);
try {
  migrate(db, { migrationsFolder: './src/db/migrations' });
  console.log(`✓ migrations applied to ${target}`);
} finally {
  closeDb(db);
}
