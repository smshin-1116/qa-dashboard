import { NextResponse } from 'next/server';

/**
 * env에 설정된 QA 검증 역할 계정 **목록만** 노출한다 (재수행 모달의 계정 칩용).
 *
 * ⚠️ 이메일·비밀번호는 절대 반환하지 않는다 — **역할 이름과 라벨만.** 재수행 조건에서
 * "QA_ADMIN으로 재로그인" 같은 문구를 오타 없이 만들도록 돕는 게 전부다. 실제 로그인은
 * 수행 에이전트가 env(QA_*_EMAIL·PASSWORD)를 직접 읽어 처리한다.
 */
const ROLES: Array<{ role: string; label: string; env: string }> = [
  { role: 'SALES', label: 'SALES(영업매니저)', env: 'QA_SALES_EMAIL' },
  { role: 'ADMIN', label: 'ADMIN(관리자)', env: 'QA_ADMIN_EMAIL' },
  { role: 'DISPATCH', label: 'DISPATCH(배차담당)', env: 'QA_DISPATCH_EMAIL' },
];

export function GET() {
  const roles = ROLES.filter((r) => (process.env[r.env] ?? '').trim().length > 0).map((r) => ({
    role: r.role,
    label: r.label,
  }));
  return NextResponse.json({ roles });
}
