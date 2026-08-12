'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import DashboardHeader from '@/components/dashboard/header/DashboardHeader';
import type { AIModel } from '@/types/session';
import type { NoticeKind, Priority, Severity } from '@/lib/workspace/types';

/**
 * 🔔 알림 — 오늘 할 일과 분리된 느린 신호.
 *
 * ── 왜 별도 화면인가 (2026-08-04 결정) ────────────────────────────────
 *   오늘 할 일 = 오늘 처리할 것.  완료하면 체크한다.
 *   알림       = 며칠~몇 주째 정체된 것. **경과일이 핵심 정보**이고
 *                미루거나 끌 수 있다.
 * 섞으면 오늘 할 일이 잔소리로 오염된다.
 *
 * ── 복귀 규칙 ⑤ ──────────────────────────────────────────────────────
 * "오늘로 복귀" = 경과일 유지 + 우선순위 1단계 승격 + 📌 고정.
 * 고정이 없으면 D+7 규칙에 다시 걸려 즉시 튕겨나간다(무한 루프).
 */

const mix = (v: string, p: number) => `color-mix(in srgb, var(${v}) ${p}%, transparent)`;
const TONE: Record<Severity, { fg: string; bd: string; bg: string }> = {
  crit: { fg: 'var(--crit)', bd: mix('--crit', 40), bg: mix('--crit', 12) },
  warn: { fg: 'var(--warn)', bd: mix('--warn', 40), bg: mix('--warn', 12) },
  info: { fg: 'var(--info)', bd: mix('--info', 40), bg: mix('--info', 12) },
  ok: { fg: 'var(--ok)', bd: mix('--ok', 40), bg: mix('--ok', 12) },
  idle: { fg: 'var(--tx-3)', bd: 'var(--line-2)', bg: 'var(--inset)' },
};

/** 그룹별 성격 색 — 이월 초과가 가장 급하다 */
const GROUP_TONE: Record<string, Severity> = {
  'carry-over': 'crit',
  'stale-asset': 'warn',
  'stalled-ticket': 'warn',
  'metric-stall': 'info',
  'skip-limit': 'warn',
};

interface NoticeItem {
  kind: NoticeKind;
  key: string;
  title: string;
  detail: string | null;
  source: string | null;
  since: string | null;
  days: number | null;
  originalPriority: Priority | null;
  promotedTo: Priority | null;
}

interface NoticeGroup {
  kind: NoticeKind;
  title: string;
  hint: string;
  items: NoticeItem[];
}

interface Payload {
  total: number;
  snoozed: number;
  groups: NoticeGroup[];
}

