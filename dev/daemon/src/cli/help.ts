// 콘솔 도움말 (T38, 직무 체계 rev 3). 트리 순서로 묶어 둔다 —
// **부서 → 지시 → 내 책상 → 일 → 지시문 → 멤버 → 디버그 → 연결**.
//
// 여기 적힌 것이 콘솔의 계약이다. 사용자가 하는 것은 `dept create` 하나이고(D-32),
// 없어진 기능(팀 직접 생성·팀원 직접 출근)은 지운 게 아니라 `force:true` 뒤의 **디버그** 절에 있다(D-34).
// 명령 구현은 `index.ts`, 출력 포맷은 `format.ts`.

export type HelpRow = [usage: string, desc: string];

export interface HelpSection {
  title: string;
  rows: HelpRow[];
}

export const HELP: HelpSection[] = [
  {
    title: '부서·트리 (사용자가 만드는 것은 부서뿐 — D-32)',
    rows: [
      ['dept create <name> <cwd> [claude|codex] [부장이름]', '부서 생성 + 부장 자동 출근 (엔진 기본 claude, 이름 기본 부장)'],
      ['depts', '부서 목록 (부서 = 프로젝트 폴더)'],
      ['dept delete <dept>', '부서 삭제 — 하위 트리 전원(팀원 → 팀장 → 부장)을 잎부터 퇴근시키고 행·task 삭제'],
      ['tree', '부서 → 부장 → 팀/팀장 → 팀원 (department.tree)'],
    ],
  },
  {
    title: '지시·터미널 (지시는 부장에게만)',
    rows: [
      ['say <head> <text...>', '부장에게 지시 → task#n. 팀장·팀원에게 하면 -32004 "부장에게만 지시할 수 있습니다 (head: …)"'],
      ['say! <member> <text...>', '[디버그] 그 게이트를 넘어 직접 지시 (member.instruct{force:true})'],
      ['attach <member>', '현재 화면 출력 + term 스트림 구독 ([term] 접두)'],
      ['detach', 'term 구독 해제'],
      ['type <member> <text>', '터미널에 raw 타이핑. \\n \\r \\t \\e \\xHH 이스케이프, 끝이 \\n/\\r 이 아니면 Enter 자동'],
      ['', '  이스케이프·제어문자만(\\e, \\e\\e, \\e[A, \\x03 …)이면 Enter 를 붙이지 않는다 — ESC 단독 전송용(T19b)'],
      ['int <member>', 'Ctrl+C — 그 턴만 끊는다 (member.interrupt). 하위 트리는 그대로'],
      ['resize <member> <cols> <rows>', '터미널 크기 변경'],
    ],
  },
  {
    title: '내 책상 — 허가·질문',
    rows: [
      ['pending', '열린 허가/질문. ask_parent 질문은 `이음 → 반장(ask_parent)` 으로 **누가 누구에게** 물었는지 찍는다'],
      ['allow <pending>', '허가 (approval.respond allow) — 셸 허가는 직급과 무관하게 전부 사용자 몫이다(D-32)'],
      ['deny <pending> [message]', '거부 (approval.respond deny)'],
      ['answer <pending> <question>=<label> ...', '질문 답 (question.respond). 질문이 하나면 answer <pending> <label>'],
      ['', '  ask_parent 질문에도 먹는다 — 정식은 상사의 reply 도구이고 이쪽은 **상사가 굳었을 때의 오버라이드**(D-37)'],
    ],
  },
  {
    title: '일·이벤트',
    rows: [
      ['tasks', 'task 목록 — `task#n <상태> <발행자>→<대상>: 지시  ↩ <보고상태> 보고` + 열린 ask_parent 건수'],
      ['events [n]', '최근 수신 이벤트 n건 (기본 20)'],
      ['query <부서|-> [beforeSeq] [limit]', '과거 이벤트 조회 (events.query). `-` 면 전체'],
    ],
  },
  {
    title: '지시문',
    rows: [
      ['instr get <member>', '지시문 보기 (사용자 파일만)'],
      ['instr effective <member>', '다음 SessionStart 에 주입될 전체 텍스트 (프리앰블 + 기본 템플릿 포함)'],
      ['instr set <member> [text]', '지시문 편집 (text 생략 시 여러 줄 입력, `.` 한 줄로 종료). 즉시 반영은 restart <member>'],
    ],
  },
  {
    title: '멤버 (퇴근은 비상구 — D-34)',
    rows: [
      ['members', '멤버 목록 (직급 라벨 포함)'],
      ['fire <member>', '**비상 퇴근** (member.clockOut). 확인 프롬프트 y — 부장·팀장이면 **하위 전원**이 잎부터 정리된다'],
      ['rehire <member>', 'exited/error 멤버 재출근 (member.rehire)'],
      ['restart <member>', '지시문 즉시 반영 재시작 (member.restart) — 열린 ask_user/ask_parent 질문은 살아남는다(D-36)'],
    ],
  },
  {
    title: '디버그 (정식 경로는 부장·팀장의 MCP 도구 — force:true 로만 열린다, D-34)',
    rows: [
      ['teams', '팀 목록'],
      ['team create <dept> <name> [claude|codex] [팀장이름]', '[디버그] 팀 생성 + 팀장 자동 출근. 정식은 부장의 create_team'],
      ['team delete <team>', '[디버그] 팀 삭제(팀장·팀원 퇴근). 정식은 부장의 dismiss_team'],
      ['hire <parent> <claude|codex> <name>', '[디버그] 그 상사 아래 직급으로 출근 (member.clockIn{force:true}). 정식은 팀장의 hire'],
    ],
  },
  {
    title: '연결',
    rows: [
      ['refresh', '재접속해 스냅샷을 다시 받는다 (부서·팀 삭제는 데몬이 snapshot 을 밀어 주므로 보통 필요 없다 — T38)'],
      ['reconnect', '끊긴 뒤 자동 재접속이 포기했을 때 다시 붙는다 (백오프 1초→30초, 8회 실패하면 멈춘다 — T30)'],
      ['help', '이 도움말'],
      ['quit', '클라이언트 종료'],
      ['shutdown', '데몬 종료 (daemon.shutdown)'],
    ],
  },
];

/** `help` 와 `--help` 가 함께 쓰는 출력. 절 제목 + `사용법  설명` 두 칸. */
export function helpLines(indent = '  '): string[] {
  const out: string[] = [];
  for (const section of HELP) {
    out.push(`${indent}── ${section.title} ──`);
    for (const [usage, desc] of section.rows) out.push(`${indent}${usage.padEnd(48)} ${desc}`);
    out.push('');
  }
  out.pop();
  return out;
}

/** 첫 토큰으로 쓰는 명령어 전부(테스트·오타 검사용). `dept create` 같은 두 단어는 첫 단어만. */
export function helpCommands(): string[] {
  const out = new Set<string>();
  for (const section of HELP) {
    for (const [usage] of section.rows) {
      const first = usage.split(/\s+/)[0];
      if (first) out.add(first);
    }
  }
  return [...out];
}
