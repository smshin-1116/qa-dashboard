import { getDb, nowIso } from './db';
import type {
  FindingKind,
  FindingRow,
  NoticeKind,
  NoticeRow,
  Priority,
  Runner,
  Severity,
  SignalRow,
  SourceName,
  TestRunRow,
  TicketRow,
  TodoRow,
  VerdictBy,
} from './types';

/**
 * 상태 저장소 읽기/쓰기.
 *
 * 원칙: 수집은 **멱등**이어야 한다.
 * 같은 신호를 두 번 수집해도 행이 늘지 않도록 전부 UPSERT로 쓴다.
 * (수집기가 실패해 재시도되거나, 사용자가 "지금 수집"을 눌러도 안전해야 함)
 */

// ─── signal ───────────────────────────────────────────────────────────

export interface SignalInput {
  source: SourceName;
  kind: string;
  ref: string;
  title: string;
  detail?: string | null;
  severity?: Severity;
  url?: string | null;
  fingerprint?: string | null;
  payload?: unknown;
  observedAt: string;
}

/** 신호 저장 — (source, ref, observed_at)이 같으면 갱신만 한다 */
export function upsertSignal(input: SignalInput): void {
  getDb()
    .prepare(
      `INSERT INTO signal
         (source, kind, ref, fingerprint, title, detail, severity, url, payload, observed_at, collected_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(source, ref, observed_at) DO UPDATE SET
         title = excluded.title,
         detail = excluded.detail,
         severity = excluded.severity,
         url = excluded.url,
         payload = excluded.payload,
         collected_at = excluded.collected_at`,
    )
    .run(
      input.source,
      input.kind,
      input.ref,
      input.fingerprint ?? null,
      input.title,
      input.detail ?? null,
      input.severity ?? 'info',
      input.url ?? null,
      input.payload === undefined ? null : JSON.stringify(input.payload),
      input.observedAt,
      nowIso(),
    );
}

/**
 * 신호 제거 — **해소된 상태를 지우는 용도**.
 *
 * UPSERT만 있으면 한 번 뜬 경고가 영원히 남는다. 실제로 2026-08-07에
 * 차량 풀을 복구했는데도 "환경 건강도 위험"이 계속 떠 있었다.
 * 조건이 사라지면 신호도 사라져야 화면이 현재 상태를 말한다.
 */
export function removeSignal(source: SourceName, ref: string): void {
  getDb().prepare(`DELETE FROM signal WHERE source = ? AND ref = ?`).run(source, ref);
}

/** 특정 소스의 최신 신호 N건 */
export function latestSignals(source: SourceName, limit = 10): SignalRow[] {
  return getDb()
    .prepare(
      `SELECT * FROM signal WHERE source = ? ORDER BY observed_at DESC, id DESC LIMIT ?`,
    )
    .all(source, limit) as unknown as SignalRow[];
}

// ─── test_run ─────────────────────────────────────────────────────────

export interface TestRunInput {
  runner: Runner;
  suite: string;
  externalId: string;
  status: TestRunRow['status'];
  total?: number | null;
  passed?: number | null;
  failed?: number | null;
  skipped?: number | null;
  startedAt?: string | null;
  durationSec?: number | null;
  url?: string | null;
}

/** 실행 결과 저장 후 내부 id 반환 (finding이 참조) */
export function upsertTestRun(input: TestRunInput): number {
  const db = getDb();
  db.prepare(
    `INSERT INTO test_run
       (runner, suite, external_id, status, total, passed, failed, skipped, started_at, duration_sec, url, collected_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(runner, external_id) DO UPDATE SET
       status = excluded.status,
       total = excluded.total,
       passed = excluded.passed,
       failed = excluded.failed,
       skipped = excluded.skipped,
       started_at = excluded.started_at,
       duration_sec = excluded.duration_sec,
       url = excluded.url,
       collected_at = excluded.collected_at`,
  ).run(
    input.runner,
    input.suite,
    input.externalId,
    input.status,
    input.total ?? null,
    input.passed ?? null,
    input.failed ?? null,
    input.skipped ?? null,
    input.startedAt ?? null,
    input.durationSec ?? null,
    input.url ?? null,
    nowIso(),
  );

  const row = db
    .prepare('SELECT id FROM test_run WHERE runner = ? AND external_id = ?')
    .get(input.runner, input.externalId) as { id: number };
  return row.id;
}

