// ScreenModel — 멤버당 headless 터미널 에뮬레이터(@xterm/headless + serialize 애드온).
// pty 출력을 전부 feed() 하면 (a) attach 용 직렬화 화면, (b) 책상 모니터의 마지막 줄,
// (c) 첫 실행 다이얼로그 감지 + 권장 키, (d) prompt ready 판정의 단일 소스가 된다.
// 화면 문구·키 시퀀스는 src/tui-maps/<engine>-<version>.json 에만 둔다(tuiMap.ts 가 로드).
import xterm from '@xterm/headless';
import serialize from '@xterm/addon-serialize';
import type { Terminal as TerminalType } from '@xterm/headless';
import type { SerializeAddon as SerializeAddonType } from '@xterm/addon-serialize';
import { compileTuiMap, isCompiledTuiMap, loadTuiMap } from './tuiMap.js';
import type { DialogKind, Engine, Key, TuiDialog, TuiMap, TuiMapJson } from './tuiMap.js';

// @xterm/headless 는 CJS 번들이라 named import 가 안 된다(cjs-module-lexer 가 export 를 못 찾음) → default 로 받는다.
const { Terminal } = xterm;
const { SerializeAddon } = serialize;

export type { DialogKind, Engine, Key, TuiDialog, TuiMap, TuiMapJson } from './tuiMap.js';

export interface ScreenModelOptions {
  engine: Engine;
  cols: number;
  rows: number;
  /** 내장 맵 대신 쓸 tui-map(JSON 원본 또는 compileTuiMap 결과). 테스트·버전 덮어쓰기용. */
  tuiMap?: TuiMap | TuiMapJson;
  /** 스크롤백 행 수. attach 시 serialize() 에 포함된다. 기본 xterm 값(1000). */
  scrollback?: number;
}

export interface DialogDetection {
  kind: DialogKind;
  /** 다이얼로그를 통과하기 위해 보낼 키 순서. kind 가 'none' 또는 'approval-prompt' 면 빈 배열(허가 프롬프트는 자동 통과 금지). */
  suggestedKeys: Key[];
  /**
   * 그 다이얼로그의 키가 **현재 강조된 항목**에 따라 갈리는가(tui-map 의 `highlight`). true 면 `suggestedKeys` 는
   * "지금 화면 기준" 이라 확인 키를 붙여 한 번에 보내면 안 된다 — InputQueue 가 이동 키만 먼저 보내고 강조가 원하는
   * 항목에 온 것을 **다시 확인한 뒤** Enter 를 보낸다(T36 실측: Claude 신뢰 다이얼로그는 뜬 직후 한 번 더 렌더되며
   * 선택을 'No, exit' 로 되돌린다 — 그때 ↓+Enter 를 붙여 보내면 CLI 가 exit 1 로 죽는다).
   */
  highlightDriven: boolean;
}

export interface ApprovalPromptDetection {
  /** CLI 자체 허가 프롬프트(예: Claude "Do you want to proceed?", Codex "Would you like to run the following command?")가 떠 있는가. */
  visible: boolean;
  /** 맵의 dialogs[].id. 안 보이면 undefined. */
  id?: string;
  /** 허가 키 순서(보통 ['enter'] = 첫 항목 Yes). 안 보이면 []. */
  allowKeys: Key[];
  /** 거부 키 순서. 안 보이면 []. */
  denyKeys: Key[];
}

export class ScreenModel {
  readonly engine: Engine;
  readonly tuiMap: TuiMap;
  private readonly term: TerminalType;
  private readonly ser: SerializeAddonType;

  constructor(opts: ScreenModelOptions) {
    this.engine = opts.engine;
    this.tuiMap = opts.tuiMap ? (isCompiledTuiMap(opts.tuiMap) ? opts.tuiMap : compileTuiMap(opts.tuiMap)) : loadTuiMap(opts.engine);
    if (this.tuiMap.engine !== opts.engine) throw new Error(`tui-map engine ${this.tuiMap.engine} != ${opts.engine}`);
    this.term = new Terminal({
      cols: opts.cols,
      rows: opts.rows,
      allowProposedApi: true,
      ...(opts.scrollback !== undefined ? { scrollback: opts.scrollback } : {}),
    });
    this.ser = new SerializeAddon();
    this.term.loadAddon(this.ser);
  }

