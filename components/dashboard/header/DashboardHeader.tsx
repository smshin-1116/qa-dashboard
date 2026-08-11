'use client';

import Link from 'next/link';
import { MODEL_SUPPORT, isEnabled, canUseMcp } from '@/constants/modelSupport';
import { WORKSPACES } from '@/constants/workspaces';
import type { AIModel, WorkspaceKind } from '@/types/session';

const MODEL_KEYS = Object.keys(MODEL_SUPPORT) as AIModel[];

interface DashboardHeaderProps {
  activeModel: AIModel;
  onModelChange: (model: AIModel) => void;
  /** CLI가 보고한 실제 claude 버전 라벨 (예: "Sonnet 4.6"). 없으면 정적 기본값 사용 */
  claudeVersion?: string | null;
  /** 현재 워크스페이스 — 헤더 탭 활성 표시 */
  activeWorkspaceKey: WorkspaceKind;
  /**
   * 🔔 알림 건수. 0이면 배지를 숨긴다.
   *
   * 알림을 워크스페이스 탭이 아니라 헤더 우측에 둔 이유:
   * "오늘 할 일"은 오늘 처리할 것, "알림"은 며칠째 정체된 것으로 성격이 달라
   * 섞으면 오늘 할 일이 잔소리로 오염된다. 탭 수도 늘지 않는다.
   */
  noticeCount?: number;
}

export default function DashboardHeader({
  activeModel,
  onModelChange,
  claudeVersion,
  activeWorkspaceKey,
  noticeCount = 0,
}: DashboardHeaderProps) {
  return (
    <header className="relative flex items-center justify-between px-5 h-14 bg-[#161B27] border-b border-[#1E2535] flex-shrink-0 gap-4">
      {/* Left: 로고 */}
      <div className="flex items-center gap-3 flex-shrink-0">
        <div className="w-7 h-7 rounded-md bg-gradient-to-br from-indigo-500 to-violet-500 flex items-center justify-center text-sm font-bold text-white">
          Q
        </div>
        <div>
          <div className="text-[15px] font-semibold text-slate-100">QA Agent</div>
          <div className="text-[11px] text-slate-500">Dashboard</div>
        </div>
      </div>

      {/* Center: Workspace 전환 탭 (절대 중앙 정렬, constants/workspaces.ts로 확장) */}
      <nav className="absolute left-1/2 -translate-x-1/2 flex items-center gap-1 bg-[#0F1520] border border-[#2A3347] rounded-lg p-[3px]">
        {WORKSPACES.map((ws) => {
          const active = ws.key === activeWorkspaceKey;
          return (
            <Link
              key={ws.key}
              href={ws.path}
              title={ws.description}
              className={[
                'flex items-center gap-1.5 px-3.5 py-1.5 rounded-md text-[12px] font-semibold transition-all whitespace-nowrap border',
                active
                  ? 'bg-[#1E1A3A] border-indigo-600 text-indigo-300'
                  : 'bg-transparent border-transparent text-slate-500 hover:bg-[#1E2535] hover:text-slate-300',
              ].join(' ')}
            >
              <span>{ws.icon}</span>
              <span>{ws.label}</span>
            </Link>
          );
        })}
      </nav>

      {/* Right: 알림 + AI 모델 + 설정 */}
      <div className="flex items-center gap-2 flex-shrink-0">
        {/* 🔔 알림 — 탭이 아니라 별도 진입점 (며칠째 정체된 느린 신호) */}
        {noticeCount > 0 && (
          <Link
            href="/dashboard/notice"
            title={`정체·방치 신호 ${noticeCount}건 (오늘 할 일과 분리)`}
            className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-[10.5px] font-semibold
                       bg-[#0F1520] border border-[#2A3347] text-slate-400
                       hover:text-slate-200 hover:border-indigo-700 transition-colors"
          >
            <span>🔔</span>
            <span className="font-mono tabular-nums px-1 rounded bg-amber-400 text-[#0B0F17] text-[9px] font-bold">
              {noticeCount}
            </span>
          </Link>
        )}

        <div className="flex items-center bg-[#0F1520] border border-[#2A3347] rounded-lg p-[3px] gap-0.5">
          <span className="text-[10px] text-slate-500 font-semibold uppercase tracking-wide px-2 border-r border-[#2A3347] mr-0.5 whitespace-nowrap">
            AI
          </span>
          {MODEL_KEYS.map((model) => {
            const info = MODEL_SUPPORT[model];
            const active = activeModel === model;
            const enabled = isEnabled(model);

            return (
              <button
                key={model}
                onClick={() => {
                  if (!enabled) return;
                  onModelChange(model);
                }}
                title={
                  !enabled
                    ? `${info.label} — 준비 중`
                    : canUseMcp(model)
                    ? `${info.label} (MCP 지원)`
                    : `${info.label} (MCP 미지원)`
                }
                disabled={!enabled}
                className={[
                  'flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-[11px] font-semibold transition-all whitespace-nowrap border',
                  enabled ? 'cursor-pointer' : 'cursor-not-allowed opacity-40',
                  active && model === 'claude'
                    ? 'bg-[#1E1A3A] border-indigo-600 text-indigo-400'
                    : active && model === 'gemini'
                    ? 'bg-[#1A2A1A] border-green-700 text-green-400'
                    : active && model === 'codex'
                    ? 'bg-[#1A1A2E] border-purple-700 text-purple-400'
                    : 'bg-transparent border-transparent text-slate-500 hover:bg-[#1E2535] hover:text-slate-400',
                ].join(' ')}
              >
                <span
                  className="w-[7px] h-[7px] rounded-full flex-shrink-0"
                  style={{
                    backgroundColor: info.color,
                    boxShadow: active ? `0 0 5px ${info.color}` : 'none',
                  }}
                />
                {info.label}
                <span className="text-[9px] opacity-70 font-normal">
                  {model === 'claude' && claudeVersion ? claudeVersion : info.version}
                </span>
              </button>
            );
          })}
        </div>

        <button className="w-[30px] h-[30px] rounded-md bg-[#1E2535] border border-[#2A3347] flex items-center justify-center text-slate-400 hover:text-slate-200 transition-colors text-sm">
          ⚙
        </button>
      </div>
    </header>
  );
}
