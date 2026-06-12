'use client';

import { create } from 'zustand';
import type { Session, ChatMessage, AIModel, Attachment, WorkspaceKind } from '@/types/session';
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

/**
 * 메시지가 한 건도 없는 세션은 IndexedDB에 저장되지 않은 draft 상태이므로,
 * 활성 세션이 다른 세션으로 바뀔 때 in-memory 리스트에서 제거한다.
 * (저장 안 됐기 때문에 DB delete 불필요)
 */
function dropDraftIfEmpty(sessions: Session[], candidate: Session | null): Session[] {
  if (!candidate || candidate.messages.length > 0) return sessions;
  return sessions.filter((s) => s.id !== candidate.id);
}

/** 레거시 세션(kind 미지정)의 기본 워크스페이스 — 앱 본래 정체성인 TC 자동화로 귀속 */
const LEGACY_KIND: WorkspaceKind = 'tc';

interface SessionStore {
  /** 모든 워크스페이스의 세션 목록 (사이드바는 activeKind로 필터해서 표시) */
  sessions: Session[];
  /** 현재 활성 세션 */
  activeSession: Session | null;
  /** 현재 보고 있는 워크스페이스(화면) */
  activeKind: WorkspaceKind;
  /** IndexedDB 로드 완료 여부 */
  isLoaded: boolean;

  // 초기화
  loadSessions: () => Promise<void>;
  /** 워크스페이스 전환 — 해당 kind의 최신 세션을 활성화 (없으면 null) */
  setActiveKind: (kind: WorkspaceKind) => Promise<void>;
  // 세션 CRUD
  createSession: (model: AIModel, kind?: WorkspaceKind) => Promise<Session>;
  selectSession: (id: string) => Promise<void>;
  removeSession: (id: string) => Promise<void>;
  // 메시지 관리
  addMessage: (message: Omit<ChatMessage, 'id' | 'createdAt'>) => Promise<void>;
  // 모델 변경
  changeModel: (model: AIModel) => Promise<void>;
  // claude CLI 세션 ID 저장
  updateClaudeSessionId: (claudeSessionId: string) => Promise<void>;
  // 핀 토글 (사이드바 상단 고정)
  togglePin: (id: string) => Promise<void>;
  // 사용자 지정 제목 (빈 문자열이면 자동 제목으로 복귀)
  renameSession: (id: string, customTitle: string) => Promise<void>;
}

export const useSessionStore = create<SessionStore>((set, get) => ({
  sessions: [],
  activeSession: null,
  activeKind: LEGACY_KIND,
  isLoaded: false,

  loadSessions: async () => {
    const all = await getAllSessions();
    // 자가 청소: lazy 생성 도입 이전에 persist된 빈 draft를 IndexedDB에서도 제거
    // (현재 로직상 빈 세션은 더 이상 저장되지 않으므로 안전)
    const orphanIds = all.filter((s) => s.messages.length === 0).map((s) => s.id);
    if (orphanIds.length > 0) {
      await Promise.all(orphanIds.map((id) => deleteSession(id)));
    }
    // 레거시 마이그레이션: kind 없는 세션은 기본 워크스페이스로 귀속하고 DB에 반영
    const sessions = all.filter((s) => s.messages.length > 0);
    const needMigration = sessions.filter((s) => !s.kind);
    if (needMigration.length > 0) {
      await Promise.all(
        needMigration.map((s) => {
          s.kind = LEGACY_KIND;
          return saveSession(s);
        }),
      );
    }
    // 활성 세션은 setActiveKind에서 화면별로 선택하므로 여기선 비워둔다
    set({ sessions, activeSession: null, isLoaded: true });
  },

  setActiveKind: async (kind) => {
    const { sessions, activeSession } = get();
    // 이전 active가 빈 draft였다면 화면 전환 시 제거
    const cleaned = dropDraftIfEmpty(sessions, activeSession);
    // 현재 active가 이미 이 kind면 유지, 아니면 해당 kind 최신 세션 선택
    if (activeSession && activeSession.kind === kind && activeSession.messages.length > 0) {
      set({ sessions: cleaned, activeKind: kind });
      return;
    }
    const newest = cleaned.find((s) => s.kind === kind) ?? null; // getAllSessions가 updatedAt desc 정렬
    const loaded = newest ? (await getSession(newest.id)) ?? newest : null;
    set({ sessions: cleaned, activeKind: kind, activeSession: loaded });
  },

  createSession: async (model, kind) => {
    const now = Date.now();
    const session: Session = {
      id: generateId(),
      kind: kind ?? get().activeKind,
      title: '새 대화',
      model,
      messages: [],
      createdAt: now,
      updatedAt: now,
    };
    // 빈 draft는 IndexedDB에 저장하지 않음 — 첫 메시지 전송 시 addMessage가 persist
    set((state) => {
      const cleaned = dropDraftIfEmpty(state.sessions, state.activeSession);
      return {
        sessions: [session, ...cleaned],
        activeSession: session,
      };
    });
    return session;
  },

  selectSession: async (id) => {
    const session = await getSession(id);
    if (!session) return;
    set((state) => {
      // 이전 active가 빈 draft였다면 이탈 시 제거
      const cleaned = dropDraftIfEmpty(state.sessions, state.activeSession);
      return { sessions: cleaned, activeSession: session };
    });
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
    // 빈 draft는 아직 DB에 없으므로 저장 생략 — in-memory만 업데이트
    if (updated.messages.length > 0) {
      await saveSession(updated);
    }
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

  togglePin: async (id) => {
    const target = get().sessions.find((s) => s.id === id);
    if (!target) return;
    // draft(메시지 0건)는 아직 DB에 없으므로 핀 불가
    if (target.messages.length === 0) return;

    const updated: Session = { ...target, pinned: !target.pinned };
    await saveSession(updated);
    set((state) => ({
      sessions: state.sessions.map((s) => (s.id === id ? updated : s)),
      activeSession: state.activeSession?.id === id ? updated : state.activeSession,
    }));
  },

  renameSession: async (id, customTitle) => {
    const target = get().sessions.find((s) => s.id === id);
    if (!target) return;
    if (target.messages.length === 0) return; // draft는 첫 메시지에서 자동 제목 부여

    const trimmed = customTitle.trim();
    const updated: Session = {
      ...target,
      customTitle: trimmed.length > 0 ? trimmed : undefined,
    };
    await saveSession(updated);
    set((state) => ({
      sessions: state.sessions.map((s) => (s.id === id ? updated : s)),
      activeSession: state.activeSession?.id === id ? updated : state.activeSession,
    }));
  },
}));
