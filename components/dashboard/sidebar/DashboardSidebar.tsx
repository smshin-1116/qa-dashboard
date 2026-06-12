'use client';

import { useMemo, useState, useRef, useEffect, useCallback } from 'react';
import { format, isToday, isYesterday, differenceInCalendarDays } from 'date-fns';
import { ko } from 'date-fns/locale';
import type { Session, AIModel } from '@/types/session';
import { MODEL_SUPPORT } from '@/constants/modelSupport';

interface DashboardSidebarProps {
  sessions: Session[];
  activeSessionId: string | null;
  onSelectSession: (id: string) => void;
  onNewSession: () => void;
  onDeleteSession: (id: string) => void;
  onTogglePin: (id: string) => void;
  onRenameSession: (id: string, customTitle: string) => void;
  /** 사이드바 헤더 라벨 (워크스페이스별) — 기본 "대화 목록" */
  label?: string;
}

type GroupKey = 'pinned' | 'today' | 'yesterday' | 'lastWeek' | 'older';

interface GroupStyle {
  label: string;
  /** 헤더 텍스트/도트 색상 — 최신일수록 밝게 */
  textClass: string;
  dotClass: string;
  /** 굵기/투명도 강조 */
  weightClass: string;
}

const GROUP_STYLE: Record<GroupKey, GroupStyle> = {
  pinned: {
    label: '고정됨',
    textClass: 'text-amber-400',
    dotClass: 'bg-amber-400',
    weightClass: 'font-bold',
  },
  today: {
    label: '오늘',
    textClass: 'text-indigo-300',
    dotClass: 'bg-indigo-400 shadow-[0_0_6px_rgba(129,140,248,0.6)]',
    weightClass: 'font-bold',
  },
  yesterday: {
    label: '어제',
    textClass: 'text-sky-400/80',
    dotClass: 'bg-sky-500/80',
    weightClass: 'font-semibold',
  },
  lastWeek: {
    label: '지난 7일',
    textClass: 'text-slate-400',
    dotClass: 'bg-slate-500',
    weightClass: 'font-semibold',
  },
  older: {
    label: '이전',
    textClass: 'text-slate-600',
    dotClass: 'bg-slate-700',
    weightClass: 'font-medium',
  },
};

const GROUP_ORDER: GroupKey[] = ['pinned', 'today', 'yesterday', 'lastWeek', 'older'];

function getDisplayTitle(s: Session): string {
  return s.customTitle?.trim() || s.title;
}

function bucketize(s: Session, now: Date): GroupKey {
  if (s.pinned) return 'pinned';
  const d = new Date(s.updatedAt);
  if (isToday(d)) return 'today';
  if (isYesterday(d)) return 'yesterday';
  if (differenceInCalendarDays(now, d) <= 7) return 'lastWeek';
  return 'older';
}

function matchesQuery(s: Session, q: string): boolean {
  if (!q) return true;
  const needle = q.toLowerCase();
  if (getDisplayTitle(s).toLowerCase().includes(needle)) return true;
  for (const m of s.messages) {
    if (m.content.toLowerCase().includes(needle)) return true;
  }
  return false;
}

