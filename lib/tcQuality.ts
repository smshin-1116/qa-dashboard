import type { TcRow } from './tcExport';

export type CheckStatus = 'pass' | 'warn' | 'fail';
export type IssueSeverity = 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW';

export interface QualityCheck {
  id: string;
  label: string;
  status: CheckStatus;
  detail: string;
  weight: number;
}

export interface QualityIssue {
  severity: IssueSeverity;
  label: string;
  detail: string;
  tcIds?: string[];
}

export interface PhaseDistribution {
  정상: number;
  부정: number;
  예외: number;
  기타: number;
  total: number;
  negativeRatio: number; // 부정+예외 비율 (%)
}

export interface TcQualityResult {
  score: number;           // 0-100
  grade: 'A' | 'B' | 'C' | 'D' | 'F';
  tcCount: number;
  checks: QualityCheck[];
  issues: QualityIssue[];
  phaseDistribution: PhaseDistribution;
}

// 추상 표현 키워드
const ABSTRACT_KEYWORDS = [
  '정상적으로', '올바르게', '정상 동작', '정상동작', '제대로',
  '올바른', '정상인지', '적절하게', '적절히', '잘 동작',
  '잘동작', '정상적인', '올바른 방식', '문제없이',
];

// 1TC=1검증포인트 위반 패턴
const COMPOUND_PATTERNS = [
  /[가-힣A-Za-z]+하고\s+[가-힣A-Za-z]+되는지/,
  /[가-힣A-Za-z]+이고\s+[가-힣A-Za-z]+인지/,
  /A인지\s+B인지/,
  /[가-힣]+인지\s+[가-힣]+인지/,
  /[가-힣]+되고\s+[가-힣]+되는지/,
];

// 허용 플랫폼 값
const VALID_PLATFORMS = ['PC(Web)', 'Mobile(App)', '공통'];

function calcGrade(score: number): TcQualityResult['grade'] {
  if (score >= 85) return 'A';
  if (score >= 70) return 'B';
  if (score >= 55) return 'C';
  if (score >= 40) return 'D';
  return 'F';
}

