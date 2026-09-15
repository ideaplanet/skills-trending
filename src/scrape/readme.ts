import { parseFlightTextChunks, readRscString } from './rsc';
import type { FetchImpl } from './skills';

const RAW_BASE = 'https://raw.githubusercontent.com';
const SKILLS_SH_BASE = 'https://www.skills.sh';

/** skills 生态的标准布局约定;少数非标准仓库会 404,走详情页回退 */
const GITHUB_RAW_PATH = (source: string, skillId: string) =>
  `/${source}/HEAD/skills/${skillId}/SKILL.md`;

export type ReadmeSource = 'github-raw' | 'skills-sh';

export interface SkillReadme {
  content: string;               // markdown (github-raw) 或 HTML (skills-sh)
  content_type: 'markdown' | 'html';
  fetch_source: ReadmeSource;
  source_url: string;
}

interface FetchOpts {
  tries?: number;
  baseMs?: number;
  timeoutMs?: number;
  fetchImpl?: FetchImpl;
}

/**
 * 抓取单个技能的完整 SKILL.md:
 *   1. 优先 GitHub raw(原始 markdown,含 frontmatter,标准布局仓库直接命中);
 *   2. 404(非标准布局)时回退 skills.sh 详情页 RSC(previewHtml+restHtml 拼接,
 *      完整但为渲染后 HTML、无 frontmatter);
 *   3. 两条路都拿不到 → 返回 null(调用方决定如何记录)。
 */
export async function scrapeSkillReadme(
  source: string,
  skillId: string,
  opts: FetchOpts = {},
): Promise<SkillReadme | null> {
  const raw = await fetchGithubRawSkillMd(source, skillId, opts);
  if (raw !== null) {
    return {
      content: raw,
      content_type: 'markdown',
      fetch_source: 'github-raw',
      source_url: `${RAW_BASE}${GITHUB_RAW_PATH(source, skillId)}`,
    };
  }

  const html = await fetchSkillsShReadmeHtml(source, skillId, opts);
  if (html !== null && html.length > 0) {
    return {
      content: html,
      content_type: 'html',
      fetch_source: 'skills-sh',
      source_url: `${SKILLS_SH_BASE}/${source}/${skillId}`,
    };
  }
  return null;
}

/**
 * 从 GitHub raw 拉原始 SKILL.md。
 * 404 → null(触发回退);429/5xx 走重试;其余错误抛出。
 * 内容必须以 `---` 或 `#`/文字开头且非空,防止把错误页当正文。
 */
export async function fetchGithubRawSkillMd(
  source: string,
  skillId: string,
  opts: FetchOpts = {},
): Promise<string | null> {
  const url = `${RAW_BASE}${GITHUB_RAW_PATH(source, skillId)}`;
  const res = await httpGet(url, opts);
  if (res.status === 404) return null;
  if (res.status !== 200) {
    throw new Error(`fetchGithubRawSkillMd(${source}/${skillId}): HTTP ${res.status}`);
  }
  const text = await res.text();
  if (text.trim().length === 0) return null;
  return text;
}

/**
 * 从 skills.sh 详情页 RSC payload 拼出完整 SKILL.md HTML。
 * 页面组件 CollapsibleReadme 把内容拆成 previewHtml + restHtml:
 * 小内容内联在 JSON 里,大内容拆成独立 T chunk(`"previewHtml":"$2e"` 引用)。
 * 两个字段都没有(如付费/受限技能的页面)→ 返回 null 表示内容不可用。
 */
export function parseDetailReadmeHtml(payload: string): string | null {
  const chunks = parseFlightTextChunks(payload);
  const preview = readRscString(payload, 'previewHtml', chunks);
  const rest = readRscString(payload, 'restHtml', chunks);
  if (preview === null && rest === null) {
    return null;
  }
  return (preview ?? '') + (rest ?? '');
}

async function fetchSkillsShReadmeHtml(
  source: string,
  skillId: string,
  opts: FetchOpts = {},
): Promise<string | null> {
  const url = `${SKILLS_SH_BASE}/${source}/${skillId}`;
  const res = await httpGet(url, { ...opts, rsc: true });
  if (res.status === 404) return null;
  if (res.status !== 200) {
    throw new Error(`fetchSkillsShReadmeHtml(${source}/${skillId}): HTTP ${res.status}`);
  }
  return parseDetailReadmeHtml(await res.text());
}

interface HttpResult {
  status: number;
  text: () => Promise<string>;
}

/** 带超时与重试(429/5xx)的 GET;404 不重试直接返回。 */
async function httpGet(
  url: string,
  opts: FetchOpts & { rsc?: boolean } = {},
): Promise<HttpResult> {
  const tries = opts.tries ?? 3;
  const baseMs = opts.baseMs ?? 1500;
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const f: FetchImpl = opts.fetchImpl ?? (globalThis.fetch as FetchImpl);

  let lastErr: unknown;
  for (let i = 0; i < tries; i++) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const res = await f(url, {
        signal: ctl.signal,
        headers: {
          'User-Agent': 'skills-trending-tracker',
          ...(opts.rsc && { RSC: '1' }),
        },
      });
      clearTimeout(timer);
      // 404 是确定性结果,不重试;429/5xx 可重试
      if (res.status === 404) return { status: 404, text: () => res.text() };
      if (res.status === 429 || res.status >= 500) {
        throw new Error(`HTTP ${res.status}`);
      }
      if (!res.ok) return { status: res.status, text: () => res.text() };
      return { status: res.status, text: () => res.text() };
    } catch (e) {
      clearTimeout(timer);
      lastErr = e;
      const retryable =
        e instanceof Error &&
        (e.name === 'AbortError' || e.message.includes('fetch') || /^HTTP (429|5\d\d)$/.test(e.message));
      if (i === tries - 1 || !retryable) throw e;
      await sleep(baseMs * 2 ** i);
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error('httpGet: unknown');
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
