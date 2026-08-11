'use client';

import { useMemo, useState } from 'react';
import type { Contract, ContractDecision } from '@/lib/workspace/contract';

/**
 * ⓪ 소스 보드 · ① 교차 분석 · ② 확인 게이트 — 시안 1590~1782행이 사양이다.
 *
 * ── 게이트의 존재 이유 (시안) ─────────────────────────────────────────
 * "TC를 만들기 **전에** 멈춘다 — 처음이 잘못되면 뒤에서 감당할 비용이 훨씬 크다."
 * 모순 2건을 모르고 TC를 쓰면 TC 전체가 틀린 전제 위에 올라간다.
 *
 * ── 질문의 재료 ───────────────────────────────────────────────────────
 * conflicts → [필수] 어느 쪽을 따를지  ·  gaps → [선택] 범위에 넣을지
 * 필수가 다 답해져야 [답변 반영 → ③ 설계 진행]이 열린다.
 * [모순 무시하고 진행]은 항상 열려 있다 — 판단은 사람 몫이다.
 */

const C = {
  inset: '#0F1520',
  panel: '#161B27',
  line: '#1E2535',
  line2: '#2A3347',
  tx1: '#E8ECF5',
  tx2: '#A8B2C7',
  tx3: '#6C7891',
  tx4: '#4A5468',
  accent: '#818CF8',
  accentDeep: '#4F46E5',
  ok: '#34D399',
  info: '#60A5FA',
  warn: '#FBBF24',
  crit: '#F87171',
  /** Codex 담당 표시 — 시안의 --codex */
  codex: '#10A37F',
} as const;

