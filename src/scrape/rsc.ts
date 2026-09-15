import { ParseError, type RawSkill } from '../types';

export interface RscSkillsPayload {
  view: string;          // "all-time" | "trending" | "hot"
  totalSkills: number;   // 全库技能总数(并非本页条数)
  skills: RawSkill[];    // 本页返回的技能列表(当前每视图 600 条)
}

/**
 * 解析 skills.sh 的 RSC (React Server Components flight) 响应。
 *
 * 请求 https://www.skills.sh/{,trending,hot} 并携带 `RSC: 1` 头时,
 * Next.js 返回多行 flight 数据,其中一行形如:
 *
 *   4d:["$","$L54",null,{"initialSkills":[{...},...],"totalSkills":9947,"allTimeTotal":1479687,"view":"trending"}]
 *
 * 这里不实现完整的 flight 协议,只做两件事:
 *   1. 定位 "initialSkills": 后面的 JSON 数组(字符串感知的括号配平);
 *   2. 用正则取出 view / totalSkills 两个标量做校验。
 */
export function parseRscSkills(payload: string): RscSkillsPayload {
  const keyIdx = payload.indexOf('"initialSkills":');
  if (keyIdx === -1) {
    throw new ParseError(
      'parseRscSkills: no "initialSkills" in payload — skills.sh markup may have changed',
    );
  }

  const arrStart = payload.indexOf('[', keyIdx);
  if (arrStart === -1) {
    throw new ParseError('parseRscSkills: no array after "initialSkills"');
  }
  const arrEnd = matchBracket(payload, arrStart);
  if (arrEnd === -1) {
    throw new ParseError('parseRscSkills: unterminated initialSkills array');
  }

  let skills: RawSkill[];
  try {
    skills = JSON.parse(payload.slice(arrStart, arrEnd + 1)) as RawSkill[];
  } catch (e) {
    throw new ParseError(
      `parseRscSkills: initialSkills is not valid JSON (${e instanceof Error ? e.message : String(e)})`,
    );
  }
  if (!Array.isArray(skills) || skills.length === 0) {
    throw new ParseError('parseRscSkills: initialSkills is empty');
  }

  const viewM = payload.match(/"view":"([^"]+)"/);
  if (!viewM || !viewM[1]) {
    throw new ParseError('parseRscSkills: missing "view" in payload');
  }
  const view = viewM[1];

  const totalM = payload.match(/"totalSkills":(\d+)/);
  if (!totalM || !totalM[1]) {
    throw new ParseError('parseRscSkills: missing "totalSkills" in payload');
  }
  const totalSkills = parseInt(totalM[1], 10);

  return { view, totalSkills, skills };
}

/** 在 payload 里找 "key": 之后的 [ ... ] 并返回闭合 ] 的下标(字符串感知)。 */
function matchBracket(s: string, open: number): number {
  let depth = 0;
  let inStr = false;
  for (let i = open; i < s.length; i++) {
    const c = s[i]!;
    if (inStr) {
      if (c === '\\') i++; // 跳过转义字符
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '[') depth++;
    else if (c === ']') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * 顺序解析 RSC flight payload,收集所有 T 行(文本 chunk)为 {id: 文本}。
 *
 * flight 格式要点(从真实 payload 逆向得出):
 *   - 每行(row)形如 `<hexid>:<row-data>`;
 *   - 文本行是 `<hexid>:T<hexlen>,<恰好 hexlen 字节的内容>` —— 注意长度是十六进制
 *     (如 `2e:T497,` 实际取 0x497=1175 字节),且 T 行内容可含裸换行,
 *     下一行可能直接紧跟内容之后(不以换行分隔),所以不能按行 split;
 *   - JSON 行是单行(JSON 字符串内换行已转义),可安全跳到下一个换行。
 */
export function parseFlightTextChunks(payload: string): Map<string, string> {
  const chunks = new Map<string, string>();
  const rowHead = /^[0-9a-f]+:/;
  const tRow = /^T([0-9a-f]+),/;
  let i = 0;
  const n = payload.length;

  while (i < n) {
    if (payload[i] === '\n') {
      i++;
      continue;
    }
    const head = rowHead.exec(payload.slice(i));
    if (!head) {
      // 不在行首的杂散内容(不应发生);跳过到下一行保证循环前进
      const nl = payload.indexOf('\n', i);
      if (nl === -1) break;
      i = nl + 1;
      continue;
    }
    const id = head[0].slice(0, -1);
    i += head[0].length;

    const t = tRow.exec(payload.slice(i));
    if (t) {
      const len = parseInt(t[1]!, 16);
      i += t[0].length;
      chunks.set(id, payload.slice(i, i + len));
      i += len;
      if (payload[i] === '\n') i++;
    } else {
      // JSON 行:单行,跳到换行
      const nl = payload.indexOf('\n', i);
      if (nl === -1) break;
      i = nl + 1;
    }
  }
  return chunks;
}

/**
 * 读取 payload 中 `"key":` 后面的 JSON 字符串值。
 * 值可能是内联字符串(含转义),也可能是指向 T chunk 的引用 "$2e"。
 * 返回解析后的文本;引用缺失时返回 null。
 */
export function readRscString(
  payload: string,
  key: string,
  chunks?: Map<string, string>,
): string | null {
  const keyIdx = payload.indexOf(`"${key}":`);
  if (keyIdx === -1) return null;

  let i = keyIdx + key.length + 3; // 跳过 "key":
  if (payload[i] !== '"') return null;
  i++;
  if (payload[i] === '$') {
    // chunk 引用形如 "$2e"
    const m = /^[0-9a-f]+/.exec(payload.slice(i + 1));
    if (!m) return null;
    return chunks?.get(m[0]) ?? null;
  }
  // 内联字符串:扫描到未转义的闭合引号
  const start = i - 1;
  let inStr = true;
  for (; i < payload.length; i++) {
    const c = payload[i]!;
    if (c === '\\') {
      i++;
      continue;
    }
    if (c === '"') {
      inStr = false;
      break;
    }
  }
  if (inStr) return null;
  try {
    return JSON.parse(payload.slice(start, i + 1)) as string;
  } catch {
    return null;
  }
}
