#!/bin/bash
#
# 아침 자동 수집 — launchd가 평일 08:00에 부른다.
#
# ── 왜 래퍼가 필요한가 ────────────────────────────────────────────────
# launchd는 로그인 셸을 거치지 않아 PATH가 최소한이다.
# gh(homebrew)·node가 안 잡히면 수집이 조용히 실패하므로 명시적으로 넣는다.
#
# ── 실패를 삼키지 않는다 ──────────────────────────────────────────────
# 실패해도 로그만 남고 끝나면 "아침에 브리핑이 비어 있는데 이유를 모르는"
# 최악의 상태가 된다. 종료 코드와 함께 요약을 로그 맨 위에 남긴다.
set -uo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOG_DIR="$APP_DIR/data/logs"
LOG="$LOG_DIR/collect-$(date +%Y-%m-%d).log"

mkdir -p "$LOG_DIR"

# homebrew(gh) + node 경로를 앞에 붙인다
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"

cd "$APP_DIR" || exit 1

{
  echo "════════════════════════════════════════════"
  echo "수집 시작 $(date '+%Y-%m-%d %H:%M:%S')"
  echo "PATH=$PATH"
  echo "gh=$(command -v gh || echo '없음')  node=$(command -v node || echo '없음')"
  echo "────────────────────────────────────────────"
} >> "$LOG"

npm run collect --silent >> "$LOG" 2>&1
code=$?

{
  echo "────────────────────────────────────────────"
  if [ $code -eq 0 ]; then
    echo "✅ 수집 완료 $(date '+%H:%M:%S')"
  else
    echo "❌ 수집 실패 (exit $code) $(date '+%H:%M:%S')"
    echo "   → 대시보드 좌측 '지금 수집'으로 수동 재시도 가능"
  fi
  echo
} >> "$LOG"

# 오래된 로그 정리 (14일)
find "$LOG_DIR" -name 'collect-*.log' -mtime +14 -delete 2>/dev/null

exit $code
