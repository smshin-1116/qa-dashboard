'use client';

import { create } from 'zustand';
import type { Session, ChatMessage, AIModel, Attachment } from '@/types/session';
import {
  getAllSessions,
  getSession,
  saveSession,
  deleteSession,
} from '@/lib/indexeddb/sessionStore';

function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

function generateTitle(firstMessage: string): string {
  return firstMessage.slice(0, 30) + (firstMessage.length > 30 ? '...' : '');
}

interface SessionStore {
  /** 사이드바에 표시할 세션 목록 */
  sessions: Session[];
  /** 현재 활성 세션 */
  activeSession: Session | null;
  /** IndexedDB 로드 완료 여부 */
  isLoaded: boolean;

  // 초기화
  loadSessions: () => Promise<void>;
  // 세션 CRUD
  createSession: (model: AIModel) => Promise<Session>;
  selectSession: (id: string) => Promise<void>;
  removeSession: (id: string) => Promise<void>;
  // 메시지 관리
  addMessage: (message: Omit<ChatMessage, 'id' | 'createdAt'>) => Promise<void>;
  // 모델 변경
  changeModel: (model: AIModel) => Promise<void>;
  // claude CLI 세션 ID 저장
  updateClaudeSessionId: (claudeSessionId: string) => Promise<void>;
}

export const useSessionStore = create<SessionStore>((set, get) => ({
  sessions: [],
  activeSession: null,
  isLoaded: false,

  loadSessions: async () => {
    const sessions = await getAllSessions();
    const activeSession = sessions[0] ?? null;
    // 가장 최근 세션이 있으면 full 데이터 로드
    const loaded = activeSession ? await getSession(activeSession.id) ?? activeSession : null;
    set({ sessions, activeSession: loaded, isLoaded: true });
  },

  createSession: async (model) => {
    const now = Date.now();
    const session: Session = {
      id: generateId(),
      title: '새 대화',
      model,
      messages: [],
      createdAt: now,
      updatedAt: now,
    };
    await saveSession(session);
    set((state) => ({
      sessions: [session, ...state.sessions],
      activeSession: session,
    }));
    return session;
  },

  selectSession: async (id) => {
    const session = await getSession(id);
    if (session) {
      set({ activeSession: session });
    }
  },

  removeSession: async (id) => {
    await deleteSession(id);
    set((state) => {
      const sessions = state.sessions.filter((s) => s.id !== id);
      const activeSession =
        state.activeSession?.id === id ? (sessions[0] ?? null) : state.activeSession;
      return { sessions, activeSession };
    });
  },

  addMessage: async (messageData) => {
    const { activeSession } = get();
    if (!activeSession) return;

    const message: ChatMessage = {
      ...messageData,
      id: generateId(),
      createdAt: Date.now(),
    };

    const isFirstUserMessage =
      messageData.role === 'user' && activeSession.messages.length === 0;

    const updated: Session = {
      ...activeSession,
      title: isFirstUserMessage ? generateTitle(messageData.content) : activeSession.title,
      messages: [...activeSession.messages, message],
      updatedAt: Date.now(),
    };

    await saveSession(updated);
    set((state) => ({
      activeSession: updated,
      sessions: state.sessions.map((s) => (s.id === updated.id ? updated : s)),
    }));
  },

  changeModel: async (model) => {
    const { activeSession } = get();
    if (!activeSession) return;

    const updated: Session = { ...activeSession, model, updatedAt: Date.now() };
    await saveSession(updated);
    set((state) => ({
      activeSession: updated,
      sessions: state.sessions.map((s) => (s.id === updated.id ? updated : s)),
    }));
  },

  updateClaudeSessionId: async (claudeSessionId) => {
    const { activeSession } = get();
    if (!activeSession) return;

    const updated: Session = { ...activeSession, claudeSessionId, updatedAt: Date.now() };
    await saveSession(updated);
    set((state) => ({
      activeSession: updated,
      sessions: state.sessions.map((s) => (s.id === updated.id ? updated : s)),
    }));
  },
}));
