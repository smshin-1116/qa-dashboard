/**
 * 프롬프트 도메인 프래그먼트 (2026-08-20, si-adaptation)
 * ────────────────────────────────────────────────────────────────────────
 * chat/route.ts의 시스템 프롬프트에서 **도메인 색이 짙은 조각**만 프로파일 기반으로
 * 만들어 돌려준다. 프롬프트 조립 자체는 route.ts에 그대로 두고, 이 조각들만 끼운다.
 *
 * 왜 별도 파일인가 — route.ts는 next/server를 import해 단독 테스트가 어렵다. 이 모듈은
 * 순수 함수라 골든 스냅샷 테스트(scripts/verify-prompts.mjs)가 그대로 import해서
 * "roouty 프로파일 → 기존 리터럴과 바이트 동일"을 자동 검증할 수 있다.
 *
 * ⚠️ roouty 프로파일일 때 아래 함수들의 출력은 기존 route.ts 리터럴과 한 글자도
 *    달라선 안 된다 (골든 테스트가 이를 강제).
 */
import { activeProfile, type ProjectProfile } from '@/config/projectProfile';

/** BASE_CONTEXT 맨 앞 "명세 우선 참고" 섹션 (도메인 전용) */
export function specGuidanceBlock(p: ProjectProfile = activeProfile): string {
  return p.specGuidanceBlock;
}

/** 파이프라인(기획서 1건 → 4단계) 전용 "명세 우선 참고" 지시문 */
export function pipelineSpecDirective(p: ProjectProfile = activeProfile): string {
  return p.pipelineSpecDirective;
}

/** TC 출력 형식 표의 예시 행 한 줄 */
export function tcExampleRow(p: ProjectProfile = activeProfile): string {
  return p.tcExampleRow;
}

/**
 * writer 모드 "TC 품질 규칙" 표에서 도메인 예시 3행.
 * (앞뒤의 "1 TC=1 검증", "플랫폼 스텝 중복 금지" 행은 도메인 무관이라 route.ts에 그대로 둔다.)
 */
export function writingExampleRows(p: ProjectProfile = activeProfile): string {
  return p.writingExamples.map((e) => `| ${e.rule} | ${e.bad} | ${e.good} |`).join('\n');
}
