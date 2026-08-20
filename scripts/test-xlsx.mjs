// 서식 엑셀 빌더 실측 — 샘플로 워크북을 만들어 파일로 쓴다(유효성·서식 확인용).
// 실행: node scripts/test-xlsx.mjs <out.xlsx>
import { buildTcWorkbook } from '../lib/tcXlsx.ts';

const out = process.argv[2] ?? '/tmp/test-tc.xlsx';

const columns = [
  'TC-ID', '대분류', '중분류', '소분류', '검증단계', '전제조건',
  '테스트 스텝', '기대결과', '플랫폼', '결과', '수행 사유', '버그 티켓', '계정 역할', '비고',
];
const mk = (id, phase, result, note, bug, role) => ({
  'TC-ID': id, 대분류: '결제 관리', 중분류: '결제 제한 계정', 소분류: '접근 제어',
  검증단계: phase, 전제조건: 'paused 계정 보유, 로그인 상태',
  '테스트 스텝': '1. paused 계정 로그인 2. /mypage 진입 후 60초간 스크롤·버튼 클릭 등 조작 반복 3. 콘솔 에러 확인',
  기대결과: '화면이 프리징 없이 모든 조작에 즉시 반응하고, 탭 CPU 점유가 정상 수준이며 콘솔 에러가 0건이다',
  플랫폼: 'PC(Web)', 결과: result, '수행 사유': note, '버그 티켓': bug, '계정 역할': role, 비고: '',
});

const rows = [
  mk('TC-001', '정상', 'Pass', '스텝대로 재현, 프리징 없음 · 콘솔 에러 0건', '', 'ADMIN'),
  mk('TC-002', '예외', 'Fail', '모달에 결제 해결 CTA 버튼이 없어 동선 진입 불가', 'DV-741', 'ADMIN'),
  mk('TC-003', '부정', 'Blocked', 'TC-002 버튼 부재로 전제 자체가 성립 안 함', '', 'SALES'),
  mk('TC-004', '정상', 'Not Test', '', '', 'DISPATCH'),
];

const wb = await buildTcWorkbook({
  title: 'DV-540 결제 제한 계정 접근 제어 — QA 검증',
  columns,
  rows,
  wrapColumns: ['전제조건', '테스트 스텝', '기대결과', '수행 사유'],
});
await wb.xlsx.writeFile(out);
console.log('saved', out);
