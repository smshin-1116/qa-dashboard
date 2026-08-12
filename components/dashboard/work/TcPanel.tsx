'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Session } from '@/types/session';

/**
 * QA 작업 — 시안 "③~⑥ TC 작성 · ⑦ 수행" + "작업 종료" 카드.
 *
 * ⚠️ 이 컴포넌트는 **시안(`qa-oracle/docs/workspace-prototype.html` 1855~2057행)이 사양이다.**
 * 카드 구성·행 순서·문구를 임의로 줄이지 않는다. 프로토타입은 이 단계에서
 * "화면이 달라지는 사고"를 막으려고 만든 것이라, 바꿔야 할 이유가 생기면
 * 코드가 아니라 시안을 먼저 고치고 논의한다.
 *
 * 카드 구성 (위에서 아래로, 시안 순서 그대로)
 *   1. 헤더 — 제목 + 부제 + [XLSX][Sheets][티켓 코멘트]
 *   2. 기존 자동화 대조 행 — "이미 자동화돼 있다" + [자동화 탭에서 보기]
 *   3. TC 표 — TC-ID · 중분류 · 검증단계 · 전제조건 · 스텝 · 기대결과 · (가변) · 결과
 *   4. 인계 행 — 넘길 TC + 카탈로그 번호 매핑 미리보기 + [넘기기 N건]
 *   5. 작업 종료 카드 — 이력/코멘트/상태전이 + 코멘트 미리보기 + [작업 종료]
 *
 * 시안이 "이번에 안 만드는 것"으로 못 박은 ⓪흡수·①교차분석·②확인게이트는
 * 여기 없다. 그건 다음 단계다.
 */

// ─── 시안 토큰 (dark) ─────────────────────────────────────────────────
const C = {
  inset: 'var(--inset)',
  panel: 'var(--panel)',
  panelHi: 'var(--panel-hi)',
  line: 'var(--line)',
  line2: 'var(--line-2)',
  tx1: 'var(--tx-1)',
  tx2: 'var(--tx-2)',
  tx3: 'var(--tx-3)',
  tx4: 'var(--tx-4)',
  accent: 'var(--accent)',
  accentDeep: 'var(--accent-deep)',
  accentBg: 'var(--accent-bg)',
  ok: 'var(--ok)',
  info: 'var(--info)',
  warn: 'var(--warn)',
  crit: 'var(--crit)',
} as const;

type Tone = 'ok' | 'info' | 'warn' | 'crit' | 'idle';
const TONE_FG: Record<Tone, string> = {
  ok: C.ok,
  info: C.info,
  warn: C.warn,
  crit: C.crit,
  idle: C.tx4,
};

/** 수행 결과 4종 — Blocked는 "검증을 시도했으나 못 한 것"(명세 미정의 등) */
const RESULTS = ['Not Test', 'Pass', 'Fail', 'Blocked'] as const;
type Result = (typeof RESULTS)[number];

const RESULT_TONE: Record<Result, Tone> = {
  Pass: 'ok',
  Fail: 'crit',
  Blocked: 'warn',
  'Not Test': 'idle',
};
/** 시안: 정상=idle · 부정=warn · 예외=crit */
const PHASE_TONE: Record<string, Tone> = { 정상: 'idle', 부정: 'warn', 예외: 'crit' };

// ─── 타입 ─────────────────────────────────────────────────────────────

export interface Tc {
  id: number;
  localId: string;
  catalogId: string | null;
  verdict: 'new' | 'covered' | 'stale' | null;
  matchedCatalogId: string | null;
  matchReason: string | null;
  category: string | null;
  subCategory: string | null;
  detailCategory: string | null;
  phase: string | null;
  precondition: string | null;
  steps: string | null;
  expected: string | null;
  platform: string | null;
  result: Result;
  note: string | null;
  testRef: string[];
  handedOffAt: string | null;
  /** 11컬럼 밖의 값 (`계정 역할` 등) — 티켓마다 달라 컬럼을 고정하지 않았다 */
  extra: Record<string, string> | null;
}

interface Crosscheck {
  catalogTotal: number;
  generatedAt: string | null;
  hits: Array<{
    /** 이 카탈로그 항목과 겹친 TC들 — 여러 TC가 같은 항목을 물 수 있다 */
    localIds: string[];
    catalogId: string;
    title: string;
    impl: string;
    tier: string;
    score: number;
  }>;
}

interface CandidateItem {
  id: number;
  localId: string;
  summary: string;
  group: {
    section: string;
    prefix: string | null;
    total: number;
    candidates: Array<{ id: string; title: string; impl: string; tier: string; score: number }>;
  } | null;
}

interface PreviewItem {
  id: number;
  localId: string;
  catalogId: string | null;
}

interface ClosePreview {
  keys: string[];
  comment: string;
  status: string;
}

