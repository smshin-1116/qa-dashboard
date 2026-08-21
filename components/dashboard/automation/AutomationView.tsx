'use client';

import { useEffect, useState } from 'react';
import DashboardHeader from '@/components/dashboard/header/DashboardHeader';
import type { AIModel } from '@/types/session';

/**
 * 테스트 자동화 (㉯ 영구 자산) — 시안 data-view="auto" 2119~2597행이 사양이다.
 *
 * ── 이번 범위 ─────────────────────────────────────────────────────────
 * 시안의 "보는 것" 3섹션을 실데이터로 만든다:
 *   A. 자산 현황 — 러너별 최신 회귀 (test_run)
 *   B. 유지보수 큐 — finding 6종 분류 + 판정 경로(토큰 소재)
 *   C. 회귀 감시 xfail — fix-confirmed(XPASS=고쳐짐 신호)
 * 실행 트리거(Jenkins/Actions 실호출)·일괄 분석(LLM)·Slack 딥링크·앱 블로커는
 * 다음 단계 — 실제 CI 호출·토큰이 걸려 신중히 간다("쓰이는 것만 짓는다").
 *
 * ── 독립성 ────────────────────────────────────────────────────────────
 * QA 작업의 tc 테이블을 보지 않는다. QA 작업이 남긴 coverage-gap 신호만 본다.
 * 넘어온 것은 "커버 공백"으로 뜨고 출처 배지가 붙는다.
 */

/**
 * 시맨틱 색은 CSS 토큰을 참조한다 (라이트/다크 자동 전환).
 * `color-mix`로 테두리·배경 투명도를 만든다 — 토큰 하나만 바뀌면 셋 다 따라온다.
 */
const TONE = {
  ok: { fg: 'var(--ok)', bd: 'color-mix(in srgb, var(--ok) 40%, transparent)', bg: 'color-mix(in srgb, var(--ok) 12%, transparent)' },
  info: { fg: 'var(--info)', bd: 'color-mix(in srgb, var(--info) 40%, transparent)', bg: 'color-mix(in srgb, var(--info) 12%, transparent)' },
  warn: { fg: 'var(--warn)', bd: 'color-mix(in srgb, var(--warn) 40%, transparent)', bg: 'color-mix(in srgb, var(--warn) 12%, transparent)' },
  crit: { fg: 'var(--crit)', bd: 'color-mix(in srgb, var(--crit) 40%, transparent)', bg: 'color-mix(in srgb, var(--crit) 12%, transparent)' },
  idle: { fg: 'var(--tx-4)', bd: 'var(--line-2)', bg: 'var(--inset)' },
} as const;
type Tone = keyof typeof TONE;

/** 유지보수 큐 6종 분류 규칙 — [분류 규칙] 토글에 표시 (route의 KIND_META와 같은 어휘) */
const KIND_RULES: Array<{ kind: string; label: string; tone: Tone; how: string; action: string }> = [
  { kind: 'fix-confirmed', label: '수정 확인', tone: 'ok', how: 'xfail이 통과로 뒤집힘', action: '기대값 정상화' },
  { kind: 'contract-drift', label: '계약 드리프트', tone: 'info', how: 'API 스키마·상태코드 어긋남', action: 'matrix 갱신' },
  { kind: 'bug-candidate', label: '버그 후보', tone: 'crit', how: '제품 버그 의심 실패', action: '/create-bug' },
  { kind: 'selector-drift', label: '셀렉터 드리프트', tone: 'warn', how: '셀렉터·타임아웃(테스트 낡음)', action: '화면 실측' },
  { kind: 'unstable', label: '불안정', tone: 'idle', how: '재현 불안정·환경 전제 실패', action: '단독 재실행' },
  { kind: 'coverage-gap', label: '커버 공백', tone: 'info', how: '검증 공백(QA 작업 인계)', action: '스켈레톤 생성' },
];

interface Asset {
  runner: string;
  label: string;
  total: number;
  passed: number;
  failed: number;
  skipped: number;
  url: string | null;
}
interface QueueItem {
  id: number;
  kind: string | null;
  label: string;
  tone: Tone;
  action: string;
  target: string;
  runner: string;
  contractKey: string | null;
  detail: string | null;
  occurrences: number;
  verdict: { label: string; how: string; tone: string };
  /** LLM 배치 분석 결과(있으면) */
  analysis: string | null;
  analyzedAt: string | null;
  fromWork: boolean;
  lastSeen: string;
}
interface RunnerTrigger {
  runner: string;
  via: string;
  tiers: string[];
  ready: boolean;
  note: string;
}
interface Payload {
  catalog: { total: number; generatedAt: string | null } | null;
  assets: Asset[];
  queue: QueueItem[];
  verdictTally: { rule: number; cache: number; llm: number };
  analysisStats: { needAnalysis: number; cached: number };
  triggers: RunnerTrigger[];
  trend: Array<{ day: string; rate: number; failed: number }>;
  envHealth: { title: string; detail: string | null; observedAt: string | null } | null;
  xfailWatch: Array<{ target: string; detail: string | null; contractKey: string | null }>;
  handedFromWork: number;
}

/** 실행 트리거 미리보기(승인 게이트) 상태 */
interface TriggerModalState {
  runner: string;
  tier: string;
  via: string;
  ready: boolean;
  note: string;
  message: string;
  running: boolean;
  result: string | null;
}