export function analyzeTcQuality(rows: TcRow[]): TcQualityResult | null {
  if (rows.length === 0) return null;

  const checks: QualityCheck[] = [];
  const issues: QualityIssue[] = [];

  // ─── 검증단계 분포 (weight 30) ───────────────────────────────────
  const phaseCount = { 정상: 0, 부정: 0, 예외: 0, 기타: 0 };
  rows.forEach((r) => {
    const p = r['검증단계']?.trim();
    if (p === '정상') phaseCount.정상++;
    else if (p === '부정') phaseCount.부정++;
    else if (p === '예외') phaseCount.예외++;
    else phaseCount.기타++;
  });

  const total = rows.length;
  const negativeCount = phaseCount.부정 + phaseCount.예외;
  const negativeRatio = Math.round((negativeCount / total) * 100);

  const phaseDistribution: PhaseDistribution = {
    ...phaseCount,
    total,
    negativeRatio,
  };

  let phaseStatus: CheckStatus;
  let phaseDetail: string;
  if (negativeRatio >= 49 && negativeRatio <= 65) {
    phaseStatus = 'pass';
    phaseDetail = `부정+예외 ${negativeRatio}% (목표 49~65%)`;
  } else if (negativeRatio >= 35) {
    phaseStatus = 'warn';
    phaseDetail = `부정+예외 ${negativeRatio}% — 목표치(49~65%) 미달`;
    issues.push({
      severity: 'MEDIUM',
      label: '검증단계 분포 부족',
      detail: `부정+예외 비율 ${negativeRatio}% — 49% 이상 권장`,
    });
  } else {
    phaseStatus = 'fail';
    phaseDetail = `부정+예외 ${negativeRatio}% — 심각하게 부족 (목표 49~65%)`;
    issues.push({
      severity: 'HIGH',
      label: '검증단계 분포 미달',
      detail: `부정+예외 비율 ${negativeRatio}% — 49% 이상 필수`,
    });
  }
  checks.push({ id: 'EVAL-02', label: '검증단계 분포', status: phaseStatus, detail: phaseDetail, weight: 30 });

  // ─── 필수 필드 완전성 (weight 25) ────────────────────────────────
  const emptyStepIds = rows.filter((r) => !r['테스트 스텝']?.trim()).map((r) => r['TC-ID']);
  const emptyExpectIds = rows.filter((r) => !r['기대결과']?.trim()).map((r) => r['TC-ID']);
  const emptyCount = new Set([...emptyStepIds, ...emptyExpectIds]).size;

  let fieldStatus: CheckStatus;
  let fieldDetail: string;
  if (emptyCount === 0) {
    fieldStatus = 'pass';
    fieldDetail = '모든 TC 필수 필드 완성';
  } else if (emptyCount <= Math.ceil(total * 0.1)) {
    fieldStatus = 'warn';
    fieldDetail = `필수 필드 미입력 ${emptyCount}건`;
    if (emptyStepIds.length > 0) issues.push({ severity: 'MEDIUM', label: '테스트 스텝 누락', detail: `${emptyStepIds.length}건 비어있음`, tcIds: emptyStepIds });
    if (emptyExpectIds.length > 0) issues.push({ severity: 'MEDIUM', label: '기대결과 누락', detail: `${emptyExpectIds.length}건 비어있음`, tcIds: emptyExpectIds });
  } else {
    fieldStatus = 'fail';
    fieldDetail = `필수 필드 미입력 ${emptyCount}건 (${Math.round((emptyCount / total) * 100)}%)`;
    if (emptyStepIds.length > 0) issues.push({ severity: 'HIGH', label: '테스트 스텝 대량 누락', detail: `${emptyStepIds.length}건`, tcIds: emptyStepIds });
    if (emptyExpectIds.length > 0) issues.push({ severity: 'HIGH', label: '기대결과 대량 누락', detail: `${emptyExpectIds.length}건`, tcIds: emptyExpectIds });
  }
  checks.push({ id: 'EVAL-03a', label: '필수 필드 완전성', status: fieldStatus, detail: fieldDetail, weight: 25 });

  // ─── 추상 표현 탐지 (weight 20) ──────────────────────────────────
  const abstractTcIds: string[] = [];
  rows.forEach((r) => {
    const text = `${r['테스트 스텝']} ${r['기대결과']}`;
    if (ABSTRACT_KEYWORDS.some((kw) => text.includes(kw))) {
      abstractTcIds.push(r['TC-ID']);
    }
  });

  let abstractStatus: CheckStatus;
  let abstractDetail: string;
  if (abstractTcIds.length === 0) {
    abstractStatus = 'pass';
    abstractDetail = '추상적 표현 없음';
  } else if (abstractTcIds.length <= 3) {
    abstractStatus = 'warn';
    abstractDetail = `추상적 표현 ${abstractTcIds.length}건`;
    issues.push({ severity: 'MEDIUM', label: '추상적 표현 검출', detail: '"정상적으로", "올바르게" 등 — 구체적 수치/상태로 교체 필요', tcIds: abstractTcIds });
  } else {
    abstractStatus = 'fail';
    abstractDetail = `추상적 표현 ${abstractTcIds.length}건 — 전면 검토 필요`;
    issues.push({ severity: 'HIGH', label: '추상적 표현 다수 검출', detail: `${abstractTcIds.length}건 — 구체적 기대결과로 수정 필요`, tcIds: abstractTcIds });
  }
  checks.push({ id: 'EVAL-03b', label: '추상 표현 탐지', status: abstractStatus, detail: abstractDetail, weight: 20 });

  // ─── 1TC=1검증포인트 (weight 10) ─────────────────────────────────
  const compoundTcIds: string[] = [];
  rows.forEach((r) => {
    const text = `${r['테스트 스텝']} ${r['기대결과']}`;
    if (COMPOUND_PATTERNS.some((re) => re.test(text))) {
      compoundTcIds.push(r['TC-ID']);
    }
  });

  let compoundStatus: CheckStatus;
  let compoundDetail: string;
  if (compoundTcIds.length === 0) {
    compoundStatus = 'pass';
    compoundDetail = '복합 검증 포인트 없음';
  } else {
    compoundStatus = 'warn';
    compoundDetail = `복합 검증 패턴 ${compoundTcIds.length}건 — TC 분리 권장`;
    issues.push({ severity: 'MEDIUM', label: '1TC=1검증포인트 위반 의심', detail: `"~하고 ~되는지" 등 복합 패턴 ${compoundTcIds.length}건`, tcIds: compoundTcIds });
  }
  checks.push({ id: 'EVAL-09a', label: '1TC=1검증포인트', status: compoundStatus, detail: compoundDetail, weight: 10 });

  // ─── TC ID 형식 (weight 10) ───────────────────────────────────────
  const invalidIdRows = rows.filter((r) => !/^TC-\d+$/.test(r['TC-ID']));
  const dupIdMap = new Map<string, number>();
  rows.forEach((r) => dupIdMap.set(r['TC-ID'], (dupIdMap.get(r['TC-ID']) ?? 0) + 1));
  const dupIds = [...dupIdMap.entries()].filter(([, c]) => c > 1).map(([id]) => id);

  let idStatus: CheckStatus;
  let idDetail: string;
  if (invalidIdRows.length === 0 && dupIds.length === 0) {
    idStatus = 'pass';
    idDetail = `TC ID ${total}개 형식/중복 이상 없음`;
  } else if (dupIds.length > 0) {
    idStatus = 'warn';
    idDetail = `중복 TC ID ${dupIds.length}건`;
    issues.push({ severity: 'MEDIUM', label: 'TC ID 중복', detail: `중복된 ID: ${dupIds.join(', ')}`, tcIds: dupIds });
  } else {
    idStatus = 'warn';
    idDetail = `비표준 TC ID ${invalidIdRows.length}건`;
    issues.push({ severity: 'LOW', label: 'TC ID 형식 오류', detail: 'TC-NNN 형식이 아닌 ID', tcIds: invalidIdRows.map((r) => r['TC-ID']) });
  }
  checks.push({ id: 'EVAL-05', label: 'TC ID 유효성', status: idStatus, detail: idDetail, weight: 10 });

  // ─── 플랫폼 값 (weight 5) ─────────────────────────────────────────
  const invalidPlatforms = rows.filter((r) => r['플랫폼'] && !VALID_PLATFORMS.includes(r['플랫폼'].trim()));
  let platformStatus: CheckStatus;
  let platformDetail: string;
  if (invalidPlatforms.length === 0) {
    platformStatus = 'pass';
    platformDetail = '플랫폼 값 정상 (PC(Web)/Mobile(App)/공통)';
  } else {
    platformStatus = 'warn';
    platformDetail = `비허용 플랫폼 값 ${invalidPlatforms.length}건`;
    issues.push({
      severity: 'LOW',
      label: '플랫폼 값 오류',
      detail: `허용값: PC(Web), Mobile(App), 공통`,
      tcIds: invalidPlatforms.map((r) => r['TC-ID']),
    });
  }
  checks.push({ id: 'EVAL-04', label: '플랫폼 값 적정성', status: platformStatus, detail: platformDetail, weight: 5 });

  // ─── 점수 계산 ─────────────────────────────────────────────────────
  const totalWeight = checks.reduce((s, c) => s + c.weight, 0);
  const earned = checks.reduce((s, c) => {
    if (c.status === 'pass') return s + c.weight;
    if (c.status === 'warn') return s + c.weight * 0.5;
    return s;
  }, 0);
  const score = Math.round((earned / totalWeight) * 100);

  // 이슈 심각도순 정렬
  const severityOrder: Record<IssueSeverity, number> = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3 };
  issues.sort((a, b) => severityOrder[a.severity] - severityOrder[b.severity]);

  return { score, grade: calcGrade(score), tcCount: total, checks, issues, phaseDistribution };
}