/** 러너별 최근 실행 (스위트별 최신 1건씩) */
export function latestRunsByRunner(): TestRunRow[] {
  return getDb()
    .prepare(
      `SELECT r.* FROM test_run r
       JOIN (
         SELECT runner, suite, MAX(COALESCE(started_at, collected_at)) AS m
         FROM test_run GROUP BY runner, suite
       ) x ON x.runner = r.runner AND x.suite = r.suite
          AND COALESCE(r.started_at, r.collected_at) = x.m
       ORDER BY r.runner, r.suite`,
    )
    .all() as unknown as TestRunRow[];
}

/** 최근 env-health 신호 (차량 풀 고갈 등 환경 전제 상태). 없으면 null = 정상 */
export function latestEnvHealth(): { title: string; detail: string | null; observedAt: string | null } | null {
  const r = getDb()
    .prepare(
      `SELECT title, detail, observed_at FROM signal
       WHERE source = 'api-test' AND kind = 'env-health'
         AND observed_at >= datetime('now', '-2 days')
       ORDER BY observed_at DESC LIMIT 1`,
    )
    .get() as { title: string; detail: string | null; observed_at: string | null } | undefined;
  return r ? { title: r.title, detail: r.detail, observedAt: r.observed_at } : null;
}

/** 최근 N일 통과율 추이 — 러너 합산 일자별 (스파크라인용) */
export function passRateTrend(days = 7): Array<{ day: string; passed: number; total: number; failed: number }> {
  return getDb()
    .prepare(
      `SELECT date(COALESCE(started_at, collected_at)) AS day,
              SUM(passed) AS passed, SUM(total) AS total, SUM(failed) AS failed
       FROM test_run
       WHERE COALESCE(started_at, collected_at) >= datetime('now', ?)
       GROUP BY day ORDER BY day ASC`,
    )
    .all(`-${days} days`) as Array<{ day: string; passed: number; total: number; failed: number }>;
}

// ─── finding ──────────────────────────────────────────────────────────

export interface FindingInput {
  fingerprint: string;
  runId?: number | null;
  runner: Runner;
  nodeId: string;
  kind?: FindingKind | null;
  verdictBy?: VerdictBy | null;
  errorType?: string | null;
  messageNorm?: string | null;
  contractKey?: string | null;
  detail?: string | null;
  observedAt: string;
}

/**
 * 실패 저장.
 * fingerprint가 이미 있으면 **행을 새로 만들지 않고** last_seen·occurrences만 올린다.
 * → 같은 실패가 매일 나도 목록이 부풀지 않고, 재발 횟수가 보인다.
 * 기존 판정(kind/analysis)은 덮어쓰지 않는다 — 캐시 재사용의 핵심.
 */
export function upsertFinding(input: FindingInput): number {
  const db = getDb();
  db.prepare(
    `INSERT INTO finding
       (fingerprint, run_id, runner, node_id, kind, verdict_by, error_type, message_norm,
        contract_key, detail, first_seen, last_seen, occurrences)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
     ON CONFLICT(fingerprint) DO UPDATE SET
       run_id      = excluded.run_id,
       last_seen   = excluded.last_seen,
       occurrences = finding.occurrences + 1,
       detail      = excluded.detail,
       -- 판정은 보존한다. 아직 판정 전(NULL)일 때만 새 값을 받는다.
       kind        = COALESCE(finding.kind, excluded.kind),
       verdict_by  = COALESCE(finding.verdict_by, excluded.verdict_by),
       resolved_at = NULL`,
  ).run(
    input.fingerprint,
    input.runId ?? null,
    input.runner,
    input.nodeId,
    input.kind ?? null,
    input.verdictBy ?? null,
    input.errorType ?? null,
    input.messageNorm ?? null,
    input.contractKey ?? null,
    input.detail ?? null,
    input.observedAt,
    input.observedAt,
  );

  const row = db
    .prepare('SELECT id FROM finding WHERE fingerprint = ?')
    .get(input.fingerprint) as { id: number };
  return row.id;
}

