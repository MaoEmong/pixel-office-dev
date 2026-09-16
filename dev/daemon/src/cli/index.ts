// pixel-office 콘솔 클라이언트 (T08). 데몬(PROTOCOL.md)에 WebSocket JSON-RPC 로 붙는 REPL.
//
//   npm run cli                                   대화형
//   npm run cli -- --exec "hire t1 claude 하루" --exec "say 하루 안녕" --wait-idle 하루
//                                                 명령을 순서대로 실행 → (선택) 멤버가 idle 될 때까지 대기 → 종료
//   옵션: --url ws://127.0.0.1:7420  --token <t>  --timeout <ms>(wait-idle 상한, 기본 10분)
import readline from 'node:readline';
import type { Member, OfficeEvent, Snapshot, Task, Team } from '../store/types.js';
import { RpcClient, RpcError, readDaemonInfo, daemonInfoPath, type HelloResult } from './RpcClient.js';
import {
  CliError,
  parseAnswerArgs,
  parseArgv,
  parseEngine,
  parseIntArg,
  parseLine,
  resolveMember,
  resolvePendingId,
  resolveTeam,
  typedPayload,
  unescapeTyped,
} from './parse.js';
import {
  detailSummary,
  formatEvent,
  formatMember,
  formatPending,
  formatTask,
  formatTeam,
  fromSnapshotPending,
  questionsOf,
  stripAnsi,
  type LocalPending,
} from './format.js';

const EVENT_BUFFER = 500;
const SPAWN_TIMEOUT_MS = 60_000;

const HELP: Array<[string, string]> = [
  ['teams', '팀 목록'],
  ['team create <name> <cwd> [claude|codex] [팀장이름]', '팀 생성 + 팀장 자동 출근 (엔진 기본 claude, 이름 기본 팀장)'],
  ['team delete <team>', '팀 삭제 (멤버 전원 퇴근)'],
  ['members', '멤버 목록'],
  ['hire <team> <claude|codex> <name>', '멤버 출근 (member.clockIn)'],
  ['fire <member>', '멤버 퇴근 (member.clockOut)'],
  ['rehire <member>', 'exited/error 멤버 재출근 (member.rehire)'],
  ['restart <member>', '지시문 즉시 반영 재시작 (member.restart)'],
  ['say <member> <text...>', '지시 (member.instruct) → taskId 출력. 팀장이 있으면 팀원 지시는 -32004'],
  ['say! <member> <text...>', '팀원 직접 지시 (member.instruct{force:true}) — 디버그용'],
  ['type <member> <text>', '터미널에 raw 타이핑. \\n \\r \\t \\e \\xHH 이스케이프, 끝이 \\n/\\r 이 아니면 Enter 자동'],
  ['', '  이스케이프·제어문자만(\\e, \\e\\e, \\e[A, \\x03 …)이면 Enter 를 붙이지 않는다 — ESC 단독 전송용(T19b)'],
  ['attach <member>', '현재 화면 출력 + term 스트림 구독 ([term] 접두)'],
  ['detach', 'term 구독 해제'],
  ['int <member>', 'Ctrl+C (member.interrupt)'],
  ['resize <member> <cols> <rows>', '터미널 크기 변경'],
  ['pending', '열린 허가/질문 목록'],
  ['allow <pending>', '허가 (approval.respond allow)'],
  ['deny <pending> [message]', '거부 (approval.respond deny)'],
  ['answer <pending> <question>=<label> ...', '질문 답 (question.respond). 질문이 하나면 answer <pending> <label>'],
  ['events [n]', '최근 수신 이벤트 n건 (기본 20)'],
  ['query <team|-> [beforeSeq] [limit]', '과거 이벤트 조회 (events.query)'],
  ['tasks', '스냅샷의 열린 task'],
  ['instr get <member>', '지시문 보기'],
  ['instr set <member> [text]', '지시문 편집 (text 생략 시 여러 줄 입력, `.` 한 줄로 종료)'],
  ['refresh', '재접속해 스냅샷을 다시 받는다'],
  ['help', '이 도움말'],
  ['quit', '클라이언트 종료'],
  ['shutdown', '데몬 종료 (daemon.shutdown)'],
];

