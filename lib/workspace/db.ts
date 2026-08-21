import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { DDL, SCHEMA_VERSION } from './schema';

/**
 * 워크스페이스 상태 저장소 연결.
 *
 * ── 왜 node:sqlite 인가 ───────────────────────────────────────────────
 * better-sqlite3는 네이티브 빌드가 필요해 Node 버전이 바뀔 때마다 깨진다.
 * Node 22+ 내장 `node:sqlite`는 의존성 0 · 빌드 0이라 개인 도구에 적합하다.
 * (실행 시 ExperimentalWarning이 뜨지만 API는 동기식으로 안정적이다.)
 *
 * ── 왜 동기(Sync) API를 쓰나 ──────────────────────────────────────────
 * 이 DB는 로컬 파일이고 사용자는 한 명이다. 비동기로 감쌀 이유가 없고,
 * Next.js route handler 안에서 그대로 호출하면 된다.
 *
 * ── 주의 ──────────────────────────────────────────────────────────────
 * 서버 전용 모듈이다. 클라이언트 컴포넌트에서 import하면 빌드가 깨진다.
 * 반드시 route handler / server action 에서만 사용할 것.
 */

/** DB 파일 위치 — 레포 루트의 data/ (gitignore 대상) */
const DB_DIR = path.join(process.cwd(), 'data');
const DB_PATH = process.env.WORKSPACE_DB_PATH ?? path.join(DB_DIR, 'workspace.db');

let _db: DatabaseSync | null = null;

/**
 * 싱글턴 연결을 반환한다. 최초 호출 시 디렉터리 생성 + 마이그레이션까지 수행.
 * dev 서버가 핫리로드로 모듈을 다시 평가해도 파일 DB라 상태는 유지된다.
 */
export function getDb(): DatabaseSync {
  if (_db) return _db;

  if (DB_PATH !== ':memory:') {
    fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  }

  const db = new DatabaseSync(DB_PATH);

  // WAL: 수집기(쓰기)와 화면(읽기)이 동시에 붙어도 서로 막지 않게 한다.
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  // 수집기가 도는 중 화면이 읽다 잠기면 최대 3초 기다린다.
  db.exec('PRAGMA busy_timeout = 3000');

  migrate(db);

  _db = db;
  return db;
}

/**
 * 스키마 적용.
 * DDL이 전부 `IF NOT EXISTS`라 반복 실행해도 안전하다.
 * 버전이 올라가면 여기에 ALTER 분기를 추가한다 (지금은 v1이라 없음).
 */
function migrate(db: DatabaseSync): void {
  db.exec(DDL);

  const row = db
    .prepare(`SELECT value FROM meta WHERE key = 'schema_version'`)
    .get() as { value?: string } | undefined;
  const current = row?.value ? Number(row.value) : 0;

  // v3: tc_work.contract — 기존 DB에는 컬럼이 없어 ALTER가 필요하다.
  // (신규 DB는 DDL에 이미 포함 → ALTER가 중복 에러를 내므로 버전으로 거른다)
  if (current > 0 && current < 3) {
    try {
      db.exec(`ALTER TABLE tc_work ADD COLUMN contract TEXT`);
    } catch {
      // 이미 있으면 무시 — DDL과 ALTER가 겹치는 경계 케이스
    }
  }

  // v4: tc.bug_ticket — Fail TC에 등록한 Jira 버그 키(중복 등록 방지). 기존 DB엔 ALTER.
  if (current > 0 && current < 4) {
    try {
      db.exec(`ALTER TABLE tc ADD COLUMN bug_ticket TEXT`);
    } catch {
      // 이미 있으면 무시
    }
  }

  // v5: tc.bug_evidence — Fail 시 수행이 남긴 구조화 버그 근거(JSON). 화면엔 안 뜨고
  // 버그 티켓 생성 시 DV-647 형식 섹션의 재료로 쓴다(재분석 없이 고품질).
  if (current > 0 && current < 5) {
    try {
      db.exec(`ALTER TABLE tc ADD COLUMN bug_evidence TEXT`);
    } catch {
      // 이미 있으면 무시
    }
  }

  if (current !== SCHEMA_VERSION) {
    db.prepare(
      `INSERT INTO meta (key, value, updated_at) VALUES ('schema_version', ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    ).run(String(SCHEMA_VERSION), nowIso());
  }
}

/** 테스트·스크립트에서 연결을 닫을 때 사용 */
export function closeDb(): void {
  _db?.close();
  _db = null;
}

// ─── 공통 유틸 ────────────────────────────────────────────────────────

/** ISO 8601 (UTC) 현재 시각 */
export function nowIso(): string {
  return new Date().toISOString();
}

/**
 * KST 기준 날짜 문자열 (YYYY-MM-DD).
 * 브리핑은 "오늘 아침"이 기준이라 UTC로 자르면 하루가 밀린다.
 */
export function todayKst(at: Date = new Date()): string {
  const kst = new Date(at.getTime() + 9 * 60 * 60 * 1000);
  return kst.toISOString().slice(0, 10);
}

/** 두 YYYY-MM-DD 사이의 일수 차 (a - b) */
export function daysBetween(a: string, b: string): number {
  const ms = Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`);
  return Math.round(ms / 86_400_000);
}

/** meta 테이블 읽기/쓰기 — 수집기 마지막 실행 시각 등에 사용 */
export function getMeta(key: string): string | null {
  const row = getDb().prepare('SELECT value FROM meta WHERE key = ?').get(key) as
    | { value?: string }
    | undefined;
  return row?.value ?? null;
}

export function setMeta(key: string, value: string): void {
  getDb()
    .prepare(
      `INSERT INTO meta (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    )
    .run(key, value, nowIso());
}