export default function DashboardSidebar({
  sessions,
  activeSessionId,
  onSelectSession,
  onNewSession,
  onDeleteSession,
  onTogglePin,
  onRenameSession,
  label = '대화 목록',
}: DashboardSidebarProps) {
  const [query, setQuery] = useState('');
  const [debounced, setDebounced] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);

  useEffect(() => {
    const t = setTimeout(() => setDebounced(query.trim()), 180);
    return () => clearTimeout(t);
  }, [query]);

  const groups = useMemo(() => {
    const now = new Date();
    const filtered = sessions.filter((s) => matchesQuery(s, debounced));
    const map: Record<GroupKey, Session[]> = {
      pinned: [],
      today: [],
      yesterday: [],
      lastWeek: [],
      older: [],
    };
    for (const s of filtered) {
      map[bucketize(s, now)].push(s);
    }
    // 각 그룹 내 최신순
    for (const k of GROUP_ORDER) {
      map[k].sort((a, b) => b.updatedAt - a.updatedAt);
    }
    return GROUP_ORDER.filter((k) => map[k].length > 0).map((k) => ({
      key: k,
      style: GROUP_STYLE[k],
      sessions: map[k],
    }));
  }, [sessions, debounced]);

  const totalHits = groups.reduce((sum, g) => sum + g.sessions.length, 0);

  return (
    <aside className="w-[236px] bg-[#161B27] border-r border-[#1E2535] flex flex-col flex-shrink-0">
      <div className="px-4 py-[14px] border-b border-[#1E2535] flex items-center justify-between">
        <span className="text-[11px] font-semibold text-slate-400 uppercase tracking-wide">
          {label}
        </span>
        <button
          onClick={onNewSession}
          className="px-2.5 py-1 rounded-md bg-indigo-600 text-white text-[11px] font-medium hover:bg-indigo-500 transition-colors"
        >
          + 새 대화
        </button>
      </div>

      {/* 검색 */}
      <div className="px-3 pt-2 pb-1.5">
        <div className="relative">
          <span className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-500 text-[11px] pointer-events-none">
            🔍
          </span>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="제목·본문 검색"
            className="w-full pl-7 pr-7 py-1.5 rounded-md bg-[#1E2535] border border-[#2A3347] text-[12px] text-slate-200 placeholder:text-slate-600 focus:outline-none focus:border-indigo-600"
          />
          {query && (
            <button
              onClick={() => setQuery('')}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-500 hover:text-slate-300 text-[10px]"
              aria-label="검색어 지우기"
            >
              ✕
            </button>
          )}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-2 pb-2">
        {sessions.length === 0 && (
          <p className="text-[12px] text-slate-500 text-center py-8">
            아직 대화가 없습니다
          </p>
        )}
        {sessions.length > 0 && totalHits === 0 && (
          <p className="text-[12px] text-slate-500 text-center py-8">
            검색 결과가 없습니다
          </p>
        )}

        {groups.map((group) => (
          <section key={group.key} className="mb-2.5">
            <div
              className={[
                'px-2 pt-2 pb-1.5 text-[10px] uppercase tracking-wider flex items-center gap-1.5',
                group.style.textClass,
                group.style.weightClass,
              ].join(' ')}
            >
              <span className={`w-1.5 h-1.5 rounded-full ${group.style.dotClass}`} />
              <span>{group.style.label}</span>
              <span className="ml-auto text-[10px] text-slate-600 font-normal normal-case tracking-normal">
                {group.sessions.length}
              </span>
            </div>
            {group.sessions.map((session) => (
              <SessionItem
                key={session.id}
                session={session}
                isActive={session.id === activeSessionId}
                isEditing={editingId === session.id}
                onSelect={() => onSelectSession(session.id)}
                onDelete={(e) => {
                  e.stopPropagation();
                  onDeleteSession(session.id);
                }}
                onTogglePin={(e) => {
                  e.stopPropagation();
                  onTogglePin(session.id);
                }}
                onStartEdit={() => setEditingId(session.id)}
                onSubmitEdit={(value) => {
                  onRenameSession(session.id, value);
                  setEditingId(null);
                }}
                onCancelEdit={() => setEditingId(null)}
              />
            ))}
          </section>
        ))}
      </div>
    </aside>
  );
}

interface SessionItemProps {
  session: Session;
  isActive: boolean;
  isEditing: boolean;
  onSelect: () => void;
  onDelete: (e: React.MouseEvent) => void;
  onTogglePin: (e: React.MouseEvent) => void;
  onStartEdit: () => void;
  onSubmitEdit: (value: string) => void;
  onCancelEdit: () => void;
}

