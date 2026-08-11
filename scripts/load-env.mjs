import fs from 'node:fs';
import path from 'node:path';

/**
 * .env.local 로더.
 *
 * Next.js는 dev/build 시 .env.local을 자동으로 읽지만,
 * `node scripts/collect.mjs` 처럼 Next 밖에서 도는 스크립트는 그렇지 않다.
 * 스케줄러(cron)가 부르는 것도 이 경로이므로 여기서 직접 읽는다.
 *
 * 이미 설정된 환경변수는 덮어쓰지 않는다 — CI나 셸에서 준 값이 우선.
 */
export function loadEnvLocal(file = '.env.local') {
  const p = path.resolve(process.cwd(), file);
  if (!fs.existsSync(p)) return;

  for (const raw of fs.readFileSync(p, 'utf8').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;

    const eq = line.indexOf('=');
    if (eq === -1) continue;

    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();

    // 따옴표로 감싼 값 벗기기 (GOOGLE_PRIVATE_KEY 등)
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1).replace(/\\n/g, '\n');
    }

    if (process.env[key] === undefined) process.env[key] = value;
  }
}
