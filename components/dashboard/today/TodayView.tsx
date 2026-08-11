'use client';

import { useCallback, useEffect, useState } from 'react';
import DashboardHeader from '@/components/dashboard/header/DashboardHeader';
import type { AIModel } from '@/types/session';
import type { BriefTile, Severity, SignalBlock, TodayPayload, TodoItem } from '@/lib/workspace/types';

/**
 * 오늘 — 아침 브리핑 보드.
 *
 * ── 확정 규칙 (시안 리뷰에서 결정) ────────────────────────────────────
 *  ① 타일 6개 · 순서 = 결론(오늘 할 일, hero) → 실무 → 모니터링
 *  ② 목록은 **우선순위 무관 5건**만 노출, 나머지는 접는다
 *  ③ 이월은 `D+N` 배지 + 좌측 노란 엣지, **D+3 초과 시 위험색**
 *  ④ 복귀 항목은 `📌 고정` — D+7 자동 이동에서 제외
 *  ⑤ 완료는 **사람이 체크**, 체크해도 사라지지 않고 취소선으로 남는다
 *
 * 색은 새로 만들지 않고 기존 에이전트 모드 색을 의미로 승격했다
 * (designer #34D399 → ok / writer #60A5FA → info /
 *  reviewer #FBBF24 → warn / fixer #F87171 → crit)
 */

/** 목록에 한 번에 보여줄 최대 건수 — 우선순위와 무관하게 항상 5줄 */
const VISIBLE_LIMIT = 5;

const TONE: Record<Severity, { fg: string; bd: string; bg: string }> = {
  crit: { fg: '#F87171', bd: '#F8717166', bg: '#F8717120' },
  warn: { fg: '#FBBF24', bd: '#FBBF2466', bg: '#FBBF2420' },
  info: { fg: '#60A5FA', bd: '#60A5FA66', bg: '#60A5FA20' },
  ok: { fg: '#34D399', bd: '#34D39966', bg: '#34D39920' },
  idle: { fg: '#6C7891', bd: '#2A3347', bg: '#0F1520' },
};

const PRIORITY_TONE: Record<string, Severity> = {
  P0: 'crit',
  P1: 'warn',
  P2: 'info',
  P3: 'idle',
};

/**
 * ISO(UTC) → KST 'MM-DD HH:mm'.
 * toLocaleString('ko-KR')은 "8. 7. 오전 11:05" 처럼 로케일 표기가 섞여
 * 잘라 쓰기에 부적합하다. 자리수가 고정된 형태로 직접 만든다.
 */
function formatKst(iso: string): string {
  const d = new Date(Date.parse(iso) + 9 * 60 * 60 * 1000);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}

