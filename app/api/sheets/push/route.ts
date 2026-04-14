import { NextRequest } from 'next/server';
import { google } from 'googleapis';

const TC_HEADERS = ['TC-ID', '대분류', '중분류', '소분류', '검증단계', '전제조건', '테스트 스텝', '기대결과', '플랫폼', '결과', '비고'];
const COL_WIDTHS = [80, 100, 100, 100, 80, 200, 250, 200, 80, 80, 150];

function extractSpreadsheetId(urlOrId: string): string | null {
  const trimmed = urlOrId.trim();
  if (!trimmed.includes('/')) return trimmed || null;
  const match = trimmed.match(/spreadsheets\/d\/([a-zA-Z0-9_-]+)/);
  return match ? match[1] : null;
}

export async function POST(req: NextRequest) {
  const { sheetsUrl, rows } = (await req.json()) as {
    sheetsUrl: string;
    rows: Record<string, string>[];
  };

  const spreadsheetId = extractSpreadsheetId(sheetsUrl);
  if (!spreadsheetId) {
    return Response.json({ error: '유효하지 않은 Sheets URL입니다.' }, { status: 400 });
  }
  if (!rows?.length) {
    return Response.json({ error: 'TC 데이터가 없습니다.' }, { status: 400 });
  }

  const email = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  const key = process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, '\n');

  if (!email || !key) {
    return Response.json({ error: 'Google 인증 정보가 설정되지 않았습니다.' }, { status: 500 });
  }

  try {
    const auth = new google.auth.GoogleAuth({
      credentials: { client_email: email, private_key: key },
      scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });
    const sheets = google.sheets({ version: 'v4', auth });

    // 시트 이름: TC_YYYYMMDD_HHmm
    const now = new Date();
    const sheetName = `TC_${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}_${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}`;

    // 새 시트 추가
    const addRes = await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: {
        requests: [{ addSheet: { properties: { title: sheetName, gridProperties: { rowCount: rows.length + 5, columnCount: 11 } } } }],
      },
    });
    const sheetId = addRes.data.replies?.[0].addSheet?.properties?.sheetId ?? 0;

    // 데이터 작성
    const values = [TC_HEADERS, ...rows.map((r) => TC_HEADERS.map((h) => r[h] ?? ''))];
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: `${sheetName}!A1`,
      valueInputOption: 'RAW',
      requestBody: { values },
    });

    // 서식 적용
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: {
        requests: [
          // 헤더: 인디고 배경 + 볼드 + 흰 글씨
          {
            repeatCell: {
              range: { sheetId, startRowIndex: 0, endRowIndex: 1 },
              cell: {
                userEnteredFormat: {
                  backgroundColor: { red: 0.31, green: 0.29, blue: 0.9 },
                  textFormat: { bold: true, foregroundColor: { red: 1, green: 1, blue: 1 }, fontSize: 10 },
                  horizontalAlignment: 'CENTER',
                  verticalAlignment: 'MIDDLE',
                },
              },
              fields: 'userEnteredFormat',
            },
          },
          // 첫 행 고정
          {
            updateSheetProperties: {
              properties: { sheetId, gridProperties: { frozenRowCount: 1 } },
              fields: 'gridProperties.frozenRowCount',
            },
          },
          // 데이터 행: 위쪽 정렬 + 줄바꿈
          {
            repeatCell: {
              range: { sheetId, startRowIndex: 1, endRowIndex: rows.length + 1 },
              cell: {
                userEnteredFormat: {
                  verticalAlignment: 'TOP',
                  wrapStrategy: 'WRAP',
                  textFormat: { fontSize: 10 },
                },
              },
              fields: 'userEnteredFormat',
            },
          },
          // 열 너비
          ...COL_WIDTHS.map((width, i) => ({
            updateDimensionProperties: {
              range: { sheetId, dimension: 'COLUMNS' as const, startIndex: i, endIndex: i + 1 },
              properties: { pixelSize: width },
              fields: 'pixelSize',
            },
          })),
        ],
      },
    });

    return Response.json({ success: true, sheetName, rowCount: rows.length, spreadsheetId });
  } catch (err) {
    const msg = err instanceof Error ? err.message : '알 수 없는 오류';
    if (msg.includes('403') || msg.includes('PERMISSION_DENIED') || msg.includes('forbidden')) {
      return Response.json(
        { error: `스프레드시트에 서비스 계정(${email})을 편집자로 공유해주세요.` },
        { status: 403 }
      );
    }
    return Response.json({ error: msg }, { status: 500 });
  }
}
