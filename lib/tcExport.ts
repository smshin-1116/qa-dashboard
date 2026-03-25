import * as XLSX from 'xlsx';
import type { Session } from '@/types/session';

export interface TcRow {
  ID: string;
  카테고리: string;
  '테스트 케이스 제목': string;
  '전제 조건': string;
  '테스트 스텝': string;
  '기대 결과': string;
  우선순위: string;
  상태: string;
}

/**
 * 어시스턴트 메시지에서 TC 테이블 데이터를 추출합니다.
 * 마크다운 테이블 또는 JSON 배열 형식을 지원합니다.
 */
function extractTcRows(content: string): TcRow[] {
  // JSON 배열 형식 탐지
  const jsonMatch = content.match(/```json\s*([\s\S]*?)```/);
  if (jsonMatch) {
    try {
      const parsed: unknown = JSON.parse(jsonMatch[1]);
      if (Array.isArray(parsed)) {
        return parsed as TcRow[];
      }
    } catch {
      // JSON 파싱 실패 시 계속 진행
    }
  }

  // 마크다운 테이블 형식 탐지
  const tableMatch = content.match(/\|.+\|\n\|[-|]+\|\n((?:\|.+\|\n?)+)/);
  if (tableMatch) {
    const rows = tableMatch[0]
      .split('\n')
      .filter((line) => line.startsWith('|') && !line.match(/^[\s|:-]+$/));

    if (rows.length < 2) return [];

    const headers = rows[0]
      .split('|')
      .map((h) => h.trim())
      .filter(Boolean);

    return rows.slice(1).map((row, i) => {
      const cells = row
        .split('|')
        .map((c) => c.trim())
        .filter(Boolean);

      const obj: Record<string, string> = {};
      headers.forEach((h, idx) => {
        obj[h] = cells[idx] ?? '';
      });

      return {
        ID: obj['ID'] ?? `TC-${String(i + 1).padStart(3, '0')}`,
        카테고리: obj['카테고리'] ?? obj['Category'] ?? '',
        '테스트 케이스 제목': obj['테스트 케이스 제목'] ?? obj['Title'] ?? obj['제목'] ?? '',
        '전제 조건': obj['전제 조건'] ?? obj['Precondition'] ?? '',
        '테스트 스텝': obj['테스트 스텝'] ?? obj['Steps'] ?? '',
        '기대 결과': obj['기대 결과'] ?? obj['Expected'] ?? '',
        우선순위: obj['우선순위'] ?? obj['Priority'] ?? 'Medium',
        상태: obj['상태'] ?? 'Not Run',
      } satisfies TcRow;
    });
  }

  return [];
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

  const ws = XLSX.utils.json_to_sheet(allRows);

  // 컬럼 너비 설정
  ws['!cols'] = [
    { wch: 12 },  // ID
    { wch: 16 },  // 카테고리
    { wch: 40 },  // 제목
    { wch: 30 },  // 전제조건
    { wch: 50 },  // 스텝
    { wch: 40 },  // 기대결과
    { wch: 10 },  // 우선순위
    { wch: 12 },  // 상태
  ];

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'TestCases');

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
