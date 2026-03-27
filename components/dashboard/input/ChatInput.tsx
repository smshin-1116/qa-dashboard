'use client';

import { useRef, useState, useCallback } from 'react';
import type { Attachment } from '@/types/session';
import type { AIModel } from '@/types/session';
import { canUseMcp, MODEL_SUPPORT } from '@/constants/modelSupport';

interface ChatInputProps {
  activeModel: AIModel;
  onSend: (content: string, attachments: Attachment[]) => void;
  disabled?: boolean;
  hasMcpTool?: boolean;
}

/** 모델별 이미지 첨부 지원 여부 — 현재는 Claude만 지원 */
function supportsImageAttachment(model: AIModel): boolean {
  return model === 'claude' && MODEL_SUPPORT[model].enabled;
}

let attachIdCounter = 0;

export default function ChatInput({
  activeModel,
  onSend,
  disabled,
  hasMcpTool = false,
}: ChatInputProps) {
  const [value, setValue] = useState('');
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [codeMode, setCodeMode] = useState(false);
  const [focused, setFocused] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const dragCounterRef = useRef(0);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const imageInputRef = useRef<HTMLInputElement>(null);

  const handleSend = useCallback(() => {
    const content = value.trim();
    if (!content && attachments.length === 0) return;

    // Guard 2단계: MCP 툴 포함 메시지인데 모델이 MCP 미지원인 경우
    if (hasMcpTool && !canUseMcp(activeModel)) {
      alert('이 모델은 MCP 툴을 지원하지 않습니다. Claude로 전환 후 사용하세요.');
      return;
    }

    onSend(content, attachments);
    setValue('');
    setAttachments([]);
    setCodeMode(false);
    textareaRef.current?.focus();
  }, [value, attachments, hasMcpTool, activeModel, onSend]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      // 한국어/일본어/중국어 IME 조합 중에는 Enter로 전송하지 않음
      // isComposing = true 이면 IME가 아직 문자를 확정하지 않은 상태
      if (e.nativeEvent.isComposing) return;
      e.preventDefault();
      handleSend();
    }
  };

  const handleFileChange = async (
    e: React.ChangeEvent<HTMLInputElement>,
    type: 'file' | 'image'
  ) => {
    const files = Array.from(e.target.files ?? []);
    const newAttachments: Attachment[] = await Promise.all(
      files.map(
        (file) =>
          new Promise<Attachment>((resolve) => {
            const reader = new FileReader();
            reader.onload = () => {
              resolve({
                id: `att-${++attachIdCounter}`,
                type,
                name: file.name,
                data: reader.result as string,
                mimeType: file.type,
              });
            };
            reader.readAsDataURL(file);
          })
      )
    );
    setAttachments((prev) => [...prev, ...newAttachments]);
    e.target.value = '';
  };

  const handleCodeToggle = () => {
    if (!codeMode) {
      // 코드 모드 ON: 현재 텍스트를 코드 첨부로 변환
      const code = value.trim();
      if (code) {
        setAttachments((prev) => [
          ...prev,
          {
            id: `att-${++attachIdCounter}`,
            type: 'code',
            name: 'snippet.ts',
            data: code,
          },
        ]);
        setValue('');
      }
    }
    setCodeMode((prev) => !prev);
  };

  const removeAttachment = (id: string) => {
    setAttachments((prev) => prev.filter((a) => a.id !== id));
  };

  const processFiles = useCallback(async (files: File[]) => {
    const newAttachments: Attachment[] = await Promise.all(
      files.map(
        (file) =>
          new Promise<Attachment>((resolve) => {
            const reader = new FileReader();
            reader.onload = () => {
              resolve({
                id: `att-${++attachIdCounter}`,
                type: file.type.startsWith('image/') ? 'image' : 'file',
                name: file.name,
                data: reader.result as string,
                mimeType: file.type,
              });
            };
            reader.readAsDataURL(file);
          })
      )
    );
    setAttachments((prev) => [...prev, ...newAttachments]);
  }, []);

  const handleDragEnter = (e: React.DragEvent) => {
    e.preventDefault();
    dragCounterRef.current += 1;
    if (dragCounterRef.current === 1) setIsDragging(true);
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    dragCounterRef.current -= 1;
    if (dragCounterRef.current === 0) setIsDragging(false);
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    dragCounterRef.current = 0;
    setIsDragging(false);
    const files = Array.from(e.dataTransfer.files);
    if (files.length > 0) processFiles(files);
  };

  return (
    <div
      className="px-6 pb-[18px] pt-[14px] bg-[#0F1117] border-t border-[#1E2535] flex-shrink-0 relative"
      onDragEnter={handleDragEnter}
      onDragLeave={handleDragLeave}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
    >
      {isDragging && (
        <div className="absolute inset-0 z-10 bg-indigo-900/40 border-2 border-dashed border-indigo-500 rounded-[10px] flex items-center justify-center pointer-events-none">
          <span className="text-indigo-300 text-[14px] font-medium">파일을 여기에 놓으세요</span>
        </div>
      )}
      {/* 첨부파일 미리보기 */}
      {attachments.length > 0 && (
        <div className="flex gap-2 flex-wrap mb-2.5">
          {attachments.map((att) => (
            <div
              key={att.id}
              className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-md bg-[#1E2535] border border-[#2A3347] text-[12px] text-slate-400"
            >
              {att.type === 'image' ? '🖼' : att.type === 'code' ? '💻' : '📎'}
              <span className="truncate max-w-[120px]">{att.name}</span>
              <button
                onClick={() => removeAttachment(att.id)}
                className="w-[14px] h-[14px] rounded-full bg-[#374151] text-slate-400 flex items-center justify-center text-[9px] hover:bg-red-800 hover:text-red-300 transition-colors ml-0.5"
              >
                ✕
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Input box */}
      <div
        className={[
          'flex items-end bg-[#161B27] border rounded-[10px] px-3 py-2.5 gap-2 transition-colors',
          focused ? 'border-indigo-600' : 'border-[#2A3347]',
        ].join(' ')}
      >
        {/* Left actions */}
        <div className="flex gap-1 items-center flex-shrink-0 pb-0.5">
          {/* 파일 업로드 */}
          <input
            ref={fileInputRef}
            type="file"
            multiple
            className="hidden"
            onChange={(e) => handleFileChange(e, 'file')}
          />
          <button
            onClick={() => fileInputRef.current?.click()}
            title="파일 첨부"
            className="w-[30px] h-[30px] rounded-md bg-[#1E2535] border border-[#2A3347] flex items-center justify-center text-slate-500 hover:text-slate-300 hover:border-slate-500 transition-colors text-[13px]"
          >
            📎
          </button>

          {/* 이미지 업로드 (R-05: Claude만 지원) */}
          <input
            ref={imageInputRef}
            type="file"
            accept="image/*"
            multiple
            className="hidden"
            onChange={(e) => handleFileChange(e, 'image')}
          />
          <button
            onClick={() => {
              if (!supportsImageAttachment(activeModel)) return;
              imageInputRef.current?.click();
            }}
            title={
              supportsImageAttachment(activeModel)
                ? '이미지 첨부'
                : '이미지 첨부는 Claude 모델만 지원합니다'
            }
            disabled={!supportsImageAttachment(activeModel)}
            className={[
              'w-[30px] h-[30px] rounded-md border flex items-center justify-center transition-colors text-[13px]',
              supportsImageAttachment(activeModel)
                ? 'bg-[#1E2535] border-[#2A3347] text-slate-500 hover:text-slate-300 hover:border-slate-500 cursor-pointer'
                : 'bg-[#131820] border-[#1E2535] text-slate-700 cursor-not-allowed opacity-50',
            ].join(' ')}
          >
            🖼
          </button>

          {/* 코드 스니펫 */}
          <button
            onClick={handleCodeToggle}
            title="코드 입력"
            className={[
              'w-[30px] h-[30px] rounded-md border flex items-center justify-center transition-colors text-[13px]',
              codeMode
                ? 'bg-[#2A1E4A] border-indigo-600 text-indigo-400'
                : 'bg-[#1E2535] border-[#2A3347] text-slate-500 hover:text-slate-300 hover:border-slate-500',
            ].join(' ')}
          >
            {'</>'}
          </button>

          <div className="w-px h-5 bg-[#2A3347] mx-0.5" />
        </div>

        {/* Textarea */}
        <textarea
          ref={textareaRef}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={handleKeyDown}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          placeholder={
            codeMode ? '코드를 입력하세요... (Enter로 첨부)' : 'QA Agent에게 메시지를 입력하세요...'
          }
          disabled={disabled}
          rows={1}
          className="flex-1 bg-transparent border-none outline-none resize-none text-[14px] text-slate-200 leading-relaxed placeholder:text-[#374151] min-h-[42px] max-h-[140px] font-[inherit] disabled:opacity-50"
          style={{
            fontFamily: codeMode ? "'SF Mono', 'Fira Code', monospace" : 'inherit',
          }}
          onInput={(e) => {
            const el = e.currentTarget;
            el.style.height = 'auto';
            el.style.height = `${el.scrollHeight}px`;
          }}
        />

        {/* Send button */}
        <button
          onClick={handleSend}
          disabled={disabled || (!value.trim() && attachments.length === 0)}
          className="flex-shrink-0 w-9 h-9 rounded-lg bg-indigo-600 flex items-center justify-center text-white hover:bg-indigo-500 disabled:opacity-30 disabled:cursor-not-allowed transition-colors pb-0.5 text-lg"
        >
          ↑
        </button>
      </div>

      <p className="text-[11px] text-slate-600 mt-2 text-center">
        Enter로 전송 · Shift+Enter 줄바꿈 · 파일/이미지/코드 첨부 가능 · 드래그 앤 드롭 지원
      </p>
    </div>
  );
}