export default function TodayView() {
  const [model, setModel] = useState<AIModel>('claude');
  const [data, setData] = useState<TodayPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [collecting, setCollecting] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (rebuild = false) => {
    try {
      const res = await fetch(`/api/workspace/today${rebuild ? '?rebuild=1' : ''}`, {
        cache: 'no-store',
      });
      if (!res.ok) throw new Error(`조회 실패 (${res.status})`);
      setData((await res.json()) as TodayPayload);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(true);
  }, [load]);

  /** 지금 수집 — 평소에는 아침 스케줄러가 대신 한다 */
  async function collect() {
    setCollecting(true);
    try {
      const res = await fetch('/api/workspace/collect', { method: 'POST' });
      const body = (await res.json()) as { ok: boolean; error?: string };
      if (!body.ok && body.error) setError(body.error);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setCollecting(false);
    }
  }

  /** 체크 토글 — 낙관적 갱신 후 서버 반영 */
  async function toggle(item: TodoItem) {
    const done = !item.done_at;
    setData((prev) =>
      prev
        ? {
            ...prev,
            todos: prev.todos.map((t) =>
              t.id === item.id ? { ...t, done_at: done ? new Date().toISOString() : null } : t,
            ),
          }
        : prev,
    );
    await fetch('/api/workspace/todo', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: item.id, done }),
    });
    // 타일 숫자(오늘 할 일 = 미완료 건수)를 서버 기준으로 맞춘다.
    // 정렬은 완료 여부를 보지 않으므로 항목이 자리를 옮기지 않는다.
    await load();
  }

  const todos = data?.todos ?? [];
  const visible = expanded ? todos : todos.slice(0, VISIBLE_LIMIT);
  const hiddenCount = Math.max(todos.length - VISIBLE_LIMIT, 0);

  return (
    <div className="flex flex-col h-screen bg-[#0B0F17]">
      <DashboardHeader
        activeModel={model}
        onModelChange={setModel}
        activeWorkspaceKey="today"
        noticeCount={data?.noticeCount ?? 0}
      />

      <div className="flex flex-1 min-h-0">
        {/* ── 좌측 레일: 수집기 상태 ─────────────────────────────── */}
        <aside className="w-[212px] flex-shrink-0 bg-[#161B27] border-r border-[#1E2535] overflow-y-auto">
          <div className="px-3 py-3 border-b border-[#1E2535]">
            <div className="text-[9.5px] font-mono font-semibold tracking-[0.1em] text-[#4A5468] uppercase">
              수집기 상태
            </div>
          </div>
          <div className="p-2 flex flex-col gap-1">
            {(data?.collectors ?? []).map((c) => (
              <div key={c.name} className="px-2.5 py-2 rounded-md bg-[#0F1520] border border-[#1E2535]">
                <div className="flex items-center gap-2">
                  <span
                    className="w-[6px] h-[6px] rounded-full flex-shrink-0"
                    style={{ background: c.ok ? TONE.ok.fg : TONE.crit.fg }}
                  />
                  <span className="text-[11.5px] text-[#E8ECF5] font-medium">{c.name}</span>
                </div>
                <div className="mt-1 text-[9.5px] font-mono text-[#6C7891] leading-relaxed break-words">
                  {c.detail}
                </div>
              </div>
            ))}
          </div>

          <div className="px-3 pt-2 pb-4">
            <button
              onClick={() => void collect()}
              disabled={collecting}
              className="w-full py-2 rounded-md text-[11.5px] font-semibold border transition-colors
                         bg-[#4F46E5] border-[#4F46E5] text-white hover:bg-[#818CF8]
                         disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {collecting ? '수집 중…' : '지금 수집'}
            </button>
            <div className="mt-2 text-[9.5px] font-mono text-[#4A5468] leading-relaxed">
              평소에는 아침 08:00 스케줄러가 수집한다.
              <br />
              LLM을 쓰지 않아 토큰 비용은 0.
            </div>
          </div>
        </aside>

        {/* ── 캔버스 ─────────────────────────────────────────────── */}
        <main className="flex-1 min-w-0 overflow-y-auto px-5 py-4 pb-16">
          <div className="mb-4">
            <div className="text-[9.5px] font-mono font-semibold tracking-[0.1em] text-[#4A5468] uppercase">
              {data?.day ?? '—'}
              {data?.collectedAt ? ` · ${formatKst(data.collectedAt)} 수집` : ' · 아직 수집 전'}
            </div>
            <h1 className="mt-1 text-[19px] font-[680] tracking-[-0.02em] text-[#E8ECF5]">오늘</h1>
            <p className="mt-0.5 text-[12.5px] text-[#6C7891] max-w-[68ch]">
              신호원 4곳을 출근 전에 수집해 오늘 할 일로 환산한다.
            </p>
          </div>

          {error && (
            <div className="mb-3 px-3 py-2 rounded-lg border text-[12px]"
                 style={{ borderColor: TONE.crit.bd, background: TONE.crit.bg, color: TONE.crit.fg }}>
              {error}
            </div>
          )}

          {loading ? (
            <div className="text-[12.5px] text-[#6C7891]">불러오는 중…</div>
          ) : (
            <>
              <Tiles tiles={data?.tiles ?? []} />

              <TodoCard
                items={visible}
                total={todos.length}
                hiddenCount={expanded ? 0 : hiddenCount}
                expanded={expanded}
                onToggleExpand={() => setExpanded((v) => !v)}
                onCheck={toggle}
              />

              <div className="text-[9.5px] font-mono font-semibold tracking-[0.1em] text-[#4A5468] uppercase mt-5 mb-2">
                수집된 신호
              </div>
              <div className="grid grid-cols-1 xl:grid-cols-2 gap-3">
                {(data?.blocks ?? []).map((b) => (
                  <Block key={b.key} block={b} />
                ))}
              </div>
            </>
          )}
        </main>
      </div>
    </div>
  );
}

// ─── 타일 ─────────────────────────────────────────────────────────────

