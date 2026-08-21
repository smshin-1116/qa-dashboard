/**
 * 워크스페이스 상태 저장소 스키마 (SQLite)
 *
 * ── 왜 이 층이 필요한가 ───────────────────────────────────────────────
 * 대시보드의 기존 영속화는 IndexedDB(브라우저 로컬)뿐이라
 * "스케줄러가 만든 결과를 UI가 읽는다"가 구조적으로 불가능했다.
 * 그래서 아침 브리핑·결과 자동 반영·티켓 루프가 전부 막혀 있었다.
 * 이 파일이 그 결손을 메우는 단일 지점이다.
 *
 * ── 설계 원칙 ─────────────────────────────────────────────────────────
 * 1. 쓰이는 테이블만 만든다. (tc·risk_pattern은 해당 화면을 구현할 때 추가)
 * 2. 수집은 멱등(idempotent)이어야 한다 — 같은 신호를 여러 번 수집해도
 *    중복이 쌓이지 않도록 UNIQUE 제약으로 막는다.
 * 3. 원본(payload)은 남기되, 화면이 읽는 값은 미리 뽑아 컬럼으로 둔다.
 *    UI가 매번 JSON을 파싱하지 않도록.
 */

/**
 * 스키마 버전 — 올리면 migrate()가 차이만큼 적용한다.
 *
 * v2 (2026-08-10): QA 작업의 TC를 상태 저장소로 옮김 (`tc_work`·`tc`).
 * v3 (2026-08-10): `tc_work.contract` — ⓪흡수·①교차분석의 인계 계약 JSON.
 *   확인 게이트(②)가 새로고침에도 살아남아야 해서 화면 state가 아니라 여기 둔다.
 *   그전까지 TC는 채팅 메시지 안 마크다운 표에만 있어서
 *   판정·테스트 참조·수행 결과를 붙일 자리가 없었다.
 */
export const SCHEMA_VERSION = 5;