/** 미해결 실패 (최근 관측 순) */
export function openFindings(limit = 50): FindingRow[] {
  return getDb()
    .prepare(
      `SELECT * FROM finding WHERE resolved_at IS NULL ORDER BY last_seen DESC LIMIT ?`,
    )
    .all(limit) as unknown as FindingRow[];
}

/** id로 단건 조회 (조치 모달·버그 초안 생성용) */
export function findingById(id: number): FindingRow | null {
  return (getDb().prepare(`SELECT * FROM finding WHERE id = ?`).get(id) as FindingRow | undefined) ?? null;
}

/**
 * 단건 해소 처리 (2026-08-20) — 조치 완료(버그 등록·수동 처리)로 큐에서 내린다.
 * 매일 도는 markResolvedExcept(러너 단위)와 별개로, 사람이 명시적으로 처리한 것.
 */
export function resolveFinding(id: number): void {
  getDb().prepare(`UPDATE finding SET resolved_at = ? WHERE id = ?`).run(nowIso(), id);
}

/**
 * LLM 배치 분석 결과 기입 (2026-08-20).
 * analyzed_at을 갱신해 fingerprint 캐시(TTL 7일) 기준으로 재분석을 건너뛰게 한다.
 * kind는 LLM이 새로 제시한 경우에만 덮고(없으면 규칙 분류 유지), verdict_by='llm'로 표시.
 */
export function setFindingAnalysis(
  id: number,
  input: { analysis: string; kind?: string | null; verdictBy?: string },
): void {
  getDb()
    .prepare(
      `UPDATE finding
         SET analysis = ?, analyzed_at = ?, kind = COALESCE(?, kind), verdict_by = ?
       WHERE id = ?`,
    )
    .run(input.analysis, nowIso(), input.kind ?? null, input.verdictBy ?? 'llm', id);
}

/**
 * 이번 실행에서 안 나온 실패는 해결된 것으로 표시한다.
 * (매일 도는 스위트에서 사라진 실패 = 고쳐졌거나 flaky가 지나간 것)
 */
export function markResolvedExcept(runner: Runner, seen: string[]): number {
  const db = getDb();
  if (seen.length === 0) {
    const r = db
      .prepare(
        `UPDATE finding SET resolved_at = ? WHERE runner = ? AND resolved_at IS NULL`,
      )
      .run(nowIso(), runner);
    return Number(r.changes);
  }
  const placeholders = seen.map(() => '?').join(',');
  const r = db
    .prepare(
      `UPDATE finding SET resolved_at = ?
       WHERE runner = ? AND resolved_at IS NULL AND fingerprint NOT IN (${placeholders})`,
    )
    .run(nowIso(), runner, ...seen);
  return Number(r.changes);
}

// ─── ticket_link ──────────────────────────────────────────────────────

export interface TicketInput {
  jiraKey: string;
  summary?: string | null;
  status?: string | null;
  isMine?: boolean;
  labels?: string[] | null;
  updatedAt?: string | null;
  /**
   * 이 상태가 된 시각 (Jira changelog에서 추출).
   * 없으면 이전 값을 유지하고, 그것도 없으면 updatedAt으로 폴백한다.
   */
  statusSince?: string | null;
  url?: string | null;
}

/**
 * 티켓 저장.
 *
 * `status_since`는 "며칠째 이 상태인가"(정체 감지)의 근거값이다.
 * ⚠️ `updated`(최종 수정)로 대신하면 안 된다 — 상태와 무관한 편집에도 갱신되어
 * 일괄 편집이 있었던 날짜로 전부 몰린다 (2026-08-08 실측: 12건이 같은 날로 보였고
 * 실제 전이는 최대 D+17까지 벌어져 있었다). 수집기가 changelog에서 뽑아 넘긴다.
 */
