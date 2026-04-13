import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'QA Studio · DEV',
  description: 'QA 업무 자동화 대시보드 (고도화 버전)',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ko">
      <body>{children}</body>
    </html>
  );
}
