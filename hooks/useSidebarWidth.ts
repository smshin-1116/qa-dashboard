'use client';

import { useState, useCallback, useEffect, useRef } from 'react';

/** 사이드바 너비 영속화 키 */
const STORAGE_KEY = 'qa-dashboard:sidebar-width';

/** 너비 제약 — 너무 좁아지거나 화면을 잠식하지 않도록 */
export const SIDEBAR_MIN_WIDTH = 200;
export const SIDEBAR_MAX_WIDTH = 420;
export const SIDEBAR_DEFAULT_WIDTH = 236;

/** min/max 범위로 너비를 보정 */
function clampWidth(w: number): number {
  return Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, w));
}

/**
 * 사이드바 리사이즈 상태 관리 훅.
 * - 오른쪽 경계 드래그로 너비를 실시간 조절
 * - 드래그 종료 시점에만 localStorage에 저장 (mousemove마다 저장하지 않음)
 * - 새로고침 후 저장된 너비 복원 (SSR 하이드레이션 불일치 방지를 위해 mount 후 적용)
 */
export function useSidebarWidth() {
  const [width, setWidth] = useState<number>(SIDEBAR_DEFAULT_WIDTH);
  const [isResizing, setIsResizing] = useState(false);

  // mousemove 핸들러에서 최신 너비를 참조하기 위한 ref
  const widthRef = useRef(width);
  widthRef.current = width;

  // 저장된 너비 복원 (클라이언트에서만)
  useEffect(() => {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) {
      const n = parseInt(saved, 10);
      if (!Number.isNaN(n)) setWidth(clampWidth(n));
    }
  }, []);

  const startResize = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = widthRef.current;
    setIsResizing(true);

    const handleMove = (ev: MouseEvent) => {
      // 시작 지점 대비 이동량을 더해 새 너비 계산
      setWidth(clampWidth(startWidth + (ev.clientX - startX)));
    };

    const handleUp = () => {
      setIsResizing(false);
      window.removeEventListener('mousemove', handleMove);
      window.removeEventListener('mouseup', handleUp);
      // 드래그가 끝난 최종 너비만 저장
      localStorage.setItem(STORAGE_KEY, String(widthRef.current));
      // 드래그 중 적용했던 전역 커서/선택 방지 해제
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };

    window.addEventListener('mousemove', handleMove);
    window.addEventListener('mouseup', handleUp);
    // 드래그 동안 전체 화면에 리사이즈 커서 유지 + 텍스트 선택 방지
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  }, []);

  return { width, isResizing, startResize };
}
