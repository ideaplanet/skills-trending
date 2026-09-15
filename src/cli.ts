#!/usr/bin/env bun
import { runFetch } from './commands/fetch';
import { runHistory } from './commands/history';
import { runLatest } from './commands/latest';
import { runDetail } from './commands/detail';
import { VIEWS, type View } from './types';

const DEFAULT_DB = 'data/skills.db';

function usage(): string {
  return `\
Usage: bun src/cli.ts <command> [flags]

Commands:
  fetch    Scrape skills.sh leaderboards and write to SQLite
  latest   Show the latest snapshot for a view
  history  Show one skill's leaderboard history
  detail   Show one skill's full SKILL.md (fetch & cache on demand)
  help     Show this message

Run "bun src/cli.ts <command> --help" for command-specific flags.
`;
}

const argv = process.argv.slice(2);
const cmd = argv[0];

if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') {
  process.stdout.write(usage());
  process.exit(cmd ? 0 : 2);
}

const flags = parseFlags(argv.slice(1));

try {
  if (cmd === 'fetch') {
    if (flags.has('help') || flags.has('h')) {
      console.log(
        `fetch [--db <path>] [--views all-time,trending,hot] [--dry-run] [--with-readme [N]]` +
          `\n  --with-readme [N]  fill SKILL.md for trending top N (default 50) skills missing a readme`,
      );
      process.exit(0);
    }
    const views = parseViews(getStr(flags, 'views', VIEWS.join(',')));
    const wr = flags.get('with-readme');
    // --with-readme [N]:给 trending Top N(默认 50)中尚无缓存的技能补抓 SKILL.md
    const withReadme =
      wr === undefined ? 0 : wr === true ? 50 : parseInt(wr, 10);
    if (Number.isNaN(withReadme) || withReadme < 0) {
      console.error(`invalid --with-readme value (expected a number >= 0)`);
      process.exit(2);
    }
    await runFetch({
      dbPath: getStr(flags, 'db', DEFAULT_DB),
      views,
      dryRun: flags.has('dry-run'),
      withReadme,
    });
    process.exit(0);
  }

  if (cmd === 'latest') {
    if (flags.has('help') || flags.has('h')) {
      console.log(`latest [--view all-time|trending|hot] [--db <path>] [--limit N] [--json]`);
      process.exit(0);
    }
    const code = runLatest({
      dbPath: getStr(flags, 'db', DEFAULT_DB),
      view: parseView(getStr(flags, 'view', 'trending')),
      limit: parseInt(getStr(flags, 'limit', '25'), 10),
      json: flags.has('json'),
    });
    process.exit(code);
  }

  if (cmd === 'history') {
    if (flags.has('help') || flags.has('h')) {
      console.log(
        `history --skill <source/skillId|skillId> [--view all-time|trending|hot|all] ` +
          `[--db <path>] [--limit N] [--json]`,
      );
      process.exit(0);
    }
    const skillArg = getStrOrNull(flags, 'skill');
    if (!skillArg) {
      console.error('history: --skill <source/skillId|skillId> is required');
      process.exit(2);
    }
    const viewArg = getStr(flags, 'view', 'all');
    const view: View | 'all' = viewArg === 'all' ? 'all' : parseView(viewArg);
    const code = runHistory({
      dbPath: getStr(flags, 'db', DEFAULT_DB),
      skillQuery: skillArg,
      view,
      limit: parseInt(getStr(flags, 'limit', '30'), 10),
      json: flags.has('json'),
    });
    process.exit(code);
  }

  if (cmd === 'detail') {
    if (flags.has('help') || flags.has('h')) {
      console.log(
        `detail --skill <owner/repo/skillId|skillId> [--db <path>] [--refresh] [--json]`,
      );
      process.exit(0);
    }
    const skillArg = getStrOrNull(flags, 'skill');
    if (!skillArg) {
      console.error('detail: --skill <owner/repo/skillId|skillId> is required');
      process.exit(2);
    }
    const code = await runDetail({
      dbPath: getStr(flags, 'db', DEFAULT_DB),
      skillQuery: skillArg,
      refresh: flags.has('refresh'),
      json: flags.has('json'),
    });
    process.exit(code);
  }

  console.error(`unknown command: ${cmd}\n`);
  process.stderr.write(usage());
  process.exit(2);
} catch (e) {
  console.error(e instanceof Error ? e.stack ?? e.message : String(e));
  process.exit(1);
}

// ----- minimal flag parser -----
type Flags = Map<string, string | true>;

function parseFlags(args: string[]): Flags {
  const out: Flags = new Map();
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (!a.startsWith('--') && !a.startsWith('-')) continue;
    const key = a.replace(/^-+/, '');
    const eq = key.indexOf('=');
    if (eq >= 0) {
      out.set(key.slice(0, eq), key.slice(eq + 1));
      continue;
    }
    const next = args[i + 1];
    if (next !== undefined && !next.startsWith('-')) {
      out.set(key, next);
      i++;
    } else {
      out.set(key, true);
    }
  }
  return out;
}

function getStr(f: Flags, k: string, def: string): string {
  const v = f.get(k);
  return typeof v === 'string' ? v : def;
}
function getStrOrNull(f: Flags, k: string): string | null {
  const v = f.get(k);
  return typeof v === 'string' ? v : null;
}
function parseView(s: string): View {
  if (s === 'all-time' || s === 'trending' || s === 'hot') return s;
  console.error(`invalid --view: ${s} (expected all-time|trending|hot)`);
  process.exit(2);
}
function parseViews(s: string): View[] {
  return s
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean)
    .map(parseView);
}
