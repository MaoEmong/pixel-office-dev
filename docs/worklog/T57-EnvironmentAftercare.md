# T57 — 환경·CLI 인증 실패 후처리

태스크: 시작 전 검사 → CLI 상태·사용자 RPC 차단 → 점검 UI → 회귀·실기·문서.
새 데몬 시작 전에 package.json·Node 24·SQLite·tsx·node-pty·ws·qrcode·zod·xterm·MCP SDK를 읽어 검사한다.
모듈 누락은 의존성 복구 명령과 실제 폴더를 표시한다. 시간 초과 검사 프로세스는 종료한다.
setupRequired는 자동 재시작 루프 대신 복구 후 재시도를 제공한다. 일반 원시 예외는 기존 자세히로 유지한다.
Windows Node는 PATH와 표준 설치 위치도 찾는다. 수동 시작도 같은 검사·파이프 스포너를 사용한다.
소스 폴더가 없을 때도 감시자 실패 화면에서 복구 방법을 보여준다.

environment.check는 전역 또는 선택 멤버의 프로젝트 CLI 홈을 검사한다.
미설치·로그아웃이 확인되면 관련 사용자 RPC를 실행 전에 거부한다. unknown은 오진 차단을 피한다.
권한 실패를 미설치로 단정하지 않고 Codex stderr 로그인 결과를 읽으며 일반 exit 1은 로그아웃으로 단정하지 않는다.
설치·로그인·프로젝트 인증을 고친 뒤 재검사할 수 있다. 인증 토큰·이메일·원시 상태 출력은 노출하지 않는다.
내부 팀 도구·자동 세션 복구·실행 중 요금 한도 등은 이 사전 RPC 검사 범위와 다르며 문서에 한계를 적었다.

실기: 격리된 .local/t57-missing-deps의 의존성 없는 데몬으로 별도 앱을 실행했다.
실패 화면이 tsx 누락·npm ci 안내를 바로 표시했고 사용자 DB·CLI 인증은 변경하지 않았다.
테스트 앱을 닫고 정상 앱의 메뉴를 직접 눌러 전역 Claude/Codex 로그인 정상과
선택한 기존 부장 세션의 별도 로그인 필요를 확인했다. 복구 명령은 정확한 프로젝트 홈을 가리켰다.
이 실제 세션에 대한 로그인 변경은 수행하지 않았다.

증빙: img/T57-missing-dependencies.png, img/T57-environment-check.png, img/T57-project-auth-check.png.
검증: backend 전체 1207 pass / 16 skip / 0 fail, 프로젝트 홈 추가 검사 포함 diagnostics 3개 통과.
Flutter 초기 전체 754 pass / 1 skip; 이후 수동 시작 문구 변경의 기대값 불일치 1건과
기존 터미널 resize 시간 초과 1건이 나와 문구를 정리하고 순차 전체 재검사를 수행했다.
관련 targeted 34개, Windows Node 경로 검사, analyze·Windows release 검증을 추가했다.
Windows Node 경로 검사 33개는 통과했고, 테스트 소스 갱신 중 수행한 순차 실행은 캐시된
이전 Node 탐색 코드와 새 기대값 불일치로 실패하여 소스 갱신 완료 후 전체를 다시 실행했다.
순차 재검사에서도 기존 panel_width의 resize 검사가 실패해 원인을 확인했다.
처음에는 Provider override 공유 문제로 판단했으나 공유만으로 전체 실행 실패가 해결되지 않았다.
기존 harness는 기본 override도 공유하므로 그 판단은 불완전했다.
해당 검사는 픽셀 폭 두 개가 반드시 다른 터미널 칸 수로 변환된다고 가정했다.
패널 크기·attach 전 재배치 검사는 유지하고, 이 검사의 범위는 명시적인 terminal resize 이벤트가
정확한 cols/rows로 실제 RPC에 전달되는 계약으로 정리했다. 단독 파일 8개 통과 뒤 전체를 재검사했다.
뷰 재배치가 이후 다른 resize를 보내는 정상 경합도 반영해 마지막 요청 대신 목표 크기 요청의 전달을 검사한다.
명시적 resize 이벤트 검사에서도 실패해 xterm 4.0.0의 Terminal.resize 구현을 확인했다.
onResize는 viewWidth/viewHeight 갱신 전에 호출되는데 TerminalCache가 갱신 전 값을 읽고 있었다.
실제 버그는 이벤트의 새 cols/rows를 사용하도록 수정했다. markAttached의 현재 크기 검사도 유지한다.
이 회귀는 목표 크기 120x40이 실제 RPC로 전달되는지 확인한다.

최종: Flutter 전체 755 pass / 1 skip / 0 fail, analyze 오류 없음.
backend 전체 1207 pass / 16 skip / 0 fail 이후 추가 프로젝트 인증 회귀 및 최종 RPC·진단 18개 통과.
Windows release 빌드 성공, 전체 런타임 의존성 import 실검사 통과, git diff --check 통과.
