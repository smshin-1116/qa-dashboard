'use client';

import { useEffect, useState, useCallback, useRef, useMemo } from 'react';
import { flushSync } from 'react-dom';
import DashboardHeader from '@/components/dashboard/header/DashboardHeader';
import DashboardSidebar from '@/components/dashboard/sidebar/DashboardSidebar';
import ChatArea from '@/components/dashboard/chat/ChatArea';
import ChatInput from '@/components/dashboard/input/ChatInput';
import RightPanel from '@/components/dashboard/panel/RightPanel';
import PipelineRunner from '@/components/dashboard/pipeline/PipelineRunner';
import QualityPanel from '@/components/dashboard/quality/QualityPanel';
import McpStatusBar from '@/components/dashboard/McpStatusBar';
import ModelSwitchModal from '@/components/dashboard/ModelSwitchModal';
import Toast from '@/components/dashboard/Toast';
import { useSessionStore } from '@/stores/useSessionStore';
import {
  initModel,
  persistModel,
  readDetectedClaudeModel,
  persistDetectedClaudeModel,
  formatClaudeModel,
} from '@/constants/modelSupport';
import { initAgentMode, persistAgentMode } from '@/constants/agentModes';
import { getWorkspace } from '@/constants/workspaces';
import { downloadTcXlsx, hasTcResult } from '@/lib/tcExport';
import { useMcpStatus } from '@/hooks/useMcpStatus';
import { useToast } from '@/hooks/useToast';
import { META_PREFIX, TOOL_PREFIX } from '@/constants/streamProtocol';
import type { AIModel, AgentMode, Attachment, WorkspaceKind } from '@/types/session';

interface WorkspaceViewProps {
  /** 이 화면이 담당하는 워크스페이스 */
  workspaceKey: WorkspaceKind;
}

/**
 * TC 자동화 / 기능 분석 등 모든 워크스페이스 화면이 공유하는 셸.
 * workspaceKey에 따라 세션(kind) 필터, 에이전트 모드, 우측 패널 탭이 달라진다.
 * 라우트(app/dashboard/<path>/page.tsx)는 이 컴포넌트를 workspaceKey만 바꿔 렌더한다.
 */
