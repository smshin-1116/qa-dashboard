import { NextResponse } from 'next/server';
import { latestRunsByRunner, openFindings, findingById, resolveFinding } from '@/lib/workspace/repo';
import type { FindingRow } from '@/lib/workspace/types';
import { loadCatalog } from '@/lib/workspace/catalog';
import { isAnalysisFresh } from '@/lib/workspace/fingerprint';
import { analyzeFailures } from '@/lib/workspace/analyzeFailures';
import { getTriggerConfig, triggerRun } from '@/lib/workspace/triggerRun';
import { createBugs } from '@/lib/workspace/jiraComment';
import { bugSectionsToMarkdown, bugLabels, type BugSections } from '@/lib/workspace/bugTemplate';
import { deepAnalyzeFinding } from '@/lib/workspace/deepAnalyzeFinding';

/**
 * finding → 구조화 버그 초안 (DV-647 형식). 도메인 무관 — 실패 데이터로만 구성.
 * ⚠️ 자동화 실패는 코드 원인이 확정되지 않은 상태다. rootCause는 "미확정 + 분석 가설"로
 *    정직하게 두고 신뢰도 등급은 붙이지 않는다 — 코드 원인은 재현/소스 분석으로 채워야 한다.
 */
function bugDraftFromFinding(f: FindingRow) {
  const target = f.node_id ?? f.contract_key ?? `finding-${f.id}`;
  const summary = `[자동화 실패] ${target}${f.runner ? ` (${f.runner})` : ''}`.slice(0, 200);
  const sections: BugSections = {
    context: `테스트 자동화 회귀에서 발견 — ${f.runner ?? ''} 러너${f.occurrences && f.occurrences > 1 ? ` · ${f.occurrences}회 반복` : ''}`,
    reproduction: [
      `회귀 스위트에서 \`${target}\` 실행`,
      f.contract_key ? `대상 계약: ${f.contract_key}` : '해당 테스트가 검증하는 화면/동작 확인',
    ].filter(Boolean),
    actual: (f.detail ?? '(에러 메시지 없음)').slice(0, 1000),
    expected: '테스트가 통과한다 (해당 기능이 기대대로 동작).',
    rootCause: [
      '미확정 — 백엔드/프론트 repo에서 `파일:라인`을 확인해야 한다 (재현 후 소스 분석 필요).',
      f.analysis ? `\n분석 가설(LLM): ${f.analysis}` : '',
    ]
      .filter(Boolean)
      .join('\n'),
    impact: '회귀 스위트 실패 — 해당 기능의 자동 검증 공백. 실사용 영향 범위는 코드 원인 확인 후 판정.',
    environment: 'stage · 자동화 회귀 (QA Workspace 테스트 자동화 탭에서 등록)',
    // 신뢰도 등급은 코드 원인이 확정돼야 부여 — 지금은 미부여(QA 레이블만)
  };
  return {
    tcId: f.id,
    localId: target,
    summary,
    description: bugSectionsToMarkdown(sections),
    sections,
    labels: bugLabels(['test', f.runner === 'api' ? 'api-automation' : 'e2e']),
  };
}

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
    triggers: getTriggerConfig(),
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
  const body = (await req.json().catch(() => ({}))) as {
    action?: string;
    runner?: 'web' | 'api' | 'app';
    tier?: string;
    confirm?: boolean;
    id?: number;
    project?: string;
    /** 심층 분석 결과(있으면 이걸로 등록 — 얕은 자동 초안 대신) */
    summary?: string;
    sections?: BugSections;
    labels?: string[];
  };

  // ── 실패 일괄 분석 ──────────────────────────────────────────────
  if (body.action === 'analyze') {
    try {
      const result = await analyzeFailures();
      return NextResponse.json({ ok: true, ...result });
    } catch (e) {
      return NextResponse.json({ error: e instanceof Error ? e.message : '분석 실패' }, { status: 500 });
    }
  }

  // ── 실행 트리거 (외부 CI 호출 — confirm 게이트) ─────────────────
  if (body.action === 'trigger') {
    const { runner, tier } = body;
    if (!runner || !tier) {
      return NextResponse.json({ error: 'runner·tier 필요' }, { status: 400 });
    }
    // confirm이 없으면 미리보기(게이트)만 — 실제 CI를 부르지 않는다
    if (body.confirm !== true) {
      const cfg = getTriggerConfig().find((t) => t.runner === runner);
      if (!cfg) return NextResponse.json({ error: '알 수 없는 runner' }, { status: 400 });
      return NextResponse.json({
        ok: true,
        preview: true,
        runner,
        tier,
        via: cfg.via,
        ready: cfg.ready,
        note: cfg.note,
        message: cfg.ready
          ? `${cfg.via}로 ${runner} ${tier}를 실행합니다. [실행]을 누르면 실제 CI가 트리거됩니다.`
          : `설정 미비 — ${cfg.note}`,
      });
    }
    // confirm=true → 실제 트리거
    try {
      const result = await triggerRun(runner, tier);
      return NextResponse.json({ ...result, preview: false });
    } catch (e) {
      return NextResponse.json({ ok: false, message: e instanceof Error ? e.message : '트리거 실패' }, { status: 500 });
    }
  }

  // ── 조치: 심층 분석 (소스까지 읽어 버그 근거 생성 — 온디맨드 에이전트) ──
  if (body.action === 'deep-analyze') {
    if (!body.id) return NextResponse.json({ error: 'id 필요' }, { status: 400 });
    const f = findingById(body.id);
    if (!f) return NextResponse.json({ error: 'finding 없음' }, { status: 404 });
    try {
      const { result: deep, raw } = await deepAnalyzeFinding(f);
      if (!deep)
        return NextResponse.json({
          ok: false,
          error: '분석 결과(JSON)를 읽지 못함 — 얕은 초안으로 등록 가능',
          raw: raw.slice(-600),
        });
      return NextResponse.json({
        ok: true,
        summary: deep.summary,
        sections: deep.sections,
        description: bugSectionsToMarkdown(deep.sections),
        labels: bugLabels(['test', f.runner === 'api' ? 'api-automation' : 'e2e'], deep.sections.confidence),
      });
    } catch (e) {
      return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : '심층 분석 실패' }, { status: 500 });
    }
  }

  // ── 조치: 버그 등록 (외부 쓰기 — confirm 게이트) ────────────────
  if (body.action === 'create-bug') {
    if (!body.id) return NextResponse.json({ error: 'id 필요' }, { status: 400 });
    const f = findingById(body.id);
    if (!f) return NextResponse.json({ error: 'finding 없음' }, { status: 404 });
    const project = body.project ?? 'DV';
    // 심층 분석 결과가 넘어오면 그걸로, 아니면 얕은 자동 초안
    const draft = body.sections
      ? {
          tcId: f.id,
          localId: f.node_id ?? `finding-${f.id}`,
          summary: body.summary ?? bugDraftFromFinding(f).summary,
          description: bugSectionsToMarkdown(body.sections),
          sections: body.sections,
          labels: body.labels ?? bugLabels([], body.sections.confidence),
        }
      : bugDraftFromFinding(f);
    // 미리보기 — Jira에 쓰지 않는다
    if (body.confirm !== true) {
      return NextResponse.json({ ok: true, preview: true, project, draft });
    }
    // 실제 등록 → 성공 시 finding 해소(큐에서 내림, Jira로 추적 이관)
    const [res] = await createBugs(project, [draft]);
    if (res?.ok) resolveFinding(f.id);
    return NextResponse.json({
      ok: Boolean(res?.ok),
      preview: false,
      key: res?.key,
      url: res?.url,
      message: res?.ok ? `${res.key} 등록됨 — 큐에서 해소` : `등록 실패: ${res?.error ?? '알 수 없음'}`,
    });
  }

  // ── 조치: 해소 처리 (수동 처리 완료 → 큐에서 내림) ─────────────
  if (body.action === 'resolve') {
    if (!body.id) return NextResponse.json({ error: 'id 필요' }, { status: 400 });
    resolveFinding(body.id);
    return NextResponse.json({ ok: true, message: '해소 처리됨 — 큐에서 내림' });
  }

  return NextResponse.json({ error: 'unknown action' }, { status: 400 });
}
