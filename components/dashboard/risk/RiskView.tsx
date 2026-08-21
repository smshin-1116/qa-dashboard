'use client';

import { useEffect, useState } from 'react';
import DashboardHeader from '@/components/dashboard/header/DashboardHeader';
import type { AIModel } from '@/types/session';

/**
 * 리스크 (◈ 리스크 패턴) — qa-oracle DESIGN 흡수.
 * 개별 버그가 아니라 "이 제품이 반복적으로 틀리는 가정/방식"을 증거와 함께 축적한다.
 * 파이프라인: 이력 추출(LLM) → 사람이 confirmed/retired 확정 → (다음) PR 대조·수용률 루프.
 * 철칙: 증거 없으면 카드 없음.
 */

const TONE = {
  ok: { fg: 'var(--ok)', bd: 'color-mix(in srgb, var(--ok) 40%, transparent)', bg: 'color-mix(in srgb, var(--ok) 12%, transparent)' },
  info: { fg: 'var(--info)', bd: 'color-mix(in srgb, var(--info) 40%, transparent)', bg: 'color-mix(in srgb, var(--info) 12%, transparent)' },
  warn: { fg: 'var(--warn)', bd: 'color-mix(in srgb, var(--warn) 40%, transparent)', bg: 'color-mix(in srgb, var(--warn) 12%, transparent)' },
  crit: { fg: 'var(--crit)', bd: 'color-mix(in srgb, var(--crit) 40%, transparent)', bg: 'color-mix(in srgb, var(--crit) 12%, transparent)' },
  idle: { fg: 'var(--tx-4)', bd: 'var(--line-2)', bg: 'var(--inset)' },
} as const;
type Tone = keyof typeof TONE;
const SEV_TONE: Record<string, Tone> = { high: 'crit', medium: 'warn', low: 'idle' };

interface Pattern {
  id: number;
  ref: string | null;
  title: string;
  category: string | null;
  status: string;
  severity: string | null;
  symptom: string | null;
  rootAssumption: string | null;
  evidence: { jira_bugs?: string[]; occurrences?: number } | null;
  checkQuestions: string[];
  updatedAt: string;
}
interface Payload {
  confirmed: Pattern[];
  candidate: Pattern[];
  retired: Pattern[];
  stats: { confirmed: number; candidate: number; evidenceTotal: number; acceptanceRate: number | null; blockedPreDeploy: number | null };
}

