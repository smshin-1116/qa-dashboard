import type { AgentMode, WorkspaceKind } from '@/types/session';

/**
 * 우측 패널 탭 키 — RightPanel이 렌더할 수 있는 탭 종류.
 * 워크스페이스별로 노출할 탭을 panelTabs로 골라 쓴다.
 */
export type PanelTab = '파이프라인' | '품질' | 'MCP' | '세션';

/**
 * 워크스페이스(화면) 정의.
 *
 * ⭐ 탭 메뉴 확장 지점 ⭐
 * 새 화면을 추가하려면:
 *   1) types/session.ts의 WorkspaceKind에 키 추가
 *   2) 아래 WORKSPACES 배열에 항목 추가
 *   3) app/dashboard/<path>/page.tsx 에서 <WorkspaceView workspaceKey="..." /> 렌더
 * 헤더 탭·사이드바 필터·패널 구성·에이전트 모드는 이 설정만 보고 자동으로 따라간다.
 */
/**
 * 화면 레이아웃 형태.
 * - 'chat'     : 채팅 중앙 + 우측 탭 패널(panelTabs)  — 기능 분석
 * - 'pipeline' : 중앙 상단 파이프라인 실행기 + 하단 채팅, 우측 품질 리포트 고정 — TC 자동화
 * - 'tool'     : 채팅/세션 없는 폼 기반 단독 툴 화면 (WorkspaceView 미사용) — 인수증 생성
 * - 'board'    : 채팅 없는 관제 보드. 수집된 신호를 읽어 타일·목록으로 표시 — 오늘
 */
export type WorkspaceLayout = 'chat' | 'pipeline' | 'tool' | 'board';

export interface WorkspaceConfig {
  key: WorkspaceKind;
  /** 라우트 경로 */
  path: string;
  /** 헤더 탭 라벨 */
  label: string;
  /** 헤더 탭 이모지 */
  icon: string;
  /** 사이드바 헤더 라벨 (예: "작업 이력", "대화 목록") */
  sidebarLabel: string;
  /** 툴팁/설명 */
  description: string;
  /** 화면 레이아웃 형태 */
  layout: WorkspaceLayout;
  /** 진입 시 기본 에이전트 모드 */
  defaultAgentMode: AgentMode;
  /** 이 화면에서 선택 가능한 에이전트 모드 */
  agentModes: AgentMode[];
  /** 우측 패널 탭 (layout 'chat'에서만 사용. 'pipeline'은 품질 리포트 고정) */
  panelTabs: PanelTab[];
}

export const WORKSPACES: WorkspaceConfig[] = [
  {
    /**
     * 오늘 — 아침 브리핑.
     * 신호원 4곳을 출근 전에 수집해 오늘 할 일로 환산한다.
     * 채팅·세션이 없고 상태 저장소(data/workspace.db)만 읽는다.
     */
    key: 'today',
    path: '/dashboard/today',
    label: '오늘',
    icon: '📋',
    sidebarLabel: '최근 브리핑',
    description: '어젯밤 실행·티켓·프로덕션 에러를 모아 오늘 할 일로 산출',
    layout: 'board',
    defaultAgentMode: 'general',
    agentModes: ['general'],
    panelTabs: [],
  },
  {
    /**
     * QA 작업 (㉮ 일회성) — 구 `TC 자동화` + `기능 분석`을 합친 화면.
     *
     * 2026-08-06 확정: 화면을 나누는 축은 "TC냐 아니냐"가 아니라
     * **일회성 작업 / 영구 자산**이다. 분석 → TC 작성 → 수행은 한 흐름이므로
     * 탭을 오가지 않고 한 화면에서 끝낸다.
     *
     * 구성 — `pipeline` 레이아웃이 파이프라인과 채팅을 모두 갖는다:
     *   상단  파이프라인 실행기 (설계·작성·리뷰·수정)   ← 구 TC 자동화
     *   중앙  채팅 (티켓·기획 분석)                     ← 구 기능 분석
     *   우측  품질 · MCP · 세션 탭
     *
     * 세션은 두 화면 것이 한 목록에 섞인다 — 한 작업의 기록이기 때문 (2026-08-09 결정).
     */
    key: 'work',
    path: '/dashboard/work',
    label: 'QA 작업',
    icon: '🔍',
    sidebarLabel: '작업 이력',
    description: '티켓·기획 분석부터 TC 작성·수행까지 — 티켓과 함께 끝나는 일회성 작업',
    layout: 'pipeline',
    // 진입 시에는 분석(general)로 시작한다. TC를 뽑을 때 파이프라인 모드로 전환.
    defaultAgentMode: 'general',
    agentModes: ['general', 'designer', 'writer', 'reviewer', 'fixer'],
    panelTabs: ['품질', 'MCP', '세션'],
  },
  {
    key: 'receipt',
    path: '/dashboard/receipt',
    label: '인수증 생성',
    icon: '🧾',
    sidebarLabel: '인수증 생성',
    description: '배차확정 데이터로 SAP 거래명세서 페이로드를 합성해 인수증을 생성하는 툴',
    layout: 'tool',
    defaultAgentMode: 'general',
    agentModes: ['general'],
    panelTabs: [],
  },
];

/** 기본 워크스페이스 (/dashboard 진입 시 리다이렉트 대상) */
export const DEFAULT_WORKSPACE: WorkspaceConfig = WORKSPACES[0];

/** kind로 워크스페이스 설정 조회 — 미정의 키는 기본 워크스페이스로 폴백 */
export function getWorkspace(key: string): WorkspaceConfig {
  return WORKSPACES.find((w) => w.key === key) ?? DEFAULT_WORKSPACE;
}
