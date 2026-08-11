/**
 * 워크스페이스 상태 저장소 타입.
 * SQLite 행 ↔ 화면이 쓰는 형태를 한 곳에서 정의한다.
 */

// ─── 공통 ─────────────────────────────────────────────────────────────

/** 심각도 — 색·형태로 인코딩된다 (시맨틱 색은 액센트와 분리) */
export type Severity = 'crit' | 'warn' | 'info' | 'ok' | 'idle';

/** 수집기 이름 */
export type SourceName = 'api-test' | 'jira' | 'datadog' | 'web-e2e' | 'stage-pr';

/** 테스트 러너 */
export type Runner = 'api' | 'web' | 'app';

/** 우선순위 — 실무단 티켓이 자동화보다 높다 (2026-08-04 확정) */
export type Priority = 'P0' | 'P1' | 'P2' | 'P3';

/**
 * 실패 분류 6종 (2026-08-06 확정).
 * 웹 `/daily-qa` 5종 + API `summarize.mjs` 4종을 통합한 것.
 * 러너별로 안 쓰는 유형이 있는 것은 허용한다 (API엔 셀렉터 개념이 없음).
 */
export type FindingKind =
  | 'fix-confirmed' // xfail→XPASS / test.fail→pass = 버그 수정됨
  | 'contract-drift' // 4xx/5xx + matrix 대조 = 계약이 바뀜
  | 'bug-candidate' // 제품 결함 의심
  | 'selector-drift' // TimeoutError / locator not found (웹 전용)
  | 'unstable' // flaky · 스테이지 불안정
  | 'coverage-gap'; // TC는 있는데 코드가 없음

/** 판정 경로 — 어디서 토큰이 들었는지 추적 */
export type VerdictBy = 'rule' | 'cache' | 'llm';

/** todo 완료 방식 — 자동 완료는 도입하지 않는다 (운영 후 재결정) */
export type TodoMode = 'semi' | 'manual';

/** 알림 종류 */
export type NoticeKind =
  | 'carry-over' // 이월 상한(D+7) 초과로 todo에서 이동
  | 'stale-asset' // 7일 이상 신호 없는 자산
  | 'stalled-ticket' // 상태가 오래 안 바뀌는 티켓
  | 'metric-stall' // 지표 정체
  | 'skip-limit'; // 미구현 스켈레톤 상한 접근

// ─── 행(row) 타입 ─────────────────────────────────────────────────────

export interface SignalRow {
  id: number;
  source: SourceName;
  kind: string;
  ref: string;
  fingerprint: string | null;
  title: string;
  detail: string | null;
  severity: Severity;
  url: string | null;
  payload: string | null;
  observed_at: string;
  collected_at: string;
}

export interface TestRunRow {
  id: number;
  runner: Runner;
  suite: string;
  external_id: string;
  status: 'success' | 'failure' | 'cancelled' | 'unknown';
  total: number | null;
  passed: number | null;
  failed: number | null;
  skipped: number | null;
  started_at: string | null;
  duration_sec: number | null;
  url: string | null;
  collected_at: string;
}

export interface FindingRow {
  id: number;
  fingerprint: string;
  run_id: number | null;
  runner: Runner;
  node_id: string;
  kind: FindingKind | null;
  verdict_by: VerdictBy | null;
  error_type: string | null;
  message_norm: string | null;
  contract_key: string | null;
  detail: string | null;
  first_seen: string;
  last_seen: string;
  occurrences: number;
  analyzed_at: string | null;
  analysis: string | null;
  resolved_at: string | null;
}

export interface TicketRow {
  jira_key: string;
  finding_id: number | null;
  summary: string | null;
  status: string | null;
  confidence: string | null;
  is_mine: number;
  labels: string | null;
  updated_at: string | null;
  status_since: string | null;
  url: string | null;
  collected_at: string;
}

export interface TodoRow {
  id: number;
  day: string;
  key: string;
  priority: Priority;
  title: string;
  detail: string | null;
  source: string | null;
  mode: TodoMode;
  action_label: string | null;
  action_url: string | null;
  signal_id: number | null;
  first_day: string;
  pinned: number;
  promoted: number;
  done_at: string | null;
  created_at: string;
}

export interface NoticeRow {
  id: number;
  kind: NoticeKind;
  key: string;
  title: string;
  detail: string | null;
  source: string | null;
  since: string | null;
  days: number | null;
  origin_todo_key: string | null;
  original_priority: Priority | null;
  snoozed_until: string | null;
  dismissed: number;
  created_at: string;
  updated_at: string;
}

// ─── 화면이 받는 형태 ─────────────────────────────────────────────────

/** todo 한 줄 — 경과일(D+N)이 계산되어 붙는다 */
export interface TodoItem extends TodoRow {
  /** day - first_day. 0이면 오늘 처음 나온 항목 */
  carriedDays: number;
  /** carriedDays > 3 이면 위험색으로 승격 */
  hot: boolean;
}

/** 브리핑 타일 */
export interface BriefTile {
  key: string;
  value: string;
  label: string;
  detail: string;
  tone: Severity;
  /** 결론 타일 — 형태로도 강조 */
  hero?: boolean;
}

/** 신호 블록 (오늘 화면 하단) */
export interface SignalBlock {
  key: string;
  title: string;
  priority: Priority | null;
  tone: Severity;
  badge: string;
  rows: Array<{
    pill?: { text: string; tone: Severity };
    title: string;
    detail?: string;
    mono?: boolean;
  }>;
  note?: string;
}

/** /api/workspace/today 응답 */
export interface TodayPayload {
  day: string;
  collectedAt: string | null;
  tiles: BriefTile[];
  todos: TodoItem[];
  blocks: SignalBlock[];
  noticeCount: number;
  /** 수집기별 상태 (우측 패널) */
  collectors: Array<{
    name: SourceName;
    ok: boolean;
    at: string | null;
    detail: string;
  }>;
}