  get cols(): number {
    return this.term.cols;
  }
  get rows(): number {
    return this.term.rows;
  }

  /**
   * pty 출력 투입. xterm 의 write 는 비동기(다음 틱에 파싱)라 화면을 읽기 전에 반드시 await 한다.
   * pty.onData 에서는 await 없이 호출해도 순서는 보존된다(내부 write 버퍼).
   */
  feed(data: string | Uint8Array): Promise<void> {
    return new Promise((resolve) => this.term.write(data, resolve));
  }

  resize(cols: number, rows: number): void {
    this.term.resize(cols, rows);
  }

  /** ANSI 직렬화(스크롤백 + 현재 화면 + 모드). 새 터미널에 그대로 write 하면 같은 화면이 복원된다. */
  serialize(): string {
    return this.ser.serialize();
  }

  /** 현재 보이는 rows 줄(스크롤 끝 기준, 오른쪽 공백 제거). 스크롤백은 포함하지 않는다. */
  lines(): string[] {
    const buf = this.term.buffer.active;
    const out: string[] = [];
    for (let y = 0; y < this.term.rows; y++) out.push(buf.getLine(buf.baseY + y)?.translateToString(true) ?? '');
    return out;
  }

  /** lines() 에서 뒤쪽 빈 줄을 뗀 것. */
  trimmedLines(): string[] {
    const ls = this.lines();
    let n = ls.length;
    while (n > 0 && ls[n - 1].trim() === '') n--;
    return ls.slice(0, n);
  }

  text(): string {
    return this.lines().join('\n');
  }

  /** 아래에서 n 줄(빈 줄 포함, 그대로). */
  lastLines(n: number): string[] {
    if (n <= 0) return [];
    return this.lines().slice(-n);
  }

  /**
   * 책상 모니터용 마지막 줄. 입력 상자(자동 제안 회색 텍스트가 들어 있을 수 있음)와 그 아래 상태줄,
   * 괘선·상태줄 등 skipLines 에 걸리는 줄을 건너뛰고 마지막으로 내용이 있는 줄을 trim 해서 준다.
   */
  lastNonEmptyLine(): string {
    const ls = this.lines();
    const m = this.tuiMap;
    const end = this.inputBoxRow() ?? ls.length;
    for (let i = end - 1; i >= 0; i--) {
      const s = ls[i].trim();
      if (!s) continue;
      if (m.skipLines.some((r) => r.test(ls[i]))) continue;
      return s;
    }
    return '';
  }

  /**
   * 입력 상자의 행 번호(0 기준). 안 보이면 undefined.
   * 입력 상자는 화면 맨 아래에 있으므로: 아래에 빈 줄·skipLines(괘선·상태줄)만 있는, prompt 로 시작하는 줄.
   * Codex 는 지난 프롬프트도 '› ' 로 다시 그리고 메뉴 강조도 '›' 라서 "마지막 › 줄" 만으로는 부족하다.
   * ruleAbove 가 있으면(Claude) 바로 윗줄이 괘선이어야 한다.
   */
  private inputBoxRow(): number | undefined {
    const box = this.tuiMap.inputBox;
    if (!box) return undefined;
    const ls = this.lines();
    const isSkip = (l: string) => l.trim() === '' || this.tuiMap.skipLines.some((r) => r.test(l));
    for (let i = ls.length - 1; i >= 0; i--) {
      if (isSkip(ls[i])) continue;
      if (!box.prompt.test(ls[i])) return undefined; // 맨 아래 내용 줄이 프롬프트가 아니면 입력 상자가 안 보이는 것
      if (box.ruleAbove && !(i > 0 && box.ruleAbove.test(ls[i - 1]))) return undefined;
      return i;
    }
    return undefined;
  }

