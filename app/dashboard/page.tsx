import { redirect } from 'next/navigation';
import { DEFAULT_WORKSPACE } from '@/constants/workspaces';

export default function DashboardPage() {
  // /dashboard 진입 시 기본 워크스페이스로 이동
  redirect(DEFAULT_WORKSPACE.path);
}