interface MultiLine {
  lines: string[];
  done: (text: string) => Promise<void>;
}

class Cli {
  readonly client: RpcClient;
  readonly teams = new Map<string, Team>();
  readonly members = new Map<string, Member>();
  readonly pending = new Map<string, LocalPending>();
  tasks: Task[] = [];
  readonly events: OfficeEvent[] = [];
  attached: string | null = null;
  quitting = false;
  private rl: readline.Interface | null = null;
  private multi: MultiLine | null = null;
  private readonly idleWaiters = new Set<(ev: { memberId: string; kind: 'event' | 'status'; idle: boolean }) => void>();

  constructor(
    private readonly interactive: boolean,
    private readonly opts: { url?: string; token?: string },
  ) {
    this.client = new RpcClient();
    this.wire();
  }

  // ---- 출력 --------------------------------------------------------------------

  print(line = ''): void {
    if (this.rl && this.interactive && this.tty) {
      readline.clearLine(process.stdout, 0);
      readline.cursorTo(process.stdout, 0);
      process.stdout.write(line + '\n');
      this.rl.prompt(true);
    } else {
      process.stdout.write(line + '\n');
    }
  }

  /** 프롬프트·커서 조작은 실제 터미널에서만 (파이프 입력이면 명령을 echo 한다). */
  private readonly tty = Boolean(process.stdin.isTTY && process.stdout.isTTY);

  nameOf = (memberId: string): string => this.members.get(memberId)?.name ?? memberId.slice(0, 8);
  teamNameOf(teamId: string): string {
    return this.teams.get(teamId)?.name ?? teamId;
  }

  // ---- 알림 배선 ---------------------------------------------------------------

  private wire(): void {
    const c = this.client;
    c.on('event', (ev) => this.onEvent(ev));
    c.on('snapshot', (s) => {
      this.applySnapshot(s);
      this.print(`[snapshot] seq=${s.seq} 갱신`);
    });
    c.on('member.status', (n) => {
      const m = this.members.get(n.memberId);
      if (m) m.status = n.status as Member['status'];
      const derived = n.derived ? ` (${n.derived})` : '';
      this.print(`status ${this.nameOf(n.memberId)} → ${n.status}${derived}`);
      for (const w of this.idleWaiters) w({ memberId: n.memberId, kind: 'status', idle: n.status === 'idle' });
    });
    c.on('term', (t) => {
      if (this.attached !== t.memberId) return;
      const text = stripAnsi(t.data);
      for (const line of text.split(/\r?\n/)) if (line.trim()) this.print(`[term] ${line}`);
    });
    c.on('daemon.notice', (n) => this.print(`[daemon:${n.level}] ${n.message}`));
    c.on('error', (e) => this.print(`[client] ${e.message}`));
    c.on('close', (code) => {
      if (this.quitting) return;
      this.print(`[client] 연결 끊김 (code ${code}) — 재접속 시도`);
      void this.reconnect();
    });
  }

  private onEvent(ev: OfficeEvent): void {
    this.events.push(ev);
    if (this.events.length > EVENT_BUFFER) this.events.splice(0, this.events.length - EVENT_BUFFER);
    this.print(formatEvent(ev, this.nameOf));
    const ref = ev.ref ?? {};
    if (ev.kind === 'waiting_approval' && ref.approvalId) {
      this.pending.set(ref.approvalId, {
        id: ref.approvalId,
        memberId: ev.memberId,
        type: 'approval',
        summary: detailSummary(ev.detail),
      });
    } else if (ev.kind === 'asking' && ref.questionId) {
      // TeamTools `ask_user`(T17) 는 `asking{tool:'ask_user', summary:<질문>, options?}` — 스냅샷 payload 와 같은
      // 모양을 만들어 두면 refresh 없이도 `pending` 이 질문·옵션을 찍고 `answer <id> <label>` 이 먹는다.
      const d = ev.detail ?? {};
      const payload =
        d.tool === 'ask_user' && typeof d.summary === 'string'
          ? { source: 'ask_user', question: d.summary, options: Array.isArray(d.options) ? d.options : [] }
          : undefined;
      this.pending.set(ref.questionId, {
        id: ref.questionId,
        memberId: ev.memberId,
        type: 'question',
        summary: detailSummary(ev.detail),
        payload,
      });
    }
    for (const w of this.idleWaiters) w({ memberId: ev.memberId, kind: 'event', idle: ev.kind === 'idle' });
  }

