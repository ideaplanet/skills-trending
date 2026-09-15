import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'bun:test';
import {
  fetchGithubRawSkillMd,
  parseDetailReadmeHtml,
  scrapeSkillReadme,
} from '../src/scrape/readme';
import type { FetchImpl } from '../src/scrape/skills';

const detailPayload = readFileSync(
  'tests/fixtures/rsc-detail-remotion.txt',
  'utf-8',
);

const RAW_URL =
  'https://raw.githubusercontent.com/remotion-dev/skills/HEAD/skills/remotion-best-practices/SKILL.md';
const DETAIL_URL = 'https://www.skills.sh/remotion-dev/skills/remotion-best-practices';

const RAW_MD = `---
name: remotion-best-practices
description: Router for all Remotion skills
---
## Preserve user changes
Users may make edits in the code outside of the conversation.
`;

function res(body: string, status = 200): Response {
  return new Response(body, { status });
}

describe('scrapeSkillReadme — source selection', () => {
  test('github raw hit → markdown with frontmatter, no fallback request', async () => {
    const calls: string[] = [];
    const f: FetchImpl = async (url, init) => {
      calls.push(`${(init?.headers as Record<string, string>)?.RSC ?? '-'} ${url}`);
      return res(RAW_MD);
    };
    const r = await scrapeSkillReadme('remotion-dev/skills', 'remotion-best-practices', {
      fetchImpl: f,
    });
    expect(r).not.toBeNull();
    expect(r!.content_type).toBe('markdown');
    expect(r!.fetch_source).toBe('github-raw');
    expect(r!.source_url).toBe(RAW_URL);
    expect(r!.content).toContain('---\nname: remotion-best-practices');
    expect(calls.length).toBe(1);
    expect(calls[0]).toBe(`- ${RAW_URL}`); // 未携带 RSC 头
  });

  test('github raw 404 → falls back to skills.sh detail page (with RSC header)', async () => {
    const f: FetchImpl = async (url, init) => {
      if (url === RAW_URL) return res('404: Not Found', 404);
      expect(url).toBe(DETAIL_URL);
      expect((init?.headers as Record<string, string>)?.RSC).toBe('1');
      return res(detailPayload);
    };
    const r = await scrapeSkillReadme('remotion-dev/skills', 'remotion-best-practices', {
      fetchImpl: f,
    });
    expect(r).not.toBeNull();
    expect(r!.content_type).toBe('html');
    expect(r!.fetch_source).toBe('skills-sh');
    expect(r!.source_url).toBe(DETAIL_URL);
    expect(r!.content.length).toBe(4178);
  });

  test('both sources 404 → null', async () => {
    const f: FetchImpl = async () => res('404: Not Found', 404);
    const r = await scrapeSkillReadme('ghost/repo', 'nope', { fetchImpl: f });
    expect(r).toBeNull();
  });

  test('github raw 500 retries then succeeds', async () => {
    let calls = 0;
    const f: FetchImpl = async () => {
      calls++;
      if (calls === 1) return res('boom', 500);
      return res(RAW_MD);
    };
    const r = await fetchGithubRawSkillMd('remotion-dev/skills', 'remotion-best-practices', {
      fetchImpl: f,
      baseMs: 1,
    });
    expect(calls).toBe(2);
    expect(r).toBe(RAW_MD);
  });

  test('404 does not retry', async () => {
    let calls = 0;
    const f: FetchImpl = async () => {
      calls++;
      return res('404: Not Found', 404);
    };
    const r = await fetchGithubRawSkillMd('ghost/repo', 'nope', {
      fetchImpl: f,
      baseMs: 1,
    });
    expect(calls).toBe(1);
    expect(r).toBeNull();
  });

  test('empty github raw body → falls back', async () => {
    const f: FetchImpl = async (url) =>
      url === RAW_URL ? res('') : res(detailPayload);
    const r = await scrapeSkillReadme('remotion-dev/skills', 'remotion-best-practices', {
      fetchImpl: f,
    });
    expect(r!.fetch_source).toBe('skills-sh');
  });

  test('detail page returns 404 → null (both routes exhausted)', async () => {
    const f: FetchImpl = async () => res('404: Not Found', 404);
    const r = await scrapeSkillReadme('ghost/repo', 'nope', { fetchImpl: f });
    expect(r).toBeNull();
  });

  test('gated skill: detail page 200 but no readme fields → null', async () => {
    // 如 mattpocock/skills/* 这类付费技能,详情页存在但不渲染 SKILL.md 内容
    const gatedPayload = `29:[["$","title","0",{"children":"grill-me — mattpocock/skills"}]]`;
    const f: FetchImpl = async (url) =>
      String(url).includes('raw.githubusercontent.com')
        ? res('404: Not Found', 404)
        : res(gatedPayload);
    const r = await scrapeSkillReadme('mattpocock/skills', 'grill-me', {
      fetchImpl: f,
    });
    expect(r).toBeNull();
  });
});

describe('parseDetailReadmeHtml — used via scrape', () => {
  test('fallback content matches direct parse', async () => {
    const f: FetchImpl = async (url) =>
      url === RAW_URL ? res('404', 404) : res(detailPayload);
    const r = await scrapeSkillReadme('remotion-dev/skills', 'remotion-best-practices', {
      fetchImpl: f,
    });
    expect(r!.content).toBe(parseDetailReadmeHtml(detailPayload)!);
  });
});
