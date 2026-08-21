/**
 * 버그 티켓 구조화 템플릿 (2026-08-21)
 * ────────────────────────────────────────────────────────────────────────
 * 대시보드의 프로그램적 버그 등록(테스트 자동화·QA 작업 두 탭 공용)이 `/create-bug`
 * 커맨드/DV-647 수준의 구조를 따르게 한다. 예전엔 평문 blob 한 덩이라 부실했다.
 *
 * 참고 티켓(DV-647) 구조 = 이 섹션들:
 *   재현 경로 · 실제 결과 · 기대 결과 · 원인(코드) · 영향 · 수정 방향 · 검증 환경
 *
 * ⚠️ "원인(코드)"는 실제 소스 분석(파일:라인)이 있어야 가치가 있다. 없으면 비워두지
 *    말고 **"미확정 — 재현 후 코드 확인 필요"** 로 명시한다(모르는 걸 아는 척 금지 — 5축 원칙).
 *
 * 층: 🔵 코어(도메인 무관 렌더러) + 🟡 컴포넌트/레이블 기본값(env). 도메인 값은 넣지 않는다.
 */

export type Confidence = 'confirmed' | 'probable' | 'api-only';

export interface BugSections {
  /** 발견 경위 — 어떤 작업/실행에서 나왔는지 한 줄 */
  context?: string;
  /** 재현 경로 — 최소 스텝(부수 조작 제외) */
  reproduction?: string[];
  /** 실제 결과 — 응답코드/메시지/상태 */
  actual?: string;
  /** 기대 결과 */
  expected?: string;
  /** 원인(코드) — `파일:라인` + 설명. 미확정이면 그렇게 명시 */
  rootCause?: string;
  /** 영향 — 누가/어떤 경로에서 겪는가, 발생 가능성 */
  impact?: string;
  /** 수정 방향(제안) */
  fixProposal?: string;
  /** 검증 환경 — env·계정·날짜·데이터 정리 여부 */
  environment?: string;
  /** 신뢰도 등급 — confirmed/probable/api-only (레이블로도 반영) */
  confidence?: Confidence;
}

/** 신뢰도 등급 설명 (본문 명시용) */
const CONFIDENCE_NOTE: Record<Confidence, string> = {
  confirmed: '재현·원인·실사용 경로까지 확인됨',
  probable: '재현·원인 확실, 사용자 영향 범위는 미확정',
  'api-only': 'API 직접 호출에서만 확인, 실사용 UI 경로 없음',
};

// ── ADF 헬퍼 ──────────────────────────────────────────────────────────
type Adf = Record<string, unknown>;
const text = (t: string): Adf => ({ type: 'text', text: t });
const para = (t: string): Adf => ({ type: 'paragraph', content: t ? [text(t)] : [] });
const heading = (t: string): Adf => ({ type: 'heading', attrs: { level: 2 }, content: [text(t)] });
const codeBlock = (t: string): Adf => ({ type: 'codeBlock', attrs: {}, content: [text(t)] });
const orderedList = (items: string[]): Adf => ({
  type: 'orderedList',
  content: items.map((it) => ({ type: 'listItem', content: [para(it)] })),
});
/** 여러 줄 텍스트 → 문단들 */
const paras = (t: string): Adf[] => t.split('\n').map((l) => para(l));

/**
 * BugSections → Jira ADF 문서. 있는 섹션만 헤딩과 함께 렌더한다.
 * 코드/에러 메시지가 섞인 원인·실제결과는 codeBlock로 가독성 확보.
 */
export function bugDescriptionAdf(s: BugSections): Adf {
  const content: Adf[] = [];
  if (s.context) content.push(para(s.context));
  if (s.reproduction?.length) {
    content.push(heading('재현 경로'), orderedList(s.reproduction));
  }
  if (s.actual) {
    content.push(heading('실제 결과'));
    if (looksLikeCode(s.actual)) content.push(codeBlock(s.actual));
    else content.push(...paras(s.actual));
  }
  if (s.expected) content.push(heading('기대 결과'), ...paras(s.expected));
  if (s.rootCause) content.push(heading('원인 (코드)'), ...paras(s.rootCause));
  if (s.impact) content.push(heading('영향'), ...paras(s.impact));
  if (s.fixProposal) content.push(heading('수정 방향 (제안)'), ...paras(s.fixProposal));
  if (s.environment) content.push(heading('검증 환경'), ...paras(s.environment));
  if (s.confidence) {
    content.push(heading('신뢰도'), para(`${s.confidence} — ${CONFIDENCE_NOTE[s.confidence]}`));
  }
  if (content.length === 0) content.push(para('(내용 없음)'));
  return { type: 'doc', version: 1, content };
}

/** 여러 줄/코드처럼 보이면 codeBlock로 */
function looksLikeCode(t: string): boolean {
  return /\n/.test(t) && /[{}[\]();]|assert|Error|HTTP|\bwhere\b/.test(t);
}

/** 미리보기·복사용 마크다운 (모달 표시) */
export function bugSectionsToMarkdown(s: BugSections): string {
  const out: string[] = [];
  if (s.context) out.push(s.context, '');
  const sec = (title: string, body?: string) => {
    if (body) out.push(`## ${title}`, body, '');
  };
  if (s.reproduction?.length) out.push('## 재현 경로', ...s.reproduction.map((r, i) => `${i + 1}. ${r}`), '');
  sec('실제 결과', s.actual);
  sec('기대 결과', s.expected);
  sec('원인 (코드)', s.rootCause);
  sec('영향', s.impact);
  sec('수정 방향 (제안)', s.fixProposal);
  sec('검증 환경', s.environment);
  if (s.confidence) sec('신뢰도', `${s.confidence} — ${CONFIDENCE_NOTE[s.confidence]}`);
  return out.join('\n').trim();
}

/** 레이블 — QA 필수 + 신뢰도 등급 + 추가 레이블. 중복 제거 */
export function bugLabels(base: string[] = [], confidence?: Confidence): string[] {
  return [...new Set(['QA', ...(confidence ? [confidence] : []), ...base])];
}