export default function NoticeView() {
  const [model, setModel] = useState<AIModel>('claude');
  const [data, setData] = useState<Payload | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);

  const load = useCallback(async () => {
    const res = await fetch('/api/workspace/notice', { cache: 'no-store' });
    setData((await res.json()) as Payload);
    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function act(item: NoticeItem, action: string, days?: number) {
    const id = `${item.kind}:${item.key}`;
    setBusy(id);
    try {
      const res = await fetch('/api/workspace/notice', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind: item.kind, key: item.key, action, days }),
      });
      const body = (await res.json()) as { movedTo?: string; snoozedDays?: number };
      setFlash(
        action === 'return'
          ? `"${item.title.slice(0, 24)}…" → 오늘 할 일로 복귀 (${item.originalPriority} → ${item.promotedTo} · 📌 고정)`
          : action === 'backlog'
            ? '백로그로 내렸습니다'
            : action === 'snooze'
              ? `${body.snoozedDays}일 뒤 다시 표시`
              : '알림을 껐습니다',
      );
      await load();
    } finally {
      setBusy(null);
      setTimeout(() => setFlash(null), 4000);
    }
  }

  const groups = data?.groups ?? [];

  return (
    <div className="flex flex-col h-screen bg-[var(--ground)]">
      <DashboardHeader
        activeModel={model}
        onModelChange={setModel}
        activeWorkspaceKey="today"
        noticeCount={data?.total ?? 0}
      />

      <main className="flex-1 min-h-0 overflow-y-auto px-6 py-5 pb-16">
        <div className="max-w-[1100px]">
          {/* ── 머리말 ─────────────────────────────────────────── */}
          <div className="mb-4">
            <div className="text-[9.5px] font-mono font-semibold tracking-[0.1em] text-[var(--tx-4)] uppercase">
              헤더 🔔 진입 · 워크스페이스 탭 아님
            </div>
            <h1 className="mt-1 text-[19px] font-[680] tracking-[-0.02em] text-[var(--tx-1)]">알림</h1>
            <p className="mt-0.5 text-[12.5px] text-[var(--tx-3)] max-w-[68ch]">
              <b className="text-[var(--tx-2)]">오늘 할 일</b>은 오늘 처리할 것,{' '}
              <b className="text-[var(--tx-2)]">알림</b>은 며칠~몇 주째 정체된 것. 성격이 달라서
              섞으면 오늘 할 일이 잔소리로 오염된다 — 그래서 따로 뒀다.
            </p>
            <div className="mt-2 flex items-center gap-3">
              <Link
                href="/dashboard/today"
                className="px-2.5 py-1 rounded-md text-[11px] font-semibold bg-[var(--inset)]
                           border border-[var(--line-2)] text-[var(--tx-2)] hover:border-[var(--accent-deep)] hover:text-[var(--tx-1)]"
              >
                ← 오늘로
              </Link>
              {(data?.snoozed ?? 0) > 0 && (
                <span className="font-mono text-[10px] text-[var(--tx-4)]">
                  미룬 항목 {data?.snoozed}건은 숨겨져 있습니다
                </span>
              )}
            </div>
          </div>

          {flash && (
            <div
              className="mb-3 px-3 py-2 rounded-lg border text-[12px]"
              style={{ borderColor: TONE.ok.bd, background: TONE.ok.bg, color: TONE.ok.fg }}
            >
              {flash}
            </div>
          )}

          {loading ? (
            <div className="text-[12.5px] text-[var(--tx-3)]">불러오는 중…</div>
          ) : groups.length === 0 ? (
            <EmptyState />
          ) : (
            <div className="flex flex-col gap-3.5">
              {groups.map((g) => (
                <Group key={g.kind} group={g} busy={busy} onAct={act} />
              ))}
            </div>
          )}
        </div>
      </main>
    </div>
  );
}

function EmptyState() {
  return (
    <div className="border border-dashed border-[var(--line-2)] rounded-xl px-5 py-8 text-center bg-[var(--inset)]">
      <div className="text-[13px] font-[640] text-[var(--ok)]">정체된 항목이 없습니다</div>
      <div className="mt-1.5 text-[12px] text-[var(--tx-3)] leading-relaxed">
        이월 상한(D+7) 초과 · 7일 이상 방치된 자산 · 오래 머문 티켓이 생기면 여기에 모입니다.
        <br />
        오늘 처리할 일은 <b className="text-[var(--tx-2)]">오늘</b> 화면에 있습니다.
      </div>
    </div>
  );
}

