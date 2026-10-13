# T58 — 추가 예측 실패·단일 엔진 사용 점검

코드 검토 결과다. 이 단계에서는 아래 결함을 구현·재현 테스트로 수정하지 않았다.

## 우선 처리

1. 사용 엔진 정책 누락: create_team은 engine을 생략하면 부장 엔진을 사용하지만 다른 엔진의
   명시적 지정도 받는다. 팀원도 팀 허용 목록 안에서 다른 엔진을 지정할 수 있다.
   부장 지시문 scope는 claude/codex 둘 다 허용한다. 결제 여부는 엔진 허용 정책으로 저장되지 않는다.
   사용자 선택 allowedEngines를 부서/전역 정책으로 영속하고 모든 생성·재고용·복구 경로에서 검사해야 한다.
2. 내부 도구 인증 검사 우회: T57 require는 사용자 RPC beforeOperation에 있으며
   MCP create_team/hire는 Office 메서드를 직접 호출한다. 내부 고용도 공통 경계에서 검사해야 한다.
3. 선택 원격 기능 장애가 로컬 기능까지 중단: index.ts에서 remote.listen 실패 시 Office.shutdown을 호출한다.
   7423 포트 충돌·remote-devices.db 오류를 로컬 작업과 분리하고 원격 기능만 실패로 표시해야 한다.
4. 설정 저장 실패가 숨겨짐: FileUiPrefsStore.write는 권한·디스크 오류를 삼킨다.
   '앱을 닫아도 계속 일하기' 등의 설정이 화면에서는 바뀌어도 재시작 후 유지되지 않을 수 있다.
   AppLock도 저장 실패 시 잠금 없이 진행한다. 저장 실패 안내와 다시 저장하는 경로가 필요하다.
5. 멤버 생성 도중 부분 실패: spawnNewMember는 starting 행 생성 뒤 지시문 저장·스폰을 호출한다.
   실패하면 이 함수에서 멤버 상태를 error로 전환하는 처리가 없다. 상위 일부 경로의 rollback과
   직접 hire 경로를 구분해 중간 상태·사용하지 못하는 멤버·미배정 작업을 정리해야 한다.

## 추가 검사 대상으로 남길 것

디스크 부족·프로젝트 폴더 삭제/이동·읽기 전용, 작업 중 인증 만료·사용량 제한·서버 오류,
부서의 팀 수·동시 CLI 수 상한, CLI 버전 변경 시 준비/로그인 화면 인식 실패.
이 항목은 전체 재현/검증을 마친 결함이라는 뜻이 아니라 후속 실패 주입 테스트 대상이다.

권장 순서: 사용 엔진 선택·내부 도구 공통 검사 → 원격 장애 분리 → 설정 저장 실패 안내
→ 멤버 생성 부분 실패 정리 → 제한/디스크/CLI 드리프트 실패 주입.
근거: Office.teamCreateTeam/pickHireEngine/spawnNewMember/templateScope,
index의 remote.listen catch와 RpcServer beforeOperation, FileUiPrefsStore.write/AppLock.acquire.
