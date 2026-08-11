import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /**
   * node:sqlite 는 Node 내장 모듈이라 번들링 대상이 아니다.
   * 워크스페이스 상태 저장소(lib/workspace/*)가 서버에서만 쓰므로
   * 번들러가 클라이언트 그래프로 끌고 가지 않도록 외부 패키지로 표시한다.
   */
  serverExternalPackages: ["node:sqlite"],
};

export default nextConfig;
