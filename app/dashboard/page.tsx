'use client';

import { useEffect, useState, useCallback, useRef } from 'react';
import { flushSync } from 'react-dom';
import DashboardHeader from '@/components/dashboard/header/DashboardHeader';
import DashboardSidebar from '@/components/dashboard/sidebar/DashboardSidebar';
import ChatArea from '@/components/dashboard/chat/ChatArea';
import ChatInput from '@/components/dashboard/input/ChatInput';
import RightPanel from '@/components/dashboard/panel/RightPanel';
import ModelSwitchModal from '@/components/dashboard/ModelSwitchModal';
import Toast from '@/components/dashboard/Toast';
import { useSessionStore } from '@/stores/useSessionStore';
import { initModel, persistModel } from '@/constants/modelSupport';
import { downloadTcXlsx, hasTcResult } from '@/lib/tcExport';
import { useMcpStatus } from '@/hooks/useMcpStatus';
import { useToast } from '@/hooks/useToast';
import { META_PREFIX, TOOL_PREFIX } from '@/constants/streamProtocol';
import type { AIModel, Attachment } from '@/types/session';

export default function DashboardPage() {
  const {
    sessions,
    activeSession,
    isLoaded,
    loadSessions,
    createSession,
    selectSession,
    removeSession,
    addMessage,
    changeModel,
    updateClaudeSessionId,
  } = useSessionStore();

  const [activeModel, setActiveModel] = useState<AIModel>('claude');
  const [isStreaming, setIsStreaming] = useState(false);
  const [streamingSessionId, setStreamingSessionId] = useState<string | null>(null);
  const [streamingContent, setStreamingContent] = useState('');
  const [toolStatus, setToolStatus] = useState('');

  // R-09: 스트리밍 완료 후 TC 파싱 타이밍을 위한 별도 상태
  const [tcAvailable, setTcAvailable] = useState(false);

  // R-02a: 모델 전환 확인 모달
  const [pendingModel, setPendingModel] = useState<AIModel | null>(null);

  // MCP 상태 (R-06)
  const { servers: mcpServers, mcpStatus } = useMcpStatus();

  // 토스트 (R-04)
  const { toasts, addToast, removeToast } = useToast();

  // 첫 렌더 ref (loadSessions 의존성 경고 방지)
  const initialized = useRef(false);

  useEffect(() => {
    if (initialized.current) return;
    initialized.current = true;
    const model = initModel();
    setActiveModel(model);
    loadSessions();
  }, [loadSessions]);

  // R-09: 세션 변경 시 TC 가용 여부 재계산
  useEffect(() => {
    setTcAvailable(hasTcResult(activeSession));
  }, [activeSession]);

  const handleNewSession = useCallback(async () => {
    await createSession(activeModel);
  }, [createSession, activeModel]);

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
    [activeModel, activeSession]
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
    [activeSession, changeModel]
  );

  const handleSend = useCallback(
    async (content: string, attachments: Attachment[]) => {
      let session = activeSession;
      if (!session) {
        session = await createSession(activeModel);
      }

      await addMessage({ role: 'user', content, attachments });

      setIsStreaming(true);
      setStreamingSessionId(session.id);
      setStreamingContent('');
      setToolStatus('');

      try {
        const res = await fetch('/api/dashboard/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            message: content,
            // 두 번째 메시지부터 --resume으로 이전 대화 이어서
            claudeSessionId: session.claudeSessionId,
            attachments,
          }),
        });

        if (!res.ok || !res.body) {
          throw new Error(`API 오류 (${res.status})`);
        }

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let full = '';
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
                  };
                  await updateClaudeSessionId(meta.claudeSessionId);
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

          // TOOL 라인 추출 및 제거
          const toolLineRegex = new RegExp(`${TOOL_PREFIX.replace(':', '\\:')}([^\n]+)\n`, 'g');
          let toolMatch: RegExpExecArray | null;
          while ((toolMatch = toolLineRegex.exec(full)) !== null) {
            setToolStatus(toolMatch[1]);
          }
          full = full.replace(new RegExp(`${TOOL_PREFIX.replace(':', '\\:')}[^\n]*\n`, 'g'), '');

          setStreamingContent(full);
        }

        // 스트리밍 버블 먼저 제거 후 메시지 저장 (중복 렌더 방지)
        flushSync(() => {
          setIsStreaming(false);
          setStreamingSessionId(null);
          setStreamingContent('');
          setToolStatus('');
        });
        await addMessage({ role: 'assistant', content: full });
      } catch (err) {
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
    [activeSession, activeModel, createSession, addMessage, updateClaudeSessionId, addToast]
  );

  const handleDownloadXlsx = useCallback(() => {
    if (!activeSession) return;
    const success = downloadTcXlsx(activeSession);
    if (success) {
      addToast('success', 'TC xlsx 파일이 다운로드되었습니다.');
    } else {
      addToast('warning', '다운로드할 TC 데이터가 없습니다. TC를 먼저 생성해주세요.');
    }
  }, [activeSession, addToast]);

  if (!isLoaded) {
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
          mcpStatus={mcpStatus}
        />

        <div className="flex flex-1 overflow-hidden">
          <DashboardSidebar
            sessions={sessions}
            activeSessionId={activeSession?.id ?? null}
            onSelectSession={selectSession}
            onNewSession={handleNewSession}
            onDeleteSession={removeSession}
          />

          <div className="flex flex-col flex-1 overflow-hidden">
            <ChatArea
              session={activeSession}
              isStreaming={isStreaming && streamingSessionId === activeSession?.id}
              streamingContent={streamingContent}
              toolStatus={toolStatus}
              hasTcResult={tcAvailable}
              onDownloadXlsx={handleDownloadXlsx}
            />
            <ChatInput
              activeModel={activeModel}
              onSend={handleSend}
              disabled={isStreaming}
            />
          </div>

          <RightPanel session={activeSession} mcpTools={mcpServers} />
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