export function upsertTicket(input: TicketInput): void {
  const db = getDb();
  const prev = db
    .prepare('SELECT status, status_since FROM ticket_link WHERE jira_key = ?')
    .get(input.jiraKey) as { status?: string; status_since?: string } | undefined;

  const statusChanged = !prev || prev.status !== input.status;
  const statusSince =
    input.statusSince ??
    (statusChanged ? (input.updatedAt ?? nowIso()) : (prev?.status_since ?? input.updatedAt ?? nowIso()));

  db.prepare(
    `INSERT INTO ticket_link
       (jira_key, summary, status, is_mine, labels, updated_at, status_since, url, collected_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(jira_key) DO UPDATE SET
       summary      = excluded.summary,
       status       = excluded.status,
       is_mine      = excluded.is_mine,
       labels       = excluded.labels,
       updated_at   = excluded.updated_at,
       status_since = excluded.status_since,
       url          = excluded.url,
       collected_at = excluded.collected_at`,
  ).run(
    input.jiraKey,
    input.summary ?? null,
    input.status ?? null,
    input.isMine ? 1 : 0,
    input.labels ? input.labels.join(',') : null,
    input.updatedAt ?? null,
    statusSince,
    input.url ?? null,
    nowIso(),
  );
}

/** 특정 상태의 티켓 (기본: 내가 리포터인 것만) */
export function ticketsByStatus(status: string, onlyMine = true): TicketRow[] {
  const sql = onlyMine
    ? `SELECT * FROM ticket_link WHERE status = ? AND is_mine = 1 ORDER BY updated_at DESC`
    : `SELECT * FROM ticket_link WHERE status = ? ORDER BY updated_at DESC`;
  return getDb().prepare(sql).all(status) as unknown as TicketRow[];
}

/** 수집에서 사라진 티켓은 해당 상태를 벗어난 것 → 상태를 비운다 */
export function clearMissingTickets(status: string, seenKeys: string[]): void {
  const db = getDb();
  if (seenKeys.length === 0) {
    db.prepare(`UPDATE ticket_link SET status = NULL WHERE status = ?`).run(status);
    return;
  }
  const ph = seenKeys.map(() => '?').join(',');
  db.prepare(
    `UPDATE ticket_link SET status = NULL WHERE status = ? AND jira_key NOT IN (${ph})`,
  ).run(status, ...seenKeys);
}

// ─── todo ─────────────────────────────────────────────────────────────

export interface TodoInput {
  day: string;
  key: string;
  priority: Priority;
  title: string;
  detail?: string | null;
  source?: string | null;
  mode?: 'semi' | 'manual';
  actionLabel?: string | null;
  actionUrl?: string | null;
  signalId?: number | null;
  /** 이월이면 최초 등장일, 신규면 day와 같음 */
  firstDay: string;
  pinned?: boolean;
  promoted?: boolean;
}

/**
 * todo 저장.
 * 같은 (day, key)면 내용만 갱신하고 **done_at은 건드리지 않는다**
 * — 사용자가 체크한 것이 재산출로 풀리면 안 되기 때문.
 */
export function upsertTodo(input: TodoInput): void {
  getDb()
    .prepare(
      `INSERT INTO todo
         (day, key, priority, title, detail, source, mode, action_label, action_url,
          signal_id, first_day, pinned, promoted, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(day, key) DO UPDATE SET
         priority     = excluded.priority,
         title        = excluded.title,
         detail       = excluded.detail,
         source       = excluded.source,
         mode         = excluded.mode,
         action_label = excluded.action_label,
         action_url   = excluded.action_url,
         signal_id    = excluded.signal_id,
         first_day    = excluded.first_day,
         pinned       = excluded.pinned,
         promoted     = excluded.promoted`,
    )
    .run(
      input.day,
      input.key,
      input.priority,
      input.title,
      input.detail ?? null,
      input.source ?? null,
      input.mode ?? 'manual',
      input.actionLabel ?? null,
      input.actionUrl ?? null,
      input.signalId ?? null,
      input.firstDay,
      input.pinned ? 1 : 0,
      input.promoted ? 1 : 0,
      nowIso(),
    );
}

export function todosForDay(day: string): TodoRow[] {
  return getDb()
    .prepare(`SELECT * FROM todo WHERE day = ? ORDER BY id`)
    .all(day) as unknown as TodoRow[];
}

