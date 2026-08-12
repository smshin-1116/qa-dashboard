'use client';

import { useEffect, useState } from 'react';

/**
 * 라이트/다크 테마 — `<html data-theme>`에 stamp하고 localStorage에 기억한다.
 *
 * globals.css의 토큰이 `:root[data-theme="light|dark"]`로 갈리므로, 여기서 하는 일은
 * data-theme 속성 하나를 바꾸는 것뿐이다. 색은 CSS 토큰이 알아서 따라온다.
 *
 * 기본값은 **라이트** — 사용자 요청(2026-08-11). 저장된 값이 있으면 그것을 쓴다.
 * SSR 깜빡임(FOUC)은 layout의 인라인 스크립트가 첫 페인트 전에 stamp해서 막는다.
 */
export type Theme = 'light' | 'dark';

const KEY = 'qa-theme';

export function useTheme(): { theme: Theme; toggle: () => void; setTheme: (t: Theme) => void } {
  const [theme, setThemeState] = useState<Theme>('light');

  // 마운트 시 저장값·현재 DOM 상태를 읽어 동기화 (인라인 스크립트가 이미 stamp했을 수 있음)
  useEffect(() => {
    const saved = (localStorage.getItem(KEY) as Theme | null) ?? null;
    const current = (document.documentElement.getAttribute('data-theme') as Theme | null) ?? null;
    setThemeState(saved ?? current ?? 'light');
  }, []);

  const setTheme = (t: Theme) => {
    document.documentElement.setAttribute('data-theme', t);
    localStorage.setItem(KEY, t);
    setThemeState(t);
  };

  const toggle = () => setTheme(theme === 'light' ? 'dark' : 'light');

  return { theme, toggle, setTheme };
}
