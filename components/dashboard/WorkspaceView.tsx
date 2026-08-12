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
import { collectTcRawRows, downloadTcXlsx, hasTcResult } from '@/lib/tcExport';
import TcPanel from '@/components/dashboard/work/TcPanel';
import SourceInput from '@/components/dashboard/work/SourceInput';
import GatePanel from '@/components/dashboard/work/GatePanel';
import type { Contract, ContractDecision } from '@/lib/workspace/contract';
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

  /**
   * 파이프라인이 만든 TC를 워크스페이스 DB로 자동 저장한다.
   *
   * ── 왜 자동인가 ────────────────────────────────────────────────────
   * 채팅 메시지 안의 마크다운 표는 **읽을 수만 있다.** 수행 결과(Pass/Fail)를 적거나
   * 자동화로 넘기려면 행마다 붙일 자리가 필요해서 tc 테이블로 옮겨야 하는데,
   * 그걸 사람이 [저장] 눌러야 한다면 십중팔구 안 누르고 표만 보고 끝난다.
   *
   * ── 덮어쓰기 걱정이 없는 이유 ──────────────────────────────────────
   * upsertTc가 (work, local_id)로 UPSERT하되 **사람이 넣은 값(result·verdict·
   * catalog_id·인계시각)은 갱신하지 않는다.** 4단계(작성→리뷰→수정)가 표를 여러 번
   * 뱉어도 마지막 표가 본문만 갱신하고, 이미 적어둔 Pass는 남는다.
   *
   * 저장 자체는 LLM을 부르지 않는다 — 파싱 + INSERT뿐이라 토큰 0.
   */
  const savedSigRef = useRef<string>('');
  useEffect(() => {
    if (!activeSession) return;
    const rows = collectTcRawRows(activeSession);
    if (rows.length === 0) return;

    // 같은 내용을 스트리밍 중 매 렌더마다 POST하지 않도록 지문으로 거른다
    const sig = `${activeSession.id}:${rows.length}:${JSON.stringify(rows).length}`;
    if (savedSigRef.current === sig) return;
    savedSigRef.current = sig;

    void fetch('/api/workspace/tc', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'save',
        sessionId: activeSession.id,
        title: activeSession.title,
        rows,
      }),
    })
      .then(() => setTcSavedAt(Date.now())) // TcPanel 새로고침 신호
      .catch(() => {
        // 저장 실패해도 대화는 계속된다 — 다음 렌더에서 재시도되도록 지문을 되돌린다
        savedSigRef.current = '';
      });
  }, [activeSession]);

  /** TC 저장 완료 시각 — 바뀌면 TcPanel이 목록을 다시 읽는다 */
  const [tcSavedAt, setTcSavedAt] = useState(0);

  /** 진행 카드 접기 (기본 펼침) */
  const [pipelineOpen, setPipelineOpen] = useState(true);
  /** 입력 카드 → 파이프라인 실행 요청 (seq가 바뀔 때마다 1회 실행) */
  const [pipelineRun, setPipelineRun] = useState<{ url: string; seq: number } | null>(null);
  const [pipelineRunning, setPipelineRunning] = useState(false);

  /** ⓪흡수·①교차분석 상태 — 계약은 서버(tc_work.contract)가 원본이다 */
  const [absorb, setAbsorb] = useState<{
    status: 'idle' | 'running' | 'ready' | 'fallback';
    contract: Contract | null;
    reason: string | null;
  }>({ status: 'idle', contract: null, reason: null });

  // 세션을 열면 저장된 계약을 복원한다 — 게이트가 새로고침에 살아남는 이유
  useEffect(() => {
    const id = activeSession?.id;
    if (!id || workspace.layout !== 'pipeline') return;
    let alive = true;
    void fetch(`/api/workspace/absorb?sessionId=${encodeURIComponent(id)}`, { cache: 'no-store' })
      .then((r) => r.json() as Promise<{ contract: Contract | null }>)
      .then((b) => {
        if (!alive) return;
        setAbsorb(
          b.contract
            ? { status: 'ready', contract: b.contract, reason: null }
            : { status: 'idle', contract: null, reason: null },
        );
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSession?.id]);

  /** 입력 카드 → ⓪①(Codex). 실패하면 시안의 폴백: Claude 단독 채팅으로 잇는다 */
  const handleAbsorb = useCallback(
    async (urls: string[], text: string) => {
      let session = activeSession;
      if (!session) session = await createSession(activeModel, workspaceKey);

      // 제목: 첫 티켓 키 > 첫 URL > 텍스트 앞머리
      const title =
        urls.find((u) => /\/browse\/[A-Z][A-Z0-9]+-\d+/.test(u))?.match(/[A-Z][A-Z0-9]+-\d+/)?.[0] ??
        urls[0] ??
        text.slice(0, 40);

      setAbsorb({ status: 'running', contract: null, reason: null });
      try {
        const res = await fetch('/api/workspace/absorb', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'absorb', sessionId: session.id, title, urls, text }),
        });
        const body = (await res.json()) as {
          engine: 'codex' | 'fallback';
          contract: Contract | null;
          fallbackReason: string | null;
        };
        if (body.contract) {
          setAbsorb({ status: 'ready', contract: body.contract, reason: null });
        } else {
          // 폴백 — ⓪①을 Claude 대화로. 배지는 GatePanel이 표시하고 작업은 멈추지 않는다
          setAbsorb({ status: 'fallback', contract: null, reason: body.fallbackReason });
          await handleSend(
            [urls.join('\n'), text].filter(Boolean).join('\n\n') +
              '\n\n위 소스들을 전부 읽고 요구사항·모순·누락을 분석해줘.',
            [],
          );
        }
      } catch (e) {
        setAbsorb({
          status: 'fallback',
          contract: null,
          reason: e instanceof Error ? e.message : '흡수 요청 실패',
        });
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [activeSession, activeModel, workspaceKey, createSession],
  );

  /**
   * ② 게이트 통과 — 답변을 전제로 고정하고 ③ 설계를 시작한다.
   *
   * Claude에게는 **원문이 아니라 계약의 요약·요구·전제만** 보낸다.
   * 원문 재조회를 막는 것이 "읽기와 분석 분리"의 토큰 절감 지점이다.
   */
  const handleGateProceed = useCallback(
    async (decisions: ContractDecision[]) => {
      const c = absorb.contract;
      const session = activeSession;
      if (!c || !session) return;

      await fetch('/api/workspace/absorb', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'decide', sessionId: session.id, decisions }),
      });
      setAbsorb((p) => (p.contract ? { ...p, contract: { ...p.contract, decisions } } : p));

      // PR·코드 소스는 별도 블록으로 — 기대결과를 구현 사실에 붙들어 매는 근거다
      const prSources = c.sources.filter((s) => s.type === 'PR' || s.type === '코드');
      const docSources = c.sources.filter((s) => s.type !== 'PR' && s.type !== '코드');

      const msg = [
        '[확인 게이트 통과 — 아래 전제로 고정됨. 전제와 어긋나는 요구는 제외할 것]',
        ...decisions.map((d, i) => `전제 ${i + 1}. ${d.question} → ${d.answer}`),
        '',
        '[소스 요약 — ⓪ 개별 흡수 결과. 티켓·기획서 원문을 다시 조회하지 말 것]',
        ...docSources.map((s) => `- ${s.id}(${s.type}): ${s.summary}`),
        ...(prSources.length
          ? [
              '',
              '[구현 근거 — 티켓에 연결된 PR·코드를 Codex가 검토한 결과]',
              ...prSources.map((s) => `- ${s.id}: ${s.summary}`),
              '기대결과가 구현과 어긋나지 않는지 이 근거로 재검증하라.',
              '요약만으로 판단이 안 서는 지점은 gh 조회(read-only: gh pr view/diff, gh api)로',
              '직접 확인해도 된다 — 단 clone·push·파일 수정은 금지다.',
            ]
          : []),
        '',
        `[확정 요구 ${c.requirements.length}건]`,
        ...c.requirements.map((r) => `- ${r.id}: ${r.text} (출처 ${r.from.join('·')})`),
        ...(c.impacts.tc_ids.length
          ? ['', `[기존 자동화 영향권] ${c.impacts.tc_ids.join(' · ')} — 중복 TC를 만들지 말 것`]
          : []),
        '',
        '위 전제와 요구만으로 TC를 설계하고, 11컬럼 마크다운 표(TC-ID·대분류·중분류·소분류·검증단계·전제조건·테스트 스텝·기대결과·플랫폼·결과·비고)로 작성해줘.',
      ].join('\n');

      await handleSend(msg, []);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [absorb.contract, activeSession],
  );

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
    async (
      content: string,
      attachments: Attachment[],
      opts?: { displayMessage?: string; tcRun?: boolean },
    ) => {
      let session = activeSession;
      if (!session) {
        session = await createSession(activeModel, workspaceKey);
      }

      // CLI엔 content(전체 프롬프트)를 보내되, 대화에는 displayMessage(짧은 안내)만 남긴다.
      // 수행 버튼이 만든 긴 프롬프트가 사용자 말풍선으로 찍히는 것을 막는다 (2026-08-12).
      await addMessage({ role: 'user', content: opts?.displayMessage ?? content, attachments });

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
            // 수행 모드 — 전용 프로필 Playwright만 붙여 브라우저 충돌 방지
            tcRun: opts?.tcRun ?? false,
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
        // 자동 수행 등 호출부가 응답 본문을 파싱할 수 있게 돌려준다
        return full;
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
          return full;
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
        return '';
      }
    },
    [activeSession, activeModel, activeAgentMode, workspaceKey, createSession, addMessage, updateClaudeSessionId, addToast],
  );

  /**
   * TC 자동 수행 — 기존 채팅 파이프라인(Claude Code + Playwright MCP)을 버튼으로 트리거한다.
   *
   * 사용자가 매번 "stage에서 수행해줘"를 치던 것을 버튼 한 번으로. 흐름:
   *   1) 선택 TC를 수행 프롬프트로 조립 (결과를 파싱 가능한 표 형식으로 요구)
   *   2) handleSend로 Claude에 전송 → Claude가 Playwright로 stage 수행
   *   3) 응답의 `| TC-ID | 결과 | 사유 |` 표를 파싱
   *   4) auto-results로 tc 테이블에 일괄 기입 → 표 새로고침
   *
   * ⚠️ 실제 stage 수행이라 토큰·시간이 크다(TC 수만큼). 사람이 버튼을 눌러야만 돈다.
   */
  const handleRunTc = useCallback(
    async (
      tcs: Array<{
        localId: string;
        subCategory: string | null;
        phase: string | null;
        precondition: string | null;
        steps: string | null;
        expected: string | null;
      }>,
    ) => {
      if (!activeSession || tcs.length === 0) return;

      const prompt = [
        '[TC 자동 수행 — stage 환경 (tms-stage.roouty.io)]',
        '아래 TC를 Playwright로 stage에서 **실제 수행**하고 결과를 판정해줘.',
        '',
        '수행 규칙:',
        '- 실행 가능 → 수행 후 Pass / Fail 판정',
        '- 데이터 세팅이 필요하거나 명세 미정의 → Blocked + 사유 (무리하게 수행하지 말 것)',
        '- 실행 리스크(BLOCK 예상)는 미리 판단해 Blocked 처리하고 필요한 데이터 세팅을 사유에 적을 것',
        '',
        '⚠️ 응답 **맨 끝**에 반드시 아래 형식의 표만 출력 (자동 기입용 — 결과는 Pass/Fail/Blocked/Not Test 중 하나):',
        '| TC-ID | 결과 | 사유 |',
        '| TC-01 | Pass | ... |',
        '',
        '[수행할 TC]',
        ...tcs.map((t) =>
          [
            `${t.localId}`,
            t.subCategory && `  중분류: ${t.subCategory}`,
            t.phase && `  검증단계: ${t.phase}`,
            t.precondition && `  전제조건: ${t.precondition}`,
            t.steps && `  스텝: ${t.steps}`,
            t.expected && `  기대결과: ${t.expected}`,
          ]
            .filter(Boolean)
            .join('\n'),
        ),
      ].join('\n');

      const full =
        (await handleSend(prompt, [], {
          displayMessage: `▶ TC ${tcs.length}건 stage 자동 수행 요청 (${tcs.map((t) => t.localId).join(', ')})`,
          tcRun: true,
        })) ?? '';

      // 응답에서 | TC-ID | 결과 | 사유 | 표를 파싱
      const RESULTS = new Set(['Pass', 'Fail', 'Blocked', 'Not Test']);
      const parsed: Array<{ localId: string; result: 'Pass' | 'Fail' | 'Blocked' | 'Not Test'; note?: string }> = [];
      for (const line of full.split('\n')) {
        if (!line.trim().startsWith('|')) continue;
        const cells = line.split('|').map((c) => c.trim()).filter((_, i, a) => i > 0 && i < a.length - 1);
        if (cells.length < 2) continue;
        const [localId, result, note] = cells;
        if (!/^TC-\d+/i.test(localId) || !RESULTS.has(result)) continue;
        parsed.push({ localId, result: result as 'Pass' | 'Fail' | 'Blocked' | 'Not Test', note: note || undefined });
      }

      if (parsed.length === 0) {
        addToast('warning', '수행은 됐지만 결과 표를 못 읽었습니다. 대화에서 확인하고 수동 기입해주세요.');
        return;
      }

      const res = await fetch('/api/workspace/tc', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'auto-results', sessionId: activeSession.id, results: parsed }),
      });
      const body = (await res.json()) as { applied: number; unmatched: string[] };
      setTcSavedAt(Date.now()); // TcPanel 새로고침
      addToast(
        body.unmatched.length ? 'warning' : 'success',
        `${body.applied}건 자동 기입` +
          (body.unmatched.length ? ` · 미매칭 ${body.unmatched.join(', ')}` : ''),
      );
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [activeSession, handleSend, addToast],
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
      <div className="h-screen bg-[var(--ground)] flex items-center justify-center">
        <div className="text-[var(--tx-3)] text-sm">로딩 중...</div>
      </div>
    );
  }

  return (
    <>
      <div className="h-screen flex flex-col overflow-hidden bg-[var(--ground)]">
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
            {workspace.layout === 'pipeline' ? (
              /*
                QA 작업 — 시안의 한 페이지 세로 스크롤 (2026-08-10 재구성).

                시안에는 하단 채팅 입력도, 대화/수행 탭도 없다. 입력은 상단 카드
                하나로 들어오고 아래로 진행 → 대화 → TC → 작업 종료가 이어진다.
                (탭 분리·하단 입력은 시안 이탈로 지적받아 제거)
              */
              <div className="flex-1 overflow-y-auto">
                <div className="max-w-6xl mx-auto w-full p-3.5 flex flex-col gap-3.5">
                  {/* ── 입력 — 소스 여러 개 (유일한 입력 지점) ─────────── */}
                  <SourceInput
                    onAbsorb={(urls, text) => void handleAbsorb(urls, text)}
                    onRunPipeline={(url) => setPipelineRun((p) => ({ url, seq: (p?.seq ?? 0) + 1 }))}
                    busy={isStreaming || pipelineRunning || absorb.status === 'running'}
                    busyLabel={absorb.status === 'running' ? '⓪① Codex 분석 중…' : undefined}
                  />

                  {/* ── 진행 · 모델 분담 ─────────────────────────────── */}
                  <div className="rounded-[13px] border border-[var(--line)] bg-[var(--panel)] p-3.5">
                    <button
                      onClick={() => setPipelineOpen((v) => !v)}
                      className="flex items-center gap-1.5 text-[13px] font-semibold text-[var(--tx-1)] hover:text-[var(--tx-1)]"
                    >
                      <span className="text-[10px] text-[var(--tx-3)]">{pipelineOpen ? '▾' : '▸'}</span>
                      진행 · 모델 분담
                    </button>
                    {/*
                      시안의 owner-band — ⓪① Codex · ② 사람 · ③~⑦ Claude.
                      ⓪①②는 실제 진행 상태를 따라간다 (2026-08-11 구현):
                      흡수 중 → 진행색 / 계약 있음 → 완료 / 전제 고정 → ② 완료.
                    */}
                    <div className="flex items-center gap-1 flex-wrap mt-2 mb-2.5 font-mono text-[10px]">
                      {(
                        [
                          ['⓪ 📥 개별 흡수', absorb.status === 'running' ? 'run' : absorb.contract ? 'done' : 'wait'],
                          ['① 🔀 교차 분석', absorb.status === 'running' ? 'run' : absorb.contract ? 'done' : 'wait'],
                          ['② ✋ 확인', (absorb.contract?.decisions.length ?? 0) > 0 ? 'done' : absorb.contract ? 'run' : 'wait'],
                        ] as const
                      ).map(([label, st]) => (
                        <span
                          key={label}
                          className={[
                            'px-2 py-0.5 rounded border',
                            st === 'done'
                              ? 'border-[#10A37F66] bg-[#10A37F1c] text-[#10A37F]'
                              : st === 'run'
                                ? 'border-[var(--warn)66] bg-[var(--warn)1c] text-[var(--warn)]'
                                : 'border-[var(--line-2)] bg-[var(--inset)] text-[var(--tx-4)]',
                          ].join(' ')}
                          title={
                            st === 'wait'
                              ? 'Codex 세션 1개가 담당 — 입력 카드에서 시작'
                              : st === 'run'
                                ? '진행 중'
                                : '완료'
                          }
                        >
                          {label}
                        </span>
                      ))}
                      <span className="text-[var(--tx-4)]">→</span>
                      <span className="px-2 py-0.5 rounded border border-[var(--accent-deep)66] bg-[var(--accent-bg)] text-[var(--accent)]">
                        ③~⑥ 설계·작성·리뷰·수정 (아래)
                      </span>
                      <span className="text-[var(--tx-4)]">→</span>
                      <span className="px-2 py-0.5 rounded border border-[var(--line-2)] bg-[var(--inset)] text-[var(--tx-3)]">
                        ⑦ ✅ 수행 (TC 카드)
                      </span>
                    </div>
                    {pipelineOpen && (
                      <PipelineRunner
                        session={activeSession}
                        activeAgentMode={activeAgentMode}
                        onAgentModeChange={handleAgentModeChange}
                        hideInput
                        requestRun={pipelineRun}
                        onRunningChange={setPipelineRunning}
                      />
                    )}
                  </div>

                  {/* ── ⓪ 소스 보드 · ① 교차 분석 · ② 확인 게이트 ────── */}
                  {absorb.status === 'running' && (
                    <div className="rounded-[13px] border border-[var(--line)] bg-[var(--panel)] p-3.5 flex items-center gap-2.5">
                      <span className="w-1.5 h-1.5 rounded-full bg-[#10A37F] animate-pulse" />
                      <span className="text-[12px] text-[var(--tx-2)]">
                        ⓪ 개별 흡수 · ① 교차 분석 — Codex 세션 1개로 처리 중 (Claude 토큰 0)
                      </span>
                      <span className="font-mono text-[10px] text-[var(--tx-4)] ml-auto">
                        소스 수에 따라 1~5분
                      </span>
                    </div>
                  )}
                  {(absorb.status === 'ready' || absorb.status === 'fallback') && (
                    <GatePanel
                      contract={absorb.contract}
                      engine={absorb.status === 'ready' ? 'codex' : 'fallback'}
                      fallbackReason={absorb.reason}
                      busy={isStreaming}
                      onProceed={(decisions) => void handleGateProceed(decisions)}
                    />
                  )}

                  {/* ── 분석 대화 — 응답이 흐르는 곳 (입력은 상단 카드) ── */}
                  {((activeSession?.messages.length ?? 0) > 0 || isStreaming) && (
                    <div className="h-[46vh] flex flex-col rounded-[13px] border border-[var(--line)] overflow-hidden">
                      <ChatArea
                        session={activeSession}
                        isStreaming={isStreaming && streamingSessionId === activeSession?.id}
                        streamingContent={streamingContent}
                        toolStatus={toolStatus}
                        hasTcResult={tcAvailable}
                        onDownloadXlsx={handleDownloadXlsx}
                      />
                    </div>
                  )}

                  {/* ── ③~⑥ TC 카드 + 작업 종료 — TC 없으면 null ─────── */}
                  <TcPanel
                    session={activeSession}
                    refreshKey={tcSavedAt}
                    onDownloadXlsx={handleDownloadXlsx}
                    onRunTc={handleRunTc}
                    running={isStreaming}
                  />
                </div>
              </div>
            ) : (
              /* chat 레이아웃 (기타 워크스페이스) — 기존 구조 유지 */
              <>
                {workspace.layout === 'chat' && <McpStatusBar mcpStatus={mcpStatus} />}
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
              </>
            )}
          </div>

          {/*
            우측 패널.
            panelTabs가 있으면 탭 패널, 비어 있으면 품질 리포트를 고정 노출한다.
            (QA 작업은 분석·TC를 한 화면에서 하므로 품질만 고정하면 MCP 상태를 볼 수 없다
             — 2026-08-09 두 탭 통합 시 레이아웃이 아니라 panelTabs 기준으로 바꿨다)
          */}
          {workspace.panelTabs.length === 0 ? (
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
