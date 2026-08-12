import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'QA Studio · DEV',
  description: 'QA 업무 자동화 대시보드 (고도화 버전)',
};

/**
 * 첫 페인트 전에 data-theme를 stamp해 FOUC(테마 깜빡임)를 막는다.
 * 저장값 > 기본 라이트. React가 붙기 전에 실행되어야 하므로 인라인 스크립트다.
 */
const THEME_INIT = `(function(){try{var t=localStorage.getItem('qa-theme')||'light';document.documentElement.setAttribute('data-theme',t);}catch(e){document.documentElement.setAttribute('data-theme','light');}})();`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ko" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
