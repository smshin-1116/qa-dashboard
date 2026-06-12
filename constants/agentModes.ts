import type { AgentMode } from '@/types/session';

export type { AgentMode };

export interface AgentModeInfo {
  label: string;
  shortLabel: string;
  description: string;
  color: string;
}

export const AGENT_MODES: Record<AgentMode, AgentModeInfo> = {
  general: {
    label: '일반 QA',
    shortLabel: '일반',
    description: 'Jira, Figma, GitHub 등 전반적인 QA 업무',
    color: '#818CF8',
  },
  designer: {
    label: 'TC 설계',
    shortLabel: '설계',
    description: '기획서 분석 및 대/중/소분류 TC 구조 설계',
    color: '#34D399',
  },
  writer: {
    label: 'TC 작성',
    shortLabel: '작성',
    description: 'TC 생성 전문 — 검증단계 분포·재현스텝 품질 자동 검증',
    color: '#60A5FA',
  },
  reviewer: {
    label: 'QA 리뷰',
    shortLabel: '리뷰',
    description: 'EVAL 13개 기준으로 TC 품질 검증',
    color: '#FBBF24',
  },
  fixer: {
    label: 'TC 수정',
    shortLabel: '수정',
    description: '리뷰 이슈 기반 TC 수정 (CRITICAL → LOW 순)',
    color: '#F87171',
  },
};

export const AGENT_MODE_KEYS = Object.keys(AGENT_MODES) as AgentMode[];

/** 워크스페이스별로 에이전트 모드를 따로 기억하기 위한 localStorage 키 */
function modeKey(workspaceKey?: string): string {
  return workspaceKey ? `qa-agent-mode-${workspaceKey}` : 'qa-agent-mode';
}

/**
 * 저장된 에이전트 모드를 읽되, `allowed`가 주어지면 그 안의 값만 인정하고
 * 아니면 `fallback`(기본 모드)으로 복귀한다.
 */
export function initAgentMode(
  workspaceKey?: string,
  allowed?: AgentMode[],
  fallback: AgentMode = 'general',
): AgentMode {
  if (typeof window === 'undefined') return fallback;
  const stored = localStorage.getItem(modeKey(workspaceKey)) as AgentMode | null;
  if (stored && stored in AGENT_MODES && (!allowed || allowed.includes(stored))) {
    return stored;
  }
  return fallback;
}

export function persistAgentMode(mode: AgentMode, workspaceKey?: string): void {
  localStorage.setItem(modeKey(workspaceKey), mode);
}
