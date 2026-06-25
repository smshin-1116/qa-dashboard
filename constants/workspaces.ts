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
 */
export type WorkspaceLayout = 'chat' | 'pipeline' | 'tool';

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
    key: 'tc',
    path: '/dashboard/tc',
    label: 'TC 자동화',
    icon: '🧪',
    sidebarLabel: '작업 이력',
    description: '기획서 기반 테스트 케이스 자동 생성 · 품질 검증',
    layout: 'pipeline',
    defaultAgentMode: 'designer',
    agentModes: ['designer', 'writer', 'reviewer', 'fixer'],
    panelTabs: ['품질', '세션'],
  },
  {
    key: 'analyze',
    path: '/dashboard/analyze',
    label: '기능 분석',
    icon: '🔍',
    sidebarLabel: '대화 목록',
    description: 'Jira · Figma · GitHub 연동 서비스/기능 분석',
    layout: 'chat',
    defaultAgentMode: 'general',
    agentModes: ['general'],
    panelTabs: ['MCP', '세션'],
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
