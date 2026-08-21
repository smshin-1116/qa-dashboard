import RiskView from '@/components/dashboard/risk/RiskView';

/**
 * 리스크 (◈ 리스크 패턴).
 * 채팅/세션 없는 'board' 레이아웃이라 WorkspaceView 대신 전용 뷰를 렌더한다.
 * risk_pattern 저장소를 읽고, 버그 이력에서 패턴을 추출·큐레이션한다.
 */
export default function RiskPage() {
  return <RiskView />;
}
