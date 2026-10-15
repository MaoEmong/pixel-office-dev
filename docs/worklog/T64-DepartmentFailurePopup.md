# T64 — 부서 생성 실패 팝업 안내

- 날짜: 2026-10-16

## 목표와 원인

부서 생성이 실패했을 때 사용자가 원인과 해결 방법을 즉시 확인할 수 있게 한다.
기존 안내는 생성 창의 스크롤 영역 맨 아래에 작은 글씨로 추가되어,
세부 설정을 펼친 상태에서는 화면 아래에 가려질 수 있었다.

## 변경

- `dev/app/lib/topbar/top_bar.dart`: 기존 공통 오류 팝업을 사용해 생성 실패와 폴더 선택 실패를 안내한다.
- 로그인·설치·저장 실패는 전달받은 원인과 해결 안내를 표시한다.
- 연결 끊김과 응답 시간 초과는 쉬운 문장으로 표시하고, 생성 결과가 불확실하므로 부서 목록부터 확인하도록 안내한다.
- 팝업을 닫아도 폴더·이름·엔진·허가 설정을 유지하며 다시 시도할 수 있다.
- `create_department_test.dart`, `top_bar_test.dart`: 팝업 표시, 사용자 화면 크기에서 안내가 보이는지, 입력 보존과 재시도 성공을 검사한다.

## 검증

- 수정 전: 새 검사 6건 실패. 별도 팝업이 존재하지 않음을 확인.
- `flutter test test/command/create_department_test.dart --reporter expanded`: 13건 통과.
- `flutter analyze`: No issues found.
- `flutter test --reporter expanded`: 772건 통과, 1건 건너뜀.
- `git diff --check`: 통과.
- `flutter build windows --release`: 성공. 수정한 앱을 다시 실행하고 창 응답 및 작업 관리 프로그램 시작을 확인했다.

## 범위

부서 생성과 그 창의 폴더 선택 실패 처리를 수정했다. AI 로그인 여부를 판단하는 규칙이나 실제 작업 실행 방식은 변경하지 않았다.