  applySnapshot(s: Snapshot): void {
    this.teams.clear();
    for (const t of s.teams ?? []) this.teams.set(t.id, t);
    this.members.clear();
    for (const m of s.members ?? []) this.members.set(m.id, m);
    this.pending.clear();
    for (const p of s.pending ?? []) this.pending.set(p.id, fromSnapshotPending(p));
    this.tasks = s.tasks ?? [];
  }

  // ---- 접속 ------------------------------------------------------------------------

  async start(): Promise<void> {
    if (!this.opts.token && !readDaemonInfo()) {
      throw new CliError(`데몬 정보가 없습니다: ${daemonInfoPath()} — 데몬이 실행 중인지 확인하세요 (npm start)`);
    }
    const res = await this.client.connectWithRetry({
      url: this.opts.url,
      intervalMs: 1000,
      maxAttempts: 5,
      hello: { token: this.opts.token },
      onAttemptFailed: (n, e) => this.print(`[client] 접속 실패 (${n}/5): ${e.message}`),
    });
    this.applyHello(res);
    this.printSummary(res);
  }

  private applyHello(res: HelloResult): void {
    this.applySnapshot(res.snapshot);
  }

  private async reconnect(): Promise<void> {
    try {
      const res = await this.client.connectWithRetry({ intervalMs: 2000, maxAttempts: 30 });
      this.applyHello(res);
      this.print(`[client] 재접속됨 (seq=${res.snapshot.seq}, since 이후 replay 적용)`);
      if (this.attached) {
        const id = this.attached;
        this.attached = null;
        await this.run(`attach ${id}`); // term 은 replay 되지 않으므로 화면을 다시 받는다
      }
    } catch (e) {
      this.print(`[client] 재접속 실패: ${(e as Error).message}`);
    }
  }

  private printSummary(res: HelloResult): void {
    const s = res.snapshot;
    this.print(`데몬 v${res.daemon.version} (pid ${res.daemon.pid}) 연결됨 — ${this.client.url}  seq=${s.seq}`);
    this.print(`팀 ${this.teams.size}개`);
    for (const t of this.teams.values()) {
      const count = [...this.members.values()].filter((m) => m.teamId === t.id).length;
      this.print('  ' + formatTeam(t, count));
    }
    this.print(`멤버 ${this.members.size}명`);
    for (const m of this.members.values()) this.print('  ' + formatMember(m, this.teamNameOf(m.teamId)));
    this.print(`열린 pending ${this.pending.size}건`);
    for (const p of this.pending.values()) this.print('  ' + formatPending(p, this.nameOf));
    if (this.tasks.length) {
      this.print(`열린 task ${this.tasks.length}건`);
      for (const t of this.tasks) this.print('  ' + formatTask(t, this.nameOf));
    }
    if (this.interactive) this.print(`help 로 명령 목록`);
  }

  // ---- REPL --------------------------------------------------------------------------

