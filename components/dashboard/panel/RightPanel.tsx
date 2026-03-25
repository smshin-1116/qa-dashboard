'use client';

import { useState } from 'react';
import type { Session } from '@/types/session';

interface McpTool {
  name: string;
  tools: string[];
  connected: boolean;
}

interface RightPanelProps {
  session: Session | null;
  mcpTools: McpTool[];
}

const TABS = ['MCP', '세션 정보'] as const;
type Tab = (typeof TABS)[number];

export default function RightPanel({ session, mcpTools }: RightPanelProps) {
  const [activeTab, setActiveTab] = useState<Tab>('MCP');

  return (
    <aside className="w-[276px] bg-[#161B27] border-l border-[#1E2535] flex flex-col flex-shrink-0">
      {/* Tabs */}
      <div className="flex border-b border-[#1E2535]">
        {TABS.map((tab) => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab)}
            className={[
              'flex-1 py-[11px] px-1.5 text-center text-[11px] font-medium transition-colors border-b-2',
              activeTab === tab
                ? 'text-indigo-400 border-indigo-600'
                : 'text-slate-500 border-transparent hover:text-slate-400',
            ].join(' ')}
          >
            {tab}
          </button>
        ))}
      </div>

      <div className="flex-1 overflow-y-auto p-3.5">
        {activeTab === 'MCP' && <McpTab mcpTools={mcpTools} />}
        {activeTab === '세션 정보' && <SessionInfoTab session={session} />}
      </div>
    </aside>
  );
}

function McpTab({ mcpTools }: { mcpTools: McpTool[] }) {
  return (
    <div>
      <p className="text-[10px] font-bold text-slate-500 uppercase tracking-wider mb-2.5">
        연결된 MCP 서버
      </p>
      {mcpTools.map((mcp) => (
        <div
          key={mcp.name}
          className="bg-[#0F1520] border border-[#1E2535] rounded-lg p-3 mb-2"
        >
          <div className="flex items-center justify-between mb-2">
            <span className="text-[12px] font-semibold text-slate-300 flex items-center gap-1.5">
              {mcp.name === 'Figma' ? '🎨' : mcp.name === 'Jira' ? '📋' : '🐙'}
              {mcp.name}
            </span>
            <span
              className={[
                'text-[10px] px-2 py-0.5 rounded-full',
                mcp.connected
                  ? 'bg-[#0D2A1A] text-green-400'
                  : 'bg-[#1A2535] text-slate-500',
              ].join(' ')}
            >
              {mcp.connected ? 'connected' : 'disconnected'}
            </span>
          </div>
          <div className="flex flex-wrap gap-1">
            {mcp.tools.map((tool) => (
              <span
                key={tool}
                className="text-[10px] px-1.5 py-0.5 rounded bg-[#1E2535] text-slate-500 border border-[#2A3347]"
              >
                {tool}
              </span>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

function SessionInfoTab({ session }: { session: Session | null }) {
  if (!session) {
    return <p className="text-[12px] text-slate-500 py-4 text-center">활성 세션 없음</p>;
  }

  const userCount = session.messages.filter((m) => m.role === 'user').length;
  const assistantCount = session.messages.filter((m) => m.role === 'assistant').length;

  return (
    <div>
      <p className="text-[10px] font-bold text-slate-500 uppercase tracking-wider mb-2.5">
        세션 통계
      </p>
      <div className="space-y-2">
        <StatRow label="전체 메시지" value={session.messages.length} />
        <StatRow label="사용자 입력" value={userCount} />
        <StatRow label="AI 응답" value={assistantCount} />
        <StatRow label="사용 모델" value={session.model} />
      </div>
    </div>
  );
}

function StatRow({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="flex justify-between py-1.5 border-b border-[#1E2535]">
      <span className="text-[12px] text-slate-500">{label}</span>
      <span className="text-[12px] font-semibold text-slate-300">{value}</span>
    </div>
  );
}
