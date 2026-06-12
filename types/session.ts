export type AIModel = 'claude' | 'gemini' | 'codex';

export type AgentMode = 'general' | 'designer' | 'writer' | 'reviewer' | 'fixer';

export type MessageRole = 'user' | 'assistant';

export interface Attachment {
  id: string;
  type: 'file' | 'image' | 'code';
  name: string;
  /** base64 인코딩된 데이터 또는 코드 텍스트 */
  data: string;
  mimeType?: string;
}

export interface ChatMessage {
  id: string;
  role: MessageRole;
  content: string;
  attachments?: Attachment[];
  createdAt: number;
}

export interface Session {
  id: string;
  /** 자동 생성된 제목 (첫 사용자 메시지 30자) — customTitle이 없을 때 표시 */
  title: string;
  /** 사용자가 직접 지정한 제목 — 있으면 title 대신 우선 표시 */
  customTitle?: string;
  /** 사이드바 상단에 고정 (false/미정 = 일반 그룹) */
  pinned?: boolean;
  model: AIModel;
  messages: ChatMessage[];
  /** claude CLI --resume 에 사용하는 세션 ID */
  claudeSessionId?: string;
  createdAt: number;
  updatedAt: number;
}