  repl(): Promise<void> {
    return new Promise<void>((resolve) => {
      const tty = this.tty;
      const prompt = tty ? 'po> ' : '';
      const rl = readline.createInterface({ input: process.stdin, output: tty ? process.stdout : undefined, prompt });
      this.rl = rl;
      let closed = false;
      let chain = Promise.resolve();
      rl.on('line', (line) => {
        chain = chain.then(async () => {
          if (this.quitting) return;
          if (this.multi) {
            if (line === '.') {
              const m = this.multi;
              this.multi = null;
              rl.setPrompt(prompt);
              await m.done(m.lines.join('\n')).catch((e: unknown) => this.printError(e));
            } else this.multi.lines.push(line);
          } else {
            if (!tty) this.print(`po> ${line}`);
            await this.run(line);
          }
          if (!this.quitting && !closed) rl.prompt();
        });
      });
      rl.on('SIGINT', () => {
        if (this.multi) {
          this.multi = null;
          rl.setPrompt(prompt);
          this.print('(입력 취소)');
          rl.prompt();
          return;
        }
        void this.quit();
      });
      // 파이프 입력은 EOF 직후 close 가 오므로, 아직 처리 중인 줄들 뒤에 quit 을 건다.
      rl.on('close', () => {
        closed = true;
        chain = chain.then(() => this.quit()).then(resolve);
      });
      rl.prompt();
    });
  }

  async quit(): Promise<void> {
    if (this.quitting) return;
    this.quitting = true;
    if (this.attached && this.client.connected) {
      await this.client.call('member.detach', { memberId: this.attached }, 2000).catch(() => {});
    }
    this.client.close();
    this.rl?.close();
    this.rl = null;
  }

  printError(e: unknown): void {
    if (e instanceof RpcError) {
      const data = e.data !== undefined ? ` ${JSON.stringify(e.data)}` : '';
      this.print(`오류 [${e.code}] ${e.message}${data}`);
    } else if (e instanceof CliError) {
      this.print(`오류: ${e.message}`);
    } else {
      this.print(`오류: ${(e as Error)?.stack ?? String(e)}`);
    }
  }

  /** 한 줄 실행. 실패해도 throw 하지 않고 출력만(대화형). 비대화 모드용으로는 성공 여부를 반환. */
  async run(line: string): Promise<boolean> {
    try {
      await this.exec(line);
      return true;
    } catch (e) {
      this.printError(e);
      return false;
    }
  }

  private member(ref: string | undefined): Member {
    if (!ref) throw new CliError('멤버 id 또는 이름이 필요합니다');
    return resolveMember(this.members.values(), ref);
  }