function Group({
  group,
  busy,
  onAct,
}: {
  group: NoticeGroup;
  busy: string | null;
  onAct: (i: NoticeItem, a: string, d?: number) => void;
}) {
  const tone = TONE[GROUP_TONE[group.kind] ?? 'idle'];
  const isCarry = group.kind === 'carry-over';

  return (
    <div
      className="bg-[var(--panel)] border border-[var(--line)] border-l-[3px] rounded-xl p-3.5"
      style={{ borderLeftColor: tone.fg }}
    >
      <div className="flex items-start justify-between gap-2.5 mb-2.5">
        <div>
          <div className="text-[13px] font-[640] text-[var(--tx-1)] tracking-[-0.01em]">
            {group.title}
          </div>
          <div className="text-[11px] text-[var(--tx-3)] mt-0.5">{group.hint}</div>
        </div>
        <Pill text={`${group.items.length}건`} tone={GROUP_TONE[group.kind] ?? 'idle'} />
      </div>

      <div className="flex flex-col gap-px bg-[var(--line)] border border-[var(--line)] rounded-lg overflow-hidden">
        {group.items.map((it) => {
          const id = `${it.kind}:${it.key}`;
          const working = busy === id;
          const hot = (it.days ?? 0) > 14;
          return (
            <div key={id} className="flex items-center gap-2.5 px-3 py-2.5 bg-[var(--panel)]">
              {/* 경과일이 이 화면의 핵심 정보 — 가장 먼저 읽히게 둔다 */}
              <span
                className="font-mono text-[9.5px] font-bold px-[6px] py-[2px] rounded border whitespace-nowrap"
                style={
                  hot
                    ? { color: TONE.crit.fg, borderColor: TONE.crit.bd, background: TONE.crit.bg }
                    : { color: TONE.warn.fg, borderColor: TONE.warn.bd, background: TONE.warn.bg }
                }
                title={it.since ? `${it.since.slice(0, 10)}부터` : undefined}
              >
                D+{it.days ?? '?'}
              </span>

              <div className="flex-1 min-w-0">
                <div className="text-[12.5px] text-[var(--tx-1)] font-medium truncate">{it.title}</div>
                {it.detail && (
                  <div className="text-[11px] text-[var(--tx-3)] mt-0.5 truncate">{it.detail}</div>
                )}
              </div>

              {it.source && (
                <span className="font-mono text-[9px] font-bold px-[5px] py-[1.5px] rounded
                                 bg-[var(--inset)] border border-[var(--line-2)] text-[var(--tx-3)] whitespace-nowrap">
                  {it.source}
                </span>
              )}

              <div className="flex gap-1.5 flex-shrink-0">
                {isCarry ? (
                  <>
                    <Btn
                      primary
                      disabled={working}
                      onClick={() => onAct(it, 'return')}
                      title="경과일 유지 + 우선순위 1단계 승격 + 📌 고정"
                    >
                      오늘로 복귀{it.promotedTo ? ` (${it.promotedTo})` : ''}
                    </Btn>
                    <Btn disabled={working} onClick={() => onAct(it, 'backlog')}>
                      백로그로
                    </Btn>
                  </>
                ) : (
                  <>
                    <Btn disabled={working} onClick={() => onAct(it, 'snooze', 7)} title="7일 뒤 다시 표시">
                      7일 미룸
                    </Btn>
                    <Btn disabled={working} onClick={() => onAct(it, 'dismiss')} title="영구 숨김">
                      끄기
                    </Btn>
                  </>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {isCarry && (
        <div className="mt-2.5 border-l-2 border-[var(--accent-deep)] pl-2.5 py-1 text-[11.5px] text-[var(--tx-3)]">
          <b className="text-[var(--accent)]">복귀 규칙</b> — 경과일은 <b>유지</b>하고 우선순위를{' '}
          <b>한 단계 올린다</b>. 그리고 <span className="font-mono">📌 고정</span>이 붙어 D+7 자동
          이동에서 제외된다 — 안 그러면 복귀 즉시 다시 여기로 튕겨나온다.
        </div>
      )}
    </div>
  );
}

function Btn({
  children,
  onClick,
  disabled,
  primary,
  title,
}: {
  children: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
  primary?: boolean;
  title?: string;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={[
        'px-2.5 py-1 rounded-md text-[10.5px] font-semibold whitespace-nowrap border transition-colors',
        primary
          ? 'bg-[var(--accent-deep)] border-[var(--accent-deep)] text-white hover:bg-[var(--accent)]'
          : 'bg-[var(--inset)] border-[var(--line-2)] text-[var(--tx-2)] hover:border-[var(--accent-deep)] hover:text-[var(--tx-1)]',
        disabled ? 'opacity-50 cursor-not-allowed' : '',
      ].join(' ')}
    >
      {children}
    </button>
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
