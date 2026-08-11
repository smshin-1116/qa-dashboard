import AutomationView from '@/components/dashboard/automation/AutomationView';

/**
 * 테스트 자동화 (㉯ 영구 자산).
 * 채팅/세션 없는 'board' 레이아웃이라 WorkspaceView 대신 전용 뷰를 렌더한다
 * (오늘·알림 탭과 같은 방식). 상태저장소의 test_run·finding·catalog를 읽는다.
 */
export default function AutoPage() {
  return <AutomationView />;
}