  private async exec(line: string): Promise<void> {
    const p = parseLine(line);
    const { cmd, args } = p;
    const c = this.client;
    switch (cmd) {
      case '':
        return;
      case 'help':
      case '?':
        for (const [usage, desc] of HELP) this.print(`  ${usage.padEnd(44)} ${desc}`);
        return;

      // ---- 팀 ----
      case 'teams':
        if (!this.teams.size) this.print('(팀 없음)');
        for (const t of this.teams.values()) {
          const count = [...this.members.values()].filter((m) => m.teamId === t.id).length;
          this.print(formatTeam(t, count));
        }
        return;
      case 'team': {
        const sub = args[0];
        if (sub === 'create') {
          const [, name, cwd, engine, leaderName] = args;
          if (!name || !cwd) throw new CliError('사용법: team create <name> <cwd> [claude|codex] [팀장이름]');
          const res = (await c.call(
            'team.create',
            { name, cwd, leaderEngine: parseEngine(engine), ...(leaderName ? { leaderName } : {}) },
            SPAWN_TIMEOUT_MS,
          )) as { team: Team; leader?: Member };
          this.teams.set(res.team.id, res.team);
          if (res.leader) this.members.set(res.leader.id, res.leader);
          this.print(`팀 생성: ${formatTeam(res.team, res.leader ? 1 : 0)}`);
          if (res.leader) this.print(`팀장: ${formatMember(res.leader, res.team.name)}`);
          return;
        }
        if (sub === 'delete') {
          const team = resolveTeam(this.teams.values(), args[1] ?? '');
          await c.call('team.delete', { teamId: team.id }, SPAWN_TIMEOUT_MS);
          this.teams.delete(team.id);
          for (const m of [...this.members.values()]) if (m.teamId === team.id) this.members.delete(m.id);
          this.print(`팀 삭제: ${team.name}`);
          return;
        }
        throw new CliError('사용법: team create <name> <cwd> [claude|codex] [팀장이름] | team delete <team>');
      }

      // ---- 멤버 ----
      case 'members':
        if (!this.members.size) this.print('(멤버 없음)');
        for (const m of this.members.values()) this.print(formatMember(m, this.teamNameOf(m.teamId)));
        return;
      case 'hire': {
        const [teamRef, engine, name] = args;
        if (!teamRef || !engine || !name) throw new CliError('사용법: hire <team> <claude|codex> <name>');
        const team = resolveTeam(this.teams.values(), teamRef);
        const res = (await c.call(
          'member.clockIn',
          { teamId: team.id, engine: parseEngine(engine), name },
          SPAWN_TIMEOUT_MS,
        )) as { member: Member };
        this.members.set(res.member.id, res.member);
        this.print(`출근: ${formatMember(res.member, team.name)}`);
        return;
      }
      case 'fire': {
        const m = this.member(args[0]);
        await c.call('member.clockOut', { memberId: m.id }, SPAWN_TIMEOUT_MS);
        this.print(`퇴근: ${m.name} (${m.id})`);
        return;
      }
      case 'rehire':
      case 'restart': {
        const m = this.member(args[0]);
        const res = (await c.call(cmd === 'rehire' ? 'member.rehire' : 'member.restart', { memberId: m.id }, SPAWN_TIMEOUT_MS)) as {
          member: Member;
        };
        this.members.set(res.member.id, res.member);
        this.print(`${cmd === 'rehire' ? '재출근' : '재시작'}: ${formatMember(res.member, this.teamNameOf(res.member.teamId))}`);
        return;
      }
      // 팀장이 있는 팀에서 팀원에게 say 하면 데몬이 -32004 를 돌려준다(T24) — printError 가
      // `오류 [-32004] 팀장에게만 지시할 수 있습니다 (leader: …)` 로 그대로 보여준다. `say!` 는 그 게이트를 넘는 디버그용.
      case 'say':
      case 'say!': {
        const m = this.member(args[0]);
        const text = p.rawAfter(1).trim();
        if (!text) throw new CliError(`사용법: ${cmd} <member> <text...>`);
        const force = cmd === 'say!';
        const res = (await c.call('member.instruct', { memberId: m.id, text, ...(force ? { force: true } : {}) })) as {
          taskId: number | string;
        };
        this.print(`task#${res.taskId} → ${m.name}${force ? ' (force)' : ''}`);
        return;
      }
      case 'type': {
        const m = this.member(args[0]);
        const raw = p.rawAfter(1);
        if (!raw) throw new CliError('사용법: type <member> <text>');
        await c.call('member.type', { memberId: m.id, data: typedPayload(raw) });
        return;
      }
      case 'attach': {
        const m = this.member(args[0]);
        if (this.attached && this.attached !== m.id) {
          await c.call('member.detach', { memberId: this.attached }).catch(() => {});
        }
        const cols = process.stdout.columns || 120;
        const rows = process.stdout.rows || 40;
        const res = (await c.call('member.attach', { memberId: m.id, cols, rows })) as {
          screen: string;
          cols: number;
          rows: number;
        };
        this.attached = m.id;
        this.print(`── ${m.name} 화면 (${res.cols}x${res.rows}) ──`);
        for (const line of stripAnsi(res.screen ?? '').split(/\r?\n/)) this.print(`[screen] ${line}`);
        this.print(`── 이후 [term] 로 스트림 (detach 로 해제) ──`);
        return;
      }
      case 'detach': {
        if (!this.attached) throw new CliError('attach 된 멤버가 없습니다');
        const id = this.attached;
        this.attached = null;
        await c.call('member.detach', { memberId: id });
        this.print(`detach: ${this.nameOf(id)}`);
        return;
      }
      case 'int': {
        const m = this.member(args[0]);
        await c.call('member.interrupt', { memberId: m.id });
        this.print(`interrupt → ${m.name}`);
        return;
      }
      case 'resize': {
        const m = this.member(args[0]);
        const cols = parseIntArg(args[1], 'cols');
        const rows = parseIntArg(args[2], 'rows');
        await c.call('member.resize', { memberId: m.id, cols, rows });
        this.print(`resize ${m.name} → ${cols}x${rows}`);
        return;
      }

      // ---- pending ----
      case 'pending':
        if (!this.pending.size) this.print('(열린 pending 없음)');
        for (const pd of this.pending.values()) {
          this.print(formatPending(pd, this.nameOf));
          for (const q of questionsOf(pd.payload)) this.print(`    Q: ${q.question}  → ${q.options.join(' | ')}`);
        }
        return;
      case 'allow':
      case 'deny': {
        const id = resolvePendingId(this.pending.keys(), args[0] ?? '');
        const params: Record<string, unknown> = { pendingId: id, behavior: cmd };
        const message = p.rawAfter(1).trim();
        if (cmd === 'deny' && message) params.message = message;
        await c.call('approval.respond', params);
        this.pending.delete(id);
        this.print(`${cmd}: ${id}`);
        return;
      }
      case 'answer': {
        const id = resolvePendingId(this.pending.keys(), args[0] ?? '');
        const pd = this.pending.get(id)!;
        const parsed = parseAnswerArgs(args.slice(1));
        let answers: Record<string, string>;
        if ('pairs' in parsed) answers = parsed.pairs;
        else {
          const qs = questionsOf(pd.payload);
          if (qs.length !== 1) {
            throw new CliError(
              qs.length === 0
                ? `질문 원문을 모릅니다(이벤트로만 알게 된 pending). answer ${id} <question>=<label> 형식을 쓰거나 refresh 후 다시 시도`
                : `질문이 ${qs.length}개입니다. answer ${id} <question>=<label> ... 형식으로`,
            );
          }
          answers = { [qs[0]!.question]: parsed.single };
        }
        await c.call('question.respond', { pendingId: id, answers });
        this.pending.delete(id);
        this.print(`answer: ${id} ${JSON.stringify(answers)}`);
        return;
      }

      // ---- 이벤트 ----
      case 'events': {
        const n = parseIntArg(args[0], 'n', 20);
        const slice = this.events.slice(-n);
        if (!slice.length) this.print('(수신한 이벤트 없음)');
        for (const ev of slice) this.print(formatEvent(ev, this.nameOf));
        return;
      }
      case 'query': {
        const params: Record<string, unknown> = {};
        if (args[0] && args[0] !== '-') params.teamId = resolveTeam(this.teams.values(), args[0]).id;
        if (args[1] !== undefined) params.beforeSeq = parseIntArg(args[1], 'beforeSeq');
        if (args[2] !== undefined) params.limit = parseIntArg(args[2], 'limit');
        const res = (await c.call('events.query', params)) as { events: OfficeEvent[] };
        if (!res.events?.length) this.print('(이벤트 없음)');
        for (const ev of res.events ?? []) this.print(formatEvent(ev, this.nameOf));
        return;
      }
      case 'tasks':
        if (!this.tasks.length) this.print('(열린 task 없음 — 스냅샷 기준)');
        for (const t of this.tasks) this.print(formatTask(t, this.nameOf));
        return;

      // ---- 지시문 ----
      case 'instr': {
        const sub = args[0];
        const m = this.member(args[1]);
        if (sub === 'get') {
          const res = (await c.call('member.instructions.get', { memberId: m.id })) as { markdown: string };
          this.print(`── ${m.name} 지시문 ──`);
          for (const line of (res.markdown ?? '').split(/\r?\n/)) this.print(`  ${line}`);
          this.print('──');
          return;
        }
        if (sub === 'set') {
          const inline = p.rawAfter(2);
          const save = async (markdown: string): Promise<void> => {
            await c.call('member.instructions.set', { memberId: m.id, markdown });
            this.print(`지시문 저장: ${m.name} (${markdown.length}자) — 다음 SessionStart 부터 반영, 즉시는 restart ${m.name}`);
          };
          if (inline.trim()) return save(unescapeTyped(inline));
          if (!this.interactive) throw new CliError('비대화 모드에서는 instr set <member> <text> 로 본문을 같이 주세요');
          this.print(`지시문 입력 (${m.name}). 마침표 한 줄(.)로 종료, Ctrl+C 취소`);
          this.multi = { lines: [], done: save };
          this.rl?.setPrompt('... ');
          return;
        }
        throw new CliError('사용법: instr get <member> | instr set <member> [text]');
      }

      // ---- 연결 ----
      case 'refresh': {
        this.client.close();
        const res = await this.client.connectWithRetry({ intervalMs: 1000, maxAttempts: 5 });
        this.applyHello(res);
        this.printSummary(res);
        return;
      }
      case 'quit':
      case 'exit':
        await this.quit();
        return;
      case 'shutdown':
        await c.call('daemon.shutdown', {});
        this.print('데몬 종료 요청됨');
        return;
      default:
        throw new CliError(`알 수 없는 명령: ${cmd} (help)`);
    }
  }

