import { daysBetween, getDb, todayKst } from './db';
import {
  removeTodo,
  todosForDay,
  unfinishedBefore,
  upsertNotice,
  upsertTodo,
  type TodoInput,
} from './repo';
import type { Priority, TodoItem, TodoRow } from './types';

/**
 * 오늘 할 일 산출 규칙 엔진.
 *
 * ── 확정 규칙 (2026-08-04 ~ 08-07 리뷰에서 결정) ──────────────────────
 *  ① 우선순위 = **실무 > 자동화**
 *       P0 티켓 · 신규 프로덕션 에러 · 환경 고장
 *       P1 계약 드리프트 · PR 회귀
 *       P2 리스크 패턴
 *       P3 야간 실패 분류        ← 이미 분류가 끝나 있어 급하지 않다
 *  ② 정렬 = 우선순위 → **경과일 내림차순** (오래 밀린 것이 등급 내 최상단)
 *  ③ 이월 = D+N. **D+3 초과 시 위험색**
 *  ④ **D+7 초과 → 🔔 알림으로 이동** (방치 감지 기준과 동일한 7일)
 *  ⑤ 복귀 = **경과일 유지 + 우선순위 1단계 승격 + 📌 고정**
 *       고정이 없으면 복귀 즉시 D+7에 다시 걸려 무한 루프가 된다
 *  ⑥ 완료 = **전부 사람이 체크** (자동 완료 미도입 — 운영 후 재결정)
 *
 * ── 토큰 ──────────────────────────────────────────────────────────────
 * **LLM을 쓰지 않는다.** 전부 SQL 조회 + 규칙 분기다.
 * 매일 아침 자동으로 도는 층이라 LLM을 넣으면 매일 비용이 나간다.
 */

/** 이월 상한 — 넘으면 알림으로 이동. 방치 감지(7일)와 같은 값으로 통일 */
export const CARRY_LIMIT_DAYS = 7;
/** 경과일이 이 값을 넘으면 위험색으로 승격 */
export const HOT_AFTER_DAYS = 3;

const ORDER: Priority[] = ['P0', 'P1', 'P2', 'P3'];

/** 우선순위 한 단계 승격 (P2 → P1). P0는 더 못 올라간다 */
export function promote(p: Priority): Priority {
  const i = ORDER.indexOf(p);
  return i <= 0 ? 'P0' : ORDER[i - 1];
}

// ─── 후보 수집 ────────────────────────────────────────────────────────

type Candidate = Omit<TodoInput, 'day' | 'firstDay'>;

/**
 * 신호 → 할 일 후보.
 *
 * 각 규칙은 "무엇을 보고" "무슨 행동을 요구하는지"가 분명해야 한다.
 * 행동이 없는 정보는 todo가 아니라 신호 블록에만 남는다.
 */
