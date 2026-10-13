# T55f — 원격 자동·실 작업 검증

실제 isolated daemon + Claude 부장·팀장 두 명으로 기기 등록, PC 승인, 원격 회의,
Write 승인, 실제 파일 생성, 검토·보고, daemon 재시작 뒤 같은 공개키 인증, 검수 완료,
PC 해제 뒤 접속 거절을 검증했다. opt-in native.integration.test.ts가 140.9초에 통과했다.

Chrome 390x844 검사는 기기 등록·reload·작업·승인·보고·검수, export 불가능 개인키,
작업 데이터의 브라우저 영속 저장 없음, 가로 넘침 없음, offline 해제의 다음 접속 동기화,
새 키 재등록과 PC 해제를 검사한다. 14.4초에 통과했다.
재등록 시 같은 탭의 새 QR fragment도 읽도록 hashchange를 처리했다.
해제 후 숨겨진 보고 DOM·입력·메모리도 비우고 재등록 시 해제 버튼을 다시 활성화했다.

신규 의존성의 첫 기동이 기존 8초 준비 상한을 넘을 수 있어 30초로 조정했다.
10초 느린 기동 테스트 및 Windows release 빌드·실제 자동 기동을 확인했다.
전체 Flutter 병렬 실행에서 기존 터미널 탭 검사가 detach 시간 초과로 한 번 실패했다.
attach 요청 수신 직후 탭을 닫으면 늦은 응답의 보상 detach가 추가되어 정확히 1회를
기다리는 조건이 틀릴 수 있다. 응답 적용까지 기다리도록 테스트를 수정했고 해당 6개가 통과했다.

검증: backend 1203 pass / 16 skip / 0 fail, tsc --noEmit 통과, npm audit 0 vulnerabilities.
Flutter analyze 오류 없음. 전체 Flutter 순차 재검사 748 pass / 1 skip / 0 fail.
다음: PC 앱 및 브라우저 직접 조작 검증.
