import WorkspaceView from '@/components/dashboard/WorkspaceView';

/**
 * QA 작업 — 구 `TC 자동화` + `기능 분석`을 합친 화면 (2026-08-09).
 * 티켓·기획 분석부터 TC 작성·수행까지 한 흐름으로 처리한다.
 */
export default function WorkWorkspacePage() {
  return <WorkspaceView workspaceKey="work" />;
}