/** 직전 산출일의 미완료 todo — 이월 판정에 쓴다 */
export function unfinishedBefore(day: string): TodoRow[] {
  return getDb()
    .prepare(
      `SELECT t.* FROM todo t
       JOIN (SELECT key, MAX(day) AS d FROM todo WHERE day < ? GROUP BY key) x
         ON x.key = t.key AND x.d = t.day
       WHERE t.done_at IS NULL`,
    )
    .all(day) as unknown as TodoRow[];
}

/** 체크박스 토글 — 완료는 전부 사람이 누른다 (자동 완료 미도입) */
export function setTodoDone(id: number, done: boolean): void {
  getDb()
    .prepare(`UPDATE todo SET done_at = ? WHERE id = ?`)
    .run(done ? nowIso() : null, id);
}

/** 해당 일자에서 특정 key 제거 (D+7 초과로 알림 이동 시) */
export function removeTodo(day: string, key: string): void {
  getDb().prepare(`DELETE FROM todo WHERE day = ? AND key = ?`).run(day, key);
}

// ─── tc_work / tc ─────────────────────────────────────────────────────

export interface TcWorkInput {
  sessionId: string;
  title: string;
  sources?: unknown;
}

/** 작업 upsert → 내부 id 반환. 같은 세션이면 같은 작업이다 */
export function upsertTcWork(input: TcWorkInput): number {
  const db = getDb();
  db.prepare(
    `INSERT INTO tc_work (session_id, title, sources, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(session_id) DO UPDATE SET
       title = excluded.title,
       sources = COALESCE(excluded.sources, tc_work.sources),
       updated_at = excluded.updated_at`,
  ).run(
    input.sessionId,
    input.title,
    input.sources === undefined ? null : JSON.stringify(input.sources),
    nowIso(),
    nowIso(),
  );
  const row = db
    .prepare('SELECT id FROM tc_work WHERE session_id = ?')
    .get(input.sessionId) as { id: number };
  return row.id;
}

export interface TcInput {
  workId: number;
  localId: string;
  category?: string | null;
  subCategory?: string | null;
  detailCategory?: string | null;
  phase?: string | null;
  precondition?: string | null;
  steps?: string | null;
  expected?: string | null;
  platform?: string | null;
  note?: string | null;
  /** 11컬럼 밖의 값 — 컬럼 고정 해제 대비 */
  extra?: Record<string, string> | null;
}

/**
 * TC 저장.
 *
 * ⚠️ **사람이 만든 값은 덮어쓰지 않는다.**
 * TC 본문은 파이프라인을 다시 돌리면 갱신되지만,
 * `result`(수행 결과) · `verdict`(판정) · `test_ref` · `catalog_id` · `handed_off_at`은
 * 사람의 판단이나 별도 절차로 채워지므로 재파싱이 지워서는 안 된다.
 */
export function upsertTc(input: TcInput): void {
  getDb()
    .prepare(
      `INSERT INTO tc
         (work_id, local_id, category, sub_category, detail_category, phase,
          precondition, steps, expected, platform, note, extra, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       -- COALESCE로 새 값이 null이면 기존 값을 유지한다. 희소한 표(예: 수행 결과 표가
       -- 잘못 섞이거나 설계 재저장 시 일부 컬럼만 있을 때) null이 설계·수행 값을 지우던
       -- 회귀를 막는다 (2026-08-18). 실제 편집은 non-null이라 정상 반영된다.
       ON CONFLICT(work_id, local_id) DO UPDATE SET
         category        = COALESCE(excluded.category, category),
         sub_category    = COALESCE(excluded.sub_category, sub_category),
         detail_category = COALESCE(excluded.detail_category, detail_category),
         phase           = COALESCE(excluded.phase, phase),
         precondition    = COALESCE(excluded.precondition, precondition),
         steps           = COALESCE(excluded.steps, steps),
         expected        = COALESCE(excluded.expected, expected),
         platform        = COALESCE(excluded.platform, platform),
         note            = COALESCE(excluded.note, note),
         extra           = COALESCE(excluded.extra, extra),
         updated_at      = excluded.updated_at`,
    )
    .run(
      input.workId,
      input.localId,
      input.category ?? null,
      input.subCategory ?? null,
      input.detailCategory ?? null,
      input.phase ?? null,
      input.precondition ?? null,
      input.steps ?? null,
      input.expected ?? null,
      input.platform ?? null,
      input.note ?? null,
      input.extra ? JSON.stringify(input.extra) : null,
      nowIso(),
      nowIso(),
    );
}