function SessionItem({
  session,
  isActive,
  isEditing,
  onSelect,
  onDelete,
  onTogglePin,
  onStartEdit,
  onSubmitEdit,
  onCancelEdit,
}: SessionItemProps) {
  const modelInfo = MODEL_SUPPORT[session.model];
  const displayTitle = getDisplayTitle(session);
  const isDraft = session.messages.length === 0;

  return (
    <div
      onClick={isEditing ? undefined : onSelect}
      className={[
        'group px-3 py-2.5 rounded-lg cursor-pointer mb-0.5 border transition-colors',
        isActive
          ? 'bg-[#1E2A45] border-[#2A3F6B]'
          : 'border-transparent hover:bg-[#1A2030]',
      ].join(' ')}
    >
      {isEditing ? (
        <RenameInput
          initial={displayTitle}
          onSubmit={onSubmitEdit}
          onCancel={onCancelEdit}
        />
      ) : (
        <div
          className="text-[13px] text-slate-300 font-medium mb-1 truncate"
          onDoubleClick={(e) => {
            e.stopPropagation();
            if (isDraft) return; // draft는 첫 메시지에서 자동 제목 부여 — 편집 금지
            onStartEdit();
          }}
          title={isDraft ? displayTitle : `${displayTitle} (더블클릭하여 이름 변경)`}
        >
          {displayTitle}
        </div>
      )}
      <div className="flex items-center justify-between">
        <span className="text-[11px] text-slate-500">
          {format(new Date(session.updatedAt), 'MM/dd HH:mm', { locale: ko })}
        </span>
        <div className="flex items-center gap-1">
          <ModelTag model={session.model} label={modelInfo.label} />
          {/* 핀 버튼 — pinned면 항상 표시, 아니면 hover 시 표시. draft는 비활성 */}
          <button
            onClick={onTogglePin}
            disabled={isDraft}
            title={isDraft ? '메시지 전송 후 고정할 수 있습니다' : session.pinned ? '고정 해제' : '상단에 고정'}
            className={[
              'w-4 h-4 rounded flex items-center justify-center transition-all text-[10px]',
              isDraft
                ? 'opacity-20 cursor-not-allowed text-slate-600'
                : session.pinned
                  ? 'text-amber-400 hover:text-amber-300'
                  : 'opacity-0 group-hover:opacity-100 text-slate-500 hover:text-amber-400',
            ].join(' ')}
          >
            {session.pinned ? '★' : '☆'}
          </button>
          <button
            onClick={onDelete}
            className="opacity-0 group-hover:opacity-100 w-4 h-4 rounded flex items-center justify-center text-slate-500 hover:text-red-400 hover:bg-red-900/30 transition-all text-[10px]"
            title="삭제"
          >
            ✕
          </button>
        </div>
      </div>
    </div>
  );
}

function RenameInput({
  initial,
  onSubmit,
  onCancel,
}: {
  initial: string;
  onSubmit: (value: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(initial);
  const ref = useRef<HTMLInputElement>(null);

  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);

  const commit = useCallback(() => {
    const trimmed = value.trim();
    // 빈 문자열도 허용 — store에서 customTitle 제거 처리
    onSubmit(trimmed);
  }, [value, onSubmit]);

  return (
    <input
      ref={ref}
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onClick={(e) => e.stopPropagation()}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          commit();
        } else if (e.key === 'Escape') {
          e.preventDefault();
          onCancel();
        }
      }}
      placeholder="제목 입력 (비우면 자동 제목)"
      className="w-full mb-1 px-1.5 py-0.5 rounded bg-[#0F1117] border border-indigo-600 text-[13px] text-slate-200 font-medium outline-none"
    />
  );
}

function ModelTag({
  model,
  label,
}: {
  model: AIModel;
  label: string;
}) {
  const bg: Record<string, string> = {
    claude: 'bg-[#1E1A3A] text-indigo-400',
    gemini: 'bg-[#162010] text-green-400',
    codex: 'bg-[#1A1A2E] text-purple-400',
  };
  return (
    <span className={`text-[10px] px-1.5 py-0.5 rounded font-medium ${bg[model]}`}>
      {label}
    </span>
  );
}