function Tiles({ tiles }: { tiles: BriefTile[] }) {
  return (
    <div
      className="grid gap-px bg-[#1E2535] border border-[#1E2535] rounded-lg overflow-hidden mb-3.5"
      style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(118px, 1fr))' }}
    >
      {tiles.map((t) => {
        const tone = TONE[t.tone];
        return (
          <div
            key={t.key}
            className="px-3 py-2.5"
            style={
              t.hero
                ? { background: '#1E1A3A', boxShadow: 'inset 3px 0 0 #818CF8' }
                : { background: '#161B27' }
            }
          >
            <div
              className="font-mono tabular-nums leading-tight tracking-[-0.02em]"
              style={{
                fontSize: t.hero ? 25 : 21,
                fontWeight: 660,
                color: t.hero ? '#818CF8' : t.tone === 'idle' ? '#E8ECF5' : tone.fg,
              }}
            >
              {t.value}
            </div>
            <div
              className="mt-0.5 font-mono text-[9.5px] font-semibold tracking-[0.1em] uppercase"
              style={{ color: t.hero ? '#A5AEF5' : '#4A5468' }}
            >
              {t.label}
            </div>
            <div className="mt-0.5 font-mono text-[9.5px] text-[#4A5468] leading-snug">
              {t.detail}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ─── 오늘 할 일 ───────────────────────────────────────────────────────

function TodoCard({
  items,
  total,
  hiddenCount,
  expanded,
  onToggleExpand,
  onCheck,
}: {
  items: TodoItem[];
  total: number;
  hiddenCount: number;
  expanded: boolean;
  onToggleExpand: () => void;
  onCheck: (t: TodoItem) => void;
}) {
  return (
    <div className="bg-[#161B27] border border-[#1E2535] border-l-[3px] border-l-[#60A5FA] rounded-xl p-3.5">
      <div className="flex items-start justify-between gap-2.5 mb-2.5">
        <div>
          <div className="text-[13px] font-[640] text-[#E8ECF5] tracking-[-0.01em]">오늘 할 일</div>
          <div className="text-[11px] text-[#6C7891] mt-0.5">
            실무단 티켓이 최우선 · 자동화 실패는 모니터링 레벨 · 완료는 전부 사람이 체크
          </div>
          <div className="font-mono text-[10px] text-[#4A5468] mt-1">
            표시 · 우선순위 무관 {VISIBLE_LIMIT}건 노출 → 나머지 접기 &nbsp;/&nbsp; D+7 초과 → 🔔 알림
          </div>
        </div>
      </div>

      {total === 0 ? (
        <div className="px-3 py-6 text-center text-[12px] text-[#6C7891]">
          오늘 할 일이 없습니다. 좌측 <b className="text-[#A8B2C7]">지금 수집</b>을 눌러 신호를 모아보세요.
        </div>
      ) : (
        <div className="flex flex-col gap-px bg-[#1E2535] border border-[#1E2535] rounded-lg overflow-hidden">
          {items.map((t) => (
            <TodoRow key={t.id} item={t} onCheck={onCheck} />
          ))}

          {(hiddenCount > 0 || expanded) && (
            <button
              onClick={onToggleExpand}
              className="w-full py-2 bg-[#0F1520] border-t border-[#1E2535] text-[#6C7891]
                         font-mono text-[10.5px] font-semibold hover:bg-[#1E2535] hover:text-[#E8ECF5]
                         transition-colors flex items-center justify-center gap-2"
            >
              {expanded ? `접기 ▴` : `나머지 ${hiddenCount}건 펼치기 ▾`}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function TodoRow({ item, onCheck }: { item: TodoItem; onCheck: (t: TodoItem) => void }) {
  const done = Boolean(item.done_at);
  const pTone = TONE[PRIORITY_TONE[item.priority] ?? 'idle'];
  const carryTone = item.hot ? TONE.crit : TONE.warn;

  return (
    <div
      className="flex items-center gap-2.5 px-3 py-2.5 bg-[#161B27] hover:bg-[#1B2130] transition-colors"
      style={{
        opacity: done ? 0.55 : 1,
        // 이월은 노란 엣지, 복귀(고정)는 인디고 엣지 — 성격이 다르므로 색으로 구분
        boxShadow: item.pinned
          ? 'inset 2px 0 0 #818CF8'
          : item.carriedDays > 0
            ? `inset 2px 0 0 ${carryTone.fg}`
            : undefined,
      }}
    >
      {/*
        input에 ::after로 체크표시를 그리면 브라우저에 따라 렌더되지 않는다
        (input은 대체 요소라 의사요소가 불안정). 실제 input은 시각적으로 숨기고
        형제 span에 체크표시를 그린다 — 키보드 포커스·접근성은 그대로 유지된다.
      */}
      <label className="relative w-[15px] h-[15px] flex-shrink-0 cursor-pointer">
        <input
          type="checkbox"
          checked={done}
          onChange={() => onCheck(item)}
          aria-label={`${item.title} 완료`}
          className="peer absolute inset-0 opacity-0 cursor-pointer"
        />
        {/* pointer-events-none: 시각 표시가 실제 input의 클릭을 가로채지 않게 한다 */}
        <span
          aria-hidden
          className="pointer-events-none absolute inset-0 grid place-items-center rounded-[4px]
                     border-[1.5px] border-[#2A3347] bg-[#0F1520] text-white text-[10px] font-bold
                     leading-none transition-colors peer-checked:bg-[#4F46E5]
                     peer-checked:border-[#4F46E5] peer-focus-visible:ring-2
                     peer-focus-visible:ring-[#818CF8]"
        >
          {done ? '✓' : ''}
        </span>
      </label>

      <Pill text={item.priority} tone={PRIORITY_TONE[item.priority] ?? 'idle'} />

      {item.carriedDays > 0 && (
        <span
          className="font-mono text-[9.5px] font-bold px-[5px] py-[1.5px] rounded whitespace-nowrap border"
          style={{ color: carryTone.fg, borderColor: carryTone.bd, background: carryTone.bg }}
          title={`${item.first_day}부터 이월`}
        >
          D+{item.carriedDays}
        </span>
      )}

      {Boolean(item.pinned) && (
        <span
          className="font-mono text-[9.5px] font-bold px-[5px] py-[1.5px] rounded whitespace-nowrap
                     border border-[#4F46E5] bg-[#1E1A3A] text-[#818CF8]"
          title="알림에서 복귀 — D+7 자동 이동에서 제외"
        >
          📌 고정
        </span>
      )}

      <div className="flex-1 min-w-0">
        <div
          className="text-[12.5px] font-medium"
          style={{
            color: done ? '#4A5468' : '#E8ECF5',
            textDecoration: done ? 'line-through' : undefined,
          }}
        >
          {item.title}
        </div>
        {item.detail && (
          <div className="text-[11px] text-[#6C7891] mt-0.5 leading-snug">{item.detail}</div>
        )}
      </div>

      <Pill text={item.mode === 'semi' ? '반자동' : '수동'} tone={item.mode === 'semi' ? 'info' : 'idle'} />

      {item.source && (
        <span className="font-mono text-[9px] font-bold px-[5px] py-[1.5px] rounded
                         bg-[#0F1520] border border-[#2A3347] text-[#6C7891] whitespace-nowrap">
          {item.source}
        </span>
      )}

      {item.action_label &&
        (item.action_url ? (
          <a
            href={item.action_url}
            target="_blank"
            rel="noreferrer"
            className="px-2.5 py-1 rounded-md text-[10.5px] font-semibold whitespace-nowrap
                       bg-[#0F1520] border border-[#2A3347] text-[#A8B2C7]
                       hover:border-[#4F46E5] hover:text-[#E8ECF5] transition-colors"
          >
            {item.action_label}
          </a>
        ) : (
          <span className="px-2.5 py-1 rounded-md text-[10.5px] font-semibold whitespace-nowrap
                           bg-[#0F1520] border border-[#2A3347] text-[#4A5468]">
            {item.action_label}
          </span>
        ))}
    </div>
  );
}

// ─── 신호 블록 ────────────────────────────────────────────────────────

function Block({ block }: { block: SignalBlock }) {
  const tone = TONE[block.tone];
  return (
    <div
      className="bg-[#161B27] border border-[#1E2535] border-l-[3px] rounded-xl p-3.5"
      style={{ borderLeftColor: tone.fg }}
    >
      <div className="flex items-start justify-between gap-2.5 mb-2.5">
        <div className="text-[13px] font-[640] text-[#E8ECF5] tracking-[-0.01em] flex items-center gap-2">
          {block.title}
          {block.priority && <Pill text={block.priority} tone={PRIORITY_TONE[block.priority]} />}
        </div>
        <Pill text={block.badge} tone={block.tone} />
      </div>

      <div className="flex flex-col gap-px bg-[#1E2535] border border-[#1E2535] rounded-lg overflow-hidden">
        {block.rows.map((r, i) => (
          <div key={i} className="flex items-center gap-2.5 px-3 py-2 bg-[#161B27]">
            {r.pill && <Pill text={r.pill.text} tone={r.pill.tone} />}
            <div className="flex-1 min-w-0">
              <div
                className={`text-[12.5px] text-[#E8ECF5] font-medium truncate ${r.mono ? 'font-mono text-[11.5px]' : ''}`}
              >
                {r.title}
              </div>
              {r.detail && (
                <div className="text-[11px] text-[#6C7891] mt-0.5 truncate">{r.detail}</div>
              )}
            </div>
          </div>
        ))}
      </div>

      {block.note && (
        <div className="mt-2.5 border-l-2 border-[#4F46E5] pl-2.5 py-1 text-[11.5px] text-[#6C7891]">
          {block.note}
        </div>
      )}
    </div>
  );
}

function Pill({ text, tone }: { text: string; tone: Severity }) {
  const t = TONE[tone];
  return (
    <span
      className="inline-flex items-center px-[7px] py-[2px] rounded-full border
                 font-mono text-[9.5px] font-bold tracking-[0.03em] whitespace-nowrap"
      style={{ color: t.fg, borderColor: t.bd, background: t.bg }}
    >
      {text}
    </span>
  );
}
