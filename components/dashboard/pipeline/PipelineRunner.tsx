'use client';

import { useState, useMemo, useCallback, useRef } from 'react';
import type { Session, AgentMode } from '@/types/session';
import { useSessionStore } from '@/stores/useSessionStore';
import type { PipelineEvent } from '@/app/api/pipeline/run/route';

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

export default function PipelineRunner({
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
          // onChange만으로 붙여넣기까지 처리됨. 과거 onPaste를 함께 두면
          // 기본 붙여넣기 + state 세팅이 겹쳐 값이 중복 입력되는 버그가 있었음.
          onChange={(e) => setConfluenceUrl(e.target.value)}
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

                  {/* 단계 설명 (대기/활성 시) */}
                  {!isRunningStage && !isDoneStage && (
                    <p className="text-[10px] text-slate-600 mt-0.5 leading-snug">{stage.description}</p>
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