export const DDL = `
-- ─────────────────────────────────────────────────────────────────────
-- meta : 스키마 버전 · 수집기별 마지막 실행 시각 등 키-값
-- ─────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS meta (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- ─────────────────────────────────────────────────────────────────────
-- signal : 모든 수집기의 공통 착지점 (원신호)
--   source  수집기 이름         'api-test' | 'jira' | 'datadog' | 'web-e2e'
--   kind    신호 종류           'run' | 'ticket' | 'error-cluster' | 'drift' ...
--   ref     원본 식별자         gh run id · 티켓키 · 클러스터키
--   observed_at  원본에서 관측된 시각(수집 시각이 아님)
-- 같은 (source, ref, observed_at)은 같은 관측 → 중복 저장 안 함
-- ─────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS signal (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  source       TEXT NOT NULL,
  kind         TEXT NOT NULL,
  ref          TEXT NOT NULL,
  fingerprint  TEXT,
  title        TEXT NOT NULL,
  detail       TEXT,
  severity     TEXT NOT NULL DEFAULT 'info',   -- crit | warn | info | ok | idle
  url          TEXT,
  payload      TEXT,                            -- 원본 JSON (문자열)
  observed_at  TEXT NOT NULL,
  collected_at TEXT NOT NULL,
  UNIQUE (source, ref, observed_at)
);
CREATE INDEX IF NOT EXISTS idx_signal_observed ON signal (observed_at DESC);
CREATE INDEX IF NOT EXISTS idx_signal_source   ON signal (source, kind);

-- ─────────────────────────────────────────────────────────────────────
-- test_run : 러너별 실행 결과 (스위트 단위)
--   runner  'api' | 'web' | 'app'
-- external_id = gh run id / jenkins build no. 없으면 시작시각으로 대체
-- ─────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS test_run (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  runner       TEXT NOT NULL,
  suite        TEXT NOT NULL,
  external_id  TEXT NOT NULL,
  status       TEXT NOT NULL,                   -- success | failure | cancelled | unknown
  total        INTEGER,
  passed       INTEGER,
  failed       INTEGER,
  skipped      INTEGER,
  started_at   TEXT,
  duration_sec INTEGER,
  url          TEXT,
  collected_at TEXT NOT NULL,
  UNIQUE (runner, external_id)
);
CREATE INDEX IF NOT EXISTS idx_run_started ON test_run (started_at DESC);

-- ─────────────────────────────────────────────────────────────────────
-- finding : 실패 1건 → 분류 결과
--   kind        6종 통합 분류 (docs 참조)
--   verdict_by  'rule' | 'cache' | 'llm'  ← 토큰이 어디서 들었는지 추적
--   fingerprint 같은 실패 재발 판정 키 (lib/workspace/fingerprint.ts)
--   analyzed_at LLM/규칙 판정 시각. TTL(7일) 지나면 재분석 대상
-- fingerprint UNIQUE → 같은 실패가 매일 나도 행이 하나. occurrences만 증가
-- ─────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS finding (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  fingerprint  TEXT NOT NULL UNIQUE,
  run_id       INTEGER REFERENCES test_run(id) ON DELETE SET NULL,
  runner       TEXT NOT NULL,
  node_id      TEXT NOT NULL,
  kind         TEXT,
  verdict_by   TEXT,
  error_type   TEXT,
  message_norm TEXT,
  contract_key TEXT,
  detail       TEXT,
  first_seen   TEXT NOT NULL,
  last_seen    TEXT NOT NULL,
  occurrences  INTEGER NOT NULL DEFAULT 1,
  analyzed_at  TEXT,
  analysis     TEXT,
  resolved_at  TEXT
);
CREATE INDEX IF NOT EXISTS idx_finding_last ON finding (last_seen DESC);
CREATE INDEX IF NOT EXISTS idx_finding_kind ON finding (kind);

-- ─────────────────────────────────────────────────────────────────────
-- ticket_link : Jira 티켓 상태 (+ finding 연결)
--   is_mine     내가 리포터인가 (= 자동화가 발굴한 버그)
--   confidence  create-bug 5축 게이트 신뢰도 등급
-- ─────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS ticket_link (
  jira_key     TEXT PRIMARY KEY,
  finding_id   INTEGER REFERENCES finding(id) ON DELETE SET NULL,
  summary      TEXT,
  status       TEXT,
  confidence   TEXT,
  is_mine      INTEGER NOT NULL DEFAULT 0,
  labels       TEXT,
  updated_at   TEXT,
  status_since TEXT,                            -- 이 상태로 머문 시작일 (정체 판정)
  url          TEXT,
  collected_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ticket_status ON ticket_link (status);

-- ─────────────────────────────────────────────────────────────────────
-- todo : 아침에 산출되는 오늘 할 일
--   day        산출 기준일 (YYYY-MM-DD)
--   key        같은 할 일 식별자 — 이월 판정에 쓴다
--   first_day  최초 등장일 → 경과일(D+N) = day - first_day
--   pinned     알림에서 사람이 복귀시킨 항목 (D+7 자동 이동에서 제외)
--   promoted   복귀하며 우선순위가 한 단계 올라갔는가
-- (day, key) UNIQUE → 하루에 같은 할 일이 두 번 생기지 않는다
-- ─────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS todo (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  day          TEXT NOT NULL,
  key          TEXT NOT NULL,
  priority     TEXT NOT NULL,                   -- P0 | P1 | P2 | P3
  title        TEXT NOT NULL,
  detail       TEXT,
  source       TEXT,                            -- 출처 배지 (api-test/jira/datadog/...)
  mode         TEXT NOT NULL DEFAULT 'manual',  -- semi(대시보드에서 실행 가능) | manual
  action_label TEXT,
  action_url   TEXT,
  signal_id    INTEGER REFERENCES signal(id) ON DELETE SET NULL,
  first_day    TEXT NOT NULL,
  pinned       INTEGER NOT NULL DEFAULT 0,
  promoted     INTEGER NOT NULL DEFAULT 0,
  done_at      TEXT,
  created_at   TEXT NOT NULL,
  UNIQUE (day, key)
);
CREATE INDEX IF NOT EXISTS idx_todo_day ON todo (day);

-- ─────────────────────────────────────────────────────────────────────
-- notice : 🔔 알림 — 오늘 할 일과 분리된 "며칠째 정체된 것"
--   kind  carry-over(이월 상한 초과) | stale-asset(방치) |
--         stalled-ticket(정체 티켓) | metric-stall(지표 정체) | skip-limit
--   snoozed_until 이 시각까지 숨김 · dismissed 영구 끄기
-- ─────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS notice (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  kind              TEXT NOT NULL,
  key               TEXT NOT NULL,
  title             TEXT NOT NULL,
  detail            TEXT,
  source            TEXT,
  since             TEXT,                       -- 언제부터 이 상태인가
  days              INTEGER,
  origin_todo_key   TEXT,                       -- 이월 초과로 넘어온 todo
  original_priority TEXT,                       -- 복귀 시 승격 계산용
  snoozed_until     TEXT,
  dismissed         INTEGER NOT NULL DEFAULT 0,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  UNIQUE (kind, key)
);

-- ─────────────────────────────────────────────────────────────────────
-- tc_work : QA 작업 1건 (= 티켓/기획서 하나를 검증하는 단위)
--   ㉮ 일회성 — 티켓이 끝나면 이 작업도 끝난다.
--   session_id 로 채팅 세션과 연결해 "이 대화에서 나온 TC"를 되짚을 수 있다.
-- ─────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS tc_work (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id  TEXT NOT NULL UNIQUE,          -- 채팅 세션 id (IndexedDB 쪽 키)
  title       TEXT NOT NULL,
  sources     TEXT,                          -- 입력 URL·텍스트 JSON 배열
  contract    TEXT,                          -- ⓪① 인계 계약 JSON (v3) — 확인 게이트의 원천
  status      TEXT NOT NULL DEFAULT 'draft', -- draft | done
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

-- ─────────────────────────────────────────────────────────────────────
-- tc : 작업 안의 테스트 케이스 1건
--
--   local_id   TC-01 — **이 작업 안에서만 유효한 일련번호** (2026-08-07 결정)
--   catalog_id ROUTE-014 — 자동화로 넘길 때 받는 영구 번호. 안 넘기면 NULL
--   verdict    기존 카탈로그(90건)와 대조한 판정
--                new    새로 써야 하는 것
--                covered 이미 자동화돼 있음 (작성 불필요)
--                stale  기존 TC가 있으나 계약 변경으로 기대결과가 낡음
--   test_ref   참조하는 테스트 (JSON 배열). TC ↔ 테스트는 1:N —
--              참조한 것이 **전부 통과해야** Pass로 본다
--   extra      가변 컬럼 (컬럼 고정 해제 대비 — 2026-08-06 결정)
--
-- 필수 4필드(phase·steps·expected·result)만 컬럼으로 고정한다.
-- 품질 스코어카드와 수행 결과가 이 필드에 물려 있기 때문.
-- ─────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS tc (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  work_id           INTEGER NOT NULL REFERENCES tc_work(id) ON DELETE CASCADE,
  local_id          TEXT NOT NULL,
  catalog_id        TEXT,
  verdict           TEXT,                    -- new | covered | stale
  matched_catalog_id TEXT,                   -- covered·stale일 때 매칭된 기존 TC
  match_reason      TEXT,                    -- 왜 그렇게 판정했는지 (사람이 검토)
  category          TEXT,
  sub_category      TEXT,
  detail_category   TEXT,
  phase             TEXT,                    -- 검증단계 [필수]
  precondition      TEXT,
  steps             TEXT,                    -- 테스트 스텝 [필수]
  expected          TEXT,                    -- 기대결과   [필수]
  platform          TEXT,
  result            TEXT NOT NULL DEFAULT 'Not Test', -- Pass|Fail|Blocked|Not Test [필수]
  note              TEXT,
  extra             TEXT,                    -- 가변 컬럼 JSON
  test_ref          TEXT,                    -- JSON 배열
  handed_off_at     TEXT,                    -- 자동화 후보로 넘긴 시각
  bug_ticket        TEXT,                    -- Fail 시 등록한 Jira 버그 키 (중복 등록 방지)
  bug_evidence      TEXT,                    -- Fail 시 수행이 남긴 구조화 버그 근거(JSON) — 화면 미표시, 티켓 재료
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  UNIQUE (work_id, local_id)
);
CREATE INDEX IF NOT EXISTS idx_tc_work ON tc (work_id);
CREATE INDEX IF NOT EXISTS idx_tc_verdict ON tc (verdict);

-- ─────────────────────────────────────────────────────────────────────
-- token_usage : 모델별 사용량 계측
--   "안 보이면 안 줄어든다" — 설계 원칙에 따라 처음부터 계측한다
-- ─────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS token_usage (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  day          TEXT NOT NULL,
  model        TEXT NOT NULL,                   -- claude | codex | gemini
  feature      TEXT NOT NULL,                   -- today-collect | qa-work | fail-analyze ...
  input_tokens  INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  calls         INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_token_day ON token_usage (day, model);
`;
