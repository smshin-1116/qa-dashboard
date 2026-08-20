/**
 * 서식 있는 TC 엑셀 산출물 빌더 (2026-08-20)
 * ────────────────────────────────────────────────────────────────────────
 * 기존 다운로드는 SheetJS(xlsx) 무료판이라 **셀 서식을 못 넣어** 텍스트처럼 밋밋했다.
 * 산출물로 제출하려면 헤더 강조·테두리·줄바꿈·결과 색상 등 서식이 필요하다.
 * exceljs(이미 의존성)는 서식을 완전 지원하므로 이걸로 워크북을 만든다.
 *
 * 브라우저에서 동작(클라이언트) — exceljs는 무겁기에 호출 시점에 dynamic import 한다.
 */

export interface TcXlsxInput {
  /** 워크북 제목 (파일 상단 배너 + 시트명 근거) */
  title: string;
  /** 열 순서 (헤더 이름) */
  columns: string[];
  /** 각 행: 열이름 → 값 */
  rows: Array<Record<string, string>>;
  /** 결과 색상 칠할 열 이름 (기본 '결과') */
  resultColumn?: string;
  /** 줄바꿈(wrap) 적용할 열 이름들 (스텝·기대결과 등 긴 텍스트) */
  wrapColumns?: string[];
}

/** 수행 결과별 색 (폰트 / 옅은 배경). ARGB. */
const RESULT_STYLE: Record<string, { font: string; fill: string }> = {
  Pass: { font: 'FF059669', fill: 'FFE9F7F1' },
  Fail: { font: 'FFDC2626', fill: 'FFFCEBEA' },
  Blocked: { font: 'FFB45309', fill: 'FFFBF1E3' },
  'Not Test': { font: 'FF6C7891', fill: 'FFF1F2F6' },
};

/** 열 이름별 너비(대략) — 없으면 기본값 */
const COL_WIDTH: Record<string, number> = {
  'TC-ID': 12,
  대분류: 16,
  중분류: 18,
  소분류: 18,
  검증단계: 10,
  전제조건: 28,
  '테스트 스텝': 46,
  기대결과: 40,
  플랫폼: 12,
  결과: 12,
  '수행 사유': 40,
  '버그 티켓': 14,
  비고: 24,
};

const HEADER_FILL = 'FF4F46E5'; // 인디고
const ZEBRA_FILL = 'FFF5F6FB';
const BORDER = 'FFD9DEEA';
const TITLE_FG = 'FF3730A3';

/**
 * 서식 있는 TC 워크북을 만든다 (DOM 비의존 — 브라우저·Node 공용, 테스트 가능).
 * 반환: exceljs Workbook. 다운로드는 downloadStyledTcXlsx가 감싼다.
 */
