# 오늘 탭 자동 수집 (daily auto-collect)

오늘 탭의 신호(jira · datadog · stage-pr · api-test · web-e2e)를 **매일 아침 자동으로**
모아두는 설정. 출근 전 대시보드가 최신 상태가 되게 한다.

## 무엇을 하나

macOS `launchd` 잡이 **매일 08:00**에 아래를 순서대로 실행한다:

1. **web-e2e junit 동기화** — Jenkins(Docker `jenkins-local`)가 만든 최신 `junit.xml`을
   `docker cp`로 로컬 동기화 폴더(`~/.qa-dashboard/web-e2e/reports/`)에 복사.
   (E2E는 Docker 볼륨 안에 결과를 쓰기 때문에, 수집기가 읽는 로컬 경로로 꺼내온다.)
2. **`npm run collect`** — 5개 신호원을 수집해 `data/workspace.db`에 저장(LLM 미사용).

> `todo`(오늘 할 일)는 수집이 만들지 않는다 — 오늘 탭을 열면
> `GET /api/workspace/today?rebuild=1`이 `buildToday()`로 그때 생성한다.

## 설치 / 재설치

```bash
bash scripts/setup-auto-collect.sh
```

스크립트가 현재 맥의 절대경로(node·docker·홈)를 **자동 탐지**해 plist를 만들어 설치한다.
plist에는 머신 전용 경로가 박히므로 레포엔 이 **생성 스크립트만** 두고, 생성된 plist는
`~/Library/LaunchAgents/`에만 둔다(커밋하지 않음).

설치 후 `.env.local`에 아래가 있어야 web-e2e가 동기화 폴더를 읽는다:

```
WEB_E2E_DIR=/Users/<you>/.qa-dashboard/web-e2e
```

## 관리

```bash
U=$(id -u); L=com.smshin.qa-dashboard.collect
launchctl kickstart -k gui/$U/$L      # 지금 바로 1회 실행(테스트)
launchctl print gui/$U/$L | grep -i state
cat data/collect.log                   # 실행 로그(gitignore)
bash scripts/setup-auto-collect.sh --remove   # 스케줄 제거
```

시각·컨테이너명·경로를 바꾸려면 `scripts/setup-auto-collect.sh` 상단 설정값을 수정하고
다시 실행하면 된다.

## 전제 / 주의

- **로그인 상태**여야 08:00에 실행된다(개인 GUI 세션 LaunchAgent). 잠자던 맥은 깨어날 때 실행.
- **web-e2e 동기화는 Docker 데몬이 떠 있어야** 된다. 꺼져 있으면 그날 web-e2e만 직전 값 유지,
  나머지 4종(라이브 API/CI)은 정상 수집.
- 수집기가 참조하는 외부 자산은 **읽기 전용**이다(레포 수정 안 함). web-e2e도
  `roouty-test-automation` 레포가 아니라 별도 동기화 폴더를 쓴다.
