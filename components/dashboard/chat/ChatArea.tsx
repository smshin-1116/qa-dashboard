'use client';

import { useEffect, useRef } from 'react';
import type { Session } from '@/types/session';
import MessageBubble from './MessageBubble';

interface ChatAreaProps {
  session: Session | null;
  isStreaming: boolean;
  streamingContent: string;
  toolStatus: string;
  hasTcResult: boolean;
  onDownloadXlsx: () => void;
}

export default function ChatArea({
  session,
  isStreaming,
  streamingContent,
  toolStatus,
  hasTcResult,
  onDownloadXlsx,
}: ChatAreaProps) {
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [session?.messages, streamingContent, toolStatus]);

  return (
    <div className="flex-1 flex flex-col overflow-hidden bg-[#0F1117]">
      {/* Chat toolbar */}
      <div className="flex items-center justify-between px-6 py-2 bg-[#111520] border-b border-[#1E2535] flex-shrink-0">
        <div className="flex items-center gap-2 text-[12px] text-slate-500">
          {session ? (
            <>
              <span>세션</span>
              <strong className="text-slate-400">{session.title}</strong>
              <span className="text-slate-600">·</span>
              <span>{session.messages.length}개 메시지</span>
            </>
          ) : (
            <span>새 대화를 시작하세요</span>
          )}
        </div>

        {/* TC 다운로드 버튼 */}
        {hasTcResult ? (
          <button
            onClick={onDownloadXlsx}
            className="flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg bg-[#0D2A1A] border border-[#166534] text-green-400 text-[12px] font-semibold hover:bg-[#14532D] hover:border-green-600 transition-colors"
          >
            <span className="text-sm">↓</span>
            TC 다운로드 .xlsx
          </button>
        ) : (
          <div className="flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg bg-[#1A1E2A] border border-[#2A3347] text-[#374151] text-[12px] font-semibold cursor-not-allowed">
            <span className="text-sm">↓</span>
            TC 다운로드 .xlsx
          </div>
        )}
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto px-6 py-5 flex flex-col gap-5">
        {!session || session.messages.length === 0 ? (
          <EmptyState />
        ) : (
          session.messages.map((msg) => <MessageBubble key={msg.id} message={msg} />)
        )}

        {/* 스트리밍 중인 응답 */}
        {isStreaming && streamingContent && (
          <MessageBubble
            message={{
              id: '__streaming__',
              role: 'assistant',
              content: streamingContent,
              createdAt: Date.now(),
            }}
            isStreaming
          />
        )}

        {/* 작업 상태 표시 */}
        {isStreaming && (
          <WorkingStatus toolStatus={toolStatus} hasContent={!!streamingContent} />
        )}

        <div ref={bottomRef} />
      </div>
    </div>
  );
}

function WorkingStatus({ toolStatus, hasContent }: { toolStatus: string; hasContent: boolean }) {
  // 텍스트가 이미 스트리밍 중이면 상태 표시 불필요
  if (hasContent && !toolStatus) return null;

  return (
    <div className="flex items-center gap-3 px-1">
      {/* 봇 아바타 자리 */}
      <div className="w-8 h-8 rounded-full flex-shrink-0 bg-[#1E2535] border border-[#2A3347] flex items-center justify-center text-sm">
        🤖
      </div>

      <div className="flex items-center gap-2.5 px-4 py-2.5 rounded-xl bg-[#161B27] border border-[#1E2535]">
        {/* 도트 애니메이션 */}
        <div className="flex items-center gap-1">
          <span className="w-1.5 h-1.5 rounded-full bg-indigo-400 animate-bounce [animation-delay:0ms]" />
          <span className="w-1.5 h-1.5 rounded-full bg-indigo-400 animate-bounce [animation-delay:150ms]" />
          <span className="w-1.5 h-1.5 rounded-full bg-indigo-400 animate-bounce [animation-delay:300ms]" />
        </div>

        {toolStatus ? (
          <span className="text-[13px] text-slate-400">
            <span className="text-indigo-400 font-medium">{toolStatus}</span>
            <span className="text-slate-600"> 중...</span>
          </span>
        ) : (
          <span className="text-[13px] text-slate-500">생각 중...</span>
        )}
      </div>
    </div>
  );
}

function EmptyState() {
  return (
    <div className="flex-1 flex flex-col items-center justify-center gap-3 text-center py-20">
      <div className="w-12 h-12 rounded-xl bg-gradient-to-br from-indigo-600 to-violet-600 flex items-center justify-center text-2xl">
        🤖
      </div>
      <p className="text-slate-400 text-[15px] font-medium">QA Agent에게 물어보세요</p>
      <p className="text-slate-600 text-[13px] max-w-xs">
        Jira 티켓 생성, Figma 분석, TC 생성 등 QA 업무를 자동화합니다
      </p>
    </div>
  );
}
