'use client';

import { useState, useMemo, useCallback, useRef } from 'react';
import type { Session } from '@/types/session';
import type { AgentMode } from '@/types/session';
import { extractTcRows } from '@/lib/tcExport';
import { analyzeTcQuality, type TcQualityResult, type CheckStatus } from '@/lib/tcQuality';
import { useSessionStore } from '@/stores/useSessionStore';
import type { PipelineEvent } from '@/app/api/pipeline/run/route';

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
}

const TABS = ['파이프라인', '품질', 'MCP', '세션'] as const;
type Tab = (typeof TABS)[number];

export default function RightPanel({ session, mcpTools, activeAgentMode, onAgentModeChange }: RightPanelProps) {
  const [activeTab, setActiveTab] = useState<Tab>('파이프라인');

  const qualityResult = useMemo(() => {
    if (!session) return null;
    const allRows = session.messages
      .filter((m) => m.role === 'assistant')
      .flatMap((m) => extractTcRows(m.content));
    return analyzeTcQuality(allRows);
  }, [session]);

  const hasTcData = !!qualityResult;

  return (
    <aside className="w-[276px] bg-[#161B27] border-l border-[#1E2535] flex flex-col flex-shrink-0">
      {/* Tabs */}
      <div className="flex border-b border-[#1E2535]">
        {TABS.map((tab) => {
          const dot = tab === '품질' && hasTcData;
          return (
            <button
              key={tab}
              onClick={() => setActiveTab(tab)}
              className={[
                'flex-1 py-[11px] px-0.5 text-center text-[11px] font-medium transition-colors border-b-2 relative',
                activeTab === tab
                  ? 'text-indigo-400 border-indigo-600'
                  : 'text-slate-500 border-transparent hover:text-slate-400',
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
          <PipelineTab
            session={session}
            activeAgentMode={activeAgentMode}
            onAgentModeChange={onAgentModeChange}
          />
        )}
        {activeTab === '품질' && <TcQualityTab result={qualityResult} />}
        {activeTab === 'MCP' && <McpTab mcpTools={mcpTools} />}
        {activeTab === '세션' && <SessionInfoTab session={session} />}
      </div>
    </aside>
  );
}

// ─── 파이프라인 탭 ─────────────────────────────────────────────────────────────

interface PipelineStage {
  mode: AgentMode;
  label: string;
  emoji: string;
  description: string;
  detectDone: (allContent: string) => boolean;
}

const STAGES: PipelineStage[] = [
  {
    mode: 'designer',
    label: 'TC 설계',
    emoji: '📐',
    description: '기획서 분석 · 대/중/소분류 구조 설계',
    detectDone: (c) => /대분류|중분류|소분류|TC 설계|검증 관점|테스트 구조|분류 구조/.test(c),
  },
  {
    mode: 'writer',
    label: 'TC 작성',
    emoji: '✏️',
    description: 'TC 생성 · 11컬럼 형식 작성',
    detectDone: (c) => /\|.*TC-\d+.*\|/.test(c),
  },
  {
    mode: 'reviewer',
    label: 'QA 리뷰',
    emoji: '🔍',
    description: 'EVAL 기준 품질 검증 · 이슈 도출',
    detectDone: (c) => /EVAL-|리뷰 보고서|이슈 목록|커버리지|Pass Gate/.test(c),
  },
  {
    mode: 'fixer',
    label: 'TC 수정',
    emoji: '🔧',
    description: '리뷰 이슈 반영 · TC 품질 개선',
    detectDone: (c) => /수정 완료|수정했|반영했|개선했|수정된 TC/.test(c),
  },
];

type PipelineStatus = 'idle' | 'running' | 'done' | 'error';

interface StageRunState {
  status: 'waiting' | 'running' | 'done' | 'error';
  liveContent: string;
  toolLabel: string;
}

function PipelineTab({
  session,
  activeAgentMode,
  onAgentModeChange,
}: {
  session: Session | null;
  activeAgentMode: AgentMode;
  onAgentModeChange: (mode: AgentMode) => void;
}) {
  const { addMessage, createSession, updateClaudeSessionId } = useSessionStore();

  const [confluenceUrl, setConfluenceUrl] = useState('');
  const [pipelineStatus, setPipelineStatus] = useState<PipelineStatus>('idle');
  const [runStates, setRunStates] = useState<StageRunState[]>(
    STAGES.map(() => ({ status: 'waiting', liveContent: '', toolLabel: '' }))
  );
  const [errorMsg, setErrorMsg] = useState('');
  const abortRef = useRef<AbortController | null>(null);

  // 어시스턴트 메시지 전체 합산 (수동 진행 감지용)
  const allContent = useMemo(() => {
    if (!session) return '';
    return session.messages
      .filter((m) => m.role === 'assistant')
      .map((m) => m.content)
      .join('\n');
  }, [session]);

  const stageStatuses = STAGES.map((s) => ({
    ...s,
    done: s.detectDone(allContent),
    active: s.mode === activeAgentMode,
  }));

  const doneCount = stageStatuses.filter((s) => s.done).length;
  const activeIdx = STAGES.findIndex((s) => s.mode === activeAgentMode);
  const nextStage = stageStatuses.find((s, i) => !s.done && i >= (activeIdx === -1 ? 0 : activeIdx));

  const updateStage = useCallback((idx: number, patch: Partial<StageRunState>) => {
    setRunStates((prev) => prev.map((s, i) => (i === idx ? { ...s, ...patch } : s)));
  }, []);

  const runPipeline = useCallback(async () => {
    if (!confluenceUrl.trim()) return;

    setPipelineStatus('running');
    setErrorMsg('');
    setRunStates(STAGES.map(() => ({ status: 'waiting', liveContent: '', toolLabel: '' })));

    // 세션 확보
    let currentSession = session;
    if (!currentSession) {
      currentSession = await createSession('claude');
    }

    abortRef.current = new AbortController();

    try {
      const res = await fetch('/api/pipeline/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          confluenceUrl: confluenceUrl.trim(),
          // 파이프라인은 항상 새 세션으로 시작 (채팅 세션과 독립)
        }),
        signal: abortRef.current.signal,
      });

      if (!res.ok || !res.body) throw new Error(`API 오류 (${res.status})`);

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          try {
            const event: PipelineEvent = JSON.parse(line.slice(6));

            if (event.type === 'stage_start') {
              updateStage(event.stageIndex, { status: 'running', liveContent: '', toolLabel: '' });
              onAgentModeChange(event.stage);
            }

            if (event.type === 'chunk') {
              setRunStates((prev) => {
                const runningIdx = prev.findIndex((s) => s.status === 'running');
                if (runningIdx === -1) return prev;
                return prev.map((s, i) =>
                  i === runningIdx ? { ...s, liveContent: s.liveContent + event.content } : s
                );
              });
            }

            if (event.type === 'tool') {
              setRunStates((prev) => {
                const runningIdx = prev.findIndex((s) => s.status === 'running');
                if (runningIdx === -1) return prev;
                return prev.map((s, i) =>
                  i === runningIdx ? { ...s, toolLabel: event.label } : s
                );
              });
            }

            if (event.type === 'stage_done') {
              updateStage(event.stageIndex, { status: 'done', toolLabel: '' });
              // 세션에 메시지 저장
              await addMessage({ role: 'user', content: event.userMessage, attachments: [] });
              await addMessage({ role: 'assistant', content: event.content, attachments: [] });
              if (event.claudeSessionId) {
                await updateClaudeSessionId(event.claudeSessionId);
              }
            }

            if (event.type === 'done') {
              setPipelineStatus('done');
            }

            if (event.type === 'error') {
              setErrorMsg(event.message);
              setPipelineStatus('error');
              setRunStates((prev) =>
                prev.map((s) => (s.status === 'running' ? { ...s, status: 'error' } : s))
              );
            }
          } catch {
            // JSON 파싱 실패 무시
          }
        }
      }
    } catch (err) {
      if ((err as Error).name === 'AbortError') return;
      setErrorMsg(err instanceof Error ? err.message : '알 수 없는 오류');
      setPipelineStatus('error');
    }
  }, [confluenceUrl, session, createSession, addMessage, updateClaudeSessionId, onAgentModeChange, updateStage]);

  const stopPipeline = useCallback(() => {
    abortRef.current?.abort();
    setPipelineStatus('idle');
    setRunStates(STAGES.map(() => ({ status: 'waiting', liveContent: '', toolLabel: '' })));
  }, []);

  const isRunning = pipelineStatus === 'running';

  return (
    <div className="space-y-3">
      {/* URL 입력 + 실행 버튼 */}
      <div className="bg-[#0F1520] border border-[#1E2535] rounded-lg p-3">
        <p className="text-[10px] font-bold text-slate-500 uppercase tracking-wider mb-2">자동 실행</p>
        <input
          type="text"
          value={confluenceUrl}
          onChange={(e) => setConfluenceUrl(e.target.value)}
          onPaste={(e) => setConfluenceUrl(e.clipboardData.getData('text'))}
          placeholder="Confluence URL 붙여넣기..."
          disabled={isRunning}
          className="w-full bg-[#161B27] border border-[#2A3347] rounded-md px-2.5 py-1.5 text-[11px] text-slate-300 placeholder:text-slate-600 outline-none focus:border-indigo-600 disabled:opacity-50 mb-2"
        />
        {isRunning ? (
          <button
            onClick={stopPipeline}
            className="w-full py-1.5 rounded-md bg-red-900/30 border border-red-800/40 text-[11px] font-semibold text-red-400 hover:bg-red-900/50 transition-colors"
          >
            ■ 중단
          </button>
        ) : (
          <button
            onClick={runPipeline}
            disabled={!confluenceUrl.trim()}
            className="w-full py-1.5 rounded-md bg-indigo-600 text-[11px] font-semibold text-white hover:bg-indigo-500 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
          >
            ▶ 파이프라인 자동 실행
          </button>
        )}
        {pipelineStatus === 'done' && (
          <p className="text-[10px] text-emerald-400 text-center mt-1.5">✓ 파이프라인 완료 — TC 다운로드 가능</p>
        )}
        {pipelineStatus === 'error' && (
          <p className="text-[10px] text-red-400 mt-1.5 leading-snug">오류: {errorMsg}</p>
        )}
      </div>

      {/* 단계 진행 표시 */}
      <div className="space-y-1">
        {STAGES.map((stage, i) => {
          const runState = runStates[i];
          const manualState = stageStatuses[i];
          const isRunningStage = runState.status === 'running';
          const isDoneStage = runState.status === 'done' || (!isRunning && manualState.done);
          const isActiveManual = !isRunning && manualState.active;
          const isError = runState.status === 'error';

          return (
            <div key={stage.mode}>
              <div
                className={[
                  'flex items-start gap-2.5 px-3 py-2 rounded-lg transition-all',
                  isRunningStage ? 'bg-indigo-900/20 border border-indigo-800/40' :
                  isDoneStage ? 'bg-[#0F1520]/60' :
                  isActiveManual ? 'bg-[#1A1F30] border border-[#2A3347]' :
                  isError ? 'bg-red-900/10 border border-red-900/30' :
                  'opacity-50',
                ].join(' ')}
              >
                {/* 아이콘 */}
                <div className={[
                  'w-6 h-6 rounded-full flex items-center justify-center flex-shrink-0 mt-0.5',
                  isRunningStage ? 'bg-indigo-600' :
                  isDoneStage ? 'bg-emerald-900/60 border border-emerald-700/50' :
                  isError ? 'bg-red-900/50' :
                  'bg-[#1E2535] border border-[#2A3347]',
                ].join(' ')}>
                  {isRunningStage ? (
                    <span className="w-3 h-3 border-2 border-white border-t-transparent rounded-full animate-spin block" />
                  ) : isDoneStage ? (
                    <span className="text-emerald-400 text-[11px]">✓</span>
                  ) : isError ? (
                    <span className="text-red-400 text-[10px]">✗</span>
                  ) : (
                    <span className="text-slate-600 text-[10px]">{i + 1}</span>
                  )}
                </div>

                {/* 내용 */}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center justify-between">
                    <span className={[
                      'text-[11px] font-semibold',
                      isRunningStage ? 'text-indigo-300' :
                      isDoneStage ? 'text-slate-400' :
                      isActiveManual ? 'text-slate-300' : 'text-slate-600',
                    ].join(' ')}>
                      {stage.emoji} {stage.label}
                    </span>
                    {!isRunning && !isDoneStage && (
                      <button
                        onClick={() => onAgentModeChange(stage.mode)}
                        className="text-[9px] text-slate-600 hover:text-indigo-400 transition-colors px-1"
                      >
                        전환
                      </button>
                    )}
                  </div>

                  {/* 실행 중 상태 */}
                  {isRunningStage && runState.toolLabel && (
                    <p className="text-[10px] text-indigo-400 mt-0.5 truncate">⚡ {runState.toolLabel}</p>
                  )}
                  {isRunningStage && !runState.toolLabel && (
                    <p className="text-[10px] text-slate-500 mt-0.5">생성 중...</p>
                  )}

                  {/* 완료 후 미리보기 (첫 50자) */}
                  {runState.status === 'done' && runState.liveContent && (
                    <p className="text-[10px] text-slate-600 mt-0.5 truncate">
                      {runState.liveContent.slice(0, 50)}…
                    </p>
                  )}
                </div>
              </div>

              {i < STAGES.length - 1 && (
                <div className="flex justify-start pl-[22px] py-0.5">
                  <div className="w-px h-2 bg-[#2A3347]" />
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* 수동 진행 — 다음 단계 추천 */}
      {!isRunning && nextStage && nextStage.mode !== activeAgentMode && pipelineStatus === 'idle' && (
        <div className="p-2.5 rounded-lg bg-[#0F1520] border border-[#2A3347]">
          <p className="text-[10px] text-slate-500 mb-1.5">다음 추천 단계</p>
          <button
            onClick={() => onAgentModeChange(nextStage.mode)}
            className="w-full flex items-center justify-between px-3 py-2 rounded-md bg-indigo-600/20 border border-indigo-700/40 hover:bg-indigo-600/30 transition-colors"
          >
            <span className="text-[12px] font-semibold text-indigo-300">
              {nextStage.emoji} {nextStage.label}
            </span>
            <span className="text-indigo-400 text-[14px]">→</span>
          </button>
        </div>
      )}
    </div>
  );
}

// ─── TC 품질 탭 ──────────────────────────────────────────────────────────────

function TcQualityTab({ result }: { result: TcQualityResult | null }) {
  if (!result) {
    return (
      <div className="flex flex-col items-center justify-center py-10 gap-2 text-center">
        <div className="w-10 h-10 rounded-xl bg-[#1E2535] flex items-center justify-center text-xl">📋</div>
        <p className="text-[12px] text-slate-500">TC 데이터 없음</p>
        <p className="text-[11px] text-slate-600">TC를 생성하면 자동으로 품질 분석이 실행됩니다</p>
      </div>
    );
  }

  const gradeColor: Record<string, string> = {
    A: '#34D399', B: '#60A5FA', C: '#FBBF24', D: '#F87171', F: '#EF4444',
  };
  const color = gradeColor[result.grade] ?? '#94A3B8';

  return (
    <div className="space-y-3">
      <div className="bg-[#0F1520] border border-[#1E2535] rounded-lg p-3">
        <div className="flex items-center justify-between mb-2.5">
          <span className="text-[10px] font-bold text-slate-500 uppercase tracking-wider">품질 점수</span>
          <span className="text-[10px] text-slate-500">{result.tcCount}개 TC 분석</span>
        </div>
        <div className="flex items-end gap-3 mb-2.5">
          <span className="text-[36px] font-bold leading-none" style={{ color }}>
            {result.score}
          </span>
          <div className="mb-1">
            <span className="text-[11px] text-slate-500">/ 100</span>
            <div className="flex items-center gap-1 mt-0.5">
              <span className="text-[13px] font-bold px-1.5 py-0.5 rounded" style={{ color, backgroundColor: `${color}18` }}>
                {result.grade}등급
              </span>
            </div>
          </div>
        </div>
        <div className="h-1.5 bg-[#1E2535] rounded-full overflow-hidden">
          <div className="h-full rounded-full transition-all" style={{ width: `${result.score}%`, backgroundColor: color }} />
        </div>
      </div>

      <div className="bg-[#0F1520] border border-[#1E2535] rounded-lg p-3">
        <p className="text-[10px] font-bold text-slate-500 uppercase tracking-wider mb-2.5">검증단계 분포</p>
        <PhaseBar label="정상" count={result.phaseDistribution.정상} total={result.phaseDistribution.total} color="#34D399" />
        <PhaseBar label="부정" count={result.phaseDistribution.부정} total={result.phaseDistribution.total} color="#F87171" />
        <PhaseBar label="예외" count={result.phaseDistribution.예외} total={result.phaseDistribution.total} color="#FBBF24" />
        {result.phaseDistribution.기타 > 0 && (
          <PhaseBar label="기타" count={result.phaseDistribution.기타} total={result.phaseDistribution.total} color="#6B7280" />
        )}
        <div className="mt-2 pt-2 border-t border-[#1E2535] flex items-center justify-between">
          <span className="text-[11px] text-slate-500">부정+예외</span>
          <span
            className="text-[11px] font-semibold"
            style={{ color: result.phaseDistribution.negativeRatio >= 49 && result.phaseDistribution.negativeRatio <= 65 ? '#34D399' : '#FBBF24' }}
          >
            {result.phaseDistribution.negativeRatio}%
            <span className="text-slate-600 font-normal ml-1">(목표 49~65%)</span>
          </span>
        </div>
      </div>

      <div className="bg-[#0F1520] border border-[#1E2535] rounded-lg p-3">
        <p className="text-[10px] font-bold text-slate-500 uppercase tracking-wider mb-2">EVAL 체크</p>
        <div className="space-y-1.5">
          {result.checks.map((check) => (
            <div key={check.id} className="flex items-start gap-2">
              <StatusIcon status={check.status} />
              <div className="flex-1 min-w-0">
                <div className="flex items-center justify-between gap-1">
                  <span className="text-[11px] text-slate-400 truncate">{check.label}</span>
                  <StatusBadge status={check.status} />
                </div>
                <p className="text-[10px] text-slate-600 mt-0.5 leading-snug">{check.detail}</p>
              </div>
            </div>
          ))}
        </div>
      </div>

      {result.issues.length > 0 ? (
        <div className="bg-[#0F1520] border border-[#1E2535] rounded-lg p-3">
          <p className="text-[10px] font-bold text-slate-500 uppercase tracking-wider mb-2">
            발견 이슈 ({result.issues.length})
          </p>
          <div className="space-y-2">
            {result.issues.map((issue, i) => (
              <div key={i} className="border-l-2 pl-2" style={{ borderColor: severityColor(issue.severity) }}>
                <div className="flex items-center gap-1.5 mb-0.5">
                  <span className="text-[9px] font-bold px-1 py-0.5 rounded" style={{ color: severityColor(issue.severity), backgroundColor: `${severityColor(issue.severity)}18` }}>
                    {issue.severity}
                  </span>
                  <span className="text-[11px] text-slate-300 font-medium">{issue.label}</span>
                </div>
                <p className="text-[10px] text-slate-500 leading-snug">{issue.detail}</p>
                {issue.tcIds && issue.tcIds.length > 0 && (
                  <p className="text-[10px] text-slate-600 mt-0.5 truncate">
                    {issue.tcIds.slice(0, 5).join(', ')}{issue.tcIds.length > 5 ? ` 외 ${issue.tcIds.length - 5}건` : ''}
                  </p>
                )}
              </div>
            ))}
          </div>
        </div>
      ) : (
        <div className="flex items-center gap-2 px-3 py-2.5 rounded-lg bg-emerald-900/20 border border-emerald-800/40">
          <span className="text-base">✓</span>
          <span className="text-[12px] text-emerald-400 font-medium">이슈 없음 — 품질 기준 통과</span>
        </div>
      )}
    </div>
  );
}

function PhaseBar({ label, count, total, color }: { label: string; count: number; total: number; color: string }) {
  const pct = total > 0 ? Math.round((count / total) * 100) : 0;
  return (
    <div className="flex items-center gap-2 mb-1.5">
      <span className="text-[11px] text-slate-500 w-8 flex-shrink-0">{label}</span>
      <div className="flex-1 h-1.5 bg-[#1E2535] rounded-full overflow-hidden">
        <div className="h-full rounded-full" style={{ width: `${pct}%`, backgroundColor: color }} />
      </div>
      <span className="text-[10px] text-slate-500 w-8 text-right flex-shrink-0">{pct}%</span>
    </div>
  );
}

function StatusIcon({ status }: { status: CheckStatus }) {
  if (status === 'pass') return <span className="text-emerald-400 text-[12px] flex-shrink-0 mt-0.5">✓</span>;
  if (status === 'warn') return <span className="text-amber-400 text-[12px] flex-shrink-0 mt-0.5">!</span>;
  return <span className="text-red-400 text-[12px] flex-shrink-0 mt-0.5">✗</span>;
}

function StatusBadge({ status }: { status: CheckStatus }) {
  const map = { pass: 'text-emerald-400 bg-emerald-900/30', warn: 'text-amber-400 bg-amber-900/30', fail: 'text-red-400 bg-red-900/30' } as const;
  const label = { pass: 'PASS', warn: 'WARN', fail: 'FAIL' } as const;
  return <span className={`text-[9px] font-bold px-1 py-0.5 rounded flex-shrink-0 ${map[status]}`}>{label[status]}</span>;
}

function severityColor(s: string): string {
  if (s === 'CRITICAL') return '#EF4444';
  if (s === 'HIGH') return '#F87171';
  if (s === 'MEDIUM') return '#FBBF24';
  return '#94A3B8';
}

// ─── MCP 탭 ──────────────────────────────────────────────────────────────────

function McpTab({ mcpTools }: { mcpTools: McpTool[] }) {
  return (
    <div>
      <p className="text-[10px] font-bold text-slate-500 uppercase tracking-wider mb-2.5">연결된 MCP 서버</p>
      {mcpTools.map((mcp) => (
        <div key={mcp.name} className="bg-[#0F1520] border border-[#1E2535] rounded-lg p-3 mb-2">
          <div className="flex items-center justify-between mb-2">
            <span className="text-[12px] font-semibold text-slate-300 flex items-center gap-1.5">
              {mcp.name === 'Figma' ? '🎨' : mcp.name === 'Jira' ? '📋' : '🐙'}
              {mcp.name}
            </span>
            <span className={['text-[10px] px-2 py-0.5 rounded-full', mcp.connected ? 'bg-[#0D2A1A] text-green-400' : 'bg-[#1A2535] text-slate-500'].join(' ')}>
              {mcp.connected ? 'connected' : 'disconnected'}
            </span>
          </div>
          <div className="flex flex-wrap gap-1">
            {mcp.tools.map((tool) => (
              <span key={tool} className="text-[10px] px-1.5 py-0.5 rounded bg-[#1E2535] text-slate-500 border border-[#2A3347]">
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
  if (!session) return <p className="text-[12px] text-slate-500 py-4 text-center">활성 세션 없음</p>;

  const userCount = session.messages.filter((m) => m.role === 'user').length;
  const assistantCount = session.messages.filter((m) => m.role === 'assistant').length;

  return (
    <div>
      <p className="text-[10px] font-bold text-slate-500 uppercase tracking-wider mb-2.5">세션 통계</p>
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
