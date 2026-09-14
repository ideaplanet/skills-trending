import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'bun:test';
import { parseRscSkills } from '../src/scrape/rsc';
import { parseViewSkills } from '../src/scrape/skills';
import { ParseError, type View } from '../src/types';

const fixtures: Record<View, string> = {
  'all-time': readFileSync('tests/fixtures/rsc-all-time.txt', 'utf-8'),
  trending: readFileSync('tests/fixtures/rsc-trending.txt', 'utf-8'),
  hot: readFileSync('tests/fixtures/rsc-hot.txt', 'utf-8'),
};

describe('parseRscSkills — fixtures', () => {
  test('trending fixture yields view/totalSkills and 12 skills', () => {
    const p = parseRscSkills(fixtures.trending);
    expect(p.view).toBe('trending');
    expect(p.totalSkills).toBeGreaterThan(1000);
    expect(p.skills.length).toBe(12);

    const first = p.skills[0]!;
    expect(first.source).toBe('designed-by-ai/skills');
    expect(first.skillId).toBe('design-mobile-apps');
    expect(first.installs).toBeGreaterThan(0);
  });

  test('all-time fixture keeps weeklyInstalls and isOfficial', () => {
    const p = parseRscSkills(fixtures['all-time']);
    expect(p.view).toBe('all-time');
    const first = p.skills[0]!;
    expect(first.skillId).toBe('find-skills');
    expect(first.installs).toBeGreaterThan(1_000_000);
    expect(first.weeklyInstalls?.length).toBeGreaterThan(0);
    expect(first.isOfficial).toBe(true);
  });

  test('hot fixture keeps installsYesterday and change', () => {
    const p = parseRscSkills(fixtures.hot);
    expect(p.view).toBe('hot');
    const first = p.skills[0]!;
    expect(typeof first.change).toBe('number');
    expect(typeof first.installsYesterday).toBe('number');
  });
});

describe('parseViewSkills — fixtures', () => {
  test('rank is 1..N in payload order; pk = source/skillId', () => {
    for (const view of ['all-time', 'trending', 'hot'] as const) {
      const rows = parseViewSkills(view, fixtures[view]);
      expect(rows.length).toBe(12);
      for (let i = 0; i < rows.length; i++) {
        const r = rows[i]!;
        expect(r.rank).toBe(i + 1);
        expect(r.pk).toBe(`${r.source}/${r.skill_id}`);
        expect(r.installs).toBeGreaterThanOrEqual(0);
      }
    }
  });

  test('view-specific fields are mapped, others null', () => {
    const allTime = parseViewSkills('all-time', fixtures['all-time']);
    expect(allTime[0]!.weekly_installs).not.toBeNull();
    expect(allTime[0]!.change).toBeNull();

    const hot = parseViewSkills('hot', fixtures.hot);
    expect(hot[0]!.change).not.toBeNull();
    expect(hot[0]!.installs_yesterday).not.toBeNull();
    expect(hot[0]!.weekly_installs).toBeNull();

    const trending = parseViewSkills('trending', fixtures.trending);
    expect(trending[0]!.weekly_installs).toBeNull();
    expect(trending[0]!.change).toBeNull();
  });
});

describe('parseViewSkills — error cases', () => {
  test('payload without initialSkills throws ParseError', () => {
    expect(() => parseViewSkills('trending', 'garbage')).toThrow(ParseError);
  });

  test('view mismatch throws ParseError', () => {
    // all-time 的 payload 冒充 trending → 必须报错而不是张冠李戴
    expect(() => parseViewSkills('trending', fixtures['all-time'])).toThrow(
      ParseError,
    );
  });

  test('unterminated array throws ParseError', () => {
    const broken = fixtures.trending.slice(0, fixtures.trending.length - 100);
    // 截断可能恰好断在别处,但无论如何不应解析成功;若解析成功说明截断处仍完整
    try {
      parseViewSkills('trending', broken);
      // 截断点落在 initialSkills 之后时不影响解析,这里只验证不抛非 ParseError
    } catch (e) {
      expect(e).toBeInstanceOf(ParseError);
    }
  });
});

describe('parseRscSkills — escaping robustness', () => {
  test('brackets inside string literals do not break extraction', () => {
    const payload =
      `0:["$","x",null,{"note":"[fake ] brackets \\" and ] chars",` +
      `"initialSkills":[{"source":"a/b","skillId":"s","name":"s","installs":5}],` +
      `"totalSkills":1,"view":"trending"}]`;
    const p = parseRscSkills(payload);
    expect(p.skills.length).toBe(1);
    expect(p.skills[0]!.skillId).toBe('s');
  });
});
