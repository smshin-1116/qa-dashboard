import { marked } from 'marked';
import { highlight } from './codeHighlight';

/** 우선순위 배지 설정 */
const PRIORITY_BADGES: Record<string, string> = {
  Highest: 'badge priority-highest',
  High: 'badge priority-high',
  Medium: 'badge priority-medium',
  Low: 'badge priority-low',
};

/** 상태 배지 설정 */
const STATUS_BADGES: Record<string, string> = {
  'Not Run': 'badge status-notrun',
  Pass: 'badge status-pass',
  Fail: 'badge status-fail',
  Blocked: 'badge status-blocked',
};

/** HTML 속성에 안전하게 삽입하기 위한 이스케이프 */
function escapeAttr(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** 코드 블록을 shiki 하이라이트 + 복사 버튼으로 래핑 */
async function buildCodeBlock(lang: string, code: string): Promise<string> {
  const shikiHtml = await highlight(code, lang);
  const escapedCode = escapeAttr(code);
  const displayLang = lang || 'text';
  return `<div class="code-block-wrap"><div class="code-block-header"><span class="code-lang">${displayLang}</span><button class="copy-btn" data-copy-code="${escapedCode}">복사</button></div>${shikiHtml}</div>`;
}

/** td 셀 안의 우선순위/상태 값을 배지로 변환 */
function applyBadges(html: string): string {
  let result = html;

  for (const [label, cls] of Object.entries(PRIORITY_BADGES)) {
    result = result.replace(
      new RegExp(`<td>\\s*${label}\\s*</td>`, 'g'),
      `<td><span class="${cls}">${label}</span></td>`,
    );
  }
  for (const [label, cls] of Object.entries(STATUS_BADGES)) {
    result = result.replace(
      new RegExp(`<td>\\s*${label}\\s*</td>`, 'g'),
      `<td><span class="${cls}">${label}</span></td>`,
    );
  }
  return result;
}

/**
 * 마크다운 텍스트를 완전한 HTML로 변환
 * - 코드 블록: shiki 하이라이팅 + 복사 버튼
 * - 테이블: 스타일 클래스 적용
 * - 우선순위/상태: 색상 배지
 */
export async function renderMarkdown(text: string): Promise<string> {
  const PLACEHOLDER = '\x00CODEBLOCK\x00';
  const codeBlocks: string[] = [];

  // 1. 코드 블록 추출 및 하이라이트
  const codeBlockRegex = /```(\w*)\n([\s\S]*?)```/g;
  const codeMatches: Array<{ original: string; lang: string; code: string }> = [];

  let m: RegExpExecArray | null;
  while ((m = codeBlockRegex.exec(text)) !== null) {
    codeMatches.push({ original: m[0], lang: m[1] || 'text', code: m[2] });
  }

  // 병렬 하이라이트 처리
  const builtBlocks = await Promise.all(
    codeMatches.map(({ lang, code }) => buildCodeBlock(lang, code)),
  );

  // 코드 블록을 플레이스홀더로 교체
  let processedText = text;
  for (let i = 0; i < codeMatches.length; i++) {
    processedText = processedText.replace(codeMatches[i].original, `${PLACEHOLDER}${i}${PLACEHOLDER}`);
    codeBlocks.push(builtBlocks[i]);
  }

  // 2. marked로 나머지 마크다운 파싱
  let html = await marked.parse(processedText);

  // 3. 코드 블록 복원
  for (let i = 0; i < codeBlocks.length; i++) {
    // marked가 플레이스홀더를 <p>로 감쌀 수 있음
    html = html.replace(`<p>${PLACEHOLDER}${i}${PLACEHOLDER}</p>`, codeBlocks[i]);
    html = html.replace(`${PLACEHOLDER}${i}${PLACEHOLDER}`, codeBlocks[i]);
  }

  // 4. 테이블 스타일 클래스 적용
  html = html.replace(/<table>/g, '<div class="md-table-wrap"><table class="md-table">');
  html = html.replace(/<\/table>/g, '</table></div>');

  // 5. 우선순위/상태 배지 적용
  html = applyBadges(html);

  return html;
}
