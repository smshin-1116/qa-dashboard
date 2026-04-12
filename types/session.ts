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
  title: string;
  model: AIModel;
  messages: ChatMessage[];
  /** claude CLI --resume 에 사용하는 세션 ID */
  claudeSessionId?: string;
  createdAt: number;
  updatedAt: number;
}