export async function buildTcWorkbook(input: TcXlsxInput) {
  const ExcelJS = (await import('exceljs')).default;
  const resultCol = input.resultColumn ?? '결과';
  const wrapSet = new Set(input.wrapColumns ?? []);

  const wb = new ExcelJS.Workbook();
  wb.creator = 'QA Workspace';
  wb.created = new Date();
  const ws = wb.addWorksheet('TC', {
    views: [{ state: 'frozen', xSplit: 1, ySplit: 3 }], // TC-ID 열 + 헤더까지 고정
  });

  const thin = { style: 'thin' as const, color: { argb: BORDER } };
  const allBorder = { top: thin, left: thin, bottom: thin, right: thin };

  // ── 1행: 제목 배너 ──────────────────────────────────────────────
  const lastColLetter = colLetter(input.columns.length);
  ws.mergeCells(`A1:${lastColLetter}1`);
  const titleCell = ws.getCell('A1');
  titleCell.value = input.title;
  titleCell.font = { bold: true, size: 14, color: { argb: TITLE_FG } };
  titleCell.alignment = { vertical: 'middle' };
  ws.getRow(1).height = 26;

  // ── 2행: 요약 (생성일 + 결과 집계) ──────────────────────────────
  ws.mergeCells(`A2:${lastColLetter}2`);
  const summary = summarize(input.rows, resultCol, input.rows.length);
  const sumCell = ws.getCell('A2');
  sumCell.value = summary;
  sumCell.font = { size: 10, color: { argb: 'FF6C7891' } };
  sumCell.alignment = { vertical: 'middle' };
  ws.getRow(2).height = 18;

  // ── 3행: 헤더 ───────────────────────────────────────────────────
  const headerRowIdx = 3;
  const headerRow = ws.getRow(headerRowIdx);
  input.columns.forEach((col, i) => {
    const cell = headerRow.getCell(i + 1);
    cell.value = col;
    cell.font = { bold: true, size: 10.5, color: { argb: 'FFFFFFFF' } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: HEADER_FILL } };
    cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
    cell.border = allBorder;
  });
  headerRow.height = 22;

  // ── 데이터 행 ───────────────────────────────────────────────────
  input.rows.forEach((row, r) => {
    const excelRow = ws.getRow(headerRowIdx + 1 + r);
    const zebra = r % 2 === 1;
    input.columns.forEach((col, i) => {
      const cell = excelRow.getCell(i + 1);
      cell.value = row[col] ?? '';
      cell.border = allBorder;
      cell.font = { size: 10, color: { argb: 'FF1B2130' } };
      const wrap = wrapSet.has(col);
      cell.alignment = {
        vertical: 'top',
        horizontal: col === 'TC-ID' || col === resultCol || col === '검증단계' || col === '플랫폼' ? 'center' : 'left',
        wrapText: wrap,
      };

      if (col === resultCol) {
        // 수행 결과 색상 — 값에 맞춰 폰트/배경
        const s = RESULT_STYLE[(row[col] ?? '').trim()];
        if (s) {
          cell.font = { size: 10, bold: true, color: { argb: s.font } };
          cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: s.fill } };
        }
      } else if (zebra) {
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: ZEBRA_FILL } };
      }
    });
  });

  // ── 열 너비 + 자동 필터 ─────────────────────────────────────────
  input.columns.forEach((col, i) => {
    ws.getColumn(i + 1).width = COL_WIDTH[col] ?? 16;
  });
  ws.autoFilter = {
    from: { row: headerRowIdx, column: 1 },
    to: { row: headerRowIdx, column: input.columns.length },
  };

  return wb;
}

/**
 * 서식 있는 TC 워크북을 만들어 브라우저 다운로드를 트리거한다.
 * 반환 없음(부수효과: 파일 다운로드). 실패 시 throw.
 */
export async function downloadStyledTcXlsx(input: TcXlsxInput, filename: string): Promise<void> {
  const wb = await buildTcWorkbook(input);
  const buf = await wb.xlsx.writeBuffer();
  const blob = new Blob([buf], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename.endsWith('.xlsx') ? filename : `${filename}.xlsx`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/** 결과 집계 문구 — "총 N건 · Pass 3 / Fail 1 / Blocked 1 / Not Test 5 · 생성 2026-08-20" */
function summarize(rows: Array<Record<string, string>>, resultCol: string, total: number): string {
  const c: Record<string, number> = {};
  for (const r of rows) {
    const v = (r[resultCol] ?? '').trim() || 'Not Test';
    c[v] = (c[v] ?? 0) + 1;
  }
  const order = ['Pass', 'Fail', 'Blocked', 'Not Test'];
  const parts = order.filter((k) => c[k]).map((k) => `${k} ${c[k]}`);
  const extra = Object.keys(c).filter((k) => !order.includes(k)).map((k) => `${k} ${c[k]}`);
  const counts = [...parts, ...extra].join(' / ');
  const today = new Date().toISOString().slice(0, 10);
  return `총 ${total}건${counts ? ` · ${counts}` : ''} · 생성 ${today}`;
}

/** 1→A, 2→B … 26→Z, 27→AA (열 문자) */
function colLetter(n: number): string {
  let s = '';
  while (n > 0) {
    const m = (n - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}
