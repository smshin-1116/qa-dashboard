'use client';

import { useState, useEffect } from 'react';
import type { Session, AgentMode } from '@/types/session';
import type { PanelTab } from '@/constants/workspaces';
import { useSessionStore } from '@/stores/useSessionStore';
import { hasTcResult } from '@/lib/tcExport';
import PipelineRunner from '@/components/dashboard/pipeline/PipelineRunner';
import QualityReport from '@/components/dashboard/quality/QualityReport';

interface McpTool {
  name: string;
  tools: string[];
  connected: boolean;
}

interface RightPanelProps {
  session: Session | null;
  mcpTools: McpTool[];
  activeAgentMode: AgentMode;
  onAgentModeChange: (mode: AgentMode) => void;
  /** 워크스페이스별로 노출할 탭 (순서대로). 미지정 시 전체 노출 */
  panelTabs?: PanelTab[];
}

const ALL_TABS: PanelTab[] = ['파이프라인', '품질', 'MCP', '세션'];

export default function RightPanel({
  session,
  mcpTools,
  activeAgentMode,
  onAgentModeChange,
  panelTabs = ALL_TABS,
}: RightPanelProps) {
  const tabs = panelTabs.length > 0 ? panelTabs : ALL_TABS;
  const [activeTab, setActiveTab] = useState<PanelTab>(tabs[0]);

  // 파이프라인이 store에 직접 addMessage하므로, 품질 배지도 store 직접 구독해야 실시간 반영됨
  const storeSession = useSessionStore((state) => state.activeSession);
  const hasTcData = hasTcResult(storeSession ?? session);

  // 워크스페이스 전환으로 탭 구성이 바뀌면 활성 탭이 없어질 수 있어 보정
  useEffect(() => {
    if (!tabs.includes(activeTab)) setActiveTab(tabs[0]);
  }, [tabs, activeTab]);

  return (
    <aside className="w-[276px] bg-[var(--panel)] border-l border-[var(--line)] flex flex-col flex-shrink-0">
      {/* Tabs */}
      <div className="flex border-b border-[var(--line)]">
        {tabs.map((tab) => {
          const dot = tab === '품질' && hasTcData;
          return (
            <button
              key={tab}
              onClick={() => setActiveTab(tab)}
              className={[
                'flex-1 py-[11px] px-0.5 text-center text-[11px] font-medium transition-colors border-b-2 relative',
                activeTab === tab
                  ? 'text-[var(--accent)] border-indigo-600'
                  : 'text-[var(--tx-3)] border-transparent hover:text-[var(--tx-3)]',
              ].join(' ')}
            >
              {tab}
              {dot && (
                <span className="absolute top-1.5 right-0.5 w-1.5 h-1.5 rounded-full bg-indigo-400" />
              )}
            </button>
          );
        })}
      </div>

      <div className="flex-1 overflow-y-auto p-3.5">
        {activeTab === '파이프라인' && (
          <PipelineRunner
            session={session}
            activeAgentMode={activeAgentMode}
            onAgentModeChange={onAgentModeChange}
          />
        )}
        {activeTab === '품질' && <QualityReport session={session} />}
        {activeTab === 'MCP' && <McpTab mcpTools={mcpTools} />}
        {activeTab === '세션' && <SessionInfoTab session={session} />}
      </div>
    </aside>
  );
}

// ─── MCP 탭 ──────────────────────────────────────────────────────────────────

function McpTab({ mcpTools }: { mcpTools: McpTool[] }) {
  return (
    <div>
      <p className="text-[10px] font-bold text-[var(--tx-3)] uppercase tracking-wider mb-2.5">연결된 MCP 서버</p>
      {mcpTools.map((mcp) => (
        <div key={mcp.name} className="bg-[var(--inset)] border border-[var(--line)] rounded-lg p-3 mb-2">
          <div className="flex items-center justify-between mb-2">
            <span className="text-[12px] font-semibold text-[var(--tx-2)] flex items-center gap-1.5">
              {mcp.name === 'Figma' ? '🎨' : mcp.name === 'Jira' ? '📋' : '🐙'}
              {mcp.name}
            </span>
            <span className={['text-[10px] px-2 py-0.5 rounded-full', mcp.connected ? 'bg-[color-mix(in_srgb,var(--ok)_14%,transparent)] text-green-400' : 'bg-[var(--panel-hi)] text-[var(--tx-3)]'].join(' ')}>
              {mcp.connected ? 'connected' : 'disconnected'}
            </span>
          </div>
          <div className="flex flex-wrap gap-1">
            {mcp.tools.map((tool) => (
              <span key={tool} className="text-[10px] px-1.5 py-0.5 rounded bg-[var(--line)] text-[var(--tx-3)] border border-[var(--line-2)]">
                {tool}
              </span>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

// ─── 세션 탭 ─────────────────────────────────────────────────────────────────

function SessionInfoTab({ session }: { session: Session | null }) {
  if (!session) return <p className="text-[12px] text-[var(--tx-3)] py-4 text-center">활성 세션 없음</p>;

  const userCount = session.messages.filter((m) => m.role === 'user').length;
  const assistantCount = session.messages.filter((m) => m.role === 'assistant').length;

  return (
    <div>
      <p className="text-[10px] font-bold text-[var(--tx-3)] uppercase tracking-wider mb-2.5">세션 통계</p>
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
    <div className="flex justify-between py-1.5 border-b border-[var(--line)]">
      <span className="text-[12px] text-[var(--tx-3)]">{label}</span>
      <span className="text-[12px] font-semibold text-[var(--tx-2)]">{value}</span>
    </div>
  );
}