function collectCandidates(): Candidate[] {
  const db = getDb();
  const out: Candidate[] = [];

  // ── P0 · 환경 고장 ──────────────────────────────────────────────────
  // 차량 풀이 고갈되면 그날 테스트가 통째로 무의미해진다. 제품 버그보다 급하다.
  const envRows = db
    .prepare(
      `SELECT ref, title, detail, url FROM signal
       WHERE source = 'api-test' AND kind = 'env-health'
         AND observed_at >= datetime('now', '-2 days')
       ORDER BY observed_at DESC`,
    )
    .all() as Array<{ ref: string; title: string; detail: string | null; url: string | null }>;

  for (const r of envRows) {
    out.push({
      key: `env:${r.ref}`,
      priority: 'P0',
      title: r.title,
      detail: r.detail,
      source: 'api-test',
      mode: 'semi',
      actionLabel: 'env_health --fix',
      actionUrl: r.url,
    });
  }

  // ── P0 · QA 중 티켓 (내가 리포터인 것만) ────────────────────────────
  // 남이 등록한 티켓까지 올리면 오늘 할 일이 남의 일로 오염된다.
  const mine = db
    .prepare(
      `SELECT jira_key, summary, status_since, url FROM ticket_link
       WHERE is_mine = 1 AND status = 'QA 중'
       ORDER BY status_since ASC`,
    )
    .all() as Array<{
    jira_key: string;
    summary: string | null;
    status_since: string | null;
    url: string | null;
  }>;

  if (mine.length > 0) {
    out.push({
      key: 'jira:qa-recheck',
      priority: 'P0',
      title: `QA 중 티켓 ${mine.length}건 재검토`,
      detail:
        `test.fail semantics로 수정 판정 → 정상 전환·부작용 점검 · ` +
        `완료 전이는 사람 승인 (${mine.slice(0, 3).map((t) => t.jira_key).join(' · ')}${
          mine.length > 3 ? ` 외 ${mine.length - 3}` : ''
        })`,
      source: 'jira',
      mode: 'semi',
      actionLabel: '건별 확인',
      actionUrl: mine[0]?.url ?? null,
    });
  }

  // ── P0 · 신규 프로덕션 에러 ─────────────────────────────────────────
  // 티켓은 자동 생성하지 않는다(dd-triage 원칙). 후보만 올리고 사람이 판단.
  const novel = db
    .prepare(
      `SELECT ref, title FROM signal
       WHERE source = 'datadog' AND kind = 'error-cluster'
         AND observed_at >= datetime('now', '-2 days')
       ORDER BY observed_at DESC`,
    )
    .all() as Array<{ ref: string; title: string }>;

  if (novel.length > 0) {
    out.push({
      key: 'datadog:novel',
      priority: 'P0',
      title: `신규 RUM 클러스터 ${novel.length}건 — 티켓 여부 판단`,
      detail: novel
        .slice(0, 2)
        .map((n) => n.title.replace(/^신규 에러 클러스터 — /, ''))
        .join(' / '),
      source: 'datadog',
      mode: 'manual',
      actionLabel: '티켓화 / 노이즈',
      actionUrl: null,
    });
  }

  // ── P1 · 계약 드리프트 ──────────────────────────────────────────────
  const drift = db
    .prepare(
      `SELECT COUNT(*) AS c FROM finding
       WHERE kind = 'contract-drift' AND resolved_at IS NULL`,
    )
    .get() as { c: number };

  if (drift.c > 0) {
    out.push({
      key: 'api:contract-drift',
      priority: 'P1',
      title: `계약 드리프트 ${drift.c}건 — matrix 갱신`,
      detail: '의도 확인 후 param-matrix.json 스키마 승격 · 자동 갱신하지 않는다',
      source: 'api-test',
      mode: 'semi',
      actionLabel: '확인',
      actionUrl: null,
    });
  }

  // ── P1 · stage PR 회귀 범위 ─────────────────────────────────────────
  // 배포된 변경이 어느 영역을 건드렸는지 확인하는 일. 오늘 안 하면 다음 배포와 섞인다.
  const pr = db
    .prepare(
      `SELECT title, detail, payload FROM signal
       WHERE source = 'stage-pr' AND kind = 'summary'
         AND observed_at >= datetime('now', '-2 days')
       ORDER BY observed_at DESC LIMIT 1`,
    )
    .get() as { title: string; detail: string | null; payload: string | null } | undefined;

  if (pr) {
    out.push({
      key: 'stage-pr:regression',
      priority: 'P1',
      title: pr.title,
      detail: pr.detail,
      source: 'stage-pr',
      mode: 'manual',
      actionLabel: 'PR 목록',
      actionUrl: null,
    });
  }

  // ── P2 · 버그 후보 ──────────────────────────────────────────────────
  const bugs = db
    .prepare(
      `SELECT COUNT(*) AS c FROM finding
       WHERE kind = 'bug-candidate' AND resolved_at IS NULL`,
    )
    .get() as { c: number };

  if (bugs.c > 0) {
    out.push({
      key: 'api:bug-candidate',
      priority: 'P2',
      title: `버그 후보 ${bugs.c}건 — 5축 게이트 통과 여부 확인`,
      detail: '최소 재현 · 원인 규명 · 실사용 경로 · 기대 근거 · 회귀 테스트 동시 작성',
      source: 'api-test',
      mode: 'semi',
      actionLabel: '/create-bug',
      actionUrl: null,
    });
  }

  // ── P3 · 야간 실패 분류 확인 ────────────────────────────────────────
  // summarize.mjs가 이미 분류했으므로 사람은 확인만 한다 → 모니터링 레벨.
  /**
   * ⚠️ 스위트별 **최신 1건**만 본다.
   * 그냥 최근 2일을 다 더하면 이미 고친 옛 실행의 실패까지 오늘 할 일에 올라온다.
   * (2026-08-07 실측: 환경 복구 후 실패 17→4인데 "17건 분류 확인"이 그대로 떠 있었다)
   */
  const runs = db
    .prepare(
      `SELECT r.suite, r.failed, r.url FROM test_run r
       JOIN (
         SELECT suite, MAX(COALESCE(started_at, collected_at)) AS m
         FROM test_run WHERE runner = 'api' GROUP BY suite
       ) x ON x.suite = r.suite AND COALESCE(r.started_at, r.collected_at) = x.m
       WHERE r.runner = 'api' AND r.failed > 0
         AND COALESCE(r.started_at, r.collected_at) >= datetime('now', '-2 days')`,
    )
    .all() as Array<{ suite: string; failed: number; url: string | null }>;

  for (const r of runs) {
    out.push({
      key: `api:run-fail:${r.suite}`,
      priority: 'P3',
      title: `${r.suite} 실패 ${r.failed}건 분류 확인`,
      detail: '분류는 summarize.mjs가 이미 수행 · 사람은 결과 확인만',
      source: 'api-test',
      mode: 'manual',
      actionLabel: '런 보기',
      actionUrl: r.url,
    });
  }

  return out;
}

