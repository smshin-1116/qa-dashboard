import { createHash } from 'node:crypto';

/**
 * "같은 실패"를 알아보는 키.
 *
 * ── 왜 필요한가 ───────────────────────────────────────────────────────
 * 같은 테스트가 같은 이유로 매일 실패하는데 매일 LLM으로 분석하면 낭비다.
 * 어제 판정을 재사용하려면 "이 실패 = 어제 그 실패"를 판단할 키가 있어야 한다.
 *
 * ── 왜 원문 그대로 비교하면 안 되나 ───────────────────────────────────
 *   어제  expected 200 but got 500 at POST /route/register (orderId=8842713)
 *   오늘  expected 200 but got 500 at POST /route/register (orderId=8843019)
 * ID만 다른데 문자열 비교로는 "다른 실패"가 되어 매일 새로 분석하게 된다.
 * → 매번 바뀌는 값(숫자·시각·UUID)을 <N>으로 치환한 뒤 해시한다.
 *
 * ── 선례 ──────────────────────────────────────────────────────────────
 * datadog-qa/triage-state.json이 이미 같은 개념을 쓴다:
 *   "<앱ID>|<정규화된 에러 메시지>"
 * RUM 에러 클러스터링에 쓰던 방식을 테스트 실패에 그대로 적용한 것이다.
 *
 * ── 트레이드오프 ──────────────────────────────────────────────────────
 * 너무 헐거우면 다른 원인이 같은 실패로 묶여 새 문제를 놓치고,
 * 너무 빡세면 매번 다른 키가 나와 캐시가 안 먹힌다.
 * → 정규화는 "명백히 실행마다 달라지는 값"으로만 한정하고,
 *   대신 TTL(7일)을 둬서 오래된 판정은 제품 변경 가능성을 고려해 재분석한다.
 */

/** 판정 캐시 유효기간 (일) — 지나면 재분석 대상 */
export const ANALYSIS_TTL_DAYS = 7;

/** 메시지에서 잘라낼 최대 길이 — 스택 전체가 아니라 앞부분만 본다 */
const MESSAGE_MAX = 200;

/**
 * 실행마다 달라지는 값을 <N>·<UUID>·<TS>로 치환한다.
 * 순서 주의: UUID·시각처럼 긴 패턴을 먼저 잡아야 숫자 규칙이 잘라먹지 않는다.
 */
export function normalizeMessage(raw: string): string {
  let s = raw.replace(/\r/g, '').trim();

  // 1) UUID
  s = s.replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '<UUID>');
  // 2) ISO 시각 / 날짜
  s = s.replace(/\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:?\d{2})?/g, '<TS>');
  s = s.replace(/\b\d{4}-\d{2}-\d{2}\b/g, '<DATE>');
  // 3) 시:분:초 (타임아웃 메시지 등)
  s = s.replace(/\b\d{1,2}:\d{2}:\d{2}(\.\d+)?\b/g, '<TIME>');
  // 4) 16진 토큰(짧은 해시·ObjectId)
  s = s.replace(/\b[0-9a-f]{16,}\b/gi, '<HEX>');
  // 5) 소요시간 (123ms / 1.5s)
  s = s.replace(/\b\d+(\.\d+)?\s?(ms|s|sec|초)\b/gi, '<DUR>');
  // 6) 남은 숫자 — 단, HTTP 상태코드는 판정에 필요하므로 보존
  s = s.replace(/\b\d+\b/g, (m) => (isHttpStatus(m) ? m : '<N>'));
  // 7) 공백 정리
  s = s.replace(/\s+/g, ' ').trim();

  return s.slice(0, MESSAGE_MAX);
}

/**
 * 상태코드는 남긴다 — "400이 아니라 500" 이 분류의 핵심 신호이기 때문.
 * 100~599 범위의 3자리만 상태코드로 본다.
 */
function isHttpStatus(token: string): boolean {
  if (token.length !== 3) return false;
  const n = Number(token);
  return n >= 100 && n <= 599;
}

/**
 * 테스트 노드 식별자 정규화.
 * pytest는 파일경로::클래스::함수[파라미터] 형태라 파라미터를 떼어낸다
 * (같은 테스트의 다른 파라미터를 같은 실패로 묶기 위함).
 */
export function normalizeNodeId(raw: string): string {
  return raw
    .replace(/\[[^\]]*\]$/, '') // pytest 파라미터
    .replace(/^.*?(tests?\/)/, '$1') // 절대경로 → tests/ 이하
    .trim();
}

export interface FingerprintInput {
  /** 'api' | 'web' | 'app' */
  runner: string;
  /** spec 파일::테스트명 */
  nodeId: string;
  /** AssertionError, TimeoutError 등. 없으면 'unknown' */
  errorType?: string | null;
  /** 원본 에러 메시지 */
  message?: string | null;
}

export interface FingerprintResult {
  fingerprint: string;
  nodeId: string;
  errorType: string;
  messageNorm: string;
}

/**
 * 구성 요소 구분자.
 *
 * ⚠️ 빈 문자열로 이으면 안 된다 — `["api","a","b"]`와 `["apia","b"]`가 같은 해시가 된다.
 * `|`를 쓰는 이유는 datadog-qa/triage-state.json의 키 형식(`<앱ID>|<정규화 메시지>`)과
 * 같은 규약을 따르기 위함이다. 정규화된 메시지에는 `|`가 거의 없고, 있어도
 * 요소 순서가 고정이라 모호해지지 않는다.
 */
const SEP = '|';

/**
 * runner + nodeId + errorType + 정규화 메시지 → sha1.
 * runner를 포함하는 이유: 웹과 API에 같은 이름의 테스트가 있어도 다른 실패다.
 */
export function makeFingerprint(input: FingerprintInput): FingerprintResult {
  const nodeId = normalizeNodeId(input.nodeId);
  const errorType = (input.errorType ?? 'unknown').trim() || 'unknown';
  const messageNorm = normalizeMessage(input.message ?? '');

  const fingerprint = createHash('sha1')
    .update([input.runner, nodeId, errorType, messageNorm].join(SEP))
    .digest('hex');

  return { fingerprint, nodeId, errorType, messageNorm };
}

/**
 * 판정 캐시가 아직 유효한가.
 * analyzedAt이 없으면 미분석, TTL을 넘었으면 재분석 대상.
 */
export function isAnalysisFresh(analyzedAt: string | null | undefined): boolean {
  if (!analyzedAt) return false;
  const ageMs = Date.now() - Date.parse(analyzedAt);
  if (Number.isNaN(ageMs)) return false;
  return ageMs < ANALYSIS_TTL_DAYS * 86_400_000;
}
