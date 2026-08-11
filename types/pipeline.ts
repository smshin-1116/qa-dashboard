import type { AgentMode } from '@/types/session';

/**
 * 파이프라인 SSE 이벤트.
 * 재생(mock) 모드가 이 타입을 그대로 직렬화/재생하므로,
 * 필드를 추가할 때는 기존 fixture와의 호환성을 함께 고려해야 합니다.
 */
export type PipelineEvent =
  | { type: 'start'; totalStages: number; mock?: boolean; recordedAt?: string }
  | { type: 'stage_start'; stageIndex: number; stage: AgentMode; label: string; emoji: string }
  | { type: 'chunk'; content: string }
  | { type: 'tool'; label: string }
  | {
      type: 'stage_done';
      stageIndex: number;
      stage: AgentMode;
      content: string;
      userMessage: string;
      claudeSessionId: string | null;
    }
  | { type: 'done' }
  | { type: 'error'; message: string };

/** fixture에 기록되는 단일 이벤트 (t = 실행 시작 후 경과 ms) */
export interface RecordedPipelineEvent {
  t: number;
  event: PipelineEvent;
}

export interface PipelineFixture {
  version: 1;
  recordedAt: string;
  confluenceUrl: string;
  durationMs: number;
  events: RecordedPipelineEvent[];
}
