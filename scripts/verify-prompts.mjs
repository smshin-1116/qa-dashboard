/**
 * 골든 스냅샷 검증 — roouty 프로파일로 만든 프롬프트 조각이 리팩터 전 리터럴과
 * 바이트 동일한지 확인한다. 다르면 실패(비 0 종료) → 동작이 몰래 바뀌는 걸 차단.
 *
 * 실행:  node scripts/verify-prompts.mjs
 * (Node 25 타입 스트리핑으로 .ts 직접 import. projectProfile.ts는 무-import 자립 파일.)
 *
 * 프래그먼트 로직은 lib/prompts/tcPrompts.ts와 동일하게 여기 재현한다(1줄짜리).
 * tsc가 route.ts·tcPrompts.ts가 같은 프로파일 필드를 쓰는지 보장하고,
 * 이 스크립트는 그 필드 값이 골든과 같은지 보장한다.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const { rooutyProfile, genericProfile } = await import('../config/projectProfile.ts');

// tcPrompts.ts와 동일한 프래그먼트 로직 (검증용 재현)
const frag = {
  specGuidanceBlock: (p) => p.specGuidanceBlock,
  pipelineSpecDirective: (p) => p.pipelineSpecDirective,
  tcExampleRow: (p) => p.tcExampleRow,
  writingExampleRows: (p) => p.writingExamples.map((e) => `| ${e.rule} | ${e.bad} | ${e.good} |`).join('\n'),
};

const golden = (name) => readFileSync(join(root, 'test/golden', name), 'utf8').replace(/\n$/, '');

const cases = [
  ['명세 우선 참고 블록(chat)', frag.specGuidanceBlock(rooutyProfile), golden('spec-guidance.roouty.txt')],
  ['명세 지시문(pipeline)', frag.pipelineSpecDirective(rooutyProfile), golden('pipeline-spec-directive.roouty.txt')],
  ['TC 예시 행', frag.tcExampleRow(rooutyProfile), golden('tc-example-row.roouty.txt')],
  ['작성 규칙 예시 3행', frag.writingExampleRows(rooutyProfile), golden('writing-examples.roouty.txt')],
];

let failed = 0;
for (const [label, got, want] of cases) {
  if (got === want) {
    console.log(`  ✓ ${label} — roouty 출력이 골든과 바이트 동일`);
  } else {
    failed++;
    console.log(`  ✗ ${label} — 불일치!`);
    console.log(`    [got ]\n${got}`);
    console.log(`    [want]\n${want}`);
  }
}

console.log('\n=== generic 프로파일 미리보기 (중립화 확인용) ===');
console.log('명세 블록:', frag.specGuidanceBlock(genericProfile).split('\n')[0]);
console.log('TC 예시 :', frag.tcExampleRow(genericProfile).slice(0, 60), '…');

if (failed) {
  console.log(`\n❌ 골든 검증 실패 ${failed}건 — 프롬프트가 원본과 달라졌습니다.`);
  process.exit(1);
}
console.log('\n✅ 골든 검증 통과 — roouty 프로파일은 기존과 100% 동일.');
