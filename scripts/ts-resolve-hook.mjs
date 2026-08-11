/**
 * 확장자 없는 TS import를 Node ESM에서 해석하기 위한 리졸버 훅.
 *
 * Next.js/TypeScript는 `./fingerprint` 같은 확장자 없는 경로를 허용하지만
 * Node의 ESM 로더는 확장자를 요구한다. 검증 스크립트를 dev 서버 없이
 * 바로 돌리기 위해 `.ts` → `/index.ts` 순으로 보정한다.
 *
 * 사용:
 *   node --experimental-strip-types --import ./scripts/ts-resolve-hook.mjs <script>
 *
 * 런타임(Next.js)에는 영향이 없다 — 검증 전용이다.
 */
import { register } from 'node:module';
import { pathToFileURL } from 'node:url';

register(
  'data:text/javascript,' +
    encodeURIComponent(`
      import { existsSync } from 'node:fs';
      import { fileURLToPath } from 'node:url';

      export async function resolve(specifier, context, next) {
        try {
          return await next(specifier, context);
        } catch (err) {
          // 상대 경로에 한해 확장자를 붙여 재시도
          if (!specifier.startsWith('.')) throw err;
          const base = new URL(specifier, context.parentURL);
          for (const cand of [base.href + '.ts', base.href + '/index.ts']) {
            if (existsSync(fileURLToPath(cand))) {
              return next(cand, context);
            }
          }
          throw err;
        }
      }
    `),
  pathToFileURL('./'),
);
