'use client';

import { MODEL_SUPPORT } from '@/constants/modelSupport';
import type { AIModel } from '@/types/session';

interface ModelSwitchModalProps {
  from: AIModel;
  to: AIModel;
  hasMessages: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export default function ModelSwitchModal({
  from,
  to,
  hasMessages,
  onConfirm,
  onCancel,
}: ModelSwitchModalProps) {
  const fromInfo = MODEL_SUPPORT[from];
  const toInfo = MODEL_SUPPORT[to];

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
      onClick={onCancel}
    >
      <div
        className="bg-[#161B27] border border-[#2A3347] rounded-2xl p-6 w-[400px] shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Icon */}
        <div className="w-11 h-11 rounded-xl bg-[#1E1A3A] border border-indigo-800 flex items-center justify-center text-xl mb-4">
          🔄
        </div>

        <h3 className="text-[15px] font-semibold text-slate-100 mb-1">AI 모델 전환</h3>

        <p className="text-[13px] text-slate-400 mb-4 leading-relaxed">
          <span style={{ color: fromInfo.color }} className="font-semibold">
            {fromInfo.label}
          </span>
          {' → '}
          <span style={{ color: toInfo.color }} className="font-semibold">
            {toInfo.label}
          </span>
          으로 전환합니다.
        </p>

        {hasMessages && (
          <div className="bg-[#1A1500] border border-yellow-900 rounded-lg px-3.5 py-3 mb-4 text-[12px] text-yellow-400 leading-relaxed">
            ⚠️ 현재 대화의 히스토리는 유지되지만, 새 모델이 이전 맥락을{' '}
            <strong>완전히 이해하지 못할 수 있습니다.</strong>
          </div>
        )}

        {!toInfo.mcpNative && (
          <div className="bg-[#1A1020] border border-purple-900 rounded-lg px-3.5 py-3 mb-4 text-[12px] text-purple-300 leading-relaxed">
            ℹ️{' '}
            <strong>{toInfo.label}</strong>은 MCP 툴을 기본 지원하지 않습니다.
            Figma·Jira·GitHub 연동 기능은 이 세션에서 사용할 수 없습니다.
          </div>
        )}

        <div className="flex gap-2 justify-end">
          <button
            onClick={onCancel}
            className="px-4 py-2 rounded-lg text-[13px] font-medium text-slate-400 bg-[#1E2535] border border-[#2A3347] hover:text-slate-200 hover:border-slate-500 transition-colors"
          >
            취소
          </button>
          <button
            onClick={onConfirm}
            className="px-4 py-2 rounded-lg text-[13px] font-semibold text-white transition-colors"
            style={{ backgroundColor: toInfo.color }}
          >
            {toInfo.label}로 전환
          </button>
        </div>
      </div>
    </div>
  );
}
