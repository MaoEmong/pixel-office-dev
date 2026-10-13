# T62 — 후속 전체 실패 경로 점검

재현된 항목은 후속 [T63 수정·검증](T63-RemainingFailureRecovery.md)에서 처리했다. 아래는 수정 전 점검 기록이다.

2026-10-14, 1f15432 기준. 구현 변경 없이 실행 환경·인증·회의/작업·입력·저장/복구·원격 경로를 재검토했다.
실제 사용 데이터와 인증은 건드리지 않았다. in-memory Store, 임시 프로젝트, FakePty, 실패 주입을 사용했다.

## 재현한 잔여 문제

### 1. 회의 소집의 부분 실패 (우선)
Coordinator.open은 meeting을 저장한 다음 requestMissing으로 참석자에게 보낸다.
send 실패를 주입하자 meeting이 남았고 같은 open 재시도는 “이미 소집된 회의” 오류였다.
resume으로 다시 요청할 수는 있지만 최초 오류와 저장 결과가 어긋나며, 일부 참석자만 받은 경우 재개 시 중복 입력 가능성도 있다.
근거: dev/daemon/src/workflow/Coordinator.ts open/requestMissing/speak/resume.
개선: 참석자별 전달 상태와 안정적인 메시지 ID, 실패 시 일관된 재개 안내.

### 2. 계획 확정 뒤 첫 위임 실패로 실행 상태에 정체 (우선)
Coordinator.decide의 delegate 실패를 주입했다. workflow는 executing, assignment는 taskId 없이 queued였다.
같은 decide는 meeting 단계가 아니라서 거부되고 resume도 회의 재개 대상이 아니라서 거부된다.
현재 취소 후 새 논의는 가능하지만 기존 계획의 미전달 업무만 재시도하는 기능은 없다.
개선: dispatch 실패를 blocked로 기록하고 배정 재시도/계속 실행을 제공.

### 3. 업무 생성 뒤 workflow 저장 실패로 연결 누락 (우선)
계획 저장은 성공하고 첫 assignment 저장만 실패하도록 주입했다.
root task 외에 delegate task가 생성됐지만 저장된 workflow assignment의 taskId는 없었다.
따라서 실제 작업과 계획의 연결이 끊기고 해당 보고가 assignment 완료에 반영되지 않을 수 있다.
근거: Coordinator.dispatch의 host.delegate → save 순서. T61 atomic 보호는 discuss/start에 한정된다.
개선: task 생성과 assignment 연결을 같은 트랜잭션으로 처리하고 입력은 commit 이후 전달.

### 4. 실행 중 로그가 이동한 옛 프로젝트 폴더를 다시 생성 (우선)
임시 프로젝트를 이동한 뒤 살아 있는 멤버의 event를 Office에 전달했다.
옛 cwd/.pixel-office/sessions/<member>/events.jsonl이 생성됐다.
새 지시/재시작 검사는 T61에서 막았지만 이벤트 저장은 writeProjectSession의 recursive mkdir를 통해 루트를 재생성한다.
근거: Office.wire / writeProjectSession.
개선: 로그 저장 전 프로젝트 루트 검사, 기록 실패 알림 반복 제한, 경로 복구 안내.

### 5. 제출 실패 작업이 assigned로 보이는 상태 불일치
InputQueue의 idle이 계속 true인 가짜 CLI에서 flushed가 먼저 발생하고, Enter 재시도 소진 후 submitLost가 발생함을 재현했다.
Office는 flushed에서 queued task를 assigned로 바꾸고 submitLost에서는 경고만 표시한다.
실제 모델이 지시를 수락한 상태와 전송 시도 상태를 작업 목록에서 구분하지 못한다.
사용자의 터미널 Enter 복구 안내는 이미 있으므로 완전 무처리는 아니다.
개선: 전달 대기/전달 실패 상태 및 기존 입력을 중복 붙여넣지 않는 재제출 동작.

## 코드로 확인한 공백 (실제 서비스/브라우저 실패 재현과 구분)

### 6. 재요청 중복 보호 범위와 원격 UI의 키 수명
Dart RpcClient는 workflow.discuss/start만 실패 재시도 키를 유지한다. 기타 로컬 변경 RPC는 응답 유실 뒤 다시 호출하면 새 실행이 될 수 있다.
원격 Gateway는 동일 requestId 재전송을 보호하지만 remote-web/app.js mutate는 호출마다 새 UUID를 만든다.
따라서 응답 유실 뒤 버튼을 다시 누르는 것은 동일 요청 재시도로 인식되지 않는다.
항상 중복 생성된다는 뜻은 아니다. approve/start처럼 상태 검사로 차단되는 메서드도 있다.
새 task를 만드는 member.instruct나 workflow.discuss 등은 별도 실패 주입 검증/보호가 필요하다.
개선: 작업 의도별 ID 유지와 결과 확인, 앱 새로고침 뒤 미확정 요청 복원, 메서드별 멱등 처리.

### 7. 장기 사용의 파일 증가와 저장 장애 복구
Store에는 events/pending/tasks 보존 정책이 있다. 그러나 프로젝트 events.jsonl, hook 로그, daemon.log에는 크기 회전 정책이 없고 workflows도 보존 정리에 포함되지 않는다.
Office는 프로젝트 로그 실패를 경고로 알리지만 log.ts fileSink는 한 번 실패하면 복구 후에도 그 프로세스에서 계속 기록을 포기한다.
index.ts의 uncaughtException/unhandledRejection은 콘솔 기록만 하므로 DB/비동기 처리 실패 후 상태 손상 여부를 사용자에게 확실히 알리지 못할 수 있다.
실제 디스크 고갈·전원 차단·DB 손상을 유발하지 않았다. 데이터가 실제 손실됐다고 판단한 것은 아니다.
개선: 로그 회전, 저장 실패 지속 표시와 회복 감지, 일관성 검사 및 백업/복구 절차.

## 기존 보호 및 점검 한계

환경 사전 점검, CLI 연결 폴링, 엔진 사용 정책, 세션/팀 제한, 부팅 시간 초과, 기기 해제/인증, 원격 동일 요청 ID 보호가 존재한다.
이 기능들이 모두 실패한다고 재분류하지 않았다. 실제 CLI 인증 만료·한도/서비스 장애·새 CLI 화면 버전은 실서비스 실패 검증이 남아 있다.
새 PC 전체 설치 및 모바일 실제 조작은 이번 코드/격리 점검에서 반복하지 않았다.

- 로컬 재현: .local/t62-workflow-audit.mts, 모든 assertion 통과 (회의 관련 3건, 경로 1건, 제출 확인 1건).
- 관련 회귀: Workflow/LifecycleGuards/RemoteGateway 13개 통과, 실패 0.
- 테스트 기록: .local/t62-regression.log.
- 실제 CLI 모델 작업 호출 없음. 구현 코드 변경 없음.

권장 수정 순서: 작업-계획 원자성/배정 재시도 → 회의 전달 복구 → 이벤트 경로 보호 → 제출 상태 → 재요청 키 유지 → 저장 용량/장애 복구.
