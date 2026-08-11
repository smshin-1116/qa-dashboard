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

const TONE = {
  ok: { fg: '#34D399', bd: '#34D39966', bg: '#34D39920' },
  info: { fg: '#60A5FA', bd: '#60A5FA66', bg: '#60A5FA20' },
  warn: { fg: '#FBBF24', bd: '#FBBF2466', bg: '#FBBF2420' },
  crit: { fg: '#F87171', bd: '#F8717166', bg: '#F8717120' },
  idle: { fg: '#6C7891', bd: '#2A3347', bg: '#0F1520' },
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
  fromWork: boolean;
  lastSeen: string;
}
interface Payload {
  catalog: { total: number; generatedAt: string | null } | null;
  assets: Asset[];
  queue: QueueItem[];
  verdictTally: { rule: number; cache: number; llm: number };
  xfailWatch: Array<{ target: string; detail: string | null; contractKey: string | null }>;
  handedFromWork: number;
}

export default function AutomationView() {
  const [model, setModel] = useState<AIModel>('claude');
  const [data, setData] = useState<Payload | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    void fetch('/api/workspace/automation', { cache: 'no-store' })
      .then((r) => r.json() as Promise<Payload>)
      .then(setData)
      .finally(() => setLoading(false));
  }, []);

  return (
    <div className="flex flex-col h-screen bg-[#0B0F17]">
      <DashboardHeader activeModel={model} onModelChange={setModel} activeWorkspaceKey="auto" />

      <div className="flex-1 min-h-0 overflow-y-auto">
        <div className="max-w-6xl mx-auto w-full p-4 flex flex-col gap-3.5">
          {/* 헤더 라벨 */}
          <div>
            <div className="font-mono text-[9.5px] font-semibold tracking-[0.1em] uppercase text-[#4A5468]">
              ㉯ 자산 · 영구 — 만든 검증을 지키는 곳
            </div>
            <h1 className="text-[19px] font-[680] tracking-[-0.02em] text-slate-100 mt-1">
              테스트 자동화
            </h1>
            <p className="text-[12.5px] text-slate-500 mt-0.5 max-w-[68ch]">
              자동화 카탈로그(자산)와 그 상태(회귀 결과)를 한 화면에서 본다. QA 작업이 넘긴
              커버 공백 신호를 받는 쪽 — <b className="text-slate-400">/daily-qa 런북을 UI로</b>.
            </p>
          </div>

          {loading ? (
            <div className="text-slate-500 text-sm py-10 text-center">불러오는 중…</div>
          ) : !data ? (
            <div className="text-slate-500 text-sm py-10 text-center">데이터를 읽지 못했습니다</div>
          ) : (
            <>
              {/* ══ A. 자산 현황 ══════════════════════════════════ */}
              <SectionLabel>
                자산 현황
                {data.catalog && (
                  <span className="font-mono text-[10px] text-slate-500 ml-1.5 normal-case tracking-normal">
                    카탈로그 {data.catalog.total}건 · 생성 {data.catalog.generatedAt ?? '?'}
                  </span>
                )}
              </SectionLabel>
              <div className="grid gap-2.5" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))' }}>
                {data.assets.length === 0 ? (
                  <Card>
                    <div className="text-[12px] text-slate-500">
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
                    <div className="text-[13px] font-[640] text-slate-100">
                      실패·공백 {data.queue.length}건
                    </div>
                    <div className="text-[11px] text-slate-500 mt-0.5">
                      /daily-qa 5유형 + summarize 4유형을 <b className="text-slate-400">6종으로 통합</b> ·
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

                {data.handedFromWork > 0 && (
                  <div
                    className="flex items-center gap-2 px-3 py-2 mb-2.5 rounded-[9px] border text-[11.5px]"
                    style={{ borderColor: TONE.info.bd, background: TONE.info.bg, color: TONE.info.fg }}
                  >
                    QA 작업에서 넘어온 커버 공백 <b>{data.handedFromWork}건</b> — 아래 표에 출처 배지로 표시
                  </div>
                )}

                <div className="overflow-x-auto rounded-[9px] border border-[#1E2535]">
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
                            <span className="text-slate-500">열린 실패·공백이 없습니다 — 회귀 전건 통과</span>
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
                <div className="text-[11px] text-slate-500 mb-2.5">
                  XPASS로 뒤집히면 = 결함 수정됨 신호. 감시 목록은 /daily-qa SKILL.md가 원본,
                  대시보드는 상태만 비춘다.
                </div>
                <div className="flex flex-col gap-px rounded-[9px] border border-[#1E2535] overflow-hidden">
                  {data.xfailWatch.length === 0 ? (
                    <div className="px-3 py-2.5 bg-[#161B27] text-[11.5px] text-slate-500">
                      XPASS로 뒤집힌 감시 항목이 없습니다
                    </div>
                  ) : (
                    data.xfailWatch.map((x) => (
                      <div key={x.target} className="flex items-center gap-2.5 px-3 py-2.5 bg-[#161B27]">
                        <Pill tone="ok">XPASS</Pill>
                        <div className="flex-1 min-w-0">
                          <div className="font-mono text-[11.5px] text-slate-200">{x.target}</div>
                          {x.detail && <div className="text-[11px] text-slate-500 mt-px">{x.detail}</div>}
                        </div>
                        {x.contractKey && <Pill tone="idle">{x.contractKey}</Pill>}
                      </div>
                    ))
                  )}
                </div>
              </Card>

              {/* 다음 단계 안내 — 만들 것을 흐리게 두지 않는다 */}
              <Card stripe="idle">
                <div className="text-[11px] text-slate-500 leading-[1.9]">
                  <b className="text-slate-400">다음 단계</b> (실제 CI 호출·토큰이 걸려 별도 승인 후):
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
      style={{ background: '#161B27', borderColor: '#1E2535', borderLeft: `3px solid ${t.fg}` }}
    >
      <div className="flex items-start justify-between gap-2.5 mb-1.5">
        <div className="text-[13px] font-[640] text-slate-100">{a.label}</div>
        <Pill tone={tone}>{a.failed > 0 ? `${a.failed} 실패` : a.total === 0 ? '데이터 없음' : '전건 통과'}</Pill>
      </div>
      <div className="font-mono text-[26px] font-[660] tracking-[-0.02em]" style={{ color: a.failed > 0 ? t.fg : '#E8ECF5' }}>
        {a.passed}
        <span className="text-[14px] text-slate-500"> / {a.total}</span>
      </div>
      {/* 스택 바 — 통과/실패/스킵 */}
      <div className="flex h-[8px] rounded-full overflow-hidden bg-[#0F1520] mt-2.5">
        <div style={{ width: `${rate * 100}%`, background: TONE.ok.fg }} />
        <div style={{ width: `${a.total > 0 ? (a.failed / a.total) * 100 : 0}%`, background: TONE.crit.fg }} />
        <div style={{ width: `${a.total > 0 ? (a.skipped / a.total) * 100 : 0}%`, background: '#2A3347' }} />
      </div>
      <div className="font-mono text-[9.5px] text-slate-500 mt-2">
        통과 {a.passed} · 실패 {a.failed} · 스킵 {a.skipped}
      </div>
    </div>
  );
}

function QueueRow({ q }: { q: QueueItem }) {
  return (
    <tr className="border-b border-[#1E2535] last:border-b-0 hover:bg-[#161B27]">
      <Td>
        <Pill tone={q.tone}>{q.label}</Pill>
      </Td>
      <Td>
        <div className="flex items-center gap-1.5">
          <span className="font-mono text-[10.5px] text-indigo-400">{q.contractKey ?? q.target}</span>
          {q.fromWork && <Pill tone="info">QA 작업 인계</Pill>}
        </div>
      </Td>
      <Td>
        <span className="text-slate-300">{(q.detail ?? '').replace(/^\[QA 작업\]\s*/, '') || '—'}</span>
        {q.occurrences > 1 && (
          <span className="font-mono text-[9.5px] text-slate-500"> ×{q.occurrences}</span>
        )}
      </Td>
      <Td>
        <Pill tone={q.verdict.tone as Tone}>{q.verdict.label}</Pill>
        <div className="font-mono text-[9.5px] text-slate-600 mt-0.5">{q.verdict.how}</div>
      </Td>
      <Td mono>{q.runner}</Td>
      <Td>
        <button
          className="px-2 py-1 rounded-[6px] border border-[#2A3347] bg-[#0F1520] text-slate-300 text-[10.5px] font-semibold hover:text-white"
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
    <div className="font-mono text-[9.5px] font-semibold tracking-[0.1em] uppercase text-[#4A5468] mt-1">
      {children}
    </div>
  );
}

function Card({ children, stripe }: { children: React.ReactNode; stripe?: Tone }) {
  return (
    <div
      className="rounded-[13px] border p-3.5"
      style={{
        background: '#161B27',
        borderColor: '#1E2535',
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
    <div className="mt-2.5 pl-2.5 text-[11.5px] border-l-2" style={{ borderColor: TONE[tone].bd, color: '#6C7891' }}>
      {children}
    </div>
  );
}

function Th({ children }: { children: React.ReactNode }) {
  return (
    <th className="sticky top-0 text-left px-2.5 py-2 font-mono text-[9.5px] font-bold tracking-[0.06em] uppercase whitespace-nowrap border-b border-[#2A3347] bg-[#0F1520] text-slate-500 z-10">
      {children}
    </th>
  );
}

function Td({ children, mono, colSpan }: { children: React.ReactNode; mono?: boolean; colSpan?: number }) {
  return (
    <td colSpan={colSpan} className={`px-2.5 py-2 align-top text-slate-400 ${mono ? 'font-mono text-[10.5px]' : ''}`}>
      {children}
    </td>
  );
}
