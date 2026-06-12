'use client';

import type { Session } from '@/types/session';
import QualityReport from './QualityReport';

/**
 * TC 자동화 화면 우측에 고정으로 붙는 품질 리포트 패널 (시안의 "품질 리포트" 영역).
 * 탭 없이 QualityReport를 항상 노출한다.
 */
export default function QualityPanel({ session }: { session: Session | null }) {
  return (
    <aside className="w-[276px] bg-[#161B27] border-l border-[#1E2535] flex flex-col flex-shrink-0">
      <div className="px-3.5 h-[42px] border-b border-[#1E2535] flex items-center">
        <span className="text-[12px] font-semibold text-slate-300">품질 리포트</span>
      </div>
      <div className="flex-1 overflow-y-auto p-3.5">
        <QualityReport session={session} />
      </div>
    </aside>
  );
}
