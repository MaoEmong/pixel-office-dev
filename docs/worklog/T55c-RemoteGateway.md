# T55c — 인증 gateway

127.0.0.1의 별도 HTTP/WebSocket gateway, Origin·Host 검증, CSP/no-store,
등록 전 작업 접근 차단, 30초 socket challenge 인증을 구현했다.
로컬 token과 hook memberToken은 원격에 전달하지 않는다. 원격은 업무 allowlist만 호출한다.
관리자 RPC·force·parentPid·daemon.shutdown은 gateway에서 거부한다.
중복 mutation은 PC DB에 요청 ID와 입력 hash를 기록하고 같은 실행 결과를 돌려준다.
재시작 중 결과가 불명확하면 재실행하지 않고 화면에서 확인하도록 알린다.
PC 또는 기기 서명 해제는 등록을 먼저 revoked로 저장하고 socket을 즉시 닫는다.

검증: typecheck, remote 테스트 2개 통과. 실제 WS bridge로 승인 전 차단·서명 재사용 거부,
관리자 인자 차단·중복 실행·재열기·두 쪽 해제를 확인. QR PNG 생성 확인.
QR 라이브러리 추가 시 기존 transitive 의존성 감사 4건 발견, 호환 범위 npm audit fix 후 0건.
다음: PC 기기 관리 화면과 원격 web assets.