export default function AutomationView() {
  const [model, setModel] = useState<AIModel>('claude');
  const [data, setData] = useState<Payload | null>(null);
  const [loading, setLoading] = useState(true);
  /** 실패 일괄 분석 진행/결과 */
  const [analyzing, setAnalyzing] = useState(false);
  const [analyzeMsg, setAnalyzeMsg] = useState<string | null>(null);
  /** 실행 트리거 승인 게이트 모달 */
  const [trig, setTrig] = useState<TriggerModalState | null>(null);
  /** 유지보수 큐 상단 [분류 규칙] 토글 */
  const [showRules, setShowRules] = useState(false);
  /** 조치 모달 (수렴점) — 버그 등록·재실행·해소 처리 라우팅 */
  const [act, setAct] = useState<{
    q: QueueItem;
    mode: 'menu' | 'bug';
    draft: { summary: string; description: string; sections?: unknown; labels?: string[] } | null;
    deep: boolean; // 심층 분석 초안인지
    project: string;
    busy: boolean;
    result: string | null;
  } | null>(null);

  const reload = () =>
    fetch('/api/workspace/automation', { cache: 'no-store' })
      .then((r) => r.json() as Promise<Payload>)
      .then(setData);

  useEffect(() => {
    void reload().finally(() => setLoading(false));
  }, []);

  /** 실패 일괄 분석 — 규칙이 못 가른/오래된 실패만 LLM 배치 1회로. 끝나면 목록 갱신. */
  async function runAnalysis() {
    if (analyzing) return;
    setAnalyzing(true);
    setAnalyzeMsg('분석 중… (LLM 배치 1회, 최대 1분)');
    try {
      const res = await fetch('/api/workspace/automation', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'analyze' }),
      });
      const body = (await res.json()) as {
        ok?: boolean;
        analyzed?: number;
        cached?: number;
        unmatched?: number;
        error?: string;
      };
      if (!res.ok || !body.ok) throw new Error(body.error ?? `실패 (${res.status})`);
      await reload();
      setAnalyzeMsg(
        `분석 완료 — 새로 ${body.analyzed ?? 0}건` +
          (body.cached ? ` · 캐시 재사용 ${body.cached}건` : '') +
          (body.unmatched ? ` · 미매칭 ${body.unmatched}건` : ''),
      );
    } catch (e) {
      setAnalyzeMsg(`분석 실패 — ${e instanceof Error ? e.message : '알 수 없음'}`);
    } finally {
      setAnalyzing(false);
    }
  }

  /** ▶ 실행 클릭 → 미리보기(게이트) 먼저. 실제 CI는 여기서 부르지 않는다. */
  async function openTrigger(runner: string, tier: string) {
    const res = await fetch('/api/workspace/automation', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'trigger', runner, tier }),
    });
    const b = (await res.json()) as { via?: string; ready?: boolean; note?: string; message?: string };
    setTrig({
      runner,
      tier,
      via: b.via ?? '',
      ready: b.ready ?? false,
      note: b.note ?? '',
      message: b.message ?? '',
      running: false,
      result: null,
    });
  }

  // ── 조치 (수렴점) ────────────────────────────────────────────────
  function openAction(q: QueueItem) {
    setAct({ q, mode: 'menu', draft: null, deep: false, project: 'DV', busy: false, result: null });
  }
  /** 심층 분석 — 소스까지 읽어 원인(코드)을 채운 초안. 무거운 에이전트 호출(최대 1~2분) */
  async function deepAnalyze() {
    if (!act || act.busy) return;
    setAct({ ...act, busy: true, result: '🔬 소스 분석 중… 테스트·제품 repo 확인 (최대 1~2분)' });
    try {
      const res = await fetch('/api/workspace/automation', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'deep-analyze', id: act.q.id }),
      });
      const b = (await res.json()) as { ok?: boolean; summary?: string; description?: string; sections?: unknown; labels?: string[]; error?: string };
      if (!b.ok) throw new Error(b.error ?? '분석 실패');
      setAct((a) =>
        a ? { ...a, mode: 'bug', deep: true, busy: false, result: null,
              draft: { summary: b.summary ?? '', description: b.description ?? '', sections: b.sections, labels: b.labels } } : a,
      );
    } catch (e) {
      setAct((a) => (a ? { ...a, busy: false, result: `❌ 심층 분석 실패 — ${e instanceof Error ? e.message : '알 수 없음'} (빠른 등록으로 대체 가능)` } : a));
    }
  }
  /** 빠른 등록 미리보기 — 소스 분석 없이 얕은 초안(원인 미확정) */
  async function previewBug() {
    if (!act) return;
    setAct({ ...act, busy: true });
    const res = await fetch('/api/workspace/automation', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'create-bug', id: act.q.id, project: act.project }),
    });
    const b = (await res.json()) as { draft?: { summary: string; description: string; sections?: unknown; labels?: string[] } };
    setAct((a) => (a ? { ...a, mode: 'bug', deep: false, draft: b.draft ?? null, busy: false } : a));
  }
  /** 게이트 [등록] → confirm=true로 실제 Jira 등록 + finding 해소 (심층 초안이면 그걸로) */
  async function confirmBug() {
    if (!act || act.busy) return;
    setAct({ ...act, busy: true, result: '등록 중…' });
    try {
      const res = await fetch('/api/workspace/automation', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'create-bug',
          id: act.q.id,
          project: act.project,
          confirm: true,
          ...(act.deep && act.draft
            ? { summary: act.draft.summary, sections: act.draft.sections, labels: act.draft.labels }
            : {}),
        }),
      });
      const b = (await res.json()) as { ok?: boolean; message?: string };
      await reload();
      setAct((a) => (a ? { ...a, busy: false, result: (b.ok ? '✅ ' : '❌ ') + (b.message ?? '') } : a));
    } catch (e) {
      setAct((a) => (a ? { ...a, busy: false, result: `❌ ${e instanceof Error ? e.message : '실패'}` } : a));
    }
  }
  /** 해소 처리 — 수동 처리 완료로 큐에서 내림 */
  async function resolveAction() {
    if (!act || act.busy) return;
    setAct({ ...act, busy: true, result: '해소 처리 중…' });
    try {
      await fetch('/api/workspace/automation', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'resolve', id: act.q.id }),
      });
      await reload();
      setAct((a) => (a ? { ...a, busy: false, result: '✅ 해소 처리됨 — 큐에서 내림' } : a));
    } catch (e) {
      setAct((a) => (a ? { ...a, busy: false, result: `❌ ${e instanceof Error ? e.message : '실패'}` } : a));
    }
  }

  /** 모달 [실행] → confirm=true로 실제 CI 트리거 */
  async function confirmTrigger() {
    if (!trig || trig.running) return;
    setTrig({ ...trig, running: true, result: '트리거 중…' });
    try {
      const res = await fetch('/api/workspace/automation', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'trigger', runner: trig.runner, tier: trig.tier, confirm: true }),
      });
      const b = (await res.json()) as { ok?: boolean; message?: string; url?: string | null };
      setTrig((t) => (t ? { ...t, running: false, result: (b.ok ? '✅ ' : '❌ ') + (b.message ?? '') } : t));
    } catch (e) {
      setTrig((t) => (t ? { ...t, running: false, result: `❌ ${e instanceof Error ? e.message : '실패'}` } : t));
    }
  }

  return (
    <div className="flex flex-col h-screen bg-[var(--ground)]">
      <DashboardHeader activeModel={model} onModelChange={setModel} activeWorkspaceKey="auto" />

      <div className="flex-1 min-h-0 flex">
        {/* ── 왼쪽 레일 — 자산 요약·판정 경로 범례 (시안: 카탈로그 요약) ── */}
        <AutoRail data={data} />

        <div className="flex-1 min-h-0 overflow-y-auto">
        <div className="max-w-6xl mx-auto w-full p-4 flex flex-col gap-3.5">
          {/* 헤더 라벨 */}
          <div>
            <div className="font-mono text-[9.5px] font-semibold tracking-[0.1em] uppercase text-[var(--tx-4)]">
              ㉯ 자산 · 영구 — 만든 검증을 지키는 곳
            </div>
            <h1 className="text-[19px] font-[680] tracking-[-0.02em] text-[var(--tx-1)] mt-1">
              테스트 자동화
            </h1>
            <p className="text-[12.5px] text-[var(--tx-3)] mt-0.5 max-w-[68ch]">
              자동화 카탈로그(자산)와 그 상태(회귀 결과)를 한 화면에서 본다. QA 작업이 넘긴
              커버 공백 신호를 받는 쪽 — <b className="text-[var(--tx-3)]">/daily-qa 런북을 UI로</b>.
            </p>
          </div>

          {loading ? (
            <div className="text-[var(--tx-3)] text-sm py-10 text-center">불러오는 중…</div>
          ) : !data ? (
            <div className="text-[var(--tx-3)] text-sm py-10 text-center">데이터를 읽지 못했습니다</div>
          ) : (
            <>
              {/* ══ A. 자산 현황 ══════════════════════════════════ */}
              <SectionLabel>
                자산 현황
                {data.catalog && (
                  <span className="font-mono text-[10px] text-[var(--tx-3)] ml-1.5 normal-case tracking-normal">
                    카탈로그 {data.catalog.total}건 · 생성 {data.catalog.generatedAt ?? '?'}
                  </span>
                )}
              </SectionLabel>
              <div className="grid gap-2.5" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))' }}>
                {data.assets.length === 0 ? (
                  <Card>
                    <div className="text-[12px] text-[var(--tx-3)]">
                      아직 수집된 회귀 실행이 없습니다 — <span className="font-mono">npm run collect</span> 후 표시됩니다
                    </div>
                  </Card>
                ) : (
                  data.assets.map((a) => (
                    <AssetCard
                      key={a.runner}
                      a={a}
                      trigger={data.triggers.find((t) => t.runner === a.runner)}
                      onTrigger={openTrigger}
                    />
                  ))
                )}
              </div>

              {/* ══ 실행 트리거 — 직접 실행 X, 기존 CI 인프라를 부른다 ══ */}
              <SectionLabel>실행 트리거</SectionLabel>
              <TriggerCard triggers={data.triggers} onTrigger={openTrigger} />

              {/* ══ B. 유지보수 큐 ════════════════════════════════ */}
              <SectionLabel>유지보수 큐</SectionLabel>
              <Card stripe="warn">
                <div className="flex items-start justify-between gap-2.5 mb-2.5">
                  <div>
                    <div className="text-[13px] font-[640] text-[var(--tx-1)]">
                      실패·공백 {data.queue.length}건
                    </div>
                    <div className="text-[11px] text-[var(--tx-3)] mt-0.5">
                      /daily-qa 5유형 + summarize 4유형을 <b className="text-[var(--tx-3)]">6종으로 통합</b> ·
                      코드 변경은 항상 사람 승인 후
                    </div>
                  </div>
                  {/* 판정 경로 집계 + 분류 규칙 (시안: 우상단 [분류 규칙]) */}
                  <div className="flex items-center gap-1.5 flex-shrink-0">
                    <Pill tone="ok">규칙 {data.verdictTally.rule}</Pill>
                    <Pill tone="idle">캐시 {data.verdictTally.cache}</Pill>
                    <Pill tone="info">LLM {data.verdictTally.llm}</Pill>
                    <button
                      onClick={() => setShowRules((v) => !v)}
                      className="px-2 py-1 rounded-[6px] border border-[var(--line-2)] bg-[var(--inset)] text-[var(--tx-2)] text-[10.5px] font-semibold hover:text-white hover:border-[var(--accent-deep)]"
                    >
                      분류 규칙 {showRules ? '▾' : '▸'}
                    </button>
                  </div>
                </div>

                {/* 6종 분류 규칙 — 무슨 유형이 어떻게 판정되고 어떤 조치인지 */}
                {showRules && (
                  <div className="mb-2.5 rounded-[9px] border p-2.5 grid gap-1.5" style={{ borderColor: 'var(--line-2)', background: 'var(--inset)', gridTemplateColumns: 'repeat(auto-fit, minmax(230px, 1fr))' }}>
                    {KIND_RULES.map((r) => (
                      <div key={r.kind} className="flex items-center gap-2 text-[10.5px]">
                        <Pill tone={r.tone}>{r.label}</Pill>
                        <span className="text-[var(--tx-3)] flex-1 min-w-0">{r.how}</span>
                        <span className="font-mono text-[9.5px] text-[var(--tx-4)]">→ {r.action}</span>
                      </div>
                    ))}
                  </div>
                )}

                {/* 실패 일괄 분석 트리거 — 규칙이 못 가른/오래된 실패만 LLM 배치 1회. fingerprint 캐시 재사용 */}
                <div
                  className="flex items-center justify-between gap-3 px-3 py-2.5 mb-2.5 rounded-[9px] border"
                  style={{ borderColor: 'var(--line-2)', background: 'var(--inset)' }}
                >
                  <div className="text-[11.5px] text-[var(--tx-2)] min-w-0">
                    <b className="text-[var(--tx-1)]">실패 일괄 분석</b>{' '}
                    <span className="text-[var(--tx-3)]">
                      규칙 자동 분류 <b>{data.verdictTally.rule}</b>건(토큰 0) · 잔여{' '}
                      <b style={{ color: TONE.info.fg }}>{data.analysisStats.needAnalysis}</b>건만 LLM 배치 1회 · 캐시 재사용{' '}
                      <b>{data.analysisStats.cached}</b>건
                    </span>
                    {/* 토큰 추정 — 배치 1회 vs 건별 호출 (시안의 핵심 장치) */}
                    <div className="font-mono text-[10px] mt-0.5" style={{ color: 'var(--tx-4)' }}>
                      예상 <b style={{ color: TONE.ok.fg }}>~{data.analysisStats.needAnalysis === 0 ? 0 : 3 + Math.ceil(data.analysisStats.needAnalysis * 0.3)}k</b> 토큰
                      {data.analysisStats.needAnalysis > 0 && (
                        <> · 건별 호출이면 ~{data.analysisStats.needAnalysis * 8}k</>
                      )}
                    </div>
                    {analyzeMsg && (
                      <div className="text-[10.5px] mt-1" style={{ color: analyzing ? 'var(--tx-3)' : TONE.ok.fg }}>
                        {analyzeMsg}
                      </div>
                    )}
                  </div>
                  <button
                    onClick={() => void runAnalysis()}
                    disabled={analyzing || data.analysisStats.needAnalysis === 0}
                    className="shrink-0 px-3 py-1.5 rounded-[7px] text-[11.5px] font-[640] border text-white disabled:opacity-40 disabled:cursor-not-allowed"
                    style={{ background: 'var(--accent-deep)', borderColor: 'var(--accent-deep)' }}
                    title="규칙이 분류 못 한/오래된(7일 초과) 실패만 LLM 배치 1회로 분석합니다"
                  >
                    {analyzing ? '분석 중…' : '분석 실행'}
                  </button>
                </div>

                {data.handedFromWork > 0 && (
                  <div
                    className="flex items-center gap-2 px-3 py-2 mb-2.5 rounded-[9px] border text-[11.5px]"
                    style={{ borderColor: TONE.info.bd, background: TONE.info.bg, color: TONE.info.fg }}
                  >
                    QA 작업에서 넘어온 커버 공백 <b>{data.handedFromWork}건</b> — 아래 표에 출처 배지로 표시
                  </div>
                )}

                <div className="overflow-x-auto rounded-[9px] border border-[var(--line)]">
                  <table className="w-full border-collapse text-[11.5px] min-w-[760px]">
                    <thead>
                      <tr>
                        <Th>유형</Th>
                        <Th>대상</Th>
                        <Th>신호</Th>
                        <Th>판정 경로</Th>
                        <Th>러너</Th>
                        <Th>조치</Th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.queue.length === 0 ? (
                        <tr>
                          <Td colSpan={6}>
                            <span className="text-[var(--tx-3)]">열린 실패·공백이 없습니다 — 회귀 전건 통과</span>
                          </Td>
                        </tr>
                      ) : (
                        data.queue.map((q) => <QueueRow key={q.id} q={q} onAction={openAction} />)
                      )}
                    </tbody>
                  </table>
                </div>

                <Quote tone="warn">
                  <b style={{ color: TONE.warn.fg }}>추측 금지</b> — 셀렉터·계약은 실제 화면/응답
                  실측으로만 갱신한다. /daily-qa 가드레일을 그대로 반영했다.
                </Quote>
                <Quote tone="info">
                  <b style={{ color: TONE.info.fg }}>판정 경로 컬럼이 토큰 설계다</b> — 규칙으로 대부분
                  걸러내고, 같은 실패는 fingerprint 캐시로 재분석하지 않는다.
                </Quote>
              </Card>

              {/* ══ C. 회귀 감시 xfail ════════════════════════════ */}
              <SectionLabel>회귀 감시 · xfail(strict)</SectionLabel>
              <Card stripe="info">
                <div className="flex items-start justify-between gap-2 mb-2.5">
                  <div className="text-[11px] text-[var(--tx-3)]">
                    XPASS로 뒤집히면 = 결함 수정됨 신호. 감시 목록은 /daily-qa SKILL.md가 원본,
                    대시보드는 상태만 비춘다.
                  </div>
                  <Pill tone="info">{data.xfailWatch.length}건</Pill>
                </div>
                <div className="flex flex-col gap-px rounded-[9px] border border-[var(--line)] overflow-hidden">
                  {data.xfailWatch.length === 0 ? (
                    <div className="px-3 py-2.5 bg-[var(--panel)] text-[11.5px] text-[var(--tx-3)]">
                      XPASS로 뒤집힌 감시 항목이 없습니다
                    </div>
                  ) : (
                    data.xfailWatch.map((x) => (
                      <div key={x.target} className="flex items-center gap-2.5 px-3 py-2.5 bg-[var(--panel)]">
                        <Pill tone="ok">XPASS</Pill>
                        <div className="flex-1 min-w-0">
                          <div className="font-mono text-[11.5px] text-[var(--tx-1)]">{x.target}</div>
                          {x.detail && <div className="text-[11px] text-[var(--tx-3)] mt-px">{x.detail}</div>}
                        </div>
                        {x.contractKey && <Pill tone="idle">{x.contractKey}</Pill>}
                      </div>
                    ))
                  )}
                </div>
              </Card>

              {/* ══ 7일 추이 · 환경 건강도 ══════════════════════════ */}
              <SectionLabel>7일 추이 · 환경 건강도</SectionLabel>
              <Card stripe={data.envHealth ? 'warn' : 'ok'}>
                <div className="flex items-start justify-between gap-3">
                  <div className="flex-1 min-w-0">
                    <div className="text-[11px] text-[var(--tx-3)] mb-1.5">통과율 추이 (최근 7일 · 러너 합산)</div>
                    <Sparkline points={data.trend} />
                    <div className="flex justify-between font-mono text-[9px] text-[var(--tx-4)] mt-1">
                      <span>{data.trend[0]?.day ?? ''}</span>
                      <span>{data.trend[data.trend.length - 1]?.day ?? ''}</span>
                    </div>
                  </div>
                  <div className="w-[220px] shrink-0">
                    <div className="flex items-center gap-1.5 mb-1.5">
                      <span className="text-[11px] font-[640] text-[var(--tx-1)]">환경 건강도</span>
                      <Pill tone={data.envHealth ? 'warn' : 'ok'}>{data.envHealth ? '위험' : '정상'}</Pill>
                    </div>
                    {data.envHealth ? (
                      <div className="text-[10.5px] leading-[1.6]" style={{ color: 'var(--tx-3)' }}>
                        <b style={{ color: TONE.warn.fg }}>{data.envHealth.title}</b>
                        {data.envHealth.detail && <div className="mt-0.5">{data.envHealth.detail}</div>}
                      </div>
                    ) : (
                      <div className="text-[10.5px] text-[var(--tx-3)]">최근 2일 환경 전제 실패 신호 없음.</div>
                    )}
                  </div>
                </div>
                <Quote tone="idle">
                  <b className="text-[var(--tx-3)]">env_health.py</b> — stage 리소스(차량 풀·잔존 경로) 상태. 고갈 시 그날 회귀가 통째로 무의미해져 P0로 다룬다.
                </Quote>
              </Card>

              {/* 다음 단계 안내 — 완료분/남은분을 흐리게 두지 않는다 */}
              <Card stripe="idle">
                <div className="text-[11px] text-[var(--tx-3)] leading-[1.9]">
                  <b style={{ color: TONE.ok.fg }}>✅ 구현됨</b>: 실패 일괄 분석(규칙→캐시→LLM 배치 1회) ·
                  실행 트리거(웹 Jenkins REST · API workflow_dispatch, 승인 게이트).<br />
                  <b className="text-[var(--tx-3)]">남은 것</b>: 조치 버튼 실동작 연결 · Slack 딥링크 · 앱 E2E 착수 블로커.
                </div>
              </Card>
            </>
          )}
        </div>
        </div>
      </div>

      {trig && <TriggerModal s={trig} onConfirm={() => void confirmTrigger()} onClose={() => setTrig(null)} />}

      {act && (
        <ActionModal
          s={act}
          onDeep={() => void deepAnalyze()}
          onPreviewBug={() => void previewBug()}
          onConfirmBug={() => void confirmBug()}
          onResolve={() => void resolveAction()}
          onProject={(p) => setAct((a) => (a ? { ...a, project: p } : a))}
          onBack={() => setAct((a) => (a ? { ...a, mode: 'menu', result: null } : a))}
          onRerun={() => {
            const runner = act.q.runner;
            setAct(null);
            if (runner === 'web' || runner === 'api') void openTrigger(runner, 'smoke');
          }}
          onClose={() => setAct(null)}
        />
      )}
    </div>
  );
}

