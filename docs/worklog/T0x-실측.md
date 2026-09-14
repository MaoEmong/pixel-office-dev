# T0x — 실측 0단계 (계획 수립 전 수행)

- 날짜: 2026-09-14
- 마일스톤: (M0 이전)
- 관련 설계: 01 §Next Steps 0
- 커밋: (저장소 초기화는 T00)

## 목표
설계의 "needs verification" 전부를 코드 전에 실측.

## 한 것
`dev/spike-0/`: `pty-claude.js`(pty+hooks+화면), `pty-claude-2.js`(AskUserQuestion·75초 보류·paste·Ctrl+C·resize·/clear), `pty-claude-resume.js`, `pty-codex.js`(신뢰 다이얼로그·hooks·PermissionRequest·resume), `hookprobe.js`(hook 실행 환경 프로브), `orphan-test.js`, `seed-trust.js`, `flutter_term/`(xterm+flutter_pty 렌더 확인).

## 검증
전 항목과 로그 발췌는 [../02-실측-체크리스트.md](../02-실측-체크리스트.md). 원본 로그는 `dev/spike-0/run*.log`, hook 페이로드는 `hooklog*.json`.

## 발견한 함정
02 "결과 요약 → 설계에 반영할 변경" 1~7.

## 결정
D-01, D-03, D-04, D-05, D-07.

## 남은 것
hook timeout 상한, compact 재주입, Codex MCP 주입, Interrupt 페이로드 → 03의 M0/M3.
