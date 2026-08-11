import NoticeView from '@/components/dashboard/notice/NoticeView';

/**
 * 🔔 알림 — 워크스페이스 탭이 아니라 헤더 우측 진입점.
 *
 * 탭으로 넣지 않은 이유: "오늘 할 일"은 매일 여는 작업 공간이고
 * "알림"은 가끔 확인하는 정체 상태라 성격이 다르다. 탭 수도 늘지 않는다.
 */
export default function NoticePage() {
  return <NoticeView />;
}