export interface TcRowDb {
  id: number;
  work_id: number;
  local_id: string;
  catalog_id: string | null;
  verdict: 'new' | 'covered' | 'stale' | null;
  matched_catalog_id: string | null;
  match_reason: string | null;
  category: string | null;
  sub_category: string | null;
  detail_category: string | null;
  phase: string | null;
  precondition: string | null;
  steps: string | null;
  expected: string | null;
  platform: string | null;
  result: string;
  note: string | null;
  extra: string | null;
  test_ref: string | null;
  handed_off_at: string | null;
  bug_ticket: string | null;
  bug_evidence: string | null;
  created_at: string;
  updated_at: string;
}

/** Fail TC에 등록한 Jira 버그 키를 기록한다 (중복 등록 방지·행 배지 표시용) */
export function setTcBugTicket(id: number, bugTicket: string): void {
  getDb()
    .prepare(`UPDATE tc SET bug_ticket = ?, updated_at = ? WHERE id = ?`)
    .run(bugTicket, nowIso(), id);
}

/**
 * Fail 시 수행이 남긴 구조화 버그 근거(JSON)를 기록한다. 화면엔 안 뜨고,
 * 버그 티켓 생성 때 DV-647 섹션의 재료로 쓴다(재분석 없이 고품질). local_id로 매칭.
 */
export function setTcBugEvidence(workId: number, localId: string, evidenceJson: string): void {
  getDb()
    .prepare(`UPDATE tc SET bug_evidence = ?, updated_at = ? WHERE work_id = ? AND local_id = ?`)
    .run(evidenceJson, nowIso(), workId, localId);
}

export function tcsOfWork(workId: number): TcRowDb[] {
  return getDb()
    .prepare(`SELECT * FROM tc WHERE work_id = ? ORDER BY id`)
    .all(workId) as unknown as TcRowDb[];
}

export interface TcWorkRow {
  id: number;
  title: string;
  /** draft | done — done이면 티켓 코멘트까지 끝난 작업이다 */
  status: string;
  sources: string | null;
  /** ⓪① 인계 계약 JSON (v3) — 확인 게이트의 원천 */
  contract: string | null;
  updated_at: string;
}

export function tcWorkBySession(sessionId: string): TcWorkRow | null {
  return (getDb()
    .prepare('SELECT id, title, status, sources, contract, updated_at FROM tc_work WHERE session_id = ?')
    .get(sessionId) as TcWorkRow) ?? null;
}

/** 인계 계약 저장 — ⓪① 완료 시, 그리고 ②에서 decisions가 채워질 때 갱신 */
export function setTcWorkContract(id: number, contract: unknown): void {
  getDb()
    .prepare(`UPDATE tc_work SET contract = ?, updated_at = ? WHERE id = ?`)
    .run(JSON.stringify(contract), nowIso(), id);
}

/**
 * 작업 종료 — 티켓 코멘트를 등록한 뒤 호출한다.
 *
 * 상태 전이(Jira의 "완료")는 **여기서 하지 않는다.** 오늘 탭의
 * "완료 전이는 사람 승인" 원칙과 같다 — 대시보드는 코멘트까지만 쓰고,
 * 티켓을 닫는 것은 Jira에서 사람이 직접 한다.
 */
export function closeTcWork(id: number, sources: unknown): void {
  getDb()
    .prepare(`UPDATE tc_work SET status = 'done', sources = ?, updated_at = ? WHERE id = ?`)
    .run(sources === undefined ? null : JSON.stringify(sources), nowIso(), id);
}

/** 판정 기록 — 카탈로그 대조 결과 */
export function setTcVerdict(
  id: number,
  verdict: 'new' | 'covered' | 'stale',
  matchedCatalogId: string | null,
  reason: string | null,
): void {
  getDb()
    .prepare(
      `UPDATE tc SET verdict = ?, matched_catalog_id = ?, match_reason = ?, updated_at = ? WHERE id = ?`,
    )
    .run(verdict, matchedCatalogId, reason, nowIso(), id);
}