// ─── 알림(방치·정체) 산출 ─────────────────────────────────────────────

/**
 * 오늘 할 일과 **분리된** 느린 신호.
 * 섞으면 오늘 할 일이 잔소리로 오염된다 — 그래서 별도 화면이다.
 */
function buildNotices(day: string): void {
  const db = getDb();
  const seenStale: string[] = [];

  // 자산 방치 — 7일 이상 신호 없음
  const assets = db
    .prepare(
      `SELECT runner, MAX(COALESCE(started_at, collected_at)) AS last_at
       FROM test_run GROUP BY runner`,
    )
    .all() as Array<{ runner: string; last_at: string }>;

  const labels: Record<string, string> = {
    api: 'API 자동화',
    web: '웹 E2E',
    app: '앱 E2E',
  };

  for (const a of assets) {
    const days = Math.floor((Date.now() - Date.parse(a.last_at)) / 86_400_000);
    if (days < CARRY_LIMIT_DAYS) continue;
    seenStale.push(a.runner);
    upsertNotice({
      kind: 'stale-asset',
      key: a.runner,
      title: `${labels[a.runner] ?? a.runner} — ${days}일째 실행 신호 없음`,
      detail: '마지막 결과가 오래됐습니다. 스케줄이 멈췄거나 실행 환경이 막혀 있을 수 있습니다',
      source: a.runner,
      since: a.last_at,
      days,
    });
  }

  // 정체 티켓 — 같은 상태로 오래 머문 것 (내 리포트 한정)
  const stalled = db
    .prepare(
      `SELECT jira_key, summary, status, status_since, url FROM ticket_link
       WHERE is_mine = 1 AND status IS NOT NULL AND status_since IS NOT NULL`,
    )
    .all() as Array<{
    jira_key: string;
    summary: string | null;
    status: string;
    status_since: string;
    url: string | null;
  }>;

  const seenStalled: string[] = [];
  for (const t of stalled) {
    const days = Math.floor((Date.now() - Date.parse(t.status_since)) / 86_400_000);
    if (days < CARRY_LIMIT_DAYS) continue;
    seenStalled.push(t.jira_key);
    upsertNotice({
      kind: 'stalled-ticket',
      key: t.jira_key,
      title: `${t.jira_key} — '${t.status}' 상태로 ${days}일`,
      detail: t.summary?.slice(0, 120) ?? null,
      source: 'jira',
      since: t.status_since,
      days,
    });
  }

  // 해소된 것은 정리
  pruneKind('stale-asset', seenStale);
  pruneKind('stalled-ticket', seenStalled);
}

function pruneKind(kind: 'stale-asset' | 'stalled-ticket', seen: string[]): void {
  const db = getDb();
  if (seen.length === 0) {
    db.prepare(`DELETE FROM notice WHERE kind = ?`).run(kind);
    return;
  }
  const ph = seen.map(() => '?').join(',');
  db.prepare(`DELETE FROM notice WHERE kind = ? AND key NOT IN (${ph})`).run(kind, ...seen);
}

// ─── 산출 본체 ────────────────────────────────────────────────────────

export interface BuildResult {
  day: string;
  created: number;
  carried: number;
  movedToNotice: number;
  returned: number;
}

/**
 * 오늘 할 일을 산출한다. 하루에 여러 번 불러도 안전(멱등)하다.
 *
 * 순서가 중요하다:
 *   1) 알림에서 복귀시킨 항목을 먼저 반영 (승격 + 고정)
 *   2) 어제까지 미완료 항목을 이월 (경과일 승계)
 *   3) D+7 초과분을 알림으로 이동
 *   4) 오늘의 새 후보를 병합
 */