  // ---- 비대화 모드 ----------------------------------------------------------------

  /**
   * 멤버의 다음 idle(Stop 이벤트 또는 status→idle)까지 대기.
   * 지금 idle/starting 로 보이면(예: `say` 직후 아직 타이핑 전) 먼저 working 을 한 번 본 뒤의 idle 만 인정한다 —
   * 출근 직후의 늦은 idle 알림 같은 stale idle 에 속지 않기 위해. 이미 working/waiting 이면 다음 idle 을 바로 인정.
   */
  waitIdle(ref: string, timeoutMs: number): Promise<void> {
    const m = this.member(ref);
    let needBusy = m.status === 'idle' || m.status === 'starting';
    this.print(`[wait-idle] ${m.name} 의 ${needBusy ? 'working → ' : ''}idle 대기 (최대 ${timeoutMs}ms)`);
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.idleWaiters.delete(waiter);
        reject(new CliError(`wait-idle 시간 초과: ${m.name}`));
      }, timeoutMs);
      const waiter = (n: { memberId: string; kind: 'event' | 'status'; idle: boolean }): void => {
        if (n.memberId !== m.id) return;
        if (!n.idle) {
          needBusy = false;
          return;
        }
        if (needBusy) return;
        clearTimeout(timer);
        this.idleWaiters.delete(waiter);
        this.print(`[wait-idle] ${m.name} idle (${n.kind})`);
        resolve();
      };
      this.idleWaiters.add(waiter);
    });
  }
}