/** 수행 결과 기입 — 사람이 넣는다 */
export function setTcResult(id: number, result: string, note?: string | null): void {
  // 자동 수행은 result와 함께 사유(note)를 남긴다 (BLOCK 사유·실패 원인 등).
  // 수동 기입(드롭다운)은 note를 안 넘기므로 기존 note를 건드리지 않는다.
  if (note !== undefined) {
    getDb()
      .prepare(`UPDATE tc SET result = ?, note = ?, updated_at = ? WHERE id = ?`)
      .run(result, note, nowIso(), id);
  } else {
    getDb()
      .prepare(`UPDATE tc SET result = ?, updated_at = ? WHERE id = ?`)
      .run(result, nowIso(), id);
  }
}

/** 자동화 후보로 넘기기 — 카탈로그 번호 부여 */
export function handOffTc(id: number, catalogId: string): void {
  getDb()
    .prepare(
      `UPDATE tc SET catalog_id = ?, handed_off_at = ?, updated_at = ? WHERE id = ?`,
    )
    .run(catalogId, nowIso(), nowIso(), id);
}

// ─── notice ───────────────────────────────────────────────────────────

export interface NoticeInput {
  kind: NoticeKind;
  key: string;
  title: string;
  detail?: string | null;
  source?: string | null;
  since?: string | null;
  days?: number | null;
  originTodoKey?: string | null;
  originalPriority?: Priority | null;
}

export function upsertNotice(input: NoticeInput): void {
  getDb()
    .prepare(
      `INSERT INTO notice
         (kind, key, title, detail, source, since, days, origin_todo_key, original_priority, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(kind, key) DO UPDATE SET
         title             = excluded.title,
         detail            = excluded.detail,
         source            = excluded.source,
         since             = excluded.since,
         days              = excluded.days,
         origin_todo_key   = excluded.origin_todo_key,
         original_priority = excluded.original_priority,
         updated_at        = excluded.updated_at`,
    )
    .run(
      input.kind,
      input.key,
      input.title,
      input.detail ?? null,
      input.source ?? null,
      input.since ?? null,
      input.days ?? null,
      input.originTodoKey ?? null,
      input.originalPriority ?? null,
      nowIso(),
      nowIso(),
    );
}

/** 표시 대상 알림 — 끈 것·미룬 것 제외 */
export function activeNotices(): NoticeRow[] {
  return getDb()
    .prepare(
      `SELECT * FROM notice
       WHERE dismissed = 0 AND (snoozed_until IS NULL OR snoozed_until < ?)
       ORDER BY days DESC NULLS LAST, id`,
    )
    .all(nowIso()) as unknown as NoticeRow[];
}

export function countActiveNotices(): number {
  const r = getDb()
    .prepare(
      `SELECT COUNT(*) AS c FROM notice
       WHERE dismissed = 0 AND (snoozed_until IS NULL OR snoozed_until < ?)`,
    )
    .get(nowIso()) as { c: number };
  return r.c;
}

export function removeNotice(kind: NoticeKind, key: string): void {
  getDb().prepare(`DELETE FROM notice WHERE kind = ? AND key = ?`).run(kind, key);
}

export function getNotice(kind: NoticeKind, key: string): NoticeRow | null {
  return (getDb()
    .prepare(`SELECT * FROM notice WHERE kind = ? AND key = ?`)
    .get(kind, key) as unknown as NoticeRow) ?? null;
}

/**
 * 미룸 — 지정 일수 뒤에 다시 뜬다.
 * "끄기"와 달리 되돌아오므로, 지금 처리 못 하는 것을 잊지 않고 넘길 때 쓴다.
 */
export function snoozeNotice(kind: NoticeKind, key: string, days: number): void {
  const until = new Date(Date.now() + days * 86_400_000).toISOString();
  getDb()
    .prepare(`UPDATE notice SET snoozed_until = ?, updated_at = ? WHERE kind = ? AND key = ?`)
    .run(until, nowIso(), kind, key);
}

/**
 * 끄기 — 영구히 숨긴다.
 * 조건이 해소되면 prune으로 행 자체가 지워지고, 다시 발생하면 새로 뜬다.
 */