export function buildToday(day: string = todayKst()): BuildResult {
  const candidates = collectCandidates();

  /**
   * (1) 이월 — 최초 등장일·고정 여부를 승계한다.
   *
   * `unfinishedBefore`(어제까지)에 더해 **오늘 행도 본다.**
   * 알림에서 "오늘로 복귀"를 누르면 오늘 날짜로 pinned 행이 먼저 생기는데,
   * 어제 것만 보면 그 고정이 다음 산출에서 날아가 즉시 다시 알림으로 튕겨나간다.
   */
  const prev = new Map<string, TodoRow>();
  for (const t of unfinishedBefore(day)) prev.set(t.key, t);
  for (const t of todosForDay(day)) {
    const before = prev.get(t.key);
    // 오늘 행이 고정(복귀)이거나, 더 이른 최초 등장일을 갖고 있으면 그것을 쓴다
    if (!before || t.pinned === 1 || t.first_day < before.first_day) prev.set(t.key, t);
  }

  let created = 0;
  let carried = 0;
  let movedToNotice = 0;
  const kept = new Set<string>();

  for (const c of candidates) {
    const before = prev.get(c.key);

    const firstDay = before?.first_day ?? day;
    const age = daysBetween(day, firstDay);
    const pinned = before?.pinned === 1;

    // (3) D+7 초과 → 알림으로 이동. 단 고정(pinned)된 것은 제외
    if (age > CARRY_LIMIT_DAYS && !pinned) {
      upsertNotice({
        kind: 'carry-over',
        key: c.key,
        title: c.title,
        detail: c.detail,
        source: c.source,
        since: firstDay,
        days: age,
        originTodoKey: c.key,
        originalPriority: c.priority,
      });
      removeTodo(day, c.key);
      movedToNotice++;
      continue;
    }

    // 복귀 항목은 승격된 우선순위를 유지한다 (규칙 ⑤ — 경과일 유지 + 1단계 승격)
    const priority = before?.promoted === 1 ? (before.priority as Priority) : c.priority;
    if (before) carried++;
    else created++;
    kept.add(c.key);

    upsertTodo({
      ...c,
      day,
      priority,
      firstDay,
      pinned,
      promoted: before?.promoted === 1,
    });
  }

  // 오늘 후보에 없는데 남아 있는 항목은 해소된 것 → 제거
  // (단, 사용자가 체크한 것은 기록으로 남긴다)
  const db = getDb();
  // 오늘 후보에 없는데 남아 있는 항목은 조건이 해소된 것 → 제거.
  // 단 ① 사용자가 체크한 것(기록) ② 📌 고정(알림에서 직접 복귀시킨 것)은 남긴다.
  //    고정을 지우면 "오늘 하겠다"고 가져온 항목이 조용히 사라진다.
  const existing = todosForDay(day);
  let returned = 0;
  for (const t of existing) {
    if (t.pinned === 1) returned++;
    if (kept.has(t.key) || t.done_at || t.pinned === 1) continue;
    db.prepare('DELETE FROM todo WHERE id = ?').run(t.id);
  }

  buildNotices(day);

  return { day, created, carried, movedToNotice, returned };
}

// ─── 조회 (화면용) ────────────────────────────────────────────────────

/**
 * 정렬된 오늘 할 일.
 * 규칙 ② — 우선순위 → 경과일 내림차순.
 *
 * ⚠️ 완료 여부는 정렬에 넣지 않는다.
 * 체크했다고 맨 아래로 내리면, 목록이 5건만 보이는 상황에서 체크한 항목이
 * 접힌 영역으로 밀려나 **사라진 것처럼 보인다**. 규칙 ⑦("체크해도 사라지지 않고
 * 취소선으로 남는다")과 정면으로 어긋나므로 자리를 그대로 유지한다.
 */
export function listToday(day: string = todayKst()): TodoItem[] {
  return todosForDay(day)
    .map((t) => {
      const carriedDays = daysBetween(day, t.first_day);
      return { ...t, carriedDays, hot: carriedDays > HOT_AFTER_DAYS };
    })
    .sort((a, b) => {
      const pDiff = ORDER.indexOf(a.priority) - ORDER.indexOf(b.priority);
      if (pDiff !== 0) return pDiff;
      return b.carriedDays - a.carriedDays;
    });
}