// ─── 본체 ─────────────────────────────────────────────────────────────

export default function TcPanel({
  session,
  refreshKey = 0,
  onDownloadXlsx,
  onRunTc,
  running = false,
}: {
  session: Session | null;
  /** 저장이 끝났을 때 바뀌는 값 — 목록을 다시 읽는 트리거 */
  refreshKey?: number;
  onDownloadXlsx: () => void;
  /** 선택 TC를 Claude(Playwright)로 자동 수행 — 결과는 부모가 파싱해 기입한다 */
  onRunTc?: (
    tcs: Array<{
      localId: string;
      subCategory: string | null;
      phase: string | null;
      precondition: string | null;
      steps: string | null;
      expected: string | null;
    }>,
  ) => Promise<void>;
  /** 수행/스트리밍 중 — 버튼 비활성 */
  running?: boolean;
}) {
  const sessionId = session?.id ?? null;

  const [tcs, setTcs] = useState<Tc[]>([]);
  const [crosscheck, setCrosscheck] = useState<Crosscheck | null>(null);
  const [picked, setPicked] = useState<Set<number>>(new Set());
  const [preview, setPreview] = useState<PreviewItem[]>([]);
  const [modal, setModal] = useState<CandidateItem[] | null>(null);
  const [catalogNote, setCatalogNote] = useState<string | null>(null);
  /** TC id → 중복으로 지목한 카탈로그 ID */
  const [dupes, setDupes] = useState<Record<number, string | null>>({});
  const [closing, setClosing] = useState<ClosePreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [flash, setFlash] = useState<{ tone: Tone; text: string } | null>(null);

  const load = useCallback(async () => {
    if (!sessionId) return;
    const res = await fetch(`/api/workspace/tc?sessionId=${encodeURIComponent(sessionId)}`, {
      cache: 'no-store',
    });
    const body = (await res.json()) as { tcs: Tc[]; crosscheck: Crosscheck | null };
    setTcs(body.tcs ?? []);
    setCrosscheck(body.crosscheck ?? null);
  }, [sessionId]);

  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  /**
   * 선택이 바뀔 때마다 "넘기면 몇 번을 받는가"를 미리 계산한다.
   * 시안의 인계 행이 `TC-01 → ROUTE-014`를 **누르기 전에** 보여주기 때문이다.
   * 번호는 선택 조합에 따라 순차 증가하므로 클라이언트가 혼자 못 정한다.
   */
  useEffect(() => {
    if (!sessionId || picked.size === 0) {
      setPreview([]);
      return;
    }
    let alive = true;
    void fetch('/api/workspace/tc', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'preview', sessionId, ids: [...picked] }),
    })
      .then((r) => r.json() as Promise<{ items: PreviewItem[] }>)
      .then((b) => {
        if (alive) setPreview(b.items ?? []);
      })
      .catch(() => {
        if (alive) setPreview([]);
      });
    return () => {
      alive = false;
    };
  }, [picked, sessionId]);

  const say = (tone: Tone, text: string) => {
    setFlash({ tone, text });
    setTimeout(() => setFlash(null), 7000);
  };

  /** 선택(picked) 또는 전체 TC를 자동 수행에 넘긴다 */
  function runTc(scope: 'picked' | 'all') {
    if (!onRunTc) return;
    const targets = scope === 'all' ? tcs : tcs.filter((t) => picked.has(t.id));
    if (targets.length === 0) return;
    void onRunTc(
      targets.map((t) => ({
        localId: t.localId,
        subCategory: t.subCategory,
        phase: t.phase,
        precondition: t.precondition,
        steps: t.steps,
        expected: t.expected,
      })),
    );
  }

  async function setResult(tc: Tc, result: Result) {
    const prevResult = tc.result;
    // 낙관적 갱신 — 반응은 즉시, 단 저장 실패 시 되돌린다
    setTcs((prev) => prev.map((t) => (t.id === tc.id ? { ...t, result } : t)));
    try {
      const res = await fetch('/api/workspace/tc', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'result', id: tc.id, result }),
      });
      if (!res.ok) throw new Error(`저장 실패 (${res.status})`);
    } catch (e) {
      /**
       * 조용한 실패 금지 — 저장이 안 됐는데 화면만 바뀌면, 새로고침 때
       * 옛 값으로 되돌아가 "왜 결과가 사라졌지"가 된다 (2026-08-11 실측).
       * 낙관값을 되돌리고 사람에게 알려, 저장된 것과 화면이 어긋나지 않게 한다.
       */
      setTcs((prev) => prev.map((t) => (t.id === tc.id ? { ...t, result: prevResult } : t)));
      say('crit', `${tc.localId} 결과 저장 실패 — ${e instanceof Error ? e.message : '알 수 없음'}. 다시 시도해주세요`);
    }
  }

  async function openHandoff() {
    if (!sessionId || picked.size === 0) return;
    setBusy(true);
    try {
      const res = await fetch('/api/workspace/tc', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'candidates', sessionId, ids: [...picked] }),
      });
      const body = (await res.json()) as {
        catalogAvailable: boolean;
        note?: string;
        catalogTotal?: number;
        generatedAt?: string;
        items: CandidateItem[];
      };
      setCatalogNote(
        body.catalogAvailable
          ? `자동화 카탈로그 ${body.catalogTotal}건 · 생성 ${body.generatedAt ?? '?'}`
          : (body.note ?? '카탈로그를 읽지 못했습니다'),
      );
      setDupes({});
      setModal(body.items);
    } finally {
      setBusy(false);
    }
  }

  async function confirmHandoff() {
    if (!sessionId || !modal) return;
    setBusy(true);
    try {
      const res = await fetch('/api/workspace/tc', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'handoff',
          sessionId,
          items: modal.map((m) => ({ id: m.id, duplicateOf: dupes[m.id] ?? null })),
        }),
      });
      const body = (await res.json()) as {
        handed: Array<{ localId: string; catalogId: string | null }>;
        markedDuplicate: number;
      };
      const txt = body.handed
        .map((h) => `${h.localId}${h.catalogId ? ` → ${h.catalogId}` : ''}`)
        .join(' · ');
      say(
        'ok',
        `${body.handed.length}건 인계${txt ? ` (${txt})` : ''}` +
          (body.markedDuplicate ? ` · 중복 ${body.markedDuplicate}건 제외` : ''),
      );
      setModal(null);
      setPicked(new Set());
      await load();
    } finally {
      setBusy(false);
    }
  }

  /** 작업 종료 — 미리보기부터. 등록은 사람이 한 번 더 눌러야 한다 */
  async function openClose() {
    if (!sessionId) return;
    setBusy(true);
    try {
      // 티켓 키는 제목만으로 놓치는 게 많다 — 대화 본문을 힌트로 같이 보낸다
      const hintText = (session?.messages ?? [])
        .map((m) => m.content)
        .join('\n')
        .slice(0, 20000);
      const res = await fetch('/api/workspace/tc', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'close-preview', sessionId, hintText }),
      });
      setClosing((await res.json()) as ClosePreview);
    } finally {
      setBusy(false);
    }
  }

  async function confirmClose() {
    if (!sessionId || !closing) return;
    setBusy(true);
    try {
      const res = await fetch('/api/workspace/tc', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'close',
          sessionId,
          keys: closing.keys,
          body: closing.comment,
        }),
      });
      const body = (await res.json()) as {
        ok: boolean;
        results: Array<{ key: string; ok: boolean; error?: string }>;
      };
      const failed = body.results.filter((r) => !r.ok);
      if (failed.length) {
        // 조용한 실패 금지 — 어느 티켓이 왜 막혔는지 그대로 드러낸다
        say('crit', `코멘트 실패 ${failed.length}건 — ${failed.map((f) => `${f.key}: ${f.error}`).join(' / ')}`);
      } else {
        say('ok', `작업 종료 · 코멘트 ${body.results.length}건 등록 (상태 전이는 Jira에서 직접)`);
      }
      setClosing(null);
      await load();
    } finally {
      setBusy(false);
    }
  }

  /**
   * 가변 컬럼 — 이번 작업의 TC들이 실제로 쓴 추가 헤더만 열로 만든다.
   * 티켓에 따라 `계정 역할`·`요금제`처럼 필요한 축이 달라 11컬럼으로 못 박지 않았다
   * (2026-08-06 결정). 등장 순서를 유지해야 원본 표와 같은 순서로 보인다.
   */
  const extraCols = useMemo(() => {
    const out: string[] = [];
    for (const t of tcs) {
      for (const k of Object.keys(t.extra ?? {})) if (!out.includes(k)) out.push(k);
    }
    return out;
  }, [tcs]);

  if (!sessionId || tcs.length === 0) return null;

  const selectable = tcs.filter((t) => !t.handedOffAt && t.verdict !== 'covered');
  const pickedTcs = tcs.filter((t) => picked.has(t.id));
  const excluded = tcs.filter((t) => !picked.has(t.id) && !t.handedOffAt);

  return (
    // 부모(QA 작업 페이지)가 스크롤을 소유한다 — 여기는 카드 나열만
    <div className="flex flex-col gap-3">
      {flash && (
        <div
          className="px-3 py-2 rounded-[9px] border text-[11.5px]"
          style={{
            borderColor: `color-mix(in srgb, ${TONE_FG[flash.tone]} 40%, transparent)`,
            background: `color-mix(in srgb, ${TONE_FG[flash.tone]} 11%, transparent)`,
            color: TONE_FG[flash.tone],
          }}
        >
          {flash.text}
        </div>
      )}

      {/* ══ 카드 1 — ③~⑥ TC 작성 · ⑦ 수행 ══════════════════════════ */}
      <Card>
        <div className="flex items-start justify-between gap-2.5 mb-2.5">
          <div>
            <div
              className="text-[13px] font-[640] tracking-[-0.01em]"
              style={{ color: C.tx1 }}
            >
              ③~⑥ TC 작성 · ⑦ 수행
            </div>
            <div className="text-[11px] mt-0.5" style={{ color: C.tx3 }}>
              컬럼은 <b style={{ color: C.tx2 }}>고정 11개가 아니라 상황에 맞게</b> · 수행은{' '}
              <b style={{ color: C.tx2 }}>[수행] 버튼으로 stage 자동 실행</b> 또는 결과 직접 기입
            </div>
          </div>
          <div className="flex gap-1.5 flex-shrink-0">
            {onRunTc && (
              <>
                <Btn
                  pri
                  onClick={() => runTc('picked')}
                  disabled={running || picked.size === 0}
                  title="체크한 TC를 Playwright로 stage에서 자동 수행"
                >
                  {running ? '수행 중…' : `▶ 선택 수행${picked.size ? ` ${picked.size}` : ''}`}
                </Btn>
                <Btn
                  onClick={() => runTc('all')}
                  disabled={running || tcs.length === 0}
                  title="전체 TC를 stage에서 자동 수행"
                >
                  전체 수행
                </Btn>
              </>
            )}
            <Btn onClick={onDownloadXlsx}>XLSX</Btn>
            <Btn onClick={() => void openClose()} disabled={busy}>
              티켓 코멘트
            </Btn>
          </div>
        </div>

        {/* ── 기존 자동화 대조 — 헛일 방지 ─────────────────────────── */}
        {crosscheck && crosscheck.hits.length > 0 && (
          <div
            className="flex items-center gap-2.5 px-3 py-2.5 mb-2.5 rounded-[9px] border"
            style={{ borderColor: C.line, background: C.inset }}
          >
            <Pill tone="ok">기존 자동화 대조</Pill>
            <div className="flex-1 min-w-0">
              <div className="text-[12px] font-[550]" style={{ color: C.tx1 }}>
                {crosscheck.hits.slice(0, 2).map((h, i) => (
                  <span key={h.catalogId}>
                    {i > 0 && <span style={{ color: C.tx4 }}> · </span>}
                    <span className="font-mono" style={{ color: C.ok }}>
                      {h.catalogId} {h.title}
                    </span>
                  </span>
                ))}
                <span style={{ color: C.tx2 }}> 가 이미 자동화돼 있다</span>
                <span className="font-mono text-[10.5px]" style={{ color: C.tx4 }}>
                  {' '}
                  ({crosscheck.hits[0].tier})
                </span>
              </div>
              <div className="text-[11px] mt-px" style={{ color: C.tx3 }}>
                {/* 어느 TC가 걸렸는지 밝힌다 — 안 그러면 5건 중 뭘 봐야 할지 모른다 */}
                <span className="font-mono" style={{ color: C.tx2 }}>
                  {crosscheck.hits[0].localIds.join(' · ')}
                </span>{' '}
                과 겹침 · 정책이 바뀌면 이 TC의 기대결과도 낡는다 →{' '}
                <b style={{ color: C.warn }}>테스트 자동화 탭에 갱신 항목으로 등록</b>
                {crosscheck.hits.length > 2 && (
                  <span style={{ color: C.tx4 }}> · 외 {crosscheck.hits.length - 2}건</span>
                )}
              </div>
            </div>
            <Btn
              onClick={() =>
                say(
                  'info',
                  `테스트 자동화 탭은 아직 없다 — 구현 위치: ${crosscheck.hits[0].impl}`,
                )
              }
            >
              자동화 탭에서 보기
            </Btn>
          </div>
        )}

        {/* ── TC 표 ───────────────────────────────────────────────── */}
        <div
          className="overflow-x-auto rounded-[9px] border"
          style={{ borderColor: C.line, maxHeight: '46vh', overflowY: 'auto' }}
        >
          <table className="w-full border-collapse text-[11.5px] min-w-[860px]">
            <thead>
              <tr>
                <Th w={32}>
                  <input
                    type="checkbox"
                    aria-label="전체 선택"
                    checked={selectable.length > 0 && picked.size === selectable.length}
                    onChange={(e) =>
                      setPicked(e.target.checked ? new Set(selectable.map((t) => t.id)) : new Set())
                    }
                    className="align-middle accent-indigo-600"
                  />
                </Th>
                <Th>TC-ID</Th>
                <Th>중분류</Th>
                <Th>검증단계</Th>
                <Th>전제조건</Th>
                <Th>테스트 스텝</Th>
                <Th>기대결과</Th>
                {extraCols.map((c) => (
                  <Th key={c}>{c}</Th>
                ))}
                <Th>결과</Th>
                <Th>자동화</Th>
              </tr>
            </thead>
            <tbody>
              {tcs.map((t) => {
                const locked = Boolean(t.handedOffAt) || t.verdict === 'covered';
                return (
                  <tr
                    key={t.id}
                    className="border-b last:border-b-0"
                    style={{ borderColor: C.line }}
                  >
                    <Td>
                      <input
                        type="checkbox"
                        aria-label={`${t.localId} 선택`}
                        disabled={locked}
                        checked={picked.has(t.id)}
                        onChange={(e) => {
                          const next = new Set(picked);
                          if (e.target.checked) next.add(t.id);
                          else next.delete(t.id);
                          setPicked(next);
                        }}
                        className="align-middle accent-indigo-600 disabled:opacity-30"
                      />
                    </Td>
                    <Td mono>
                      <span style={{ color: C.accent }}>{t.localId}</span>
                    </Td>
                    <Td>{t.subCategory ?? '—'}</Td>
                    <Td>
                      {t.phase ? (
                        <Pill tone={PHASE_TONE[t.phase] ?? 'idle'}>{t.phase}</Pill>
                      ) : (
                        '—'
                      )}
                    </Td>
                    <Td>{t.precondition ?? '—'}</Td>
                    <Td>{t.steps ?? '—'}</Td>
                    <Td>{t.expected ?? '—'}</Td>
                    {extraCols.map((c) => (
                      <Td key={c}>{t.extra?.[c] || '—'}</Td>
                    ))}
                    <Td>
                      {/* 완료 판정은 사람이 넣는다 — 자동 판정하지 않는다 */}
                      <select
                        value={t.result}
                        onChange={(e) => void setResult(t, e.target.value as Result)}
                        aria-label={`${t.localId} 수행 결과`}
                        className="rounded-full px-1.5 py-[1px] text-[9.5px] font-bold font-mono outline-none cursor-pointer border"
                        style={{
                          color: TONE_FG[RESULT_TONE[t.result]],
                          borderColor: `color-mix(in srgb, ${TONE_FG[RESULT_TONE[t.result]]} 40%, transparent)`,
                          background: `color-mix(in srgb, ${TONE_FG[RESULT_TONE[t.result]]} 11%, transparent)`,
                        }}
                      >
                        {RESULTS.map((r) => (
                          <option key={r} value={r} style={{ background: C.inset, color: C.tx2 }}>
                            {r}
                          </option>
                        ))}
                      </select>
                    </Td>
                    <Td>
                      {t.handedOffAt ? (
                        <Pill tone="info">{t.catalogId ?? '인계됨'}</Pill>
                      ) : t.verdict === 'covered' ? (
                        <span title={t.matchReason ?? undefined}>
                          <Pill tone="ok">중복 {t.matchedCatalogId ?? ''}</Pill>
                        </span>
                      ) : (
                        <span style={{ color: C.tx4 }}>—</span>
                      )}
                    </Td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {/* ── 인계점 — ID 매핑을 명시 ─────────────────────────────── */}
        <div
          className="flex items-center gap-2.5 px-3 py-2.5 mt-2.5 rounded-[9px] border"
          style={{ borderColor: C.accentDeep, background: C.accentBg }}
        >
          <span
            className="font-mono text-[9.5px] font-bold px-[5px] py-[1.5px] rounded whitespace-nowrap border"
            style={{ background: C.accentBg, borderColor: C.accentDeep, color: C.accent }}
          >
            인계
          </span>
          <div className="flex-1 min-w-0">
            <div className="text-[12px] font-[550]" style={{ color: C.accent }}>
              자동화 후보로 넘기기
              {pickedTcs.length > 0 && (
                <> — {pickedTcs.map((t) => t.localId).join(' · ')}</>
              )}
            </div>
            <div className="text-[11px] mt-px" style={{ color: C.tx3 }}>
              {pickedTcs.length === 0 ? (
                <>
                  반복 검증 가치가 있는 TC를 골라 체크한다 —{' '}
                  <b style={{ color: C.tx2 }}>여기서 만든 TC는 기본적으로 일회성</b>이고, 넘긴
                  것만 영구 자산이 된다
                </>
              ) : (
                <>
                  넘길 때 카탈로그 번호를 받는다 —{' '}
                  {preview.length > 0 ? (
                    preview.map((p, i) => (
                      <span key={p.id} className="font-mono">
                        {i > 0 && ' · '}
                        {p.localId} → {p.catalogId ?? '번호 미정'}
                      </span>
                    ))
                  ) : (
                    <span style={{ color: C.tx4 }}>번호 계산 중…</span>
                  )}
                  {excluded.length > 0 && (
                    <>
                      <br />
                      <span style={{ color: C.tx4 }}>
                        {excluded.map((t) => `${t.localId}(${t.result})`).join(' · ')}는 제외 — 안
                        넘긴 TC는 카탈로그 번호를 낭비하지 않는다
                      </span>
                    </>
                  )}
                </>
              )}
            </div>
          </div>
          <Btn pri onClick={() => void openHandoff()} disabled={picked.size === 0 || busy}>
            넘기기 {picked.size}건
          </Btn>
        </div>

        {/* ══ 카드 2 — 작업 종료 ═══════════════════════════════════ */}
        <CloseCard
          tcs={tcs}
          busy={busy}
          closing={closing}
          onOpen={() => void openClose()}
          onChange={(comment) => setClosing((c) => (c ? { ...c, comment } : c))}
          onCancel={() => setClosing(null)}
          onConfirm={() => void confirmClose()}
        />

        <div
          className="mt-2.5 pl-2.5 text-[11.5px] border-l-2"
          style={{ borderColor: C.accentDeep, color: C.tx3 }}
        >
          <b style={{ color: C.tx2 }}>여기서 만든 TC는 이 티켓과 함께 끝난다.</b> 영구 자산으로
          남길 것만 골라 넘기고, 나머지는 xlsx·티켓 코멘트로 산출하고 종료. 이 경계가 없으면
          일회성 TC가 자동화 카탈로그를 오염시킨다.
        </div>
      </Card>

      {modal && (
        <HandoffModal
          items={modal}
          note={catalogNote}
          dupes={dupes}
          busy={busy}
          onPick={(tcId, catalogId) => setDupes((p) => ({ ...p, [tcId]: catalogId }))}
          onCancel={() => setModal(null)}
          onConfirm={() => void confirmHandoff()}
        />
      )}
    </div>
  );
}

// ─── 작업 종료 카드 ───────────────────────────────────────────────────

function CloseCard({
  tcs,
  busy,
  closing,
  onOpen,
  onChange,
  onCancel,
  onConfirm,
}: {
  tcs: Tc[];
  busy: boolean;
  closing: ClosePreview | null;
  onOpen: () => void;
  onChange: (comment: string) => void;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const done = closing?.status === 'done';
  const handed = tcs.filter((t) => t.handedOffAt).length;
  const executed = tcs.filter((t) => t.result !== 'Not Test').length;

  return (
    <div
      className="mt-2.5 rounded-[13px] border p-3.5"
      style={{ background: C.panel, borderColor: C.line, borderLeft: `3px solid ${C.ok}` }}
    >
      <div className="flex items-start justify-between gap-2.5 mb-2.5">
        <div>
          <div className="text-[13px] font-[640]" style={{ color: C.tx1 }}>
            작업 종료
          </div>
          <div className="text-[11px] mt-0.5" style={{ color: C.tx3 }}>
            이력 보관 + 티켓 코멘트 자동 · <b style={{ color: C.tx2 }}>상태 전이는 사람이 직접</b>
          </div>
        </div>
        <Pill tone={done ? 'ok' : executed > 0 ? 'ok' : 'idle'}>
          {done ? '종료됨' : executed > 0 ? '준비됨' : '수행 전'}
        </Pill>
      </div>

      <div
        className="flex flex-col gap-px rounded-[9px] border overflow-hidden mb-2.5"
        style={{ background: C.line, borderColor: C.line }}
      >
        <CloseRow tone="ok" label="자동" title="작업 이력 보관">
          TC {tcs.length} · 수행 {executed} · 인계 {handed}건 — 좌측 세션 목록에서 다시 열람
        </CloseRow>
        <CloseRow tone="ok" label="자동" title="티켓에 결과 코멘트 등록">
          {closing ? (
            closing.keys.length > 0 ? (
              <>
                관련 티켓 <b className="font-mono">{closing.keys.length}</b>건 —{' '}
                <span className="font-mono" style={{ color: C.accent }}>
                  {closing.keys.join(' · ')}
                </span>
              </>
            ) : (
              <span style={{ color: C.warn }}>
                대화·제목에서 티켓 키를 찾지 못했다 — 코멘트 없이 종료된다
              </span>
            )
          ) : (
            '대화와 제목에서 티켓 키를 찾아 전건에 등록한다'
          )}
        </CloseRow>
        <CloseRow tone="idle" label="수동" title="티켓 상태 전이">
          대시보드가 건드리지 않는다 — <b style={{ color: C.tx2 }}>Jira에서 직접</b>
          <span style={{ color: C.tx4 }}> (오늘 탭의 &quot;완료 전이는 사람 승인&quot; 원칙과 동일)</span>
        </CloseRow>
      </div>

      {!closing ? (
        <div className="flex justify-end">
          <Btn onClick={onOpen} disabled={busy}>
            등록될 코멘트 미리보기
          </Btn>
        </div>
      ) : (
        <>
          <div
            className="font-mono text-[9.5px] font-semibold tracking-[0.1em] uppercase mb-1.5"
            style={{ color: C.tx4 }}
          >
            등록될 코멘트 미리보기
          </div>
          {editing ? (
            <textarea
              value={closing.comment}
              onChange={(e) => onChange(e.target.value)}
              rows={12}
              className="w-full rounded-r-[6px] px-3 py-2 text-[11.5px] leading-[1.8] outline-none resize-y border-l-2"
              style={{ background: C.inset, borderColor: C.ok, color: C.tx2 }}
            />
          ) : (
            <pre
              className="whitespace-pre-wrap px-3 py-2 text-[11.5px] leading-[1.8] rounded-r-[6px] border-l-2 font-sans"
              style={{ background: C.inset, borderColor: C.ok, color: C.tx2 }}
            >
              {closing.comment}
            </pre>
          )}
          <div className="flex gap-1.5 mt-2.5 justify-end">
            <Btn onClick={onCancel} disabled={busy}>
              닫기
            </Btn>
            <Btn onClick={() => setEditing((v) => !v)} disabled={busy}>
              {editing ? '수정 완료' : '코멘트 수정'}
            </Btn>
            <Btn pri onClick={onConfirm} disabled={busy}>
              {busy
                ? '등록 중…'
                : `작업 종료 · 코멘트 ${closing.keys.length}건 등록`}
            </Btn>
          </div>
          <div
            className="mt-2.5 pl-2.5 text-[11.5px] border-l-2"
            style={{ borderColor: C.accentDeep, color: C.tx3 }}
          >
            수행 결과와 인계 번호가 코멘트에 남는다 — 나중에{' '}
            <b style={{ color: C.tx2 }}>&quot;왜 이렇게 검증했나&quot;를 티켓만 봐도 알 수 있다</b>.
          </div>
        </>
      )}
    </div>
  );
}

function CloseRow({
  tone,
  label,
  title,
  children,
}: {
  tone: Tone;
  label: string;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-center gap-2.5 px-3 py-2.5" style={{ background: C.panel }}>
      <Pill tone={tone}>{label}</Pill>
      <div className="flex-1 min-w-0">
        <div className="text-[12.5px] font-[550]" style={{ color: C.tx1 }}>
          {title}
        </div>
        <div className="text-[11px] mt-px" style={{ color: C.tx3 }}>
          {children}
        </div>
      </div>
    </div>
  );
}

// ─── 넘기기 모달 — 중복 확인 ──────────────────────────────────────────

function HandoffModal({
  items,
  note,
  dupes,
  busy,
  onPick,
  onCancel,
  onConfirm,
}: {
  items: CandidateItem[];
  note: string | null;
  dupes: Record<number, string | null>;
  busy: boolean;
  onPick: (tcId: number, catalogId: string | null) => void;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const handing = items.filter((i) => !dupes[i.id]).length;

  return (
    <div
      className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-6"
      role="dialog"
      aria-modal="true"
    >
      <div
        className="rounded-[13px] border w-full max-w-[880px] max-h-[84vh] flex flex-col"
        style={{ background: C.panel, borderColor: C.line2 }}
      >
        <div className="px-5 py-3.5 border-b" style={{ borderColor: C.line }}>
          <div className="text-[14px] font-[640]" style={{ color: C.tx1 }}>
            자동화 후보 확인
          </div>
          <div className="text-[11.5px] mt-0.5" style={{ color: C.tx3 }}>
            이미 자동화된 것과 겹치지 않는지 확인한다. 애매하면 그냥 넘겨도 된다 —{' '}
            <b style={{ color: C.tx2 }}>중복이면 유지보수 큐에서 빼면 된다</b>.
          </div>
          {note && (
            <div className="font-mono text-[10px] mt-1" style={{ color: C.tx4 }}>
              {note}
            </div>
          )}
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-3.5 flex flex-col gap-3.5">
          {items.map((it) => {
            const dup = dupes[it.id] ?? null;
            return (
              <div
                key={it.id}
                className="rounded-[9px] border overflow-hidden"
                style={{ borderColor: C.line }}
              >
                <div
                  className="px-3.5 py-2.5 flex items-start gap-2.5"
                  style={{ background: C.inset }}
                >
                  <span className="font-mono text-[11.5px] font-bold" style={{ color: C.accent }}>
                    {it.localId}
                  </span>
                  <span className="text-[12px] flex-1" style={{ color: C.tx2 }}>
                    {it.summary}
                  </span>
                  {dup ? <Pill tone="ok">중복 {dup}</Pill> : <Pill tone="info">신규로 넘김</Pill>}
                </div>

                {it.group ? (
                  <div className="px-3.5 py-2.5">
                    <div className="text-[10px] font-mono mb-1.5" style={{ color: C.tx4 }}>
                      {it.group.section}
                      {it.group.prefix ? `(${it.group.prefix})` : ''} {it.group.total}건 · 유사도 순
                    </div>
                    <div
                      className="flex flex-col gap-px border rounded overflow-hidden max-h-[190px] overflow-y-auto"
                      style={{ background: C.line, borderColor: C.line }}
                    >
                      <CandRow
                        active={dup === null}
                        onClick={() => onPick(it.id, null)}
                        score={null}
                        id="—"
                        title="해당 없음 — 신규로 넘긴다"
                        impl=""
                      />
                      {it.group.candidates.map((c) => (
                        <CandRow
                          key={c.id}
                          active={dup === c.id}
                          onClick={() => onPick(it.id, dup === c.id ? null : c.id)}
                          score={c.score}
                          id={c.id}
                          title={c.title}
                          impl={c.impl}
                        />
                      ))}
                    </div>
                  </div>
                ) : (
                  <div className="px-3.5 py-2.5 text-[11.5px]" style={{ color: C.tx3 }}>
                    카탈로그를 읽지 못해 중복 확인을 건너뜁니다 — 그대로 넘길 수 있습니다.
                  </div>
                )}
              </div>
            );
          })}
        </div>

        <div className="px-5 py-3 border-t flex items-center gap-2" style={{ borderColor: C.line }}>
          <span className="text-[11.5px]" style={{ color: C.tx3 }}>
            {handing}건 넘김
            {items.length - handing > 0 ? ` · ${items.length - handing}건 중복 제외` : ''}
          </span>
          <div className="ml-auto flex gap-1.5">
            <Btn onClick={onCancel} disabled={busy}>
              취소
            </Btn>
            <Btn pri onClick={onConfirm} disabled={busy}>
              {busy ? '처리 중…' : `넘기기 ${handing}건`}
            </Btn>
          </div>
        </div>
      </div>
    </div>
  );
}

function CandRow({
  active,
  onClick,
  score,
  id,
  title,
  impl,
}: {
  active: boolean;
  onClick: () => void;
  score: number | null;
  id: string;
  title: string;
  impl: string;
}) {
  return (
    <button
      onClick={onClick}
      className="flex items-center gap-2.5 px-2.5 py-1.5 text-left transition-colors"
      style={{ background: active ? C.accentBg : C.panel }}
    >
      <span
        className="w-[38px] text-right font-mono text-[10px] font-bold"
        style={{
          color:
            score === null ? C.tx4 : score >= 70 ? C.ok : score >= 40 ? C.warn : C.tx4,
        }}
      >
        {score === null ? '—' : `${score}%`}
      </span>
      <span className="font-mono text-[10.5px] w-[76px]" style={{ color: C.tx2 }}>
        {id === '—' ? '' : id}
      </span>
      <span className="text-[11.5px] flex-1 truncate" style={{ color: C.tx2 }}>
        {title}
      </span>
      <span
        className="font-mono text-[9.5px] truncate max-w-[240px]"
        style={{ color: C.tx4 }}
      >
        {impl}
      </span>
    </button>
  );
}

// ─── 시안 조각 ────────────────────────────────────────────────────────

function Card({ children }: { children: React.ReactNode }) {
  return (
    <div
      className="rounded-[13px] border p-3.5"
      style={{ background: C.panel, borderColor: C.line }}
    >
      {children}
    </div>
  );
}

function Btn({
  children,
  onClick,
  disabled,
  pri,
  title,
}: {
  children: React.ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  pri?: boolean;
  title?: string;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={title}
      className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-[6px] border text-[10.5px] font-semibold
                 transition-colors disabled:opacity-40 disabled:cursor-not-allowed whitespace-nowrap"
      style={
        pri
          ? { background: C.accentDeep, borderColor: C.accentDeep, color: '#fff' }
          : { background: C.inset, borderColor: C.line2, color: C.tx2 }
      }
    >
      {children}
    </button>
  );
}

function Pill({ tone, children }: { tone: Tone; children: React.ReactNode }) {
  const fg = TONE_FG[tone];
  return (
    <span
      className="inline-flex items-center gap-1 px-[7px] py-[2px] rounded-full border
                 font-mono text-[9.5px] font-bold tracking-[.03em] whitespace-nowrap"
      style={
        tone === 'idle'
          ? { color: C.tx4, borderColor: C.line2, background: C.inset }
          : { color: fg, borderColor: `color-mix(in srgb, ${fg} 40%, transparent)`, background: `color-mix(in srgb, ${fg} 11%, transparent)` }
      }
    >
      {children}
    </span>
  );
}

function Th({ children, w }: { children: React.ReactNode; w?: number }) {
  return (
    <th
      className="sticky top-0 text-left px-2.5 py-2 font-mono text-[9.5px] font-bold
                 tracking-[0.06em] uppercase whitespace-nowrap border-b z-10"
      style={{ background: C.inset, color: C.tx3, borderColor: C.line2, width: w }}
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