export default function WorkspaceView({ workspaceKey }: WorkspaceViewProps) {
  const workspace = getWorkspace(workspaceKey);

  const {
    sessions,
    activeSession,
    activeKind,
    isLoaded,
    loadSessions,
    setActiveKind,
    createSession,
    selectSession,
    removeSession,
    addMessage,
    changeModel,
    updateClaudeSessionId,
    togglePin,
    renameSession,
  } = useSessionStore();

  const [activeModel, setActiveModel] = useState<AIModel>('claude');
  // CLI가 보고한 실제 claude 모델 ID (예: claude-sonnet-4-6) — 헤더 버전 라벨에 사용
  const [detectedClaudeModel, setDetectedClaudeModel] = useState<string | null>(null);
  const [activeAgentMode, setActiveAgentMode] = useState<AgentMode>(workspace.defaultAgentMode);
  const [isStreaming, setIsStreaming] = useState(false);
  const [streamingSessionId, setStreamingSessionId] = useState<string | null>(null);
  const [streamingContent, setStreamingContent] = useState('');
  const [toolStatus, setToolStatus] = useState('');

  // R-09: 스트리밍 완료 후 TC 파싱 타이밍을 위한 별도 상태
  const [tcAvailable, setTcAvailable] = useState(false);

  // R-02a: 모델 전환 확인 모달
  const [pendingModel, setPendingModel] = useState<AIModel | null>(null);

  // 채팅 스트리밍 중단용 AbortController
  const chatAbortRef = useRef<AbortController | null>(null);

  // MCP 상태 (R-06)
  const { servers: mcpServers, mcpStatus } = useMcpStatus();

  // 토스트 (R-04)
  const { toasts, addToast, removeToast } = useToast();

  // 워크스페이스 진입 시 1회 초기화 (라우트 전환 시 새 인스턴스에서 다시 실행)
  const initialized = useRef(false);
  useEffect(() => {
    if (initialized.current) return;
    initialized.current = true;
    setActiveModel(initModel());
    setDetectedClaudeModel(readDetectedClaudeModel());
    setActiveAgentMode(
      initAgentMode(workspaceKey, workspace.agentModes, workspace.defaultAgentMode),
    );
    (async () => {
      if (!useSessionStore.getState().isLoaded) {
        await loadSessions();
      }
      await setActiveKind(workspaceKey);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceKey]);

  // 현재 워크스페이스 소속 세션만 사이드바에 노출
  const workspaceSessions = useMemo(
    () => sessions.filter((s) => s.kind === workspaceKey),
    [sessions, workspaceKey],
  );

  // R-09: 세션 변경 시 TC 가용 여부 재계산
  useEffect(() => {
    setTcAvailable(hasTcResult(activeSession));
  }, [activeSession]);

  const handleNewSession = useCallback(async () => {
    await createSession(activeModel, workspaceKey);
  }, [createSession, activeModel, workspaceKey]);

  // R-02a: 모델 변경 요청 — 대화 중이면 모달 표시
  const handleModelChangeRequest = useCallback(
    (model: AIModel) => {
      if (model === activeModel) return;
      if (activeSession && activeSession.messages.length > 0) {
        setPendingModel(model);
      } else {
        applyModelChange(model);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [activeModel, activeSession],
  );

  const handleAgentModeChange = useCallback(
    (mode: AgentMode) => {
      setActiveAgentMode(mode);
      persistAgentMode(mode, workspaceKey);
    },
    [workspaceKey],
  );

  const applyModelChange = useCallback(
    async (model: AIModel) => {
      setActiveModel(model);
      persistModel(model);
      if (activeSession) {
        await changeModel(model);
      }
      setPendingModel(null);
    },
    [activeSession, changeModel],
  );

  const handleSend = useCallback(
    async (content: string, attachments: Attachment[]) => {
      let session = activeSession;
      if (!session) {
        session = await createSession(activeModel, workspaceKey);
      }

      await addMessage({ role: 'user', content, attachments });

      setIsStreaming(true);
      setStreamingSessionId(session.id);
      setStreamingContent('');
      setToolStatus('');

      chatAbortRef.current = new AbortController();

      let full = '';
      try {
        const res = await fetch('/api/dashboard/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            message: content,
            // 두 번째 메시지부터 --resume으로 이전 대화 이어서
            claudeSessionId: session.claudeSessionId,
            attachments,
            agentMode: activeAgentMode,
          }),
          signal: chatAbortRef.current.signal,
        });

        if (!res.ok || !res.body) {
          throw new Error(`API 오류 (${res.status})`);
        }

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        // META 탐지용 버퍼 (첫 줄 파싱 전용, 이후 사용 안 함)
        let metaBuffer = '';
        let metaParsed = false;

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          const chunk = decoder.decode(value, { stream: true });

          if (!metaParsed) {
            // 첫 번째 줄(\n 이전)까지 META 버퍼에 누적
            metaBuffer += chunk;

            if (metaBuffer.includes('\n')) {
              const newlineIdx = metaBuffer.indexOf('\n');
              const firstLine = metaBuffer.slice(0, newlineIdx);
              const remainder = metaBuffer.slice(newlineIdx + 1);
              metaBuffer = ''; // 이후로 사용 안 함
              metaParsed = true;

              if (firstLine.startsWith(META_PREFIX)) {
                try {
                  const meta = JSON.parse(firstLine.slice(META_PREFIX.length)) as {
                    claudeSessionId: string;
                    model?: string | null;
                  };
                  await updateClaudeSessionId(meta.claudeSessionId);
                  // CLI가 보고한 실제 모델 ID 기억 (헤더 버전 라벨 + 새로고침 유지)
                  if (meta.model) {
                    setDetectedClaudeModel(meta.model);
                    persistDetectedClaudeModel(meta.model);
                  }
                } catch {
                  // 메타 파싱 실패 무시
                }
                full = remainder; // META 이후 텍스트로 시작
              } else {
                // META 없는 응답 (에러 메시지 등)
                full = firstLine + '\n' + remainder;
              }
            }
          } else {
            // META 완료 후: 청크를 full에 직접 누적
            full += chunk;
          }

          // TOOL 라인 추출 및 제거 (앞 \n 포함 제거 후 \n\n으로 대체해 텍스트 블록 경계 보존)
          const toolLineRegex = new RegExp(`${TOOL_PREFIX.replace(':', '\\:')}([^\n]+)\n`, 'g');
          let toolMatch: RegExpExecArray | null;
          while ((toolMatch = toolLineRegex.exec(full)) !== null) {
            setToolStatus(toolMatch[1]);
          }
          full = full.replace(
            new RegExp(`\\n?${TOOL_PREFIX.replace(':', '\\:')}[^\\n]*\\n`, 'g'),
            '\n\n',
          );

          setStreamingContent(full);
        }

        // 스트리밍 버블 먼저 제거 후 메시지 저장 (중복 렌더 방지)
        flushSync(() => {
          setIsStreaming(false);
          setStreamingSessionId(null);
          setStreamingContent('');
          setToolStatus('');
        });
        if (full.trim()) {
          await addMessage({ role: 'assistant', content: full });
        } else {
          addToast('error', '응답을 받지 못했습니다. 다시 시도해주세요.');
        }
      } catch (err) {
        if ((err as Error).name === 'AbortError') {
          // 사용자가 중단 — 지금까지 받은 내용을 저장하고 조용히 종료
          flushSync(() => {
            setIsStreaming(false);
            setStreamingSessionId(null);
            setStreamingContent('');
            setToolStatus('');
          });
          if (full.trim()) {
            await addMessage({ role: 'assistant', content: full });
          }
          return;
        }
        const msg = err instanceof Error ? err.message : '알 수 없는 오류';
        flushSync(() => {
          setIsStreaming(false);
          setStreamingSessionId(null);
          setStreamingContent('');
          setToolStatus('');
        });
        await addMessage({ role: 'assistant', content: `오류가 발생했습니다: ${msg}` });
        addToast('error', msg);
      }
    },
    [activeSession, activeModel, activeAgentMode, workspaceKey, createSession, addMessage, updateClaudeSessionId, addToast],
  );

  const handleStop = useCallback(() => {
    chatAbortRef.current?.abort();
  }, []);

  const handleDownloadXlsx = useCallback(() => {
    if (!activeSession) return;
    const success = downloadTcXlsx(activeSession);
    if (success) {
      addToast('success', 'TC xlsx 파일이 다운로드되었습니다.');
    } else {
      addToast('warning', '다운로드할 TC 데이터가 없습니다. TC를 먼저 생성해주세요.');
    }
  }, [activeSession, addToast]);

  // 스토어가 아직 이 워크스페이스로 전환되기 전이면 로딩 (라우트 전환 직후 깜빡임 방지)
  if (!isLoaded || activeKind !== workspaceKey) {
    return (
      <div className="h-screen bg-[#0F1117] flex items-center justify-center">
        <div className="text-slate-500 text-sm">로딩 중...</div>
      </div>
    );
  }

  return (
    <>
      <div className="h-screen flex flex-col overflow-hidden bg-[#0F1117]">
        <DashboardHeader
          activeModel={activeModel}
          onModelChange={handleModelChangeRequest}
          claudeVersion={formatClaudeModel(detectedClaudeModel)}
          activeWorkspaceKey={workspaceKey}
        />

        <div className="flex flex-1 overflow-hidden">
          <DashboardSidebar
            sessions={workspaceSessions}
            activeSessionId={activeSession?.id ?? null}
            onSelectSession={selectSession}
            onNewSession={handleNewSession}
            onDeleteSession={removeSession}
            onTogglePin={togglePin}
            onRenameSession={renameSession}
            label={workspace.sidebarLabel}
          />

          <div className="flex flex-col flex-1 overflow-hidden">
            {/* 기능 분석(chat 레이아웃): 중앙 상단에 MCP 연동 칩바 */}
            {workspace.layout === 'chat' && <McpStatusBar mcpStatus={mcpStatus} />}
            {/* TC 자동화(pipeline 레이아웃): 중앙 상단에 파이프라인 실행기 */}
            {workspace.layout === 'pipeline' && (
              <div className="flex-shrink-0 max-h-[44%] overflow-y-auto border-b border-[#1E2535] bg-[#111520] px-4 py-3">
                <div className="text-[13px] font-semibold text-slate-200 mb-2.5">파이프라인 실행</div>
                <PipelineRunner
                  session={activeSession}
                  activeAgentMode={activeAgentMode}
                  onAgentModeChange={handleAgentModeChange}
                />
              </div>
            )}
            <ChatArea
              session={activeSession}
              isStreaming={isStreaming && streamingSessionId === activeSession?.id}
              streamingContent={streamingContent}
              toolStatus={toolStatus}
              hasTcResult={tcAvailable}
              onDownloadXlsx={handleDownloadXlsx}
            />
            <ChatInput
              key={activeSession?.id ?? 'none'}
              activeModel={activeModel}
              onSend={handleSend}
              onStop={handleStop}
              isStreaming={isStreaming && streamingSessionId === activeSession?.id}
              disabled={isStreaming}
              activeAgentMode={activeAgentMode}
              onAgentModeChange={handleAgentModeChange}
            />
          </div>

          {/* 우측: TC는 품질 리포트 고정, 그 외는 탭 패널 */}
          {workspace.layout === 'pipeline' ? (
            <QualityPanel session={activeSession} />
          ) : (
            <RightPanel
              session={activeSession}
              mcpTools={mcpServers}
              activeAgentMode={activeAgentMode}
              onAgentModeChange={handleAgentModeChange}
              panelTabs={workspace.panelTabs}
            />
          )}
        </div>
      </div>

      {/* R-02a: 모델 전환 확인 모달 */}
      {pendingModel && (
        <ModelSwitchModal
          from={activeModel}
          to={pendingModel}
          hasMessages={(activeSession?.messages.length ?? 0) > 0}
          onConfirm={() => applyModelChange(pendingModel)}
          onCancel={() => setPendingModel(null)}
        />
      )}

      {/* R-04: 토스트 알림 */}
      <Toast toasts={toasts} onRemove={removeToast} />
    </>
  );
}
