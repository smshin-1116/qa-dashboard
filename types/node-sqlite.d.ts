/**
 * `node:sqlite` 타입 선언.
 *
 * Node 22+ 내장 모듈이지만 이 프로젝트의 @types/node가 20.x라 타입이 없다.
 * @types/node를 올리면 다른 곳에서 연쇄 타입 오류가 날 수 있어,
 * 실제로 쓰는 API만 최소한으로 선언한다.
 *
 * (@types/node를 24+로 올리면 이 파일은 지워도 된다)
 */
declare module 'node:sqlite' {
  /** prepare()가 돌려주는 문장 핸들 */
  export class StatementSync {
    /** 첫 행 1건. 없으면 undefined */
    get(...params: unknown[]): unknown;
    /** 전체 행 */
    all(...params: unknown[]): unknown[];
    /** 변경 실행 — 영향 행 수와 마지막 insert id */
    run(...params: unknown[]): { changes: number | bigint; lastInsertRowid: number | bigint };
  }

  export class DatabaseSync {
    constructor(
      path: string,
      options?: { open?: boolean; readOnly?: boolean; enableForeignKeyConstraints?: boolean },
    );
    /** DDL·PRAGMA 등 결과를 받지 않는 실행 */
    exec(sql: string): void;
    prepare(sql: string): StatementSync;
    close(): void;
  }
}