export default function GatePanel({
  contract,
  engine,
  fallbackReason,
  busy,
  onProceed,
}: {
  contract: Contract | null;
  engine: 'codex' | 'fallback' | null;
  fallbackReason: string | null;
  busy: boolean;
  /** 게이트 통과 — 확정된 decisions와 함께 ③ 설계로 */
  onProceed: (decisions: ContractDecision[]) => void;
}) {
  /** 질문 키 → 선택한 답 */
  const [answers, setAnswers] = useState<Record<string, string>>({});

  /** 이미 통과한 게이트(저장된 decisions 있음)는 요약만 남긴다 */
  const decided = (contract?.decisions.length ?? 0) > 0;

  const questions = useMemo(() => {
    if (!contract) return [];
    const qs: Array<{
      key: string;
      required: boolean;
      text: string;
      options: string[];
    }> = [];
    for (const [i, cf] of contract.conflicts.entries()) {
      qs.push({
        key: `conflict-${i}`,
        required: true,
        text: cf.topic,
        // 어느 소스를 따를지 — 소스 이름이 곧 선택지다
        options: cf.sides.map((s) => s.source),
      });
    }
    for (const [i, g] of contract.gaps.entries()) {
      qs.push({
        key: `gap-${i}`,
        required: false,
        text: `"${g.text}"을(를) 이번 범위에 넣을까요?`,
        options: ['넣기', '빼기'],
      });
    }
    return qs;
  }, [contract]);

  const requiredLeft = questions.filter((q) => q.required && !answers[q.key]).length;

  if (!contract) {
    // 폴백 — 시안: "⓪①을 Claude가 처리하고 '분산 실패 · Claude 단독' 배지 표시 · 작업은 멈추지 않는다"
    if (engine === 'fallback') {
      return (
        <div
          className="rounded-[13px] border p-3.5"
          style={{ background: C.panel, borderColor: C.line, borderLeft: `3px solid ${C.warn}` }}
        >
          <div className="flex items-center gap-2">
            <Pill fg={C.warn}>분산 실패 · Claude 단독</Pill>
            <span className="text-[11.5px]" style={{ color: C.tx3 }}>
              ⓪①(Codex)이 실패해 분석을 Claude 대화로 진행한다 — 작업은 멈추지 않는다
            </span>
          </div>
          {fallbackReason && (
            <div className="font-mono text-[10px] mt-1.5" style={{ color: C.tx4 }}>
              {fallbackReason}
            </div>
          )}
        </div>
      );
    }
    return null;
  }

  function buildDecisions(ignore: boolean): ContractDecision[] {
    return questions
      .filter((q) => answers[q.key] || (ignore && q.required))
      .map((q) => ({
        question: q.text,
        answer: answers[q.key] ?? '미결 — 모순 무시하고 진행',
        decided_by: 'human' as const,
      }));
  }

  return (
    <div className="flex flex-col gap-3.5">
      {/* ══ ⓪ 소스 보드 ═══════════════════════════════════════════ */}
      <div className="rounded-[13px] border p-3.5" style={{ background: C.panel, borderColor: C.line }}>
        <div className="flex items-start justify-between gap-2.5 mb-2.5">
          <div>
            <div className="text-[13px] font-[640] flex items-center gap-1.5" style={{ color: C.tx1 }}>
              <Dot color={C.codex} /> ⓪ 소스 보드
            </div>
            <div className="text-[11px] mt-0.5" style={{ color: C.tx3 }}>
              Codex가 담당 · 소스별로 따로 읽어 구조화 — 다음 단계로 넘어가는 것은 요약뿐
            </div>
          </div>
          <div className="font-mono text-[10px] text-right" style={{ color: C.tx3 }}>
            소스 <b style={{ color: C.codex }}>{contract.sources.length}</b>
            {engine === 'codex' && (
              <>
                <br />
                <span style={{ color: C.tx4 }}>Codex 처리 · Claude 0</span>
              </>
            )}
          </div>
        </div>
        <div className="overflow-x-auto rounded-[9px] border" style={{ borderColor: C.line }}>
          <table className="w-full border-collapse text-[11.5px] min-w-[620px]">
            <thead>
              <tr>
                <Th>소스</Th>
                <Th>유형</Th>
                <Th>추출</Th>
                <Th>불명확</Th>
              </tr>
            </thead>
            <tbody>
              {contract.sources.map((s) => (
                <tr key={s.id} className="border-b last:border-b-0" style={{ borderColor: C.line }}>
                  <Td mono>
                    <span style={{ color: s.type === '버그' ? C.crit : C.accent }}>{s.id}</span>
                  </Td>
                  <Td>{s.type}</Td>
                  <Td>{s.summary}</Td>
                  <Td>
                    {s.unclear.length ? (
                      <span style={{ color: C.warn }}>{s.unclear.join(' · ')}</span>
                    ) : (
                      '—'
                    )}
                  </Td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* ══ ① 교차 분석 ═══════════════════════════════════════════ */}
      <div
        className="rounded-[13px] border p-3.5"
        style={{ background: C.panel, borderColor: C.line, borderLeft: `3px solid ${C.crit}` }}
      >
        <div className="mb-2.5">
          <div className="text-[13px] font-[640] flex items-center gap-1.5" style={{ color: C.tx1 }}>
            <Dot color={C.codex} /> ① 교차 분석
          </div>
          <div className="text-[11px] mt-0.5" style={{ color: C.tx3 }}>
            요약본끼리 대조 · <b style={{ color: C.tx2 }}>여기서 잡지 못하면 TC 전체가 틀린 전제 위에 올라간다</b>
          </div>
        </div>

        <div
          className="flex flex-col gap-px rounded-[9px] border overflow-hidden"
          style={{ background: C.line, borderColor: C.line }}
        >
          {contract.conflicts.map((cf, i) => (
            <Row
              key={`cf-${i}`}
              pill={<Pill fg={C.crit}>⚠ 모순</Pill>}
              title={cf.topic}
              sub={cf.sides
                .map((s) => `${s.source} "${s.claim}"${s.updated_at ? ` (${s.updated_at})` : ''}`)
                .join(' ↔ ')}
            />
          ))}
          {contract.duplicates.map((d, i) => (
            <Row
              key={`dup-${i}`}
              pill={<Pill fg={C.warn}>🔁 중복</Pill>}
              title={`같은 요구가 ${d.requirement_ids.length}건 중복`}
              sub={`${d.requirement_ids.join(' · ')} — TC는 1건으로 통합`}
            />
          ))}
          {contract.gaps.map((g, i) => (
            <Row
              key={`gap-${i}`}
              pill={<Pill fg={C.warn}>❓ 누락</Pill>}
              title={g.text}
              sub={`${g.mentioned_in}에만 있고 어디에도 안 잡힘 — 범위 누락인지 확인 필요`}
            />
          ))}
          {contract.impacts.tc_ids.length > 0 && (
            <Row
              pill={<Pill fg={C.info}>🔗 영향</Pill>}
              title={`기존 자동화 ${contract.impacts.tc_ids.length}건이 영향권`}
              sub={contract.impacts.tc_ids.join(' · ')}
            />
          )}
          {contract.conflicts.length === 0 &&
            contract.duplicates.length === 0 &&
            contract.gaps.length === 0 && (
              <Row
                pill={<Pill fg={C.ok}>✓</Pill>}
                title="모순·중복·누락 없음"
                sub="소스들이 같은 말을 한다 — 게이트를 바로 통과할 수 있다"
              />
            )}
        </div>
      </div>

      {/* ══ ② 확인 게이트 ═════════════════════════════════════════ */}
      <div
        className="rounded-[13px] border p-3.5"
        style={{ background: C.panel, borderColor: C.line, borderLeft: `3px solid ${C.warn}` }}
      >
        <div className="flex items-start justify-between gap-2.5 mb-2.5">
          <div>
            <div className="text-[13px] font-[640]" style={{ color: C.tx1 }}>
              ② 확인 게이트
            </div>
            <div className="text-[11px] mt-0.5" style={{ color: C.tx3 }}>
              TC를 만들기 <b style={{ color: C.tx2 }}>전에</b> 멈춘다 — 처음이 잘못되면 뒤에서 감당할
              비용이 훨씬 크다
            </div>
          </div>
          {decided ? (
            <Pill fg={C.ok}>전제 {contract.decisions.length}건 고정</Pill>
          ) : requiredLeft > 0 ? (
            <Pill fg={C.warn}>응답 대기 {requiredLeft}</Pill>
          ) : (
            <Pill fg={C.ok}>진행 가능</Pill>
          )}
        </div>

        {decided ? (
          /* 이미 통과 — 고정된 전제를 요약으로 남긴다 (산출물에 "이 전제로 작성됨" 명시) */
          <div className="flex flex-col gap-1.5">
            {contract.decisions.map((d, i) => (
              <div key={i} className="text-[11.5px]" style={{ color: C.tx3 }}>
                <span style={{ color: C.tx4 }}>전제 {i + 1}.</span>{' '}
                <span style={{ color: C.tx2 }}>{d.question}</span>
                {' → '}
                <b style={{ color: C.ok }}>{d.answer}</b>
              </div>
            ))}
          </div>
        ) : (
          <>
            <div className="text-[12.5px] mb-2" style={{ color: C.tx2 }}>
              소스 <b className="font-mono">{contract.sources.length}</b>개에서 요구{' '}
              <b className="font-mono">{contract.requirements.length}</b>건을 뽑았고, 그중{' '}
              <b style={{ color: C.crit }}>
                모순 {contract.conflicts.length}건 · 누락 {contract.gaps.length}건
              </b>
              이 있습니다.
            </div>

            <div className="flex flex-col gap-1.5">
              {questions.map((q) => (
                <div key={q.key} className="flex items-center gap-2.5">
                  <Pill fg={q.required ? C.crit : C.warn}>{q.required ? '필수' : '선택'}</Pill>
                  <span className="flex-1 text-[12px]" style={{ color: C.tx2 }}>
                    {q.text}
                  </span>
                  <div className="flex gap-1.5">
                    {q.options.map((opt) => (
                      <button
                        key={opt}
                        onClick={() =>
                          setAnswers((p) => ({
                            ...p,
                            [q.key]: p[q.key] === opt ? '' : opt,
                          }))
                        }
                        className="px-2.5 py-1 rounded-[6px] border text-[10.5px] font-semibold transition-colors"
                        style={
                          answers[q.key] === opt
                            ? { background: C.accentDeep, borderColor: C.accentDeep, color: '#fff' }
                            : { background: C.inset, borderColor: C.line2, color: C.tx2 }
                        }
                      >
                        {opt}
                      </button>
                    ))}
                  </div>
                </div>
              ))}
            </div>

            <div className="flex gap-1.5 mt-3 justify-end">
              <button
                onClick={() => onProceed(buildDecisions(true))}
                disabled={busy}
                className="px-2.5 py-1 rounded-[6px] border text-[10.5px] font-semibold disabled:opacity-40"
                style={{ background: C.inset, borderColor: C.line2, color: C.tx2 }}
              >
                모순 무시하고 진행
              </button>
              <button
                onClick={() => onProceed(buildDecisions(false))}
                disabled={busy || requiredLeft > 0}
                title={requiredLeft > 0 ? `필수 질문 ${requiredLeft}건이 남았습니다` : undefined}
                className="px-2.5 py-1 rounded-[6px] border text-[10.5px] font-semibold text-white
                           disabled:opacity-40 disabled:cursor-not-allowed"
                style={{ background: C.accentDeep, borderColor: C.accentDeep }}
              >
                답변 반영 → ③ 설계 진행
              </button>
            </div>

            <div
              className="mt-2.5 pl-2.5 text-[11.5px] border-l-2"
              style={{ borderColor: C.accentDeep, color: C.tx3 }}
            >
              여기서 답한 내용이 <b style={{ color: C.tx2 }}>전제로 고정되어</b> 이후 TC 전 단계에
              적용된다. 산출물에는 &quot;이 전제로 작성됨&quot;이 명시된다.
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// ─── 조각 ─────────────────────────────────────────────────────────────

function Dot({ color }: { color: string }) {
  return <span className="inline-block w-1.5 h-1.5 rounded-full" style={{ background: color }} />;
}

function Pill({ fg, children }: { fg: string; children: React.ReactNode }) {
  return (
    <span
      className="inline-flex items-center gap-1 px-[7px] py-[2px] rounded-full border
                 font-mono text-[9.5px] font-bold tracking-[.03em] whitespace-nowrap"
      style={{ color: fg, borderColor: `${fg}66`, background: `${fg}1c` }}
    >
      {children}
    </span>
  );
}

function Row({ pill, title, sub }: { pill: React.ReactNode; title: string; sub: string }) {
  return (
    <div className="flex items-center gap-2.5 px-3 py-2.5" style={{ background: C.panel }}>
      {pill}
      <div className="flex-1 min-w-0">
        <div className="text-[12.5px] font-[550]" style={{ color: C.tx1 }}>
          {title}
        </div>
        <div className="text-[11px] mt-px" style={{ color: C.tx3 }}>
          {sub}
        </div>
      </div>
    </div>
  );
}

function Th({ children }: { children: React.ReactNode }) {
  return (
    <th
      className="text-left px-2.5 py-2 font-mono text-[9.5px] font-bold tracking-[0.06em]
                 uppercase whitespace-nowrap border-b"
      style={{ background: C.inset, color: C.tx3, borderColor: C.line2 }}
    >
      {children}
    </th>
  );
}

function Td({ children, mono }: { children: React.ReactNode; mono?: boolean }) {
  return (
    <td
      className={`px-2.5 py-2 align-top ${mono ? 'font-mono text-[10.5px] whitespace-nowrap' : ''}`}
      style={{ color: C.tx2 }}
    >
      {children}
    </td>
  );
}
