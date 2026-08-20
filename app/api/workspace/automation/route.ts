import { NextResponse } from 'next/server';
import { latestRunsByRunner, openFindings } from '@/lib/workspace/repo';
import type { FindingRow } from '@/lib/workspace/types';
import { loadCatalog } from '@/lib/workspace/catalog';
import { isAnalysisFresh } from '@/lib/workspace/fingerprint';
import { analyzeFailures } from '@/lib/workspace/analyzeFailures';

/**
 * GET /api/workspace/automation — 테스트 자동화 탭 데이터.
 *
 * ── 독립성 (2026-08-10 결정) ──────────────────────────────────────────
 * 이 화면은 QA 작업의 tc 테이블을 **들여다보지 않는다.** QA 작업이 남긴
 * finding(coverage-gap) 신호만 본다 — 인계는 한 방향·한 지점이다.
 *
 * ── 토큰 ──────────────────────────────────────────────────────────────
 * **LLM 호출 0.** 상태 저장소 조회 + 규칙 분류만 한다. 화면을 열 때마다
 * 도는 경로이므로 여기에 LLM이 들어가면 매일 비용이 난다.
 * (실패 일괄 분석은 별도 트리거로 분리 — 이 라우트에 넣지 않는다)
 */
export const dynamic = 'force-dynamic';

/**
 * 유지보수 큐 6종 분류 (시안 확정).
 * finding.kind를 시안 라벨·판정경로·조치로 매핑한다. DB에 없는 유형
 * (계약 드리프트·셀렉터 드리프트)은 수집기가 채우면 자동으로 뜬다.
 */
const KIND_META: Record<
  string,
  { label: string; tone: 'ok' | 'info' | 'warn' | 'crit' | 'idle'; action: string }
> = {
  'fix-confirmed': { label: '수정 확인', tone: 'ok', action: '기대값 정상화' },
  'contract-drift': { label: '계약 드리프트', tone: 'info', action: 'matrix 갱신' },
  'bug-candidate': { label: '버그 후보', tone: 'crit', action: '/create-bug' },
  'selector-drift': { label: '셀렉터 드리프트', tone: 'warn', action: '화면 실측' },
  unstable: { label: '불안정', tone: 'idle', action: '단독 재실행' },
  'coverage-gap': { label: '커버 공백', tone: 'info', action: '스켈레톤 생성' },
};

/** 판정 경로 — 어디서 토큰이 드는지. verdict_by가 원본 */
function verdictPath(f: FindingRow): { label: string; how: string; tone: string } {
  if (f.analyzed_at && f.verdict_by === 'llm') return { label: 'LLM', how: '배치 1회', tone: 'info' };
  if (f.verdict_by === 'cache') return { label: '캐시', how: '동일 fingerprint', tone: 'idle' };
  return { label: '규칙', how: '수집기 분류', tone: 'ok' };
}

export async function GET() {
  const catalog = loadCatalog();
  const runs = latestRunsByRunner();
  const findings = openFindings(100);

  // ── 자산 현황 — 러너별 최신 실행을 합산 (스위트 여러 개면 합쳐 한 카드) ──
  const byRunner = new Map<string, { total: number; passed: number; failed: number; skipped: number; url: string | null }>();
  for (const r of runs) {
    const cur = byRunner.get(r.runner) ?? { total: 0, passed: 0, failed: 0, skipped: 0, url: null };
    cur.total += r.total ?? 0;
    cur.passed += r.passed ?? 0;
    cur.failed += r.failed ?? 0;
    cur.skipped += r.skipped ?? 0;
    cur.url = cur.url ?? r.url;
    byRunner.set(r.runner, cur);
  }
  const RUNNER_LABEL: Record<string, string> = { web: '웹 E2E', api: 'API', app: '앱 E2E' };
  // 시안 순서 고정: 웹 → API → 앱 (수집 순서에 흔들리지 않게)
  const RUNNER_ORDER = ['web', 'api', 'app'];
  const assets = [...byRunner.entries()]
    .sort((a, b) => RUNNER_ORDER.indexOf(a[0]) - RUNNER_ORDER.indexOf(b[0]))
    .map(([runner, s]) => ({
    runner,
    label: RUNNER_LABEL[runner] ?? runner,
    total: s.total,
    passed: s.passed,
    failed: s.failed,
    skipped: s.skipped,
    url: s.url,
  }));

  // ── 유지보수 큐 — finding을 6종으로. 판정 경로로 토큰 소재를 드러낸다 ──
  const queue = findings.map((f) => {
    const meta = KIND_META[f.kind ?? ''] ?? { label: f.kind ?? '미분류', tone: 'idle' as const, action: '확인' };
    const vp = verdictPath(f);
    return {
      id: f.id,
      kind: f.kind,
      label: meta.label,
      tone: meta.tone,
      action: meta.action,
      target: f.node_id,
      runner: f.runner,
      contractKey: f.contract_key,
      detail: f.detail,
      occurrences: f.occurrences,
      verdict: vp,
      /** LLM 배치 분석 결과(있으면) — 근본원인 + 조치 방향 */
      analysis: f.analysis,
      analyzedAt: f.analyzed_at,
      /** QA 작업에서 넘어온 것인지 (detail에 출처가 박혀 있다) */
      fromWork: (f.detail ?? '').startsWith('[QA 작업]'),
      lastSeen: f.last_seen,
    };
  });

  // 실패 일괄 분석 대상 집계 — 미분석·TTL 만료 = 분석 대상, 나머지는 캐시 재사용
  const analysisStats = { needAnalysis: 0, cached: 0 };
  for (const f of findings) {
    if (isAnalysisFresh(f.analyzed_at)) analysisStats.cached++;
    else analysisStats.needAnalysis++;
  }

  // 판정 경로 집계 — 시안 "규칙 N · 캐시 N · LLM N" (토큰 설계 가시화)
  const verdictTally = { rule: 0, cache: 0, llm: 0 };
  for (const q of queue) {
    if (q.verdict.label === 'LLM') verdictTally.llm++;
    else if (q.verdict.label === '캐시') verdictTally.cache++;
    else verdictTally.rule++;
  }

  // ── 회귀 감시 (xfail) — fix-confirmed는 XPASS(고쳐짐 신호) ──
  const xfailWatch = findings
    .filter((f) => f.kind === 'fix-confirmed')
    .map((f) => ({ target: f.node_id, detail: f.detail, contractKey: f.contract_key }));

  return NextResponse.json({
    catalog: catalog
      ? { total: catalog.entries.length, generatedAt: catalog.generatedAt }
      : null,
    assets,
    queue,
    verdictTally,
    analysisStats,
    xfailWatch,
    // QA 작업 인계분만 따로 셈 — 이 탭이 받은 신호 (인계 완결의 증거)
    handedFromWork: queue.filter((q) => q.fromWork).length,
  });
}

/**
 * POST /api/workspace/automation — { action: 'analyze' }
 * 실패 일괄 분석 트리거. 규칙이 못 가른/오래된 실패만 LLM 배치 1회로 분석한다.
 * GET(화면 로드)엔 LLM을 넣지 않는다는 원칙을 지키려 쓰기는 여기로 분리.
 */
export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as { action?: string };
  if (body.action !== 'analyze') {
    return NextResponse.json({ error: 'unknown action' }, { status: 400 });
  }
  try {
    const result = await analyzeFailures();
    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : '분석 실패' },
      { status: 500 },
    );
  }
}