  /** 화면 전체 텍스트에 dialogs[] 를 순서대로 대어 첫 매치를 준다. */
  private matchDialog(): { dialog: TuiDialog; lines: string[] } | undefined {
    const ls = this.lines();
    const text = ls.join('\n');
    for (const d of this.tuiMap.dialogs) if (d.all.every((r) => r.test(text))) return { dialog: d, lines: ls };
    return undefined;
  }

  /**
   * 다이얼로그 감지. 매치되는 첫 항목을 준다(JSON 순서 = 우선순위).
   * kind 가 'approval-prompt' 면 suggestedKeys 는 항상 [] — InputQueue 가 키를 얹지 않고, 앱은 "재지시 필요" 폴백으로 안내한다.
   * 허가/거부 키는 approvalPrompt() 로 따로 받는다.
   */
  detectDialog(): DialogDetection {
    const m = this.matchDialog();
    if (m) {
      const d = m.dialog;
      const ls = m.lines;
      let keys = d.keys;
      if (d.highlight) {
        const { marker, choices } = d.highlight;
        const hl = ls.find((l) => marker.test(l));
        if (hl !== undefined) {
          const label = hl.replace(marker, '');
          const c = choices.find((c) => c.match.test(label));
          if (c) keys = c.keys;
        }
      }
      return { kind: d.kind, suggestedKeys: d.kind === 'approval-prompt' ? [] : [...keys], highlightDriven: d.highlight !== undefined };
    }
    return { kind: 'none', suggestedKeys: [], highlightDriven: false };
  }

  /**
   * CLI 자체 허가 프롬프트(hook 이 없거나 만료된 뒤의 폴백, D-16) 감지 + 허가/거부 키.
   * 데몬은 이 키를 자동으로 보내지 않는다(정보용). 사용자가 앱에서 "허가"/"거부"를 고르거나 터미널 탭에서 직접 답한다.
   */
  approvalPrompt(): ApprovalPromptDetection {
    const m = this.matchDialog();
    if (!m || m.dialog.kind !== 'approval-prompt') return { visible: false, allowKeys: [], denyKeys: [] };
    return { visible: true, id: m.dialog.id, allowKeys: [...(m.dialog.allowKeys ?? [])], denyKeys: [...(m.dialog.denyKeys ?? [])] };
  }

  /** 작업 중 표시(스피너 줄 또는 "esc to interrupt" 상태줄). */
  busyIndicator(): boolean {
    const ls = this.lines();
    return this.tuiMap.busy.some((r) => ls.some((l) => r.test(l)));
  }

  /** Ctrl+C 후 "Interrupted · What should Claude do instead?" 같은 중단 안내가 보이는가. */
  interrupted(): boolean {
    const ls = this.lines();
    return this.tuiMap.interrupted.some((r) => ls.some((l) => r.test(l)));
  }

  /**
   * 입력 프롬프트가 지시를 받을 수 있는 상태인가.
   * 다이얼로그(허가 프롬프트 포함)가 떠 있거나 작업 중이거나 noneOf(예: Codex 'model: loading')가 보이면 false.
   * 그 외에 화면 하단(뒤쪽 빈 줄 제외 scanLines 줄)에 준비 문구가 있거나, (Codex) 입력줄 아래에 상태줄이 보이면 true.
   */
  promptReady(): boolean {
    if (this.detectDialog().kind !== 'none') return false;
    if (this.busyIndicator()) return false;
    const pr = this.tuiMap.promptReady;
    if (pr.noneOf.length && this.lines().some((l) => pr.noneOf.some((r) => r.test(l)))) return false;
    const bottom = this.trimmedLines().slice(-pr.scanLines);
    if (bottom.some((l) => pr.anyOf.some((r) => r.test(l)))) return true;
    if (pr.inputLine) {
      const { prompt, status, statusWithin } = pr.inputLine;
      for (let i = 0; i < bottom.length; i++) {
        if (!prompt.test(bottom[i])) continue;
        for (let j = i + 1; j <= i + statusWithin && j < bottom.length; j++) if (status.test(bottom[j])) return true;
      }
    }
    return false;
  }

  dispose(): void {
    this.term.dispose();
  }
}
