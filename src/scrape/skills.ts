import { ParseError, type ParsedRow, type View } from '../types';
import { parseRscSkills } from './rsc';

const SKILLS_BASE = 'https://www.skills.sh';

const VIEW_URL: Record<View, string> = {
  'all-time': SKILLS_BASE + '/',
  'trending': SKILLS_BASE + '/trending',
  'hot': SKILLS_BASE + '/hot',
};

export class HttpRetryable extends Error {
  constructor(public readonly status: number) {
    super(`HTTP ${status}`);
    this.name = 'HttpRetryable';
  }
}
export class HttpFatal extends Error {
  constructor(public readonly status: number) {
    super(`HTTP ${status}`);
    this.name = 'HttpFatal';
  }
}

export type FetchImpl = (input: string, init?: RequestInit) => Promise<Response>;

interface FetchOpts {
  tries?: number;
  baseMs?: number;
  timeoutMs?: number;
  fetchImpl?: FetchImpl;
}

/**
 * 拉取一个视图的 RSC flight payload。
 * 429/5xx 走指数退避重试;其余非 2xx 视为致命错误直接抛出。
 */
export async function fetchViewRsc(
  view: View,
  opts: FetchOpts = {},
): Promise<string> {
  const tries = opts.tries ?? 3;
  const baseMs = opts.baseMs ?? 1500;
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const f: FetchImpl = opts.fetchImpl ?? (globalThis.fetch as FetchImpl);
  const url = VIEW_URL[view];

  let lastErr: unknown;
  for (let i = 0; i < tries; i++) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const res = await f(url, {
        signal: ctl.signal,
        // Next.js App Router 靠这个头返回 RSC flight 数据而非 HTML
        headers: { RSC: '1', 'User-Agent': 'skills-trending-tracker' },
      });
      clearTimeout(timer);
      if (res.status === 429 || res.status >= 500) {
        throw new HttpRetryable(res.status);
      }
      if (!res.ok) throw new HttpFatal(res.status);
      return await res.text();
    } catch (e) {
      clearTimeout(timer);
      lastErr = e;
      if (e instanceof HttpFatal) throw e;
      const retryable =
        e instanceof HttpRetryable ||
        (e instanceof Error &&
          (e.name === 'AbortError' || e.message.includes('fetch')));
      if (i === tries - 1 || !retryable) throw e;
      await sleep(baseMs * 2 ** i);
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error('fetchViewRsc: unknown');
}

/**
 * 把一个视图的 RSC payload 解析为 ParsedRow[]。纯函数,不接触网络与数据库。
 * - 校验 payload 的 view 与请求一致,防止站点改版后张冠李戴;
 * - rank 按数组顺序 1..N(页面即按此顺序渲染);
 * - 必需字段缺失抛 ParseError。
 */
export function parseViewSkills(view: View, payload: string): ParsedRow[] {
  const { view: payloadView, skills } = parseRscSkills(payload);
  if (payloadView !== view) {
    throw new ParseError(
      `parseViewSkills: payload view "${payloadView}" != requested "${view}" — skills.sh markup may have changed`,
    );
  }

  const out: ParsedRow[] = [];
  let missingOptional = 0;

  skills.forEach((s, idx) => {
    if (!s.source || !s.skillId || !s.name || typeof s.installs !== 'number') {
      throw new ParseError(
        `parseViewSkills(${view}): skill ${idx} missing required fields`,
      );
    }
    const weekly = Array.isArray(s.weeklyInstalls)
      ? s.weeklyInstalls.filter((n) => typeof n === 'number')
      : null;
    // 视图特有字段缺失才算异常;isOfficial 各视图都可有可无
    if (view === 'all-time' && !weekly) missingOptional++;
    if (view === 'hot' && typeof s.change !== 'number') missingOptional++;

    out.push({
      pk: `${s.source}/${s.skillId}`,
      source: s.source,
      skill_id: s.skillId,
      name: s.name,
      installs: s.installs,
      rank: idx + 1,
      is_official: typeof s.isOfficial === 'boolean' ? s.isOfficial : null,
      weekly_installs: view === 'all-time' ? weekly : null,
      installs_yesterday:
        view === 'hot' && typeof s.installsYesterday === 'number'
          ? s.installsYesterday
          : null,
      change: view === 'hot' && typeof s.change === 'number' ? s.change : null,
    });
  });

  if (missingOptional > 0) {
    console.warn(
      `[scrape] ${view}: ${out.length} rows, ${missingOptional} rows missing optional fields`,
    );
  }
  return out;
}

export async function scrapeView(
  view: View,
  opts: FetchOpts = {},
): Promise<ParsedRow[]> {
  const payload = await fetchViewRsc(view, opts);
  return parseViewSkills(view, payload);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
