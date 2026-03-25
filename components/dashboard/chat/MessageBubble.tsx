'use client';

import { useEffect, useState } from 'react';
import type { ChatMessage } from '@/types/session';
import { highlightMarkdown } from '@/lib/codeHighlight';

interface MessageBubbleProps {
  message: ChatMessage;
  isStreaming?: boolean;
}

export default function MessageBubble({ message, isStreaming }: MessageBubbleProps) {
  const isUser = message.role === 'user';
  const [htmlContent, setHtmlContent] = useState<string>('');

  useEffect(() => {
    if (isUser) {
      setHtmlContent(escapeHtml(message.content));
      return;
    }
    // assistant 메시지는 코드 블록 하이라이팅
    highlightMarkdown(message.content).then((html) => {
      setHtmlContent(html);
    });
  }, [message.content, isUser]);

  return (
    <div className={`flex gap-3 ${isUser ? 'flex-row-reverse' : ''}`}>
      {/* Avatar */}
      <div
        className={[
          'w-8 h-8 rounded-full flex-shrink-0 flex items-center justify-center text-sm font-semibold',
          isUser
            ? 'bg-gradient-to-br from-indigo-500 to-violet-500 text-white'
            : 'bg-[#1E2535] text-slate-400 border border-[#2A3347]',
        ].join(' ')}
      >
        {isUser ? 'U' : '🤖'}
      </div>

      {/* Bubble */}
      <div
        className={[
          'max-w-[660px] px-4 py-3 rounded-xl text-[14px] leading-relaxed',
          isUser
            ? 'bg-[#312E81] text-indigo-100 rounded-tr-sm'
            : 'bg-[#161B27] border border-[#1E2535] text-slate-300 rounded-tl-sm',
        ].join(' ')}
      >
        {/* 첨부파일 미리보기 */}
        {message.attachments && message.attachments.length > 0 && (
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
        )}

        {isUser ? (
          <span className="whitespace-pre-wrap">{message.content}</span>
        ) : (
          <div
            className="prose-sm prose-invert max-w-none shiki-wrap"
            dangerouslySetInnerHTML={{ __html: htmlContent || message.content }}
          />
        )}

        {isStreaming && (
          <span className="inline-block w-1 h-4 bg-indigo-400 ml-0.5 animate-pulse rounded-sm" />
        )}
      </div>
    </div>
  );
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