async function main(): Promise<number> {
  let argv;
  try {
    argv = parseArgv(process.argv.slice(2));
  } catch (e) {
    console.error((e as Error).message);
    return 2;
  }
  if (argv.help) {
    console.log('사용법: npm run cli [-- --exec "<명령>" ... --wait-idle <member> --url <ws://> --token <t> --timeout <ms>]');
    for (const [usage, desc] of HELP) console.log(`  ${usage.padEnd(44)} ${desc}`);
    return 0;
  }
  const interactive = argv.exec.length === 0 && !argv.waitIdle;
  const cli = new Cli(interactive, { url: argv.url, token: argv.token });
  try {
    await cli.start();
  } catch (e) {
    cli.printError(e);
    cli.client.close();
    return 1;
  }
  if (interactive) {
    await cli.repl();
    return 0;
  }
  let code = 0;
  for (const line of argv.exec) {
    cli.print(`po> ${line}`);
    if (!(await cli.run(line))) {
      code = 1;
      break;
    }
  }
  if (code === 0 && argv.waitIdle) {
    try {
      await cli.waitIdle(argv.waitIdle, argv.timeoutMs);
    } catch (e) {
      cli.printError(e);
      code = 1;
    }
  }
  await cli.quit();
  return code;
}

main().then(
  (code) => process.exit(code),
  (e) => {
    console.error(e);
    process.exit(1);
  },
);