// ─── 조치 모달 (수렴점) ───────────────────────────────────────────────
// 조치 버튼 → 여기서 버그 등록(Jira·게이트)·재실행(트리거로)·해소 처리로 라우팅.
// ①분석(신호 아래 표시)과 ②트리거(재실행)가 이 모달에서 만난다.
function ActionModal({
  s,
  onDeep,
  onPreviewBug,
  onConfirmBug,
  onResolve,
  onProject,
  onBack,
  onRerun,
  onClose,
}: {
  s: {
    q: QueueItem;
    mode: 'menu' | 'bug';
    draft: { summary: string; description: string; sections?: unknown; labels?: string[] } | null;
    deep: boolean;
    project: string;
    busy: boolean;
    result: string | null;
  };
  onDeep: () => void;
  onPreviewBug: () => void;
  onConfirmBug: () => void;
  onResolve: () => void;
  onProject: (p: string) => void;
  onBack: () => void;
  onRerun: () => void;
  onClose: () => void;
}) {
  const { q } = s;
  const canRerun = q.runner === 'web' || q.runner === 'api';
  const done = Boolean(s.result) && !s.busy && s.result?.startsWith('✅');
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: 'color-mix(in srgb, #000 55%, transparent)' }}>
      <div className="w-full max-w-lg max-h-[86vh] flex flex-col rounded-[13px] border overflow-hidden" style={{ background: 'var(--panel)', borderColor: 'var(--line)' }}>
        <div className="px-4 py-3 border-b flex items-center justify-between gap-2" style={{ borderColor: 'var(--line)' }}>
          <div className="min-w-0">
            <div className="text-[13px] font-[640] text-[var(--tx-1)] flex items-center gap-1.5">
              <Pill tone={q.tone}>{q.label}</Pill> 조치
            </div>
            <div className="font-mono text-[10.5px] text-[var(--accent)] mt-0.5 truncate">{q.contractKey ?? q.target}</div>
          </div>
          <span className="font-mono text-[10px] text-[var(--tx-4)] shrink-0">추천: {q.action}</span>
        </div>

        <div className="flex-1 overflow-y-auto p-4 flex flex-col gap-2.5">
          {/* 신호 + 분석 (①) */}
          <div className="text-[11.5px] leading-[1.7]" style={{ background: 'var(--inset)', padding: '8px 10px', borderRadius: 8, color: 'var(--tx-2)' }}>
            {(q.detail ?? '').replace(/^\[QA 작업\]\s*/, '') || '—'}
            {q.analysis && (
              <div className="mt-1.5 pl-2 border-l-2" style={{ borderColor: TONE.info.bd, color: 'var(--tx-3)' }}>
                <b style={{ color: TONE.info.fg }}>🔍 분석</b> {q.analysis}
              </div>
            )}
          </div>

          {s.mode === 'bug' && s.draft ? (
            <div className="flex flex-col gap-1.5">
              <div className="flex items-center gap-1.5">
                <span className="font-mono text-[9.5px] font-bold uppercase tracking-wider text-[var(--tx-4)]">등록될 버그 (미리보기)</span>
                <Pill tone={s.deep ? 'ok' : 'warn'}>{s.deep ? '🔬 심층 분석' : '얕은 초안 (원인 미확정)'}</Pill>
              </div>
              <div className="flex items-center gap-1.5">
                <span className="text-[10.5px] text-[var(--tx-3)]">보드</span>
                {['DV', 'QI', 'RV'].map((p) => (
                  <button key={p} onClick={() => onProject(p)}
                    className="font-mono text-[10px] font-bold px-2 py-[3px] rounded-full border"
                    style={s.project === p
                      ? { color: '#fff', background: 'var(--accent-deep)', borderColor: 'var(--accent-deep)' }
                      : { color: 'var(--tx-3)', background: 'var(--inset)', borderColor: 'var(--line-2)' }}>
                    {p}
                  </button>
                ))}
              </div>
              <div className="text-[12px] font-[600] text-[var(--tx-1)]">{s.draft.summary}</div>
              <pre className="text-[10.5px] whitespace-pre-wrap font-mono text-[var(--tx-3)] max-h-[28vh] overflow-y-auto" style={{ background: 'var(--inset)', padding: '8px 10px', borderRadius: 8 }}>{s.draft.description}</pre>
            </div>
          ) : (
            <div className="text-[11px] text-[var(--tx-3)]">
              아래에서 조치를 고르세요. <b className="text-[var(--tx-2)]">버그 등록</b>은 Jira 쓰기(승인 게이트),
              {canRerun ? ' 재실행은 CI 트리거로,' : ''} 코드/수동 처리 완료는 <b className="text-[var(--tx-2)]">해소 처리</b>로 큐에서 내립니다.
            </div>
          )}

          {s.result && <div className="text-[11.5px] font-[550]" style={{ color: 'var(--tx-1)' }}>{s.result}</div>}
        </div>

        <div className="flex items-center justify-between gap-2 px-4 py-3 border-t" style={{ borderColor: 'var(--line)' }}>
          <button onClick={onClose} className="px-3 py-1.5 rounded-[7px] border border-[var(--line-2)] bg-[var(--inset)] text-[var(--tx-2)] text-[11.5px] font-[640]">
            {done ? '닫기' : '취소'}
          </button>
          {!done && (
            <div className="flex gap-2">
              {s.mode === 'bug' ? (
                <>
                  <button onClick={onBack} disabled={s.busy} className="px-3 py-1.5 rounded-[7px] border border-[var(--line-2)] bg-[var(--inset)] text-[var(--tx-2)] text-[11.5px] font-[640] disabled:opacity-40">뒤로</button>
                  <button onClick={onConfirmBug} disabled={s.busy}
                    className="px-3.5 py-1.5 rounded-[7px] text-[11.5px] font-[640] border text-white disabled:opacity-40"
                    style={{ background: 'var(--crit)', borderColor: 'var(--crit)' }}>
                    {s.busy ? '등록 중…' : '버그 등록'}
                  </button>
                </>
              ) : (
                <>
                  <button onClick={() => void onResolve()} disabled={s.busy}
                    className="px-3 py-1.5 rounded-[7px] border text-[11.5px] font-[640] disabled:opacity-40"
                    style={{ borderColor: TONE.ok.bd, background: TONE.ok.bg, color: TONE.ok.fg }}>
                    ✓ 해소 처리
                  </button>
                  {canRerun && (
                    <button onClick={onRerun} disabled={s.busy}
                      className="px-3 py-1.5 rounded-[7px] border border-[var(--line-2)] bg-[var(--inset)] text-[var(--tx-2)] text-[11.5px] font-[640] disabled:opacity-40">
                      ⟳ 재실행
                    </button>
                  )}
                  <button onClick={onPreviewBug} disabled={s.busy}
                    className="px-3 py-1.5 rounded-[7px] border border-[var(--line-2)] bg-[var(--inset)] text-[var(--tx-3)] text-[11.5px] font-[640] disabled:opacity-40"
                    title="소스 분석 없이 얕은 초안(원인 미확정)으로 빠르게">
                    빠른 등록
                  </button>
                  <button onClick={onDeep} disabled={s.busy}
                    className="px-3.5 py-1.5 rounded-[7px] text-[11.5px] font-[640] border text-white disabled:opacity-40"
                    style={{ background: 'var(--accent-deep)', borderColor: 'var(--accent-deep)' }}
                    title="테스트 소스+제품 repo를 읽어 원인(코드)까지 채운다 (최대 1~2분)">
                    🔬 심층 분석 후 등록
                  </button>
                </>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── 조각 ─────────────────────────────────────────────────────────────

function AssetCard({
  a,
  trigger,
  onTrigger,
}: {
  a: Asset;
  trigger?: RunnerTrigger;
  onTrigger: (runner: string, tier: string) => void;
}) {
  const rate = a.total > 0 ? a.passed / a.total : 0;
  const tone: Tone = a.failed > 0 ? 'crit' : a.total === 0 ? 'idle' : 'ok';
  const t = TONE[tone];
  const [tier, setTier] = useState(trigger?.tiers[0] ?? '');
  return (
    <div
      className="rounded-[13px] border p-3.5"
      style={{ background: 'var(--panel)', borderColor: 'var(--line)', borderLeft: `3px solid ${t.fg}` }}
    >
      <div className="flex items-start justify-between gap-2.5 mb-1.5">
        <div className="text-[13px] font-[640] text-[var(--tx-1)]">{a.label}</div>
        <Pill tone={tone}>{a.failed > 0 ? `${a.failed} 실패` : a.total === 0 ? '데이터 없음' : '전건 통과'}</Pill>
      </div>
      <div className="font-mono text-[26px] font-[660] tracking-[-0.02em]" style={{ color: a.failed > 0 ? t.fg : 'var(--tx-1)' }}>
        {a.passed}
        <span className="text-[14px] text-[var(--tx-3)]"> / {a.total}</span>
      </div>
      {/* 스택 바 — 통과/실패/스킵 */}
      <div className="flex h-[8px] rounded-full overflow-hidden bg-[var(--inset)] mt-2.5">
        <div style={{ width: `${rate * 100}%`, background: TONE.ok.fg }} />
        <div style={{ width: `${a.total > 0 ? (a.failed / a.total) * 100 : 0}%`, background: TONE.crit.fg }} />
        <div style={{ width: `${a.total > 0 ? (a.skipped / a.total) * 100 : 0}%`, background: 'var(--line-2)' }} />
      </div>
      <div className="flex items-center justify-between gap-2 mt-2">
        <div className="font-mono text-[9.5px] text-[var(--tx-3)]">
          통과 {a.passed} · 실패 {a.failed} · 스킵 {a.skipped}
        </div>
        {/* ▶ 실행 트리거 — 기존 CI 인프라를 부른다(직접 실행 X). 앱은 tiers 비어 미노출 */}
        {trigger && trigger.tiers.length > 0 && (
          <div className="flex items-center gap-1.5 shrink-0">
            <select
              value={tier}
              onChange={(e) => setTier(e.target.value)}
              className="font-mono text-[10px] rounded-[6px] border border-[var(--line-2)] bg-[var(--inset)] text-[var(--tx-2)] px-1.5 py-1 outline-none"
              title={trigger.via}
            >
              {trigger.tiers.map((tr) => (
                <option key={tr} value={tr}>{tr}</option>
              ))}
            </select>
            <button
              onClick={() => onTrigger(a.runner, tier)}
              className="px-2.5 py-1 rounded-[6px] text-[10.5px] font-[640] border text-white"
              style={{ background: 'var(--accent-deep)', borderColor: 'var(--accent-deep)' }}
              title={`${trigger.via}로 트리거 (승인 게이트 후 실행)`}
            >
              ▶ 실행
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── 왼쪽 레일 — 자산 요약·판정 경로 범례 (시안: 카탈로그 요약) ──────────
function AutoRail({ data }: { data: Payload | null }) {
  return (
    <aside className="w-[212px] flex-shrink-0 bg-[var(--panel)] border-r border-[var(--line)] overflow-y-auto hidden lg:block">
      <div className="px-3 py-3 border-b border-[var(--line)]">
        <div className="font-mono text-[9.5px] font-semibold tracking-[0.1em] uppercase text-[var(--tx-4)]">
          자산 · 카탈로그
        </div>
      </div>
      <div className="p-2 flex flex-col gap-2">
        {/* 카탈로그 요약 */}
        <div className="px-2.5 py-2 rounded-md bg-[var(--inset)] border border-[var(--line)]">
          <div className="text-[10.5px] text-[var(--tx-3)]">카탈로그</div>
          <div className="font-mono text-[13px] font-[660] text-[var(--tx-1)] mt-0.5">
            {data?.catalog ? `${data.catalog.total}건` : '—'}
          </div>
          <div className="font-mono text-[9px] text-[var(--tx-4)] mt-0.5">
            생성 {data?.catalog?.generatedAt ?? '?'}
          </div>
        </div>
        {/* 러너별 자산 상태 */}
        {(data?.assets ?? []).map((a) => (
          <div key={a.runner} className="px-2.5 py-2 rounded-md bg-[var(--inset)] border border-[var(--line)]">
            <div className="flex items-center justify-between gap-1">
              <span className="text-[11px] text-[var(--tx-1)] font-medium">{a.label}</span>
              <span className="font-mono text-[10px]" style={{ color: a.failed > 0 ? TONE.crit.fg : TONE.ok.fg }}>
                {a.passed}/{a.total}
              </span>
            </div>
            {a.failed > 0 && (
              <div className="font-mono text-[9px] mt-0.5" style={{ color: TONE.crit.fg }}>실패 {a.failed}</div>
            )}
          </div>
        ))}
        {/* 판정 경로 범례 */}
        {data && (
          <div className="px-2.5 py-2 rounded-md bg-[var(--inset)] border border-[var(--line)]">
            <div className="text-[9.5px] font-mono uppercase tracking-wider text-[var(--tx-4)] mb-1.5">판정 경로</div>
            <div className="flex flex-col gap-1 text-[10px]">
              <div className="flex justify-between"><span style={{ color: TONE.ok.fg }}>규칙</span><span className="font-mono">{data.verdictTally.rule}</span></div>
              <div className="flex justify-between"><span style={{ color: TONE.idle.fg }}>캐시</span><span className="font-mono">{data.verdictTally.cache}</span></div>
              <div className="flex justify-between"><span style={{ color: TONE.info.fg }}>LLM</span><span className="font-mono">{data.verdictTally.llm}</span></div>
            </div>
          </div>
        )}
      </div>
      <div className="px-3 pb-4 text-[9px] font-mono text-[var(--tx-4)] leading-relaxed">
        /daily-qa 런북을 UI로. 매일 08:00 수집된 회귀 상태를 비춘다.
      </div>
    </aside>
  );
}

// ─── 실행 트리거 카드 — 직접 실행 X, 기존 CI 인프라를 부른다 ──────────────
function TriggerCard({
  triggers,
  onTrigger,
}: {
  triggers: RunnerTrigger[];
  onTrigger: (runner: string, tier: string) => void;
}) {
  const LABEL: Record<string, string> = { web: '웹', api: 'API', app: '앱' };
  return (
    <Card stripe="info">
      <div className="flex items-start justify-between gap-2.5 mb-2">
        <div>
          <div className="text-[13px] font-[640] text-[var(--tx-1)]">실행 트리거</div>
          <div className="text-[11px] text-[var(--tx-3)] mt-0.5">
            대시보드는 <b className="text-[var(--tx-2)]">직접 실행하지 않고 기존 인프라를 부른다</b> — 실행 환경을 다시 만들지 않는다
          </div>
        </div>
        <Pill tone="ok">동시 실행 방지 유지</Pill>
      </div>
      <div className="flex flex-col gap-px rounded-[9px] border border-[var(--line)] overflow-hidden">
        {triggers.map((t) => (
          <div key={t.runner} className="flex items-center gap-2.5 px-3 py-2.5 bg-[var(--panel)]">
            <span className="font-mono text-[11px] font-bold w-[32px] shrink-0" style={{ color: 'var(--accent)' }}>
              {LABEL[t.runner] ?? t.runner}
            </span>
            <div className="flex-1 min-w-0">
              <div className="text-[11.5px] text-[var(--tx-1)]">{t.via}</div>
              <div className="text-[10px] text-[var(--tx-3)] mt-px truncate">{t.note}</div>
            </div>
            <div className="flex items-center gap-1 shrink-0 flex-wrap justify-end">
              {t.tiers.length === 0 ? (
                <span className="font-mono text-[9.5px] text-[var(--tx-4)]">트리거 대상 아님</span>
              ) : (
                t.tiers.map((tier) => (
                  <button
                    key={tier}
                    onClick={() => onTrigger(t.runner, tier)}
                    disabled={!t.ready}
                    className="font-mono text-[10px] font-[640] px-2 py-1 rounded-[6px] border disabled:opacity-40"
                    style={{ color: t.ready ? '#fff' : 'var(--tx-4)', background: t.ready ? 'var(--accent-deep)' : 'var(--inset)', borderColor: t.ready ? 'var(--accent-deep)' : 'var(--line-2)' }}
                    title={t.ready ? `${t.via}로 ${tier} 트리거 (승인 게이트 후)` : t.note}
                  >
                    {tier}
                  </button>
                ))
              )}
            </div>
          </div>
        ))}
      </div>
      <Quote tone="info">
        <b style={{ color: TONE.info.fg }}>직접 pytest를 띄우지 않는 이유</b> —
        Jenkins의 <span className="font-mono">disableConcurrentBuilds()</span>가 stage 데이터 충돌을 막는다. 대시보드가 우회하면 야간 회귀와 겹쳐 데이터가 꼬인다.
      </Quote>
    </Card>
  );
}

// ─── 실행 트리거 승인 게이트 모달 ─────────────────────────────────────
// 외부 CI를 실제로 부르기 전 마지막 확인. [실행]을 눌러야 confirm=true로 트리거된다.
function TriggerModal({
  s,
  onConfirm,
  onClose,
}: {
  s: TriggerModalState;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const done = s.result && !s.running;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: 'color-mix(in srgb, #000 55%, transparent)' }}>
      <div className="w-full max-w-md rounded-[13px] border overflow-hidden" style={{ background: 'var(--panel)', borderColor: 'var(--line)' }}>
        <div className="px-4 py-3 border-b" style={{ borderColor: 'var(--line)' }}>
          <div className="text-[13px] font-[640] text-[var(--tx-1)]">▶ 실행 트리거 — 확인</div>
          <div className="text-[11px] text-[var(--tx-3)] mt-0.5">대시보드는 직접 실행하지 않고 기존 CI 인프라를 부릅니다</div>
        </div>
        <div className="p-4 flex flex-col gap-2.5">
          <div className="flex items-center gap-2 text-[12px]">
            <Pill tone="info">{s.via}</Pill>
            <span className="font-mono text-[var(--tx-1)]">{s.runner}</span>
            <span className="text-[var(--tx-3)]">TIER =</span>
            <span className="font-mono font-bold" style={{ color: TONE.info.fg }}>{s.tier}</span>
          </div>
          <div className="text-[11.5px] text-[var(--tx-2)]" style={{ background: 'var(--inset)', padding: '8px 10px', borderRadius: 8 }}>
            {s.message}
          </div>
          {!s.ready && (
            <div className="text-[11px]" style={{ color: TONE.warn.fg }}>⚠ {s.note}</div>
          )}
          {s.result && (
            <div className="text-[11.5px] font-[550]" style={{ color: 'var(--tx-1)' }}>{s.result}</div>
          )}
        </div>
        <div className="flex items-center justify-end gap-2 px-4 py-3 border-t" style={{ borderColor: 'var(--line)' }}>
          <button onClick={onClose} className="px-3 py-1.5 rounded-[7px] border border-[var(--line-2)] bg-[var(--inset)] text-[var(--tx-2)] text-[11.5px] font-[640]">
            {done ? '닫기' : '취소'}
          </button>
          {!done && (
            <button
              onClick={onConfirm}
              disabled={!s.ready || s.running}
              className="px-3.5 py-1.5 rounded-[7px] text-[11.5px] font-[640] border text-white disabled:opacity-40 disabled:cursor-not-allowed"
              style={{ background: 'var(--accent-deep)', borderColor: 'var(--accent-deep)' }}
            >
              {s.running ? '트리거 중…' : '실행'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function QueueRow({ q, onAction }: { q: QueueItem; onAction: (q: QueueItem) => void }) {
  return (
    <tr className="border-b border-[var(--line)] last:border-b-0 hover:bg-[var(--panel)]">
      <Td>
        <Pill tone={q.tone}>{q.label}</Pill>
      </Td>
      <Td>
        <div className="flex items-center gap-1.5">
          <span className="font-mono text-[10.5px] text-[var(--accent)]">{q.contractKey ?? q.target}</span>
          {q.fromWork && <Pill tone="info">QA 작업 인계</Pill>}
        </div>
      </Td>
      <Td>
        <span className="text-[var(--tx-2)]">{(q.detail ?? '').replace(/^\[QA 작업\]\s*/, '') || '—'}</span>
        {q.occurrences > 1 && (
          <span className="font-mono text-[9.5px] text-[var(--tx-3)]"> ×{q.occurrences}</span>
        )}
        {q.analysis && (
          <div
            className="mt-1 pl-2 text-[10.5px] border-l-2"
            style={{ borderColor: TONE.info.bd, color: 'var(--tx-3)' }}
            title={q.analyzedAt ? `LLM 분석 · ${q.analyzedAt.slice(0, 16)}` : 'LLM 분석'}
          >
            <b style={{ color: TONE.info.fg }}>🔍 분석</b> {q.analysis}
          </div>
        )}
      </Td>
      <Td>
        <Pill tone={q.verdict.tone as Tone}>{q.verdict.label}</Pill>
        <div className="font-mono text-[9.5px] text-[var(--tx-4)] mt-0.5">{q.verdict.how}</div>
      </Td>
      <Td mono>{q.runner}</Td>
      <Td>
        <button
          onClick={() => onAction(q)}
          className="px-2 py-1 rounded-[6px] border border-[var(--line-2)] bg-[var(--inset)] text-[var(--tx-2)] text-[10.5px] font-semibold hover:text-white hover:border-[var(--accent-deep)]"
          title="조치 — 버그 등록·재실행·해소 처리"
        >
          {q.action}
        </button>
      </Td>
    </tr>
  );
}

// ─── 통과율 스파크라인 (7일) ──────────────────────────────────────────
function Sparkline({ points }: { points: Array<{ day: string; rate: number; failed: number }> }) {
  if (points.length === 0) {
    return <div className="h-[48px] flex items-center text-[10px] text-[var(--tx-4)]">추이 데이터 없음</div>;
  }
  const W = 100, H = 40, pad = 2;
  const n = points.length;
  const x = (i: number) => (n === 1 ? W / 2 : pad + (i / (n - 1)) * (W - pad * 2));
  const y = (r: number) => H - pad - (r / 100) * (H - pad * 2);
  const line = points.map((p, i) => `${x(i)},${y(p.rate)}`).join(' ');
  const area = `${x(0)},${H} ${line} ${x(n - 1)},${H}`;
  const last = points[n - 1];
  const stroke = last.failed > 0 ? TONE.warn.fg : TONE.ok.fg;
  return (
    <div className="relative">
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="w-full h-[48px] block">
        <polygon points={area} fill={`color-mix(in srgb, ${stroke} 12%, transparent)`} />
        <polyline points={line} fill="none" stroke={stroke} strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
      </svg>
      <span className="absolute top-0 right-0 font-mono text-[11px] font-[660]" style={{ color: stroke }}>
        {last.rate}%
      </span>
    </div>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="font-mono text-[9.5px] font-semibold tracking-[0.1em] uppercase text-[var(--tx-4)] mt-1">
      {children}
    </div>
  );
}

function Card({ children, stripe }: { children: React.ReactNode; stripe?: Tone }) {
  return (
    <div
      className="rounded-[13px] border p-3.5"
      style={{
        background: 'var(--panel)',
        borderColor: 'var(--line)',
        ...(stripe ? { borderLeft: `3px solid ${TONE[stripe].fg}` } : {}),
      }}
    >
      {children}
    </div>
  );
}

function Pill({ tone, children }: { tone: Tone; children: React.ReactNode }) {
  const t = TONE[tone];
  return (
    <span
      className="inline-flex items-center px-[7px] py-[2px] rounded-full border font-mono text-[9.5px] font-bold whitespace-nowrap"
      style={{ color: t.fg, borderColor: t.bd, background: t.bg }}
    >
      {children}
    </span>
  );
}

function Quote({ children, tone }: { children: React.ReactNode; tone: Tone }) {
  return (
    <div className="mt-2.5 pl-2.5 text-[11.5px] border-l-2" style={{ borderColor: TONE[tone].bd, color: 'var(--tx-3)' }}>
      {children}
    </div>
  );
}

function Th({ children }: { children: React.ReactNode }) {
  return (
    <th className="sticky top-0 text-left px-2.5 py-2 font-mono text-[9.5px] font-bold tracking-[0.06em] uppercase whitespace-nowrap border-b border-[var(--line-2)] bg-[var(--inset)] text-[var(--tx-3)] z-10">
      {children}
    </th>
  );
}

function Td({ children, mono, colSpan }: { children: React.ReactNode; mono?: boolean; colSpan?: number }) {
  return (
    <td colSpan={colSpan} className={`px-2.5 py-2 align-top text-[var(--tx-3)] ${mono ? 'font-mono text-[10.5px]' : ''}`}>
      {children}
    </td>
  );
}
