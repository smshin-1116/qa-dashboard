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

  /** ⓪흡수·①교차분석 상태 — 계약은 서버(tc_work.contract)가 원본이다.
   *  'skipped' = 단일 소스라 codex 교차분석을 건너뛴 상태(진행 띠에 "생략"으로 표시). */
  const [absorb, setAbsorb] = useState<{
    status: 'idle' | 'running' | 'ready' | 'fallback' | 'skipped';
    contract: Contract | null;
    reason: string | null;
  }>({ status: 'idle', contract: null, reason: null });

  /**
   * 지금 Claude가 무슨 단계를 도는지 — 진행 띠(③~⑥·⑦)를 실제로 켜기 위한 신호.
   * 'design' = 게이트 통과 후 TC 설계·작성, 'run' = TC 자동 수행(Playwright).
   * handleSend가 시작 시 켜고 끝(성공·에러·중단)에 끈다.
   */
  const [streamPhase, setStreamPhase] = useState<'design' | 'run' | null>(null);

  /**
   * #4 에러 이어가기 — 마지막으로 실패한 액션을 "그 지점부터" 다시 실행하는 thunk.
   *
   * 계약·전제(decide)·TC는 이미 서버에 저장돼 있고, Claude 세션은 --resume으로 이어진다.
   * 그래서 재시도는 "처음부터 재분석"이 아니라 실패한 그 요청만 다시 보낸다 —
   * 일 중복도 토큰 낭비도 없다 (2026-08-13 사용자 요구).
   */
  const [retry, setRetry] = useState<{ label: string; run: () => Promise<unknown> } | null>(null);

  /** 후속 입력 — 대화 세션에서 추가 요구사항(더 분석/이 부분만/TC 전환)을 이어서 보낸다 */
  const [followUp, setFollowUp] = useState('');

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

      // 제목(#1): 티켓 URL이면 "DV-*** 분석 및 설계"로 고정, 아니면 텍스트/URL 앞머리로 임시.
      // 짧게 다듬는 헬퍼 — 공백 정리 + 28자 컷.
      const shortTitle = (s: string, max = 28) => {
        const t = s.replace(/\s+/g, ' ').trim();
        return t.length > max ? `${t.slice(0, max)}…` : t;
      };
      const ticketKey = urls
        .map((u) => u.match(/\/browse\/([A-Z][A-Z0-9]+-\d+)/)?.[1])
        .find(Boolean);
      const title = ticketKey
        ? `${ticketKey} 분석 및 설계`
        : shortTitle(text || urls[0] || '새 작업');

      // 사이드바 작업 이력에 즉시 반영 (흡수 시작 시점부터 어떤 작업인지 보이게)
      void renameSession(session.id, title);

      // 단일 소스(티켓 1개·텍스트 등)는 codex 교차분석이 무의미하다 — 대조할 다른 소스가
      // 없어 모순·누락을 찾을 게 없고 게이트도 빈다. 그래서 codex·게이트를 건너뛰고 Claude가
      // 바로 읽고 분석→설계한다 (2026-08-18 사용자 결정). URL 2개 이상만 codex 흡수·교차분석.
      if (urls.length < 2) {
        setAbsorb({ status: 'skipped', contract: null, reason: null });
        const directMsg = [
          '[소스를 읽고 바로 TC를 설계·작성 — codex 교차분석 생략(단일 소스)]',
          ...(urls.length ? [urls.join('\n')] : []),
          ...(text ? [text] : []),
          '',
          '위 소스(티켓/기획 등)를 읽고 요구사항·검증 포인트·엣지케이스를 분석한 뒤, 바로',
          '11컬럼 마크다운 표(TC-ID·대분류·중분류·소분류·검증단계·전제조건·테스트 스텝·기대결과·플랫폼·결과·비고)로 TC를 설계·작성해줘.',
        ].join('\n');
        await handleSend(directMsg, [], {
          phase: 'design',
          displayMessage: `▶ ${title} — 소스 읽고 분석·TC 설계 진행 (codex 생략)`,
        });
        return;
      }

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
          // 텍스트 소스(티켓 아님)면 흡수 결과의 핵심 요구/요약으로 제목을 더 낫게 추천·갱신
          if (!ticketKey) {
            const c = body.contract;
            const derived = c.requirements[0]?.text ?? c.sources[0]?.summary ?? '';
            if (derived) void renameSession(session.id, shortTitle(derived, 30));
          }
        } else {
          // 폴백 — ⓪①을 Claude 대화로. 배지는 GatePanel이 표시하고 작업은 멈추지 않는다
          setAbsorb({ status: 'fallback', contract: null, reason: body.fallbackReason });
          await handleSend(
            [urls.join('\n'), text].filter(Boolean).join('\n\n') +
              '\n\n위 소스들을 전부 읽고 요구사항·모순·누락을 분석해줘.',
            [],
            { phase: 'design' },
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
    [activeSession, activeModel, workspaceKey, createSession, renameSession],
  );

  /**
   * 기능 분석 (신규 모드) — codex·게이트·TC 설계 없이 **Claude가 바로 분석만** 한다.
   *
   * "분석만 원했는데 TC까지 만드는" 낭비를 없애기 위한 별도 경로다 (2026-08-19).
   * 기존 handleAbsorb(흡수·게이트)·파이프라인은 손대지 않는다 — 이건 순수 추가 경로.
   */
  const handleAnalyze = useCallback(
    async (urls: string[], text: string) => {
      let session = activeSession;
      if (!session) session = await createSession(activeModel, workspaceKey);

      const shortTitle = (s: string, max = 28) => {
        const t = s.replace(/\s+/g, ' ').trim();
        return t.length > max ? `${t.slice(0, max)}…` : t;
      };
      const ticketKey = urls
        .map((u) => u.match(/\/browse\/([A-Z][A-Z0-9]+-\d+)/)?.[1])
        .find(Boolean);
      const title = ticketKey ? `${ticketKey} 기능 분석` : shortTitle(text || urls[0] || '기능 분석');
      void renameSession(session.id, title);

      // codex·게이트를 건너뛴다 — 진행 띠에 "생략"으로 표시(설계 모드와 구분)
      setAbsorb({ status: 'skipped', contract: null, reason: null });

      const msg = [
        '[기능 분석 — 소스를 읽고 분석만. ⚠️ TC(테스트 케이스) 표는 절대 만들지 말 것]',
        ...(urls.length ? [urls.join('\n')] : []),
        ...(text ? [text] : []),
        '',
        '위 소스(티켓/기획 등)를 읽고 아래를 정리해줘. **TC 설계·11컬럼 표는 만들지 마.**',
        '- 기능 요약 · 핵심 동작 흐름',
        '- 요구사항 · 수용 기준',
        '- 주요 엣지케이스 · 리스크',
        '- 불명확하거나 확인이 필요한 지점',
      ].join('\n');

      // phase 미지정 — 진행 띠의 ③~⑥(TC 설계)를 켜지 않는다(이건 분석이지 설계가 아니다)
      await handleSend(msg, [], {
        displayMessage: `🔍 ${title} — 기능 분석 (codex·TC 설계 없음)`,
      });
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [activeSession, activeModel, workspaceKey, createSession, renameSession],
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

      // phase 'design' → 진행 띠 ③~⑥ 활성 · 실패 시 이 요청(전제는 이미 저장됨)만 재전송.
      // #3: CLI엔 전체 전제 msg를 보내되, 대화엔 짧은 요약만 남긴다 — 긴 전제 텍스트가
      // 작업 대화를 가득 채워 가독성을 해치던 문제 해소. 응답(분석 결과+TC)만 보이게 된다.
      const decidedSummary =
        decisions.length > 0
          ? `전제 ${decisions.length}건 고정`
          : '전제 없이 진행';
      await handleSend(msg, [], {
        phase: 'design',
        displayMessage: `✅ 확인 게이트 통과 (${decidedSummary}) → TC 설계·작성 진행`,
      });
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
      opts?: {
        displayMessage?: string;
        tcRun?: boolean;
        /** 진행 띠 표시용 — 이 전송이 어느 단계인지 */
        phase?: 'design' | 'run';
        /**
         * 새 Claude 세션으로 전송 — 설계 대화를 --resume으로 상속하지 않는다.
         * TC 수행 배치가 설계 대화·이전 배치의 스냅샷을 안 물려받게 해 컨텍스트를
         * 배치 단위로 고정한다(누적 폭증 차단). 반환된 세션 id도 스토어에 안 쓴다 —
         * 설계 세션(activeSession.claudeSessionId)을 덮으면 안 되므로.
         */
        freshSession?: boolean;
        /**
         * #4 재시도 훅 — 실패 시 이걸 그대로 다시 실행한다. 안 주면 이 handleSend를
         * 같은 인자로 재실행한다(=Claude --resume). TC 수행처럼 전송 뒤 파싱·저장이
         * 더 붙는 액션은 그 전체를 감싼 thunk를 넘겨 "이어서"가 온전해지게 한다.
         */
        onRetry?: () => Promise<unknown>;
      },
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
      if (opts?.phase) setStreamPhase(opts.phase);
      // 새 전송을 시작하면 직전 실패 배너는 치운다 (이 전송이 곧 그 재시도일 수 있다)
      setRetry(null);

      chatAbortRef.current = new AbortController();

      let full = '';
      try {
        const res = await fetch('/api/dashboard/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            message: content,
            // 두 번째 메시지부터 --resume으로 이전 대화 이어서.
            // freshSession이면 상속하지 않는다(수행 배치 격리).
            claudeSessionId: opts?.freshSession ? undefined : session.claudeSessionId,
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
                  // freshSession(수행 배치)은 임시 세션이라 설계 세션 포인터를 안 덮는다
                  if (!opts?.freshSession) {
                    await updateClaudeSessionId(meta.claudeSessionId);
                  }
                  // CLI가 보고한 실제 모델 ID 기억 (헤더 버전 라벨 + 새로고침 유지).
                  // 단, 수행(freshSession)은 Sonnet 고정이라 그 모델로 헤더가 바뀌면 오해를
                  // 준다 — 설계/기본 모델 표시를 유지하려고 freshSession일 땐 갱신 안 함.
                  if (meta.model && !opts?.freshSession) {
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
          setStreamPhase(null);
        });
        if (full.trim()) {
          await addMessage({ role: 'assistant', content: full });
        } else {
          // 빈 응답도 재개 대상 — 저장된 세션에서 이어서 다시 시도할 수 있게 배너를 남긴다
          addToast('error', '응답을 받지 못했습니다.');
          setRetry({
            label: '이어서 다시 시도',
            run: opts?.onRetry ?? (() => handleSend(content, attachments, opts)),
          });
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
            setStreamPhase(null);
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
          setStreamPhase(null);
        });
        // 부분 응답이 있으면 버리지 않고 남긴다 — 재시도 시 --resume이 이어받는다
        if (full.trim()) {
          await addMessage({ role: 'assistant', content: full });
        }
        await addMessage({
          role: 'assistant',
          content: `오류가 발생했습니다: ${msg}\n\n> 계약·전제·TC는 저장돼 있습니다. 아래 **[${'이어서 다시 시도'}]** 로 이 지점부터 다시 진행하세요 (처음부터 재분석 아님).`,
        });
        addToast('error', msg);
        // #4 — 실패한 액션을 그대로 재실행할 수 있게 보관 (onRetry 있으면 그걸, 없으면 이 전송 자체)
        setRetry({
          label: '이어서 다시 시도',
          run: opts?.onRetry ?? (() => handleSend(content, attachments, opts)),
        });
        return '';
      }
    },
    [activeSession, activeModel, activeAgentMode, workspaceKey, createSession, addMessage, updateClaudeSessionId, addToast],
  );

  /**
   * TC 자동 수행 — 선택 TC 전부를 **한 세션**에서 수행하고 결과를 tc 테이블에 기입한다.
   *
   * ── 왜 전체 1세션인가 (2026-08-13 재설계) ────────────────────────────
   * 처음엔 컨텍스트 폭증을 막으려 3건 소배치로 쪼갰는데, 진짜 폭증 원인은
   * roouty-spec 명세 로딩이었고 그건 이미 제거했다. 배치 쪼개기는 배치마다 브라우저
   * 재기동·재접속(워밍업)을 반복하고, **같은 화면을 보는 연관 TC의 네비게이션 공유**를
   * 잃어 오히려 느리고 비쌌다. 그래서 전부 한 세션(freshSession)에 넣는다:
   *   · 워밍업 1회 · 같은 화면 TC는 한 번 이동해 함께 확인 → 빠르고 저렴
   *   · 설계 대화는 여전히 상속 안 함(freshSession) · 로그인은 영속 프로필로 유지
   *   · 판정 방식은 백엔드(repo·stage API read-only) 우선, 화면 필요 시만 Playwright
   *     — 이 하이브리드 지시는 서버의 TC_RUN_PROMPT에 있다.
   * 판단 근거(기능 맥락)는 계약 요약(digest)으로 주입해 품질을 유지한다.
   *
   * ⚠️ 실제 stage 수행이라 토큰·시간이 크다. 사람이 버튼을 눌러야만 돈다.
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
      // 재수행 조건 — 있을 때만 프롬프트 맨 앞에 주입한다. 없으면(일반 수행) 기존과 동일.
      opts?: { condition?: string },
    ) => {
      if (!activeSession || tcs.length === 0) return;

      // 계약 요약 — 판단 근거를 주입(원문 재조회 없이). PR·코드 소스는 수행 판정에
      // 직접 안 쓰므로 제외하고 문서형 소스 요약 + 핵심 요구만 압축한다.
      const c = absorb.contract;
      const digest = c
        ? [
            '[기능 맥락 — 이미 흡수된 요약. 티켓·기획 원문을 다시 조회하지 말 것]',
            ...c.sources
              .filter((s) => s.type !== 'PR' && s.type !== '코드')
              .map((s) => `- ${s.id}: ${s.summary}`),
            ...(c.requirements.length
              ? [`[핵심 요구] ${c.requirements.map((r) => r.text).join(' / ')}`]
              : []),
            '',
          ].join('\n')
        : '';

      // 결과 표 파서 — 한 세션 응답에서 | TC-ID | 결과 | 사유 | 행만 뽑는다
      const RESULTS = new Set(['Pass', 'Fail', 'Blocked', 'Not Test']);
      const parseResults = (full: string) => {
        const out: Array<{ localId: string; result: 'Pass' | 'Fail' | 'Blocked' | 'Not Test'; note?: string }> = [];
        for (const line of full.split('\n')) {
          if (!line.trim().startsWith('|')) continue;
          const cells = line.split('|').map((x) => x.trim()).filter((_, i, a) => i > 0 && i < a.length - 1);
          if (cells.length < 2) continue;
          const [localId, result, note] = cells;
          // 헤더('TC-ID')·구분선('---')·빈 id만 제외하고, 결과가 유효하면 **어떤 id 형식이든** 받는다.
          // ⚠️ 예전엔 /^TC-\d+/로 한정해, local_id가 숫자(1,2,3)·MV-·RPT- 등인 작업은 결과가
          //    통째로 파싱에서 탈락해 기입이 안 됐다 (회귀 수정 2026-08-18). 매칭은 서버가 정규화로 처리.
          if (!localId || /^-{2,}$/.test(localId) || localId.toUpperCase() === 'TC-ID') continue;
          if (!RESULTS.has(result)) continue;
          out.push({ localId, result: result as 'Pass' | 'Fail' | 'Blocked' | 'Not Test', note: note || undefined });
        }
        return out;
      };

      // 재수행 조건 블록 — 로그인 재사용 규칙보다 우선한다(계정 변경·재로그인 지시가 먹히게).
      const conditionBlock = opts?.condition?.trim()
        ? [
            '[재수행 조건 — 아래 지시를 로그인 재사용 규칙보다 우선 적용할 것]',
            opts.condition.trim(),
            '',
          ]
        : [];

      const buildPrompt = (part: typeof tcs) =>
        [
          '[TC 자동 수행 — stage 환경 (tms-stage.roouty.io / API: tms-api-stage.roouty.io)]',
          ...conditionBlock,
          '아래 TC 전부를 **시스템 지시의 수행 절차대로** 판정해줘:',
          '먼저 전체를 훑어 분류(백엔드 판정 가능 vs 화면 필요, 화면은 화면·전제별 그룹) →',
          '백엔드 그룹을 repo·stage API read-only로 일괄 판정 → 화면 그룹은 화면 단위로 한 번',
          '이동해 그룹 TC를 모두 확인. **표 순서대로 한 건씩 이동·확인하지 말 것.**',
          '',
          digest,
          '⚠️ 응답 **맨 끝**에 반드시 아래 형식의 결과 표만 출력 (자동 기입용 — 결과는 Pass/Fail/Blocked/Not Test 중 하나):',
          '| TC-ID | 결과 | 사유 |',
          '| (아래 [수행할 TC]의 ID를 글자 그대로) | Pass | ... |',
          '※ TC-ID는 [수행할 TC]에 적힌 ID를 **변형 없이 그대로** 쓸 것 (예: 1, MV-003, TC-007 등 — 형식을 바꾸거나 zero-padding 추가 금지).',
          '',
          '[수행할 TC]',
          ...part.map((t) =>
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
        ]
          .filter(Boolean)
          .join('\n');

      // 한 세션 실행 → 파싱 → 기입. retryTcs = 실패 시 재시도 배너가 다시 돌릴 TC 목록.
      const runOne = async (part: typeof tcs, label: string, retryTcs: typeof tcs) => {
        const full =
          (await handleSend(buildPrompt(part), [], {
            displayMessage: label,
            tcRun: true,
            phase: 'run',
            freshSession: true, // 새 세션 — 설계 대화 상속 안 함
            onRetry: () => handleRunTc(retryTcs, opts), // 재시도도 같은 조건 유지
          })) ?? '';
        // 빈 응답 = 에러/중단 → handleSend가 재시도 배너를 세워둔다
        if (!full.trim()) return { ok: false as const, applied: 0, unmatched: [] as string[] };
        const parsed = parseResults(full);
        if (parsed.length === 0) {
          addToast('warning', '수행은 됐지만 결과 표를 못 읽었습니다. 대화에서 확인 후 수동 기입해주세요.');
          return { ok: true as const, applied: 0, unmatched: [] as string[] };
        }
        const res = await fetch('/api/workspace/tc', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'auto-results', sessionId: activeSession.id, results: parsed }),
        });
        const body = (await res.json()) as { applied: number; unmatched: string[] };
        setTcSavedAt(Date.now()); // 세션(청크)마다 즉시 표 새로고침
        return { ok: true as const, applied: body.applied, unmatched: body.unmatched };
      };

      const finalToast = (applied: number, unmatched: string[]) =>
        addToast(
          unmatched.length ? 'warning' : 'success',
          `${applied}건 자동 기입` + (unmatched.length ? ` · 미매칭 ${unmatched.join(', ')}` : ''),
        );

      /*
        안전장치(예방형) — 세션 하나에 너무 많은 TC가 쌓여 컨텍스트가 과부하로 "뻑나기 전에"
        카운트 기준으로 미리 끊는다. 세션당 최대 CHUNK건이라 절대 그 지점에 닿지 않는다.
        작은/중간 세트는 통째로 1세션(빠름 — 워밍업·네비게이션 공유). 큰 세트만 청크로
        끊고 청크마다 저장 → 중간 실패해도 앞 청크 결과는 남고 그 청크부터 재시도된다.

        임계값 20 (2026-08-18): 명세 로드 제거·로그인 재사용으로 세션이 가벼워져 한 세션이
        20건까지 감당 가능. 그전 보수적 값 10에서 상향 — 분할이 덜 일어나 플랜·네비 공유 이득↑.
      */
      const CHUNK = 20;

      if (tcs.length <= CHUNK) {
        const r = await runOne(
          tcs,
          `▶ TC ${tcs.length}건 stage 자동 수행 (${tcs.map((t) => t.localId).join(', ')})`,
          tcs,
        );
        if (!r.ok) return;
        finalToast(r.applied, r.unmatched);
        return;
      }

      const chunks: Array<typeof tcs> = [];
      for (let i = 0; i < tcs.length; i += CHUNK) chunks.push(tcs.slice(i, i + CHUNK));
      let totalApplied = 0;
      const allUnmatched: string[] = [];
      for (let ci = 0; ci < chunks.length; ci++) {
        const part = chunks[ci];
        const r = await runOne(
          part,
          `▶ [${ci + 1}/${chunks.length}] TC ${part.length}건 stage 수행 (${part.map((t) => t.localId).join(', ')})`,
          tcs.slice(ci * CHUNK), // 실패 시 이 청크부터 재시도(앞 청크는 이미 저장됨)
        );
        if (!r.ok) return; // handleSend가 재시도 배너를 세워둠 — 남은 청크는 멈춘다
        totalApplied += r.applied;
        allUnmatched.push(...r.unmatched);
      }
      finalToast(totalApplied, allUnmatched);
    },
    [activeSession, absorb.contract, handleSend, addToast],
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

  /*
    진행 띠(⓪~⑦)의 실제 상태 — 고정 라벨이 아니라 지금 도는 단계를 켠다 (2026-08-13).
      · ⓪① 흡수·교차분석 → absorb.status
      · ②  확인          → 전제(decisions) 고정 여부
      · ③~⑥ 설계·작성    → design 스트림 중이거나(streamPhase) 파이프라인 실행 중이면 run,
                            TC가 한 건이라도 작성돼 있으면 done
      · ⑦  수행          → run 스트림 중이면 run, 결과가 하나라도 있으면 done
  */
  const tcDrafted = activeSession ? collectTcRawRows(activeSession).length > 0 : false;
  const designRunning = streamPhase === 'design' || pipelineRunning;
  const runRunning = streamPhase === 'run';
  const codexSkipped = absorb.status === 'skipped'; // 단일 소스 → codex 교차분석 생략
  const bandStages: Array<{
    label: string;
    status: 'wait' | 'run' | 'done' | 'skip';
    tone: string;
    title: string;
    arrowBefore?: boolean;
  }> = [
    {
      label: '⓪ 📥 개별 흡수',
      status: codexSkipped ? 'skip' : absorb.status === 'running' ? 'run' : absorb.contract ? 'done' : 'wait',
      tone: '#10A37F',
      title: codexSkipped ? '단일 소스 — codex 생략, Claude가 바로 읽음' : 'Codex 세션 1개가 담당 — 입력 카드에서 시작',
    },
    {
      label: '① 🔀 교차 분석',
      status: codexSkipped ? 'skip' : absorb.status === 'running' ? 'run' : absorb.contract ? 'done' : 'wait',
      tone: '#10A37F',
      title: codexSkipped ? '단일 소스 — 대조할 다른 소스가 없어 생략' : 'Codex — 소스 간 모순·중복·누락 대조',
    },
    {
      label: '② ✋ 확인',
      status: codexSkipped
        ? 'skip'
        : (absorb.contract?.decisions.length ?? 0) > 0 ? 'done' : absorb.contract ? 'run' : 'wait',
      tone: 'var(--info)',
      title: codexSkipped ? '단일 소스 — 게이트 생략(모순·누락 없음)' : '사람 — 확인 게이트에서 전제 확정',
      arrowBefore: true,
    },
    {
      label: '③~⑥ ✍️ 설계·작성',
      status: designRunning ? 'run' : tcDrafted ? 'done' : 'wait',
      tone: 'var(--accent)',
      title: 'Claude — TC 설계·작성·리뷰·수정 (아래 카드)',
      arrowBefore: true,
    },
    {
      label: '⑦ ✅ 수행',
      status: runRunning ? 'run' : tcAvailable ? 'done' : 'wait',
      tone: 'var(--accent)',
      title: 'Claude + Playwright — stage 자동 수행 (TC 카드)',
      arrowBefore: true,
    },
  ];

  /*
    #4 재시도 배너 — 에러로 멈췄을 때 "처음부터"가 아니라 저장된 지점에서 이어가게 한다.
    두 레이아웃(작업 화면·일반 채팅)에서 같은 걸 쓴다.
  */
  const retryBanner = retry ? (
    <div
      className="rounded-[13px] border p-3 flex items-center gap-3 flex-wrap"
      style={{
        borderColor: 'color-mix(in srgb, var(--warn) 45%, transparent)',
        backgroundColor: 'color-mix(in srgb, var(--warn) 10%, transparent)',
      }}
    >
      <span className="text-[16px] leading-none">⚠️</span>
      <div className="flex-1 min-w-[200px]">
        <div className="text-[12.5px] font-semibold text-[var(--tx-1)]">오류로 중단됨</div>
        <div className="text-[11px] text-[var(--tx-3)] mt-0.5">
          계약·전제·TC는 저장돼 있습니다. <b className="text-[var(--tx-2)]">처음부터 재분석하지 않고</b> 이
          지점부터 이어서 진행합니다.
        </div>
      </div>
      <button
        onClick={() => void retry.run()}
        disabled={isStreaming || pipelineRunning || absorb.status === 'running'}
        className="shrink-0 px-3 py-1.5 rounded-[7px] border border-[var(--warn)] text-[11px] font-semibold
                   text-[var(--warn)] hover:bg-[color-mix(in_srgb,var(--warn)_16%,transparent)]
                   disabled:opacity-40 disabled:cursor-not-allowed"
      >
        ▶ {retry.label}
      </button>
      <button
        onClick={() => setRetry(null)}
        className="shrink-0 px-2 py-1.5 rounded-[7px] text-[11px] text-[var(--tx-4)] hover:text-[var(--tx-2)]"
      >
        닫기
      </button>
    </div>
  ) : null;

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
                    onAnalyze={(urls, text) => void handleAnalyze(urls, text)}
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
                      이제 다섯 단계 전부 실제 진행을 따라간다 (2026-08-13):
                      run(지금 도는 중)=앰버 펄스 · done(끝남)=담당색 · wait=회색.
                      "codex 분석 중"으로 버튼만 바뀌고 띠는 고정이던 문제를 해소.
                    */}
                    <div className="flex items-center gap-1 flex-wrap mt-2 mb-2.5 font-mono text-[10px]">
                      {bandStages.map((s) => {
                        // run=앰버(진행) · wait=회색 · skip=회색(생략, 취소선) · done=담당색
                        const color =
                          s.status === 'run'
                            ? 'var(--warn)'
                            : s.status === 'wait' || s.status === 'skip'
                              ? 'var(--tx-4)'
                              : s.tone;
                        return (
                          <span key={s.label} className="contents">
                            {s.arrowBefore && <span className="text-[var(--tx-4)]">→</span>}
                            <span
                              className={
                                'px-2 py-0.5 rounded border inline-flex items-center gap-1 ' +
                                (s.status === 'run' ? 'animate-pulse ' : '') +
                                (s.status === 'skip' ? 'line-through opacity-60' : '')
                              }
                              style={{
                                color,
                                borderColor: `color-mix(in srgb, ${color} 42%, transparent)`,
                                backgroundColor: `color-mix(in srgb, ${color} ${s.status === 'wait' || s.status === 'skip' ? '8' : '16'}%, transparent)`,
                              }}
                              title={s.title}
                            >
                              {s.status === 'run' && (
                                <span
                                  className="w-1 h-1 rounded-full"
                                  style={{ backgroundColor: 'var(--warn)' }}
                                />
                              )}
                              {s.label}
                              {s.status === 'skip' && <span className="no-underline"> 생략</span>}
                            </span>
                          </span>
                        );
                      })}
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

                  {/*
                    #5 에러 이어가기 배너 — 상단이 아니라 작업 대화 바로 위에 둔다.
                    오류는 설계·수행 중(이 대화)에서 나므로, 그 맥락 옆에서 재시도하는 게 직관적.
                  */}
                  {retryBanner}

                  {/* ── 분석 대화 — 응답이 흐르는 곳 (입력은 상단 카드) ── */}
                  {((activeSession?.messages.length ?? 0) > 0 || isStreaming) && (
                    <>
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

                      {/*
                        #후속 입력 (2026-08-19) — 대화가 생긴 뒤부터 추가 요구사항을 이어서 보낸다.
                        기존 handleSend를 그대로 재사용(같은 세션 --resume, 맥락 유지). 응답 중엔 비활성.
                      */}
                      <div className="flex items-end gap-2 rounded-[13px] border border-[var(--line)] bg-[var(--panel)] p-2.5">
                        <textarea
                          value={followUp}
                          onChange={(e) => setFollowUp(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter' && !e.shiftKey) {
                              e.preventDefault();
                              const t = followUp.trim();
                              if (t && !isStreaming) {
                                setFollowUp('');
                                void handleSend(t, []);
                              }
                            }
                          }}
                          disabled={isStreaming}
                          rows={1}
                          placeholder="추가 분석·요구사항 입력 — 예) 동시성 리스크만 더 파줘 / 이 부분 TC로 만들어줘  (Enter 전송·Shift+Enter 줄바꿈)"
                          className="flex-1 min-w-0 bg-[var(--inset)] border border-[var(--line-2)] rounded-[9px]
                                     px-3 py-2 text-[12px] leading-[1.6] text-[var(--tx-1)] resize-none
                                     outline-none focus:border-[var(--accent)]
                                     placeholder:text-[var(--tx-4)] disabled:opacity-50 max-h-[120px]"
                        />
                        <button
                          onClick={() => {
                            const t = followUp.trim();
                            if (t && !isStreaming) {
                              setFollowUp('');
                              void handleSend(t, []);
                            }
                          }}
                          disabled={isStreaming || !followUp.trim()}
                          className="shrink-0 px-3.5 py-2 rounded-[8px] border border-[var(--accent-deep)] bg-[var(--accent-deep)]
                                     text-white text-[11.5px] font-semibold hover:bg-[var(--accent)]
                                     disabled:opacity-40 disabled:cursor-not-allowed"
                        >
                          {isStreaming ? '응답 중…' : '보내기'}
                        </button>
                      </div>
                    </>
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
                {retryBanner && <div className="px-3.5 pb-2">{retryBanner}</div>}
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
