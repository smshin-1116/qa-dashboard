'use client';

import { format } from 'date-fns';
import { ko } from 'date-fns/locale';
import type { Session, AIModel } from '@/types/session';
import { MODEL_SUPPORT } from '@/constants/modelSupport';

interface DashboardSidebarProps {
  sessions: Session[];
  activeSessionId: string | null;
  onSelectSession: (id: string) => void;
  onNewSession: () => void;
  onDeleteSession: (id: string) => void;
}

export default function DashboardSidebar({
  sessions,
  activeSessionId,
  onSelectSession,
  onNewSession,
  onDeleteSession,
}: DashboardSidebarProps) {
  return (
    <aside className="w-[236px] bg-[#161B27] border-r border-[#1E2535] flex flex-col flex-shrink-0">
      <div className="px-4 py-[14px] border-b border-[#1E2535] flex items-center justify-between">
        <span className="text-[11px] font-semibold text-slate-400 uppercase tracking-wide">
          대화 목록
        </span>
        <button
          onClick={onNewSession}
          className="px-2.5 py-1 rounded-md bg-indigo-600 text-white text-[11px] font-medium hover:bg-indigo-500 transition-colors"
        >
          + 새 대화
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-2">
        {sessions.length === 0 && (
          <p className="text-[12px] text-slate-500 text-center py-8">
            아직 대화가 없습니다
          </p>
        )}
        {sessions.map((session) => (
          <SessionItem
            key={session.id}
            session={session}
            isActive={session.id === activeSessionId}
            onSelect={() => onSelectSession(session.id)}
            onDelete={(e) => {
              e.stopPropagation();
              onDeleteSession(session.id);
            }}
          />
        ))}
      </div>
    </aside>
  );
}

function SessionItem({
  session,
  isActive,
  onSelect,
  onDelete,
}: {
  session: Session;
  isActive: boolean;
  onSelect: () => void;
  onDelete: (e: React.MouseEvent) => void;
}) {
  const modelInfo = MODEL_SUPPORT[session.model];

  return (
    <div
      onClick={onSelect}
      className={[
        'group px-3 py-2.5 rounded-lg cursor-pointer mb-0.5 border transition-colors',
        isActive
          ? 'bg-[#1E2A45] border-[#2A3F6B]'
          : 'border-transparent hover:bg-[#1A2030]',
      ].join(' ')}
    >
      <div className="text-[13px] text-slate-300 font-medium mb-1 truncate">
        {session.title}
      </div>
      <div className="flex items-center justify-between">
        <span className="text-[11px] text-slate-500">
          {format(new Date(session.updatedAt), 'MM/dd HH:mm', { locale: ko })}
        </span>
        <div className="flex items-center gap-1">
          <ModelTag model={session.model} label={modelInfo.label} />
          <button
            onClick={onDelete}
            className="opacity-0 group-hover:opacity-100 w-4 h-4 rounded flex items-center justify-center text-slate-500 hover:text-red-400 hover:bg-red-900/30 transition-all text-[10px]"
          >
            ✕
          </button>
        </div>
      </div>
    </div>
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