export function dismissNotice(kind: NoticeKind, key: string): void {
  getDb()
    .prepare(`UPDATE notice SET dismissed = 1, updated_at = ? WHERE kind = ? AND key = ?`)
    .run(nowIso(), kind, key);
}

/** 알림에서 사라진 항목 정리 (해소된 것) */
export function pruneNotices(kind: NoticeKind, seenKeys: string[]): void {
  const db = getDb();
  if (seenKeys.length === 0) {
    db.prepare(`DELETE FROM notice WHERE kind = ?`).run(kind);
    return;
  }
  const ph = seenKeys.map(() => '?').join(',');
  db.prepare(`DELETE FROM notice WHERE kind = ? AND key NOT IN (${ph})`).run(kind, ...seenKeys);
}

// ─── risk_pattern ──────────────────────────────────────────────────────
// 이 제품이 반복적으로 틀리는 가정/방식을 증거와 함께 축적 (qa-oracle DESIGN).

export interface RiskPatternRow {
  id: number;
  ref: string | null;
  title: string;
  category: string | null;
  status: string; // candidate | confirmed | retired
  severity: string | null;
  symptom: string | null;
  root_assumption: string | null;
  evidence: string | null; // JSON
  detector: string | null; // JSON
  check_questions: string | null; // JSON
  created_at: string;
  updated_at: string;
}

/** 상태 우선순위(confirmed→candidate→retired) 후 최신순 */
export function listRiskPatterns(): RiskPatternRow[] {
  return getDb()
    .prepare(
      `SELECT * FROM risk_pattern
       ORDER BY CASE status WHEN 'confirmed' THEN 0 WHEN 'candidate' THEN 1 ELSE 2 END, id DESC`,
    )
    .all() as unknown as RiskPatternRow[];
}

/** 다음 RP-NNN 번호 */
export function nextRiskRef(): string {
  const rows = getDb().prepare(`SELECT ref FROM risk_pattern WHERE ref LIKE 'RP-%'`).all() as Array<{ ref: string }>;
  let max = 0;
  for (const r of rows) {
    const n = parseInt((r.ref ?? '').replace(/^RP-/, ''), 10);
    if (Number.isFinite(n) && n > max) max = n;
  }
  return `RP-${String(max + 1).padStart(3, '0')}`;
}

export interface RiskPatternInput {
  ref?: string | null;
  title: string;
  category?: string | null;
  status?: string;
  severity?: string | null;
  symptom?: string | null;
  rootAssumption?: string | null;
  evidence?: unknown;
  detector?: unknown;
  checkQuestions?: unknown;
}

/** 리스크 패턴 저장(신규). ref 없으면 자동 채번. */
export function insertRiskPattern(input: RiskPatternInput): number {
  const now = nowIso();
  const r = getDb()
    .prepare(
      `INSERT INTO risk_pattern
         (ref, title, category, status, severity, symptom, root_assumption, evidence, detector, check_questions, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.ref ?? nextRiskRef(),
      input.title,
      input.category ?? null,
      input.status ?? 'candidate',
      input.severity ?? null,
      input.symptom ?? null,
      input.rootAssumption ?? null,
      input.evidence ? JSON.stringify(input.evidence) : null,
      input.detector ? JSON.stringify(input.detector) : null,
      input.checkQuestions ? JSON.stringify(input.checkQuestions) : null,
      now,
      now,
    );
  return Number(r.lastInsertRowid);
}

/** candidate → confirmed / retired (사람이 확정) */
export function setRiskPatternStatus(id: number, status: 'candidate' | 'confirmed' | 'retired'): void {
  getDb().prepare(`UPDATE risk_pattern SET status = ?, updated_at = ? WHERE id = ?`).run(status, nowIso(), id);
}

/** 리스크 패턴 추출용 — DV 버그 티켓 요약 목록 (최신순) */
export function bugTicketsForExtract(limit = 60): Array<{ key: string; summary: string | null; labels: string | null }> {
  return getDb()
    .prepare(`SELECT jira_key AS key, summary, labels FROM ticket_link WHERE jira_key LIKE 'DV-%' ORDER BY updated_at DESC LIMIT ?`)
    .all(limit) as Array<{ key: string; summary: string | null; labels: string | null }>;
}
