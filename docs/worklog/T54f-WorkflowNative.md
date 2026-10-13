# T54f — 실제 CLI와 종료 검증

Claude 2.1.296 부장 + Claude 팀장 2명: 대화 → 명시적 시작 → 두 차례 의견 4건 →
부장 결정 → Write 승인 대기(승인 전 파일 없음) → 승인 → 작성 완료 → 후속 Read 검토 →
부장 report → 검수 대기 → 데몬 재시작 → 동일 sessionId·회의·보고 복원 → 검수 완료.
최종 실기 160초 통과. 두 번의 daemon 종료 코드가 모두 0이고 각 종료 시 CLI PID가 모두 사라짐.
프로젝트 JSON도 completed로 저장된다. 테스트는 workflow.integration.test.ts.

Codex 0.162.0-alpha.17.2 부장 + Claude 팀장 2명에서도 동일 전체 흐름 통과(278초).
종료 수정 후 Codex 부장과 두 팀장을 다시 복원하여 확인용 세션까지 켠 상태로 종료:
종료 코드 0, 8.6초, 세 멤버 PID 모두 사라짐.
Windows는 Node 24.20.0, Flutter 3.44.7.

검사를 강화해 두 가지 종료 경로를 보완했다:
- 확인용 세션·사용량 타이머를 멤버 종료 대기 전에 멈춰 종료 중 새 probe 기동을 막는다.
- 강제 node-pty.kill 뒤 onExit가 같은 native pseudoconsole을 다시 닫지 않도록 구분한다.
- test/pty/conpty-cleanup.test.ts + Lifecycle.test.ts 24개 통과.
수정 뒤 npm test 전체: 1215개 중 1201 통과·14 opt-in skip·실패 0(63초), typecheck 통과.

제한: Windows node-pty의 강제 종료 helper에서 기존 AttachConsole failed stderr가
때때로 찍힌다. 종료 코드 0과 자식 PID 소멸을 별도로 검증했고 작업·복원 결과에는 영향이 없다.
Codex 버전에 정확히 맞는 tui-map이 없어 기존 0.159 map을 사용한다는 진단도 기존 그대로다.
