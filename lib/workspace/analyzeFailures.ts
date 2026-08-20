/**
 * 실패 일괄 분석 (2026-08-20) — 테스트 자동화 탭 "분석 실행".
 * ────────────────────────────────────────────────────────────────────────
 * 규칙 → 캐시 → LLM 순서로, 규칙이 못 가른/오래된 실패만 **LLM 배치 1회**로 분석한다.
 *   · 규칙: 수집기가 이미 kind를 붙임(verdict_by='rule')
 *   · 캐시: fingerprint별 analyzed_at이 TTL(7일) 안이면 재분석 안 함
 *   · LLM : 위를 통과한 것만 한 번의 호출로 묶어 분석 → analysis·analyzed_at 기입
 *
 * 토큰 규칙 준수: 배치 1회 · MCP 비활성(실패 데이터는 프롬프트에 주입, 외부 조회 없음)
 * · Sonnet 고정 · fingerprint 캐시로 같은 실패 재분석 금지.
 *
 * 🔵 코어(제네릭) — 도메인 용어를 넣지 않는다. 테스트 실패를 분석하는 일반 파이프라인.
 */
import { openFindings, setFindingAnalysis } from '@/lib/workspace/repo';
import { isAnalysisFresh } from '@/lib/workspace/fingerprint';
import { runClaude } from '@/lib/claudeRunner';
import type { FindingRow } from '@/lib/workspace/types';

/** LLM이 고를 수 있는 분류(수집기 6종과 동일 어휘) */
const KINDS = [
  'fix-confirmed',
  'contract-drift',
  'bug-candidate',
  'selector-drift',
  'unstable',
  'coverage-gap',
] as const;

const ANALYSIS_SYSTEM = `당신은 테스트 실패 분석 전문가입니다. 자동화 테스트(웹 E2E·API 등)의 실패 목록을 받아
각 실패의 **근본 원인 추정**과 **조치 방향**을 판정합니다. 실제 화면/코드에 접근하지 말고
(도구 없음) 주어진 에러 메시지·노드 ID·기존 규칙 분류만으로 판단합니다.

각 실패를 아래 kind 중 하나로 분류하세요:
- fix-confirmed: 알려진 버그가 고쳐진 신호(예: xfail이 통과로 뒤집힘)
- contract-drift: API 계약(스키마·상태코드)이 기대와 어긋남
- bug-candidate: 제품 버그로 의심되는 실제 실패
- selector-drift: 화면 셀렉터/타임아웃 — 테스트가 낡음(제품 정상일 수 있음)
- unstable: 재현 불안정(flaky)·환경 전제 실패 등
- coverage-gap: 검증 공백

⚠️ 출력은 **JSON 배열만**. 다른 텍스트·설명·코드펜스 없이 아래 형식 그대로:
[{"id": <숫자>, "kind": "<위 중 하나>", "analysis": "한 줄 근본원인 + 조치 방향(한국어, 100자 이내)"}]
반드시 입력의 모든 id에 대해 한 항목씩. id는 입력값 그대로.`;

function buildPrompt(items: FindingRow[]): string {
  const lines = items.map((f) => {
    const parts = [
      `- id: ${f.id}`,
      `  runner: ${f.runner}`,
      f.node_id && `  target: ${f.node_id}`,
      f.error_type && `  error_type: ${f.error_type}`,
      f.kind && `  규칙분류: ${f.kind}`,
      f.contract_key && `  contract: ${f.contract_key}`,
      f.occurrences && `  발생: ${f.occurrences}회`,
      f.detail && `  message: ${f.detail.slice(0, 300).replace(/\n/g, ' ')}`,
    ].filter(Boolean);
    return parts.join('\n');
  });
  return `[분석할 테스트 실패 ${items.length}건]\n\n${lines.join('\n\n')}\n\n위 ${items.length}건 전부를 JSON 배열로 판정하세요.`;
}

/** 응답에서 JSON 배열만 뽑아 파싱 (코드펜스·잡텍스트 방어) */
function parseResults(content: string): Array<{ id: number; kind: string; analysis: string }> {
  const start = content.indexOf('[');
  const end = content.lastIndexOf(']');
  if (start < 0 || end <= start) return [];
  try {
    const parsed: unknown = JSON.parse(content.slice(start, end + 1));
    if (!Array.isArray(parsed)) return [];
    return (parsed as Array<Record<string, unknown>>)
      .map((r) => ({
        id: Number(r.id),
        kind: typeof r.kind === 'string' && (KINDS as readonly string[]).includes(r.kind) ? r.kind : '',
        analysis: typeof r.analysis === 'string' ? r.analysis.trim() : '',
      }))
      .filter((r) => Number.isFinite(r.id) && r.analysis);
  } catch {
    return [];
  }
}

export interface AnalyzeResult {
  /** 이번에 LLM으로 새로 분석한 건수 */
  analyzed: number;
  /** 캐시(TTL 내 analyzed_at)로 건너뛴 건수 */
  cached: number;
  /** 분석 대상이었으나 응답에서 매칭 못 한 건수 */
  unmatched: number;
  total: number;
}

/**
 * 미해소 finding 중 분석이 필요한(미분석·TTL 만료) 것만 LLM 배치 1회로 분석한다.
 * 화면(GET)이 아니라 명시적 트리거(POST)에서만 호출 — 매일 도는 경로에 LLM을 넣지 않는다.
 */
export async function analyzeFailures(): Promise<AnalyzeResult> {
  const all = openFindings(100);
  const stale = all.filter((f) => !isAnalysisFresh(f.analyzed_at));
  const cached = all.length - stale.length;

  if (stale.length === 0) {
    return { analyzed: 0, cached, unmatched: 0, total: all.length };
  }

  const { content } = await runClaude({
    message: buildPrompt(stale),
    systemPrompt: ANALYSIS_SYSTEM,
    disableMcp: true, // 외부 조회 없음 — 실패 데이터는 프롬프트에 주입
    model: 'sonnet', // 저비용 원샷
  });

  const results = parseResults(content);
  const byId = new Map(results.map((r) => [r.id, r]));

  let analyzed = 0;
  for (const f of stale) {
    const r = byId.get(f.id);
    if (!r) continue;
    setFindingAnalysis(f.id, { analysis: r.analysis, kind: r.kind || null, verdictBy: 'llm' });
    analyzed++;
  }

  return { analyzed, cached, unmatched: stale.length - analyzed, total: all.length };
}
