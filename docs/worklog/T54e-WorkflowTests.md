# T54e — 자동 검사와 회귀

TypeScript typecheck 통과. backend 전체 1214개 중 1200 통과·14 opt-in skip·실패 0
(`node --import tsx --test --test-concurrency=1 "test/**/*.test.ts"`, 266초).
Flutter analyze 및 전체 746개 통과·기존 1 skip·실패 0. Windows release 빌드 통과.

새 테스트는 실제 Office hook 단계 차단, 조기 위임·보고 거부, 두 차례 발언,
참석자·의존성 검증, 후속 업무 배정, 정상 종료 보존, 누락 의견 복구,
앱의 대화/시작 분리·실행 입력 잠금·검수·퇴근 참가자 이름 표시를 검사한다.

기존 비동기 테스트 경합도 고쳤다:
- Usage Stop는 고정 30ms 대신 토큰 적용 완료를 기다린다.
- 보고서 테스트는 task 제거 외에도 thinking 백필 도착을 기다린다.
- 패널 재배치 테스트는 동일 ProviderScope overrides를 재사용한다.
- 휠 테스트는 소켓에 남은 위 방향 메시지와 아래 방향 메시지를 구분해 기다린다.
기대 결과를 약하게 바꾸지 않고 실제 완료 조건·방향·내용을 검증한다.

실제 CLI와 GUI 검증 결과는 T54f/g에 기록한다.
