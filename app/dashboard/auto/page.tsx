import { Suspense } from 'react';
import AutomationView from '@/components/dashboard/automation/AutomationView';

/**
 * 테스트 자동화 (㉯ 영구 자산).
 * 채팅/세션 없는 'board' 레이아웃이라 WorkspaceView 대신 전용 뷰를 렌더한다
 * (오늘·알림 탭과 같은 방식). 상태저장소의 test_run·finding·catalog를 읽는다.
 *
 * Suspense 경계 — AutomationView가 useSearchParams(?focus=fail Slack 딥링크)를 쓰므로
 * 정적 생성 시 경고를 피하려 감싼다.
 */
export default function AutoPage() {
  return (
    <Suspense fallback={null}>
      <AutomationView />
    </Suspense>
  );
}
