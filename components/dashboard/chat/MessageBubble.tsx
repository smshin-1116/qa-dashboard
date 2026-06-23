'use client';

import { useEffect, useRef, useState } from 'react';
import type { ChatMessage } from '@/types/session';
import { renderMarkdown } from '@/lib/markdownRenderer';

interface MessageBubbleProps {
  message: ChatMessage;
  isStreaming?: boolean;
}

export default function MessageBubble({ message, isStreaming }: MessageBubbleProps) {
  const isUser = message.role === 'user';
  const [htmlContent, setHtmlContent] = useState<string>('');
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (isUser) {
      setHtmlContent(escapeHtml(message.content));
      return;
    }
    let cancelled = false;
    renderMarkdown(message.content).then((html) => {
      if (!cancelled) setHtmlContent(html);
    });
    return () => { cancelled = true; };
  }, [message.content, isUser]);

  // 복사 버튼 클릭 위임 처리
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const handleClick = (e: MouseEvent) => {
      const btn = (e.target as HTMLElement).closest('.copy-btn') as HTMLElement | null;
      if (!btn) return;
      const code = btn.dataset.copyCode ?? '';
      navigator.clipboard.writeText(code).then(() => {
        btn.textContent = '복사됨!';
        setTimeout(() => {
          btn.textContent = '복사';
        }, 2000);
      });
    };

    container.addEventListener('click', handleClick);
    return () => container.removeEventListener('click', handleClick);
  }, [htmlContent]);

  // 첨부파일 칩 (사용자/AI 공통)
  const attachmentChips = message.attachments && message.attachments.length > 0 && (
    <div className="flex gap-2 flex-wrap mb-2">
      {message.attachments.map((att) => (
        <div
          key={att.id}
          className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-md bg-[#1E2535] border border-[#2A3347] text-[12px] text-slate-400"
        >
          {att.type === 'image' ? '🖼' : att.type === 'code' ? '💻' : '📎'}
          <span className="truncate max-w-[120px]">{att.name}</span>
        </div>
      ))}
    </div>
  );

  // 사용자 메시지: 우측 정렬 + 옅은 배경 블록 (Claude 앱 레퍼런스)
  if (isUser) {
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] px-4 py-2.5 rounded-2xl rounded-tr-md bg-[#262C3D] text-slate-100 text-[14.5px] leading-relaxed">
          {attachmentChips}
          <span className="whitespace-pre-wrap break-words">{message.content}</span>
        </div>
      </div>
    );
  }

  // AI 응답: 옅은 배경 카드 안에 본문 전체 폭 표시
  return (
    <div className="w-full px-5 py-4 rounded-2xl bg-[#141926] border border-[#1E2535] text-slate-200 text-[14.5px] leading-relaxed">
      {attachmentChips}
      <div
        ref={containerRef}
        className="md-prose max-w-none"
        dangerouslySetInnerHTML={{
          __html: htmlContent || escapeHtml(message.content).replace(/\n/g, '<br>'),
        }}
      />
      {isStreaming && (
        <span className="inline-block w-1.5 h-4 bg-indigo-400 ml-0.5 align-text-bottom animate-pulse rounded-sm" />
      )}
    </div>
  );
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
