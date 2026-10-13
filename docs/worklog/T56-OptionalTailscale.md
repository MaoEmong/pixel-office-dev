# T56 — 로컬 기본·Tailscale 선택

오픈소스 배포에서 개발자 도메인·중계 서버·운영 비용을 전제로 하지 않기로 했다.
로컬 기본 동작은 유지하고 외부 접속 UI를 접힌 선택 설정으로 변경했다.
Tailscale Serve(개인 네트워크)와 Funnel(공개 브라우저) 차이, 설치·계정 설정,
실제 로컬 포트를 반영한 명령, HTTPS 주소 입력·QR 등록 절차를 안내한다.
앱은 설치·가입·외부 공개를 자동 실행하지 않는다.

로컬 주소 복귀 RPC와 버튼을 추가했다. publicUrl을 비워 외부 Host/Origin 허용을 제거하고
새 QR 주소를 loopback으로 되돌린다. Tailscale 서비스 중단·기기 접근 폐기는 별도임을 명시했다.
설정 문서 docs/원격접속.md와 설계·README를 갱신했다.
검증: TypeScript typecheck 및 RemoteGateway 회귀 통과(로컬 복귀 저장 검사 포함).
Flutter analyze 오류 없음, 기기 관리·터미널 패널 관련 7개 테스트 통과, Windows release 빌드 성공.
최신 앱을 직접 열어 선택 안내 펼치기, 실제 로컬 주소 명령, 로컬 복귀 버튼 및 오류 없는 상태를 확인했다.
앞선 T55 테스트 수정의 불필요한 import도 analyze 결과에 따라 정리했다.
Tailscale 계정 연결과 외부망 실기는 사용자가 선택 설정한 뒤 진행한다.
