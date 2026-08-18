import * as XLSX from 'xlsx';
import type { Session } from '@/types/session';
import { normalizeTcId } from '@/lib/tcId';

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
 * 마크다운 표의 한 행을 셀 배열로 나눈다.
 *
 * ⚠️ `split('|').filter(Boolean)`을 쓰면 안 된다 — 행 앞뒤 파이프의 빈 조각을
 * 지우려던 것이 **내용이 빈 셀**까지 지워서 컬럼이 한 칸씩 밀린다.
 * LLM은 반복되는 대분류·중분류를 빈 셀로 두는 습관이 있어(`| TC-002 | | | 모니터링…`)
 * 실측에서 19건 중 14건이 밀렸다 (2026-08-11 DV-740). 앞뒤 파이프만 잘라내고
 * 내부 빈 셀은 자리 그대로 보존한다.
 */
function splitRow(line: string): string[] {
  let l = line.trim();
  if (l.startsWith('|')) l = l.slice(1);
  if (l.endsWith('|')) l = l.slice(0, -1);
  return l.split('|').map((c) => c.trim());
}

/**
 * 어시스턴트 메시지에서 TC 테이블 데이터를 추출합니다.
 * 마크다운 테이블 및 JSON 배열 형식을 지원합니다.
 */
export function extractTcRows(content: string): TcRow[] {
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

    const headers = splitRow(lines[0]);

    // TC 테이블 여부 확인 (TC-ID 또는 ID 컬럼 포함 필요)
    const hasTcIdCol = headers.some(
      (h) => h === 'TC-ID' || h === 'ID' || h === 'TC ID'
    );
    if (!hasTcIdCol) continue;

    lines.slice(1).forEach((row, i) => {
      const cells = splitRow(row);

      const raw: Record<string, string> = {};
      headers.forEach((h, idx) => {
        raw[h] = cells[idx] ?? '';
      });

      allRows.push(buildRow(raw, allRows.length + i));
    });
  }

  return allRows;
}

/**
 * 표를 **정규화하지 않고** 헤더 그대로 뽑는다.
 *
 * `extractTcRows`는 xlsx 내보내기용이라 11컬럼으로 접어버려 그 밖의 컬럼이 사라진다.
 * 워크스페이스 저장(`/api/workspace/tc`)은 컬럼 고정을 풀기로 했으므로
 * (2026-08-06 결정 — 티켓마다 필요한 컬럼이 달라 11개로 못 박으면 곧 깨진다)
 * 저장 경로는 이 함수를 써서 `계정 역할` 같은 임의 컬럼을 `extra`로 넘긴다.
 */
export function extractTcRawRows(content: string): Array<Record<string, string>> {
  const out: Array<Record<string, string>> = [];
  const tableRegex = /(\|.+\|\n\|[-| :]+\|\n(?:\|.+\|\n?)+)/g;
  let tableMatch: RegExpExecArray | null;

  while ((tableMatch = tableRegex.exec(content)) !== null) {
    const lines = tableMatch[1]
      .split('\n')
      .filter((line) => line.startsWith('|') && !line.match(/^[\s|:-]+$/));
    if (lines.length < 2) continue;

    const headers = splitRow(lines[0]);
    // TC 표가 아닌 일반 표(요약·비교표 등)는 건너뛴다
    if (!headers.some((h) => h === 'TC-ID' || h === 'ID' || h === 'TC ID')) continue;

    /**
     * ditto 채우기 — 분류 3컬럼은 빈 셀이 "위와 같음"을 뜻한다 (LLM 표 관행).
     * 빈 채로 저장하면 카탈로그 후보 좁히기(카테고리 매칭)와 화면 표시가 죽는다.
     * 나머지 컬럼(비고 등)의 빈 셀은 진짜 빈 값이므로 건드리지 않는다.
     */
    const DITTO = new Set(['대분류', '중분류', '소분류']);
    const prev: Record<string, string> = {};

    for (const row of lines.slice(1)) {
      const cells = splitRow(row);
      const raw: Record<string, string> = {};
      headers.forEach((h, idx) => {
        // 헤더 이름을 정규화해 저장 API가 아는 키로 맞추되, 모르는 헤더는 원문 그대로 둔다
        const key = normalizeHeader(h) ?? h;
        let val = cells[idx] ?? '';
        if (!val && DITTO.has(key) && prev[key]) val = prev[key];
        raw[key] = val;
        if (val && DITTO.has(key)) prev[key] = val;
      });
      out.push(raw);
    }
  }
  return out;
}

/** 세션 전체(어시스턴트 메시지)에서 원본 TC 행을 모은다 */
export function collectTcRawRows(session: Session | null): Array<Record<string, string>> {
  if (!session) return [];
  const rows: Array<Record<string, string>> = [];
  for (const msg of session.messages) {
    if (msg.role !== 'assistant') continue;
    rows.push(...extractTcRawRows(msg.content));
  }
  return rows;
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

  return {
    // XLSX도 저장(local_id)과 같은 규칙으로 TC-001 형식 통일 (구 로직은 'MV-001'을
    // 'TC-MV-001'로 만드는 버그가 있었다 — 공용 normalizeTcId로 일원화)
    'TC-ID': normalizeTcId(get('TC-ID'), index),
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
