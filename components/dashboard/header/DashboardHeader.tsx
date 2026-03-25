'use client';

import { MODEL_SUPPORT, isEnabled, canUseMcp } from '@/constants/modelSupport';
import type { AIModel } from '@/types/session';

const MODEL_KEYS = Object.keys(MODEL_SUPPORT) as AIModel[];

interface DashboardHeaderProps {
  activeModel: AIModel;
  onModelChange: (model: AIModel) => void;
  mcpStatus: { figma: boolean; jira: boolean; git: boolean };
}

export default function DashboardHeader({
  activeModel,
  onModelChange,
  mcpStatus,
}: DashboardHeaderProps) {
  return (
    <header className="flex items-center justify-between px-5 h-14 bg-[#161B27] border-b border-[#1E2535] flex-shrink-0 gap-4">
      {/* Left */}
      <div className="flex items-center gap-3 flex-shrink-0">
        <div className="w-7 h-7 rounded-md bg-gradient-to-br from-indigo-500 to-violet-500 flex items-center justify-center text-sm font-bold text-white">
          Q
        </div>
        <div>
          <div className="text-[15px] font-semibold text-slate-100">QA Agent</div>
          <div className="text-[11px] text-slate-500">Dashboard</div>
        </div>
      </div>

      {/* MCP Badges */}
      <div className="flex gap-1.5 items-center">
        <McpBadge label="Figma" connected={mcpStatus.figma} color="figma" />
        <McpBadge label="Jira" connected={mcpStatus.jira} color="jira" />
        <McpBadge label="GitHub" connected={mcpStatus.git} color="git" />
      </div>

      {/* AI Model Switcher */}
      <div className="flex items-center bg-[#0F1520] border border-[#2A3347] rounded-lg p-[3px] gap-0.5 flex-shrink-0">
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
              <span className="text-[9px] opacity-70 font-normal">{info.version}</span>
            </button>
          );
        })}
      </div>

      {/* Right actions */}
      <div className="flex items-center gap-1.5 flex-shrink-0">
        <button className="w-[30px] h-[30px] rounded-md bg-[#1E2535] border border-[#2A3347] flex items-center justify-center text-slate-400 hover:text-slate-200 transition-colors text-sm">
          ⚙
        </button>
      </div>
    </header>
  );
}

function McpBadge({
  label,
  connected,
  color,
}: {
  label: string;
  connected: boolean;
  color: 'figma' | 'jira' | 'git';
}) {
  const styles = {
    figma: {
      container: 'bg-[#2A1A1A] border-[#7C3626] text-orange-400',
      dot: '#F97316',
    },
    jira: {
      container: 'bg-[#121D2E] border-[#1A4A7A] text-blue-400',
      dot: '#60A5FA',
    },
    git: {
      container: 'bg-[#162110] border-[#2D4A15] text-green-400',
      dot: '#4ADE80',
    },
  };

  const s = styles[color];
  return (
    <div
      className={`flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-medium border ${s.container}`}
    >
      <span
        className="w-1.5 h-1.5 rounded-full"
        style={{
          backgroundColor: connected ? s.dot : '#374151',
          boxShadow: connected ? `0 0 4px ${s.dot}` : 'none',
        }}
      />
      {label}
    </div>
  );
}
