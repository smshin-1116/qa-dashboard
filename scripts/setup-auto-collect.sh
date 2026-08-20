#!/usr/bin/env bash
#
# 오늘 탭 자동 수집 설치 스크립트 (macOS launchd)
# ─────────────────────────────────────────────────────────────────────────
# 매일 정해진 시각에 `npm run collect`을 자동 실행하는 launchd 잡을 설치한다.
# 실행 직전 Jenkins(Docker)의 최신 web-e2e junit.xml을 로컬로 동기화한다.
#
# 왜 이 스크립트인가 — launchd plist에는 절대경로(사용자 홈·바이너리 위치·컨테이너명)가
# 박혀야 한다. 그 값은 맥마다 다르므로 plist를 그대로 커밋할 수 없다. 대신 이 스크립트가
# 현재 환경을 탐지해 plist를 "생성·설치"한다 → 어느 맥에서든 한 번 실행으로 재현된다.
#
# 사용:
#   bash scripts/setup-auto-collect.sh          # 설치(또는 재설치)
#   bash scripts/setup-auto-collect.sh --remove # 제거
#
set -euo pipefail

# ── 설정 (필요하면 이 값만 바꾸세요) ──────────────────────────────────────
LABEL="com.smshin.qa-dashboard.collect"   # launchd 잡 이름
HOUR=8                                     # 매일 실행 시각 (시)
MINUTE=0                                   # 매일 실행 시각 (분)
JENKINS_CONTAINER="jenkins-local"          # E2E 도는 Docker 컨테이너명
JENKINS_JUNIT="/var/jenkins_home/workspace/roouty-e2e/reports/junit.xml"  # 컨테이너 내 junit 경로
SYNC_DIR="$HOME/.qa-dashboard/web-e2e"     # web-e2e junit을 동기화할 로컬 폴더(레포 밖)
# ─────────────────────────────────────────────────────────────────────────

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
UID_NUM="$(id -u)"

# ── 제거 모드 ─────────────────────────────────────────────────────────────
if [[ "${1:-}" == "--remove" ]]; then
  launchctl bootout "gui/$UID_NUM/$LABEL" 2>/dev/null || true
  rm -f "$PLIST"
  echo "제거됨: $LABEL"
  exit 0
fi

# ── 바이너리 절대경로 탐지 (launchd는 최소 PATH로 돈다) ───────────────────
NPM_BIN="$(command -v npm || true)"
NODE_BIN="$(command -v node || true)"
DOCKER_BIN="$(command -v docker || true)"
GH_BIN="$(command -v gh || true)"
[[ -z "$NPM_BIN" || -z "$NODE_BIN" ]] && { echo "❌ node/npm을 PATH에서 못 찾음"; exit 1; }

# 실행 시 쓸 PATH — node·gh(있으면) 디렉터리 + 표준 경로
RUN_PATH="$(dirname "$NODE_BIN")"
[[ -n "$GH_BIN" ]] && RUN_PATH="$RUN_PATH:$(dirname "$GH_BIN")"
RUN_PATH="$RUN_PATH:/usr/bin:/bin:/usr/sbin:/sbin"

mkdir -p "$SYNC_DIR/reports" "$PROJECT_DIR/data" "$HOME/Library/LaunchAgents"

# ── web-e2e 동기화 명령 (docker 있을 때만) ────────────────────────────────
if [[ -n "$DOCKER_BIN" ]]; then
  SYNC_STEP="if $DOCKER_BIN cp $JENKINS_CONTAINER:$JENKINS_JUNIT $SYNC_DIR/reports/junit.xml; then echo '[web-e2e] Jenkins junit 동기화 OK'; else echo '[web-e2e] junit 동기화 실패(수집은 진행)'; fi; "
else
  SYNC_STEP="echo '[web-e2e] docker 없음 — junit 동기화 건너뜀'; "
  echo "⚠️ docker를 못 찾음 — web-e2e 동기화 단계는 건너뛰도록 설치합니다."
fi

# ── 실행 명령 조립 ────────────────────────────────────────────────────────
# 주의: & < > 를 쓰지 않는다(plist XML 이스케이프 회피). &&/|| 대신 if/;/를 쓴다.
# $(date …) 와 $? 는 실행 시점(08:00)에 평가되도록 "리터럴"로 남긴다.
CMD="export PATH=$RUN_PATH; cd $PROJECT_DIR; "
CMD+='echo "===== $(date "+%Y-%m-%d %H:%M:%S") 수집 시작 ====="; '
CMD+="$SYNC_STEP"
CMD+="$NPM_BIN run collect; "
CMD+='echo "----- 종료(exit $?) -----"'

# 혹시 모를 XML 특수문자 이스케이프(현재 CMD엔 없지만 안전장치)
esc() { printf '%s' "$1" | sed 's/&/\&amp;/g; s/</\&lt;/g; s/>/\&gt;/g'; }
CMD_XML="$(esc "$CMD")"
LOG="$PROJECT_DIR/data/collect.log"

# ── plist 생성 ────────────────────────────────────────────────────────────
cat > "$PLIST" <<PLISTEOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>-c</string>
    <string>$CMD_XML</string>
  </array>
  <key>StartCalendarInterval</key>
  <dict>
    <key>Hour</key><integer>$HOUR</integer>
    <key>Minute</key><integer>$MINUTE</integer>
  </dict>
  <key>RunAtLoad</key>
  <false/>
  <key>StandardOutPath</key>
  <string>$LOG</string>
  <key>StandardErrorPath</key>
  <string>$LOG</string>
</dict>
</plist>
PLISTEOF

plutil -lint "$PLIST" >/dev/null

# ── 등록(재설치) ──────────────────────────────────────────────────────────
launchctl bootout "gui/$UID_NUM/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$UID_NUM" "$PLIST"

echo "✅ 설치 완료: $LABEL — 매일 $(printf '%02d:%02d' "$HOUR" "$MINUTE")"
echo "   plist : $PLIST"
echo "   로그  : $LOG"
echo "   동기화: $SYNC_DIR/reports/junit.xml  ← $JENKINS_CONTAINER"
echo
echo "관리:"
echo "  지금 1회 실행:  launchctl kickstart -k gui/$UID_NUM/$LABEL"
echo "  상태 확인:      launchctl print gui/$UID_NUM/$LABEL | grep -i state"
echo "  제거:           bash scripts/setup-auto-collect.sh --remove"
echo
echo "⚠️ .env.local 에 아래가 있어야 web-e2e가 동기화 폴더를 읽습니다:"
echo "   WEB_E2E_DIR=$SYNC_DIR"
