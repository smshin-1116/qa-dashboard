import { NextResponse } from 'next/server';
import { getDb, getMeta, todayKst } from '@/lib/workspace/db';
import { countActiveNotices } from '@/lib/workspace/repo';
import { buildToday, listToday } from '@/lib/workspace/todo';
import type {
  BriefTile,
  Severity,
  SignalBlock,
  SourceName,
  TodayPayload,
} from '@/lib/workspace/types';

/**
 * GET /api/workspace/today — 아침 브리핑 데이터.
 *
 * ── 토큰 ──────────────────────────────────────────────────────────────
 * **LLM 호출 0.** 상태 저장소 조회 + 규칙 계산만 한다.
 * 화면을 열 때마다 도는 경로이므로 여기에 LLM이 들어가면 안 된다.
 *
 * ?rebuild=1 을 붙이면 todo를 다시 산출한다 (수집 직후 호출).
 */

// SQLite 파일을 읽으므로 정적 최적화 대상이 아니다
export const dynamic = 'force-dynamic';

const SOURCES: SourceName[] = ['api-test', 'jira', 'datadog', 'web-e2e', 'stage-pr'];

export async function GET(req: Request) {
  const url = new URL(req.url);
  const day = url.searchParams.get('day') ?? todayKst();

  if (url.searchParams.get('rebuild') === '1') buildToday(day);

  const db = getDb();
  const todos = listToday(day);

  // ── 브리핑 타일 6개 ─────────────────────────────────────────────────
  // 순서 = 결론(오늘 할 일) → 실무(티켓·에러) → 모니터링(실행·드리프트·환경)
  const openTodos = todos.filter((t) => !t.done_at);
  const byPriority = (p: string) => openTodos.filter((t) => t.priority === p).length;
  const carried = openTodos.filter((t) => t.carriedDays > 0).length;

  const qaTickets = (
    db
      .prepare(
        `SELECT COUNT(*) AS c FROM ticket_link WHERE is_mine = 1 AND status = 'QA 중'`,
      )
      .get() as { c: number }
  ).c;

  const novelErrors = (
    db
      .prepare(
        `SELECT COUNT(*) AS c FROM signal
         WHERE source = 'datadog' AND kind = 'error-cluster'
           AND observed_at >= datetime('now', '-2 days')`,
      )
      .get() as { c: number }
  ).c;

  // 스위트별 최신 1건만 합산 — 옛 실행의 실패까지 더하면 고친 뒤에도 숫자가 안 줄어든다
  const nightFailed = (
    db
      .prepare(
        `SELECT COALESCE(SUM(r.failed), 0) AS c FROM test_run r
         JOIN (
           SELECT suite, MAX(COALESCE(started_at, collected_at)) AS m
           FROM test_run WHERE runner = 'api' GROUP BY suite
         ) x ON x.suite = r.suite AND COALESCE(r.started_at, r.collected_at) = x.m
         WHERE r.runner = 'api'
           AND COALESCE(r.started_at, r.collected_at) >= datetime('now', '-2 days')`,
      )
      .get() as { c: number }
  ).c;

  const driftCount = (
    db
      .prepare(
        `SELECT COUNT(*) AS c FROM finding WHERE kind = 'contract-drift' AND resolved_at IS NULL`,
      )
      .get() as { c: number }
  ).c;

  const envRow = db
    .prepare(
      `SELECT title, detail FROM signal
       WHERE source = 'api-test' AND kind = 'env-health'
         AND observed_at >= datetime('now', '-2 days')
       ORDER BY observed_at DESC LIMIT 1`,
    )
    .get() as { title: string; detail: string | null } | undefined;

  const tiles: BriefTile[] = [
    {
      key: 'todo',
      value: String(openTodos.length),
      label: '오늘 할 일',
      detail:
        `P0 ${byPriority('P0')} · P1 ${byPriority('P1')} · P2 ${byPriority('P2')} · P3 ${byPriority('P3')}` +
        (carried ? ` · 이월 ${carried}` : ''),
      tone: 'info',
      hero: true,
    },
    {
      key: 'tickets',
      value: String(qaTickets),
      label: '확인 대기',
      detail: 'QA 중 티켓 (내 리포트)',
      tone: qaTickets > 0 ? 'warn' : 'ok',
    },
    {
      key: 'errors',
      value: String(novelErrors),
      label: '신규 에러',
      detail: 'RUM 클러스터',
      tone: novelErrors > 0 ? 'warn' : 'ok',
    },
    {
      key: 'night',
      value: String(nightFailed),
      label: '야간 실패',
      detail: '모니터링 레벨',
      tone: 'idle',
    },
    {
      key: 'drift',
      value: String(driftCount),
      label: '계약 드리프트',
      detail: 'matrix 위반',
      tone: driftCount > 0 ? 'info' : 'ok',
    },
    {
      key: 'env',
      value: envRow ? '위험' : 'OK',
      label: '환경 건강도',
      detail: envRow ? '차량 풀 고갈 의심' : '전제 실패 없음',
      tone: envRow ? 'crit' : 'ok',
    },
  ];

  // ── 신호 블록 ───────────────────────────────────────────────────────
  const blocks: SignalBlock[] = [];

  // 1) 수정 확인 대기 (P0)
  const tickets = db
    .prepare(
      `SELECT jira_key, summary, status_since FROM ticket_link
       WHERE is_mine = 1 AND status = 'QA 중' ORDER BY status_since ASC LIMIT 6`,
    )
    .all() as Array<{ jira_key: string; summary: string | null; status_since: string | null }>;

  if (tickets.length) {
    blocks.push({
      key: 'tickets',
      title: '수정 확인 대기',
      priority: 'P0',
      tone: 'crit',
      badge: `${qaTickets}건`,
      rows: tickets.map((t) => ({
        pill: { text: daysSince(t.status_since), tone: 'warn' satisfies Severity as Severity },
        title: t.jira_key,
        detail: t.summary?.slice(0, 90) ?? undefined,
        mono: true,
      })),
      note: '완료 전이는 사람 승인 — 대시보드가 상태를 바꾸지 않는다',
    });
  }

  // 2) 프로덕션 에러 (P0)
  const ddSignals = db
    .prepare(
      `SELECT kind, title, detail FROM signal
       WHERE source = 'datadog' AND kind IN ('error-cluster','error-4xx')
         AND observed_at >= datetime('now', '-2 days')
       ORDER BY observed_at DESC LIMIT 5`,
    )
    .all() as Array<{ kind: string; title: string; detail: string | null }>;

  if (ddSignals.length) {
    blocks.push({
      key: 'datadog',
      title: '프로덕션 에러 (RUM)',
      priority: 'P0',
      tone: 'crit',
      badge: `신규 ${novelErrors}`,
      rows: ddSignals.map((s) => ({
        pill: {
          text: s.kind === 'error-cluster' ? '신규' : '4xx',
          tone: (s.kind === 'error-cluster' ? 'warn' : 'info') satisfies Severity as Severity,
        },
        title: s.title.replace(/^(신규 에러 클러스터|4xx 반복) — /, ''),
        detail: s.detail ?? undefined,
        mono: true,
      })),
      note: '티켓은 자동 생성하지 않는다 — 후보만 올리고 사람이 결정한다',
    });
  }

  // 3) 계약 드리프트 · 버그 후보 (P1/P2)
  const findings = db
    .prepare(
      `SELECT kind, node_id, contract_key, detail FROM finding
       WHERE resolved_at IS NULL AND kind IN ('contract-drift','bug-candidate','fix-confirmed')
       ORDER BY last_seen DESC LIMIT 6`,
    )
    .all() as Array<{
    kind: string;
    node_id: string;
    contract_key: string | null;
    detail: string | null;
  }>;

  if (findings.length) {
    blocks.push({
      key: 'findings',
      title: '계약 · 버그 후보',
      priority: 'P1',
      tone: 'info',
      badge: `${findings.length}건`,
      rows: findings.map((f) => ({
        pill: { text: KIND_LABEL[f.kind] ?? f.kind, tone: KIND_TONE[f.kind] ?? 'info' },
        title: f.contract_key ?? f.node_id.slice(0, 60),
        detail: (f.detail ?? '').slice(0, 100) || undefined,
        mono: true,
      })),
    });
  }

  // 4) stage 병합 PR (P1 — 회귀 범위 확인)
  const prs = db
    .prepare(
      `SELECT title, detail, url FROM signal
       WHERE source = 'stage-pr' AND kind = 'pr-merged'
         AND observed_at >= datetime('now', '-2 days')
       ORDER BY observed_at DESC LIMIT 5`,
    )
    .all() as Array<{ title: string; detail: string | null; url: string | null }>;

  if (prs.length) {
    blocks.push({
      key: 'stage-pr',
      title: 'stage 병합 PR',
      priority: 'P1',
      tone: 'warn',
      badge: `${prs.length}건`,
      rows: prs.map((p) => ({
        pill: { text: 'merged', tone: 'warn' satisfies Severity as Severity },
        // "[backend] #4675 " 접두는 제목에 이미 있으므로 그대로 쓴다
        title: p.title,
        detail: p.detail ?? undefined,
        mono: true,
      })),
      note: '영향 영역은 변경 파일 경로로 판정한다 (LLM 미사용) — 애매하면 분류하지 않는다',
    });
  }

  // 5) 정기 실행 (P3 — 모니터링)
  const runs = db
    .prepare(
      `SELECT runner, suite, status, passed, failed, total, started_at FROM test_run
       ORDER BY COALESCE(started_at, collected_at) DESC LIMIT 4`,
    )
    .all() as Array<{
    runner: string;
    suite: string;
    status: string;
    passed: number | null;
    failed: number | null;
    total: number | null;
    started_at: string | null;
  }>;

  if (runs.length) {
    blocks.push({
      key: 'runs',
      title: '정기 실행',
      priority: 'P3',
      tone: 'idle',
      badge: nightFailed > 0 ? `${nightFailed} 실패` : '전체 통과',
      rows: runs.map((r) => ({
        pill: {
          text: r.status === 'success' ? '통과' : '실패',
          tone: (r.status === 'success' ? 'ok' : 'warn') satisfies Severity as Severity,
        },
        title: `${r.suite}`,
        detail: `${r.passed ?? '?'}/${r.total ?? '?'} · ${r.started_at?.slice(0, 16).replace('T', ' ') ?? ''}`,
        mono: true,
      })),
      note: '분류는 summarize.mjs가 이미 수행 — 아침에 급히 볼 일이 아니다',
    });
  }

  // ── 수집기 상태 ─────────────────────────────────────────────────────
  const collectors = SOURCES.map((name) => ({
    name,
    ok: getMeta(`collector:${name}:ok`) === '1',
    at: getMeta(`collector:${name}:at`),
    detail: getMeta(`collector:${name}:detail`) ?? '아직 수집한 적 없음',
  }));

  const payload: TodayPayload = {
    day,
    collectedAt: getMeta('collect:last_run'),
    tiles,
    todos,
    blocks,
    noticeCount: countActiveNotices(),
    collectors,
  };

  return NextResponse.json(payload);
}

const KIND_LABEL: Record<string, string> = {
  'contract-drift': '드리프트',
  'bug-candidate': '버그 후보',
  'fix-confirmed': '수정 확인',
  'selector-drift': '셀렉터',
  unstable: '불안정',
  'coverage-gap': '커버 공백',
};

const KIND_TONE: Record<string, 'crit' | 'warn' | 'info' | 'ok' | 'idle'> = {
  'contract-drift': 'info',
  'bug-candidate': 'crit',
  'fix-confirmed': 'ok',
  'selector-drift': 'warn',
  unstable: 'idle',
  'coverage-gap': 'info',
};

/** 'YYYY-MM-DDT..' → 'D+n' */
function daysSince(iso: string | null): string {
  if (!iso) return '—';
  const d = Math.floor((Date.now() - Date.parse(iso)) / 86_400_000);
  return Number.isNaN(d) ? '—' : `D+${Math.max(d, 0)}`;
}
