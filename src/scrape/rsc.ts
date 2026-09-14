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
