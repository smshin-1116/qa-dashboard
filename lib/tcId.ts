/**
 * TC-ID를 "TC-001" 형식으로 통일한다.
 *
 * 모델이 TC-ID를 제각각 뱉는다 — "TC-001"·"1"·"MV-003"·"tc-7" 등. 저장(local_id)·표시·
 * XLSX가 다 이 형식을 공유하도록, **끝의 숫자를 살려 `TC-NNN`(3자리)** 으로 맞춘다.
 * 숫자가 없으면 index(행 순서)로 채번한다.
 *
 * 예: "TC-001"→"TC-001", "1"→"TC-001", "10"→"TC-010", "MV-003"→"TC-003", ""→"TC-{index+1}".
 *
 * (2026-08-18: local_id 형식이 작업마다 달라 수행 결과 매칭이 깨지던 문제의 근본 해결 —
 *  생성 프롬프트만으론 모델이 종종 벗어나므로 저장 시점에서 형식을 강제한다.)
 */
export function normalizeTcId(raw: string | undefined | null, index: number): string {
  const s = (raw ?? '').trim();
  const m = s.match(/(\d+)\s*$/); // 끝에 붙은 숫자
  const n = m ? parseInt(m[1], 10) : index + 1;
  return `TC-${String(n).padStart(3, '0')}`;
}
