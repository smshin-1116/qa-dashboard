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
interface Payload {
  catalog: { total: number; generatedAt: string | null } | null;
  assets: Asset[];
  queue: QueueItem[];
  verdictTally: { rule: number; cache: number; llm: number };
  analysisStats: { needAnalysis: number; cached: number };
  xfailWatch: Array<{ target: string; detail: string | null; contractKey: string | null }>;
  handedFromWork: number;
}

export default function AutomationView() {
  const [model, setModel] = useState<AIModel>('claude');
  const [data, setData] = useState<Payload | null>(null);
  const [loading, setLoading] = useState(true);
  /** 실패 일괄 분석 진행/결과 */
  const [analyzing, setAnalyzing] = useState(false);
  const [analyzeMsg, setAnalyzeMsg] = useState<string | null>(null);

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

  return (
    <div className="flex flex-col h-screen bg-[var(--ground)]">
      <DashboardHeader activeModel={model} onModelChange={setModel} activeWorkspaceKey="auto" />

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
                  data.assets.map((a) => <AssetCard key={a.runner} a={a} />)
                )}
              </div>

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
                  {/* 판정 경로 집계 — 토큰이 어디서 드는지 (시안의 핵심 장치) */}
                  <div className="flex items-center gap-1.5 flex-shrink-0">
                    <Pill tone="ok">규칙 {data.verdictTally.rule}</Pill>
                    <Pill tone="idle">캐시 {data.verdictTally.cache}</Pill>
                    <Pill tone="info">LLM {data.verdictTally.llm}</Pill>
                  </div>
                </div>

                {/* 실패 일괄 분석 트리거 — 규칙이 못 가른/오래된 실패만 LLM 배치 1회. fingerprint 캐시 재사용 */}
                <div
                  className="flex items-center justify-between gap-3 px-3 py-2.5 mb-2.5 rounded-[9px] border"
                  style={{ borderColor: 'var(--line-2)', background: 'var(--inset)' }}
                >
                  <div className="text-[11.5px] text-[var(--tx-2)] min-w-0">
                    <b className="text-[var(--tx-1)]">실패 일괄 분석</b>{' '}
                    <span className="text-[var(--tx-3)]">
                      분석 대상 <b style={{ color: TONE.info.fg }}>{data.analysisStats.needAnalysis}</b>건 · 캐시 재사용{' '}
                      <b>{data.analysisStats.cached}</b>건 (LLM 배치 1회 · 도구 없음 · Sonnet)
                    </span>
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
                        data.queue.map((q) => <QueueRow key={q.id} q={q} />)
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
                <div className="text-[11px] text-[var(--tx-3)] mb-2.5">
                  XPASS로 뒤집히면 = 결함 수정됨 신호. 감시 목록은 /daily-qa SKILL.md가 원본,
                  대시보드는 상태만 비춘다.
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

              {/* 다음 단계 안내 — 만들 것을 흐리게 두지 않는다 */}
              <Card stripe="idle">
                <div className="text-[11px] text-[var(--tx-3)] leading-[1.9]">
                  <b className="text-[var(--tx-3)]">다음 단계</b> (실제 CI 호출·토큰이 걸려 별도 승인 후):
                  실행 트리거(웹 Jenkins REST · API workflow_dispatch) · 실패 일괄 분석(규칙→캐시→LLM 배치 1회) ·
                  Slack 딥링크 · 앱 E2E 착수 블로커.
                </div>
              </Card>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── 조각 ─────────────────────────────────────────────────────────────

function AssetCard({ a }: { a: Asset }) {
  const rate = a.total > 0 ? a.passed / a.total : 0;
  const tone: Tone = a.failed > 0 ? 'crit' : a.total === 0 ? 'idle' : 'ok';
  const t = TONE[tone];
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
      <div className="font-mono text-[9.5px] text-[var(--tx-3)] mt-2">
        통과 {a.passed} · 실패 {a.failed} · 스킵 {a.skipped}
      </div>
    </div>
  );
}

function QueueRow({ q }: { q: QueueItem }) {
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
          className="px-2 py-1 rounded-[6px] border border-[var(--line-2)] bg-[var(--inset)] text-[var(--tx-2)] text-[10.5px] font-semibold hover:text-white"
          title="다음 단계에서 실제 동작 연결 예정"
        >
          {q.action}
        </button>
      </Td>
    </tr>
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
