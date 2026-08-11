import TodayView from '@/components/dashboard/today/TodayView';

/**
 * 오늘 — 아침 브리핑.
 * 채팅/세션이 없는 'board' 레이아웃이라 WorkspaceView 대신 전용 뷰를 렌더한다
 * (인수증 툴과 같은 방식).
 */
export default function TodayPage() {
  return <TodayView />;
}
