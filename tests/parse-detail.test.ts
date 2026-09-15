import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'bun:test';
import {
  parseFlightTextChunks,
  readRscString,
} from '../src/scrape/rsc';
import { parseDetailReadmeHtml } from '../src/scrape/readme';

const detailPayload = readFileSync(
  'tests/fixtures/rsc-detail-remotion.txt',
  'utf-8',
);

describe('parseFlightTextChunks — real detail payload', () => {
  test('collects T-chunks with hex lengths (0x497=1175, 0xbbb=3003)', () => {
    const chunks = parseFlightTextChunks(detailPayload);
    expect(chunks.get('2e')!.length).toBe(0x497);
    expect(chunks.get('2f')!.length).toBe(0xbbb);
    expect(chunks.get('2e')!.startsWith('<h2>Preserve user changes</h2>')).toBe(true);
  });

  test('handles chunk rows not preceded by newline', () => {
    // 真实 payload 中 2f 行紧跟在 2e 内容之后(无换行分隔),顺序扫描必须能找到
    const chunks = parseFlightTextChunks(detailPayload);
    expect(chunks.has('2f')).toBe(true);
  });
});

describe('parseFlightTextChunks — synthetic edge cases', () => {
  test('hex length with content containing newlines and row-like text', () => {
    const content = 'line1\nline2 with fake row 99:T5,xxxx inside\nline3';
    const payload = `1:["$","div"]\n2f:T${content.length.toString(16)},${content}30:["$","p"]\n`;
    const chunks = parseFlightTextChunks(payload);
    expect(chunks.get('2f')).toBe(content);
    // 2f 内容里的 "99:T5," 不会被误认为新行(它不在行首)
    expect(chunks.has('99')).toBe(false);
  });

  test('empty payload returns empty map', () => {
    expect(parseFlightTextChunks('').size).toBe(0);
  });
});

describe('readRscString', () => {
  test('inline string with escapes', () => {
    const payload = `1:["$","x",null,{"previewHtml":"<p>say \\"hi\\"</p>\\n","restHtml":""}]`;
    expect(readRscString(payload, 'previewHtml')).toBe('<p>say "hi"</p>\n');
  });

  test('chunk reference resolves via chunks map', () => {
    const payload = `{"previewHtml":"$2e"}`;
    const chunks = new Map([['2e', '<h1>x</h1>']]);
    expect(readRscString(payload, 'previewHtml', chunks)).toBe('<h1>x</h1>');
  });

  test('missing key / dangling ref → null', () => {
    expect(readRscString('{}', 'previewHtml')).toBeNull();
    expect(readRscString('{"previewHtml":"$ff"}', 'previewHtml')).toBeNull();
  });
});

describe('parseDetailReadmeHtml — real payload', () => {
  test('preview + rest concat to complete SKILL.md html', () => {
    const html = parseDetailReadmeHtml(detailPayload)!;
    // 0x497 + 0xbbb = 4178
    expect(html.length).toBe(4178);
    expect(html.startsWith('<h2>Preserve user changes</h2>')).toBe(true);
    expect(html.endsWith('Remotion Upgrade</a>.</p>')).toBe(true);
    expect(html).toContain('<h2>Upgrading</h2>');
  });

  test('payload without readme fields → null (gated/unavailable skill)', () => {
    expect(parseDetailReadmeHtml('1:["$","div",null,{"children":"SKILL.md"}]')).toBeNull();
  });
});
