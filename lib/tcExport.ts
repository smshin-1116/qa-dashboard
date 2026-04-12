import * as XLSX from 'xlsx';
import type { Session } from '@/types/session';

export interface TcRow {
  'TC-ID': string;
  대분류: string;
  중분류: string;
  소분류: string;
  검증단계: string;
  전제조건: string;
  '테스트 스텝': string;
  기대결과: string;
  플랫폼: string;
  결과: string;
  비고: string;
}

const COLUMNS: (keyof TcRow)[] = [
  'TC-ID',
  '대분류',
  '중분류',
  '소분류',
  '검증단계',
  '전제조건',
  '테스트 스텝',
  '기대결과',
  '플랫폼',
  '결과',
  '비고',
];

const COL_WIDTHS: number[] = [12, 16, 20, 20, 12, 30, 50, 40, 14, 12, 30];

/**
 * 마크다운 테이블 헤더 셀을 TcRow 키로 정규화합니다.
 * 신규 11컬럼 형식과 기존 7컬럼 형식 모두 지원합니다.
 */
function normalizeHeader(raw: string): keyof TcRow | null {
  const h = raw.trim();
  const map: Record<string, keyof TcRow> = {
    // 신규 컬럼
    'TC-ID': 'TC-ID',
    'TC ID': 'TC-ID',
    TCID: 'TC-ID',
    대분류: '대분류',
    중분류: '중분류',
    소분류: '소분류',
    검증단계: '검증단계',
    전제조건: '전제조건',
    '테스트 스텝': '테스트 스텝',
    기대결과: '기대결과',
    플랫폼: '플랫폼',
    결과: '결과',
    비고: '비고',
    // 구버전 컬럼 → 신규 컬럼 매핑 (하위 호환)
    ID: 'TC-ID',
    '1depth': '대분류',
    '2depth': '중분류',
    카테고리: '대분류',
    '테스트 케이스 제목': '기대결과',
    제목: '기대결과',
    '전제 조건': '전제조건',
    Precondition: '전제조건',
    Steps: '테스트 스텝',
    '기대 결과': '기대결과',
    Expected: '기대결과',
    Comment: '비고',
    우선순위: '비고',
    상태: '결과',
  };
  return map[h] ?? null;
}

/**
 * 어시스턴트 메시지에서 TC 테이블 데이터를 추출합니다.
 * 마크다운 테이블 및 JSON 배열 형식을 지원합니다.
 */
function extractTcRows(content: string): TcRow[] {
  // JSON 배열 형식 탐지
  const jsonMatch = content.match(/```json\s*([\s\S]*?)```/);
  if (jsonMatch) {
    try {
      const parsed: unknown = JSON.parse(jsonMatch[1]);
      if (Array.isArray(parsed)) {
        return (parsed as Record<string, string>[]).map((item, i) =>
          buildRow(item, i)
        );
      }
    } catch {
      // JSON 파싱 실패 시 마크다운 파싱으로 계속 진행
    }
  }

  // 마크다운 테이블 형식 탐지 (여러 테이블 지원)
  const allRows: TcRow[] = [];
  const tableRegex = /(\|.+\|\n\|[-| :]+\|\n(?:\|.+\|\n?)+)/g;
  let tableMatch: RegExpExecArray | null;

  while ((tableMatch = tableRegex.exec(content)) !== null) {
    const lines = tableMatch[1]
      .split('\n')
      .filter((line) => line.startsWith('|') && !line.match(/^[\s|:-]+$/));

    if (lines.length < 2) continue;

    const headers = lines[0]
      .split('|')
      .map((h) => h.trim())
      .filter(Boolean);

    // TC 테이블 여부 확인 (TC-ID 또는 ID 컬럼 포함 필요)
    const hasTcIdCol = headers.some(
      (h) => h === 'TC-ID' || h === 'ID' || h === 'TC ID'
    );
    if (!hasTcIdCol) continue;

    lines.slice(1).forEach((row, i) => {
      const cells = row
        .split('|')
        .map((c) => c.trim())
        .filter(Boolean);

      const raw: Record<string, string> = {};
      headers.forEach((h, idx) => {
        raw[h] = cells[idx] ?? '';
      });

      allRows.push(buildRow(raw, allRows.length + i));
    });
  }

  return allRows;
}

function buildRow(raw: Record<string, string>, index: number): TcRow {
  const get = (key: keyof TcRow): string => {
    // 정확한 키 직접 참조
    if (raw[key] !== undefined) return raw[key];
    // 헤더 정규화를 통한 역방향 탐색
    for (const [rawKey, val] of Object.entries(raw)) {
      if (normalizeHeader(rawKey) === key) return val;
    }
    return '';
  };

  const tcId =
    get('TC-ID') ||
    `TC-${String(index + 1).padStart(3, '0')}`;

  return {
    'TC-ID': tcId.startsWith('TC-') ? tcId : `TC-${tcId.padStart(3, '0')}`,
    대분류: get('대분류'),
    중분류: get('중분류'),
    소분류: get('소분류'),
    검증단계: get('검증단계'),
    전제조건: get('전제조건'),
    '테스트 스텝': get('테스트 스텝'),
    기대결과: get('기대결과'),
    플랫폼: get('플랫폼') || 'PC(Web)',
    결과: get('결과') || 'Not Test',
    비고: get('비고'),
  };
}

/**
 * 세션의 TC 결과를 xlsx 파일로 다운로드합니다.
 */
export function downloadTcXlsx(session: Session): boolean {
  const allRows: TcRow[] = [];

  for (const msg of session.messages) {
    if (msg.role !== 'assistant') continue;
    const rows = extractTcRows(msg.content);
    allRows.push(...rows);
  }

  if (allRows.length === 0) return false;

  // 컬럼 순서 보장을 위해 배열 형식으로 변환
  const sheetData: string[][] = [
    COLUMNS as string[], // 헤더
    ...allRows.map((row) => COLUMNS.map((col) => row[col] ?? '')),
  ];

  const ws = XLSX.utils.aoa_to_sheet(sheetData);

  // 컬럼 너비
  ws['!cols'] = COL_WIDTHS.map((wch) => ({ wch }));

  // 헤더 행 고정 (스크롤 시 유지)
  ws['!freeze'] = { xSplit: 0, ySplit: 1 };

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'TC');

  const fileName = `TC_${session.title.replace(/[^\w가-힣]/g, '_')}_${Date.now()}.xlsx`;
  XLSX.writeFile(wb, fileName);

  return true;
}

/**
 * 세션에 TC 결과가 있는지 확인합니다.
 */
export function hasTcResult(session: Session | null): boolean {
  if (!session) return false;
  return session.messages.some(
    (msg) => msg.role === 'assistant' && extractTcRows(msg.content).length > 0
  );
}