export default function RiskView() {
  const [model, setModel] = useState<AIModel>('claude');
  const [data, setData] = useState<Payload | null>(null);
  const [loading, setLoading] = useState(true);
  const [extracting, setExtracting] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const reload = () =>
    fetch('/api/workspace/risk', { cache: 'no-store' })
      .then((r) => r.json() as Promise<Payload>)
      .then(setData);

  useEffect(() => {
    void reload().finally(() => setLoading(false));
  }, []);

  async function extract() {
    if (extracting) return;
    setExtracting(true);
    setMsg('버그 이력에서 패턴 추출 중… (LLM 1회, 최대 1분)');
    try {
      const res = await fetch('/api/workspace/risk', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'extract' }),
      });
      const b = (await res.json()) as { ok?: boolean; proposed?: number; skipped?: number; scanned?: number; error?: string };
      if (!b.ok) throw new Error(b.error ?? '추출 실패');
      await reload();
      setMsg(`버그 ${b.scanned}건 훑음 → 후보 ${b.proposed}건 제안` + (b.skipped ? ` · 증거부족·중복 ${b.skipped} 제외` : ''));
    } catch (e) {
      setMsg(`추출 실패 — ${e instanceof Error ? e.message : '알 수 없음'}`);
    } finally {
      setExtracting(false);
    }
  }

  async function curate(id: number, status: 'confirmed' | 'retired' | 'candidate') {
    await fetch('/api/workspace/risk', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'curate', id, status }),
    });
    await reload();
  }

  return (
    <div className="flex flex-col h-screen bg-[var(--ground)]">
      <DashboardHeader activeModel={model} onModelChange={setModel} activeWorkspaceKey="risk" />
      <div className="flex-1 min-h-0 overflow-y-auto">
        <div className="max-w-5xl mx-auto w-full p-4 flex flex-col gap-3.5">
          <div>
            <div className="font-mono text-[9.5px] font-semibold tracking-[0.1em] uppercase text-[var(--tx-4)]">
              qa-oracle DESIGN 흡수 · 증거 없으면 카드 아님
            </div>
            <h1 className="text-[19px] font-[680] tracking-[-0.02em] text-[var(--tx-1)] mt-1">리스크 패턴</h1>
            <p className="text-[12.5px] text-[var(--tx-3)] mt-0.5 max-w-[68ch]">
              개별 버그가 아니라 <b className="text-[var(--tx-3)]">이 제품이 반복적으로 틀리는 가정/방식</b>을 증거와 함께 축적한다.
              버그 이력에서 후보를 추출하고, 사람이 확정한다.
            </p>
          </div>

          {loading ? (
            <div className="text-[var(--tx-3)] text-sm py-10 text-center">불러오는 중…</div>
          ) : !data ? (
            <div className="text-[var(--tx-3)] text-sm py-10 text-center">데이터를 읽지 못했습니다</div>
          ) : (
            <>
              {/* 성과 지표 + 추출 트리거 */}
              <Card>
                <div className="flex items-center justify-between gap-3 flex-wrap">
                  <div className="flex items-center gap-4">
                    <Stat label="확정 패턴" value={String(data.stats.confirmed)} tone="crit" />
                    <Stat label="후보" value={String(data.stats.candidate)} tone="warn" />
                    <Stat label="근거 이력" value={String(data.stats.evidenceTotal)} tone="idle" />
                    <Stat label="개발자 수용률" value={data.stats.acceptanceRate == null ? '—' : `${data.stats.acceptanceRate}%`} tone="idle" sub="데이터 축적 전" />
                  </div>
                  <div className="text-right">
                    <button
                      onClick={() => void extract()}
                      disabled={extracting}
                      className="px-3 py-1.5 rounded-[7px] text-[11.5px] font-[640] border text-white disabled:opacity-40"
                      style={{ background: 'var(--accent-deep)', borderColor: 'var(--accent-deep)' }}
                      title="버그 이력을 LLM으로 훑어 후보 패턴을 제안합니다 (증거 2건 이상만)"
                    >
                      {extracting ? '추출 중…' : '패턴 추출'}
                    </button>
                    {msg && <div className="text-[10.5px] mt-1" style={{ color: extracting ? 'var(--tx-3)' : TONE.ok.fg }}>{msg}</div>}
                  </div>
                </div>
              </Card>

              {/* 확정 패턴 */}
              <SectionLabel>확정 패턴 (confirmed)</SectionLabel>
              {data.confirmed.length === 0 ? (
                <Card><div className="text-[12px] text-[var(--tx-3)]">확정된 패턴이 없습니다 — 후보를 검토해 확정하세요.</div></Card>
              ) : (
                data.confirmed.map((p) => <PatternCard key={p.id} p={p} onCurate={curate} confirmed />)
              )}

              {/* 후보 큐 */}
              <SectionLabel>후보 큐 — 사람이 확정한다 (candidate)</SectionLabel>
              {data.candidate.length === 0 ? (
                <Card><div className="text-[12px] text-[var(--tx-3)]">후보가 없습니다 — [패턴 추출]로 버그 이력에서 뽑아보세요.</div></Card>
              ) : (
                data.candidate.map((p) => <PatternCard key={p.id} p={p} onCurate={curate} />)
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function PatternCard({ p, onCurate, confirmed }: { p: Pattern; onCurate: (id: number, s: 'confirmed' | 'retired' | 'candidate') => void; confirmed?: boolean }) {
  const sev = (p.severity && SEV_TONE[p.severity]) || 'idle';
  const bugs = p.evidence?.jira_bugs ?? [];
  return (
    <div className="rounded-[13px] border p-3.5" style={{ background: 'var(--panel)', borderColor: 'var(--line)', borderLeft: `3px solid ${TONE[sev].fg}` }}>
      <div className="flex items-start justify-between gap-2.5 mb-1.5">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5 flex-wrap">
            {p.ref && <span className="font-mono text-[10px] font-bold" style={{ color: 'var(--accent)' }}>{p.ref}</span>}
            {p.severity && <Pill tone={sev}>{p.severity}</Pill>}
            {p.category && <Pill tone="idle">{p.category}</Pill>}
          </div>
          <div className="text-[13px] font-[640] text-[var(--tx-1)] mt-1">{p.title}</div>
        </div>
        <div className="flex gap-1.5 shrink-0">
          {confirmed ? (
            <button onClick={() => onCurate(p.id, 'retired')} className="px-2 py-1 rounded-[6px] border border-[var(--line-2)] bg-[var(--inset)] text-[var(--tx-3)] text-[10.5px] font-semibold">폐기</button>
          ) : (
            <>
              <button onClick={() => onCurate(p.id, 'retired')} className="px-2.5 py-1 rounded-[6px] border border-[var(--line-2)] bg-[var(--inset)] text-[var(--tx-3)] text-[10.5px] font-semibold">기각</button>
              <button onClick={() => onCurate(p.id, 'confirmed')} className="px-2.5 py-1 rounded-[6px] border text-white text-[10.5px] font-[640]" style={{ background: 'var(--accent-deep)', borderColor: 'var(--accent-deep)' }}>확정</button>
            </>
          )}
        </div>
      </div>
      {p.symptom && <Field label="증상" v={p.symptom} />}
      {p.rootAssumption && <Field label="근본 가정" v={p.rootAssumption} accent />}
      <div className="mt-1.5">
        <div className="font-mono text-[9px] uppercase tracking-wider text-[var(--tx-4)] mb-1">증거 {bugs.length}건</div>
        <div className="flex flex-wrap gap-1">
          {bugs.map((k) => (
            <a key={k} href={`https://wemeet2025.atlassian.net/browse/${k}`} target="_blank" rel="noreferrer"
              className="font-mono text-[10px] px-1.5 py-[2px] rounded border" style={{ color: 'var(--accent)', borderColor: 'var(--line-2)', background: 'var(--inset)' }}>
              {k}
            </a>
          ))}
        </div>
      </div>
      {p.checkQuestions.length > 0 && (
        <div className="mt-1.5">
          <div className="font-mono text-[9px] uppercase tracking-wider text-[var(--tx-4)] mb-1">PR에 물어볼 대조 질문</div>
          <ul className="text-[11px] text-[var(--tx-2)] leading-[1.7] list-disc pl-4">
            {p.checkQuestions.map((q, i) => <li key={i}>{q}</li>)}
          </ul>
        </div>
      )}
    </div>
  );
}

function Field({ label, v, accent }: { label: string; v: string; accent?: boolean }) {
  return (
    <div className="text-[11.5px] mt-1">
      <span className="font-mono text-[9px] uppercase tracking-wider text-[var(--tx-4)]">{label} </span>
      <span style={{ color: accent ? 'var(--tx-1)' : 'var(--tx-2)', fontWeight: accent ? 600 : 400 }}>{v}</span>
    </div>
  );
}
function Stat({ label, value, tone, sub }: { label: string; value: string; tone: Tone; sub?: string }) {
  return (
    <div>
      <div className="font-mono text-[20px] font-[660] leading-none" style={{ color: value === '—' ? 'var(--tx-4)' : TONE[tone].fg }}>{value}</div>
      <div className="text-[10px] text-[var(--tx-3)] mt-1">{label}</div>
      {sub && <div className="text-[8.5px] font-mono text-[var(--tx-4)]">{sub}</div>}
    </div>
  );
}
function SectionLabel({ children }: { children: React.ReactNode }) {
  return <div className="font-mono text-[9.5px] font-semibold tracking-[0.1em] uppercase text-[var(--tx-4)] mt-1">{children}</div>;
}
function Card({ children }: { children: React.ReactNode }) {
  return <div className="rounded-[13px] border p-3.5" style={{ background: 'var(--panel)', borderColor: 'var(--line)' }}>{children}</div>;
}
function Pill({ tone, children }: { tone: Tone; children: React.ReactNode }) {
  const t = TONE[tone];
  return <span className="inline-flex items-center px-[7px] py-[2px] rounded-full border font-mono text-[9.5px] font-bold whitespace-nowrap" style={{ color: t.fg, borderColor: t.bd, background: t.bg }}>{children}</span>;
}
