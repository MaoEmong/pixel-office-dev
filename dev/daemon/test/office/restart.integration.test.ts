// T09 통합 테스트(opt-in): 실제 데몬을 죽였다 켜서 Claude 멤버가 `--resume` 으로 이어지는지 본다.
//   데몬#1: team.create(sandbox) → clockIn(claude) → instruct "한 줄로 인사해줘" → idle
//   process.kill(데몬#1) (하드 킬 — daemon.json 이 남고 멤버 status 는 idle 그대로)
//   데몬#2(같은 dataDir): stdout 의 "[office] 복구: …" → hello{since} → 멤버 재스폰 확인 → [RESUMED] 턴 종료 대기
//   → member.attach 화면에 이전 대화가 보이는지 → instruct "아까 뭐라고 인사했는지 한 줄로" → text 이벤트가 앞 인사를 언급하는지
//   → clockOut → daemon.shutdown
// 실행: PIXEL_IT=1 npx tsx --test test/office/restart.integration.test.ts   (bash)
// 전제: dev/spike-0/sandbox 가 신뢰된 폴더이고 claude 로그인이 끝나 있다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import type { DaemonInfo } from '../../src/office/types.js';
import type { Member, OfficeEvent, Snapshot, Team } from '../../src/store/types.js';

const IT = process.env.PIXEL_IT === '1';
const DAEMON_DIR = path.resolve(import.meta.dirname, '..', '..');
const SANDBOX = path.resolve(DAEMON_DIR, '..', 'spike-0', 'sandbox');
const GREET = '한 줄로 인사해줘';
const RECALL = '아까 뭐라고 인사했는지 한 줄로';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as net.AddressInfo).port;
      srv.close(() => resolve(port));
    });
  });
}

interface Notification {
  method: string;
  params: Record<string, unknown>;
}

class Client {
  private nextId = 1;
  private readonly waiting = new Map<number, { resolve: (v: unknown) => void; reject: (e: unknown) => void }>();
  readonly notifications: Notification[] = [];
  private readonly waiters: Array<{ pred: (n: Notification) => boolean; resolve: (n: Notification) => void }> = [];
  lastSeq = 0;

  private constructor(
    readonly ws: WebSocket,
    readonly tag: string,
  ) {
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString()) as Record<string, unknown>;
      if (typeof msg.method === 'string') {
        const n = { method: msg.method, params: (msg.params ?? {}) as Record<string, unknown> };
        this.notifications.push(n);
        if (n.method === 'event') {
          const e = n.params as unknown as OfficeEvent;
          this.lastSeq = Math.max(this.lastSeq, e.seq);
          console.log(`[IT:${tag}] event #${e.seq} ${e.kind} ${JSON.stringify(e.detail).slice(0, 160)}`);
        } else if (n.method === 'member.status') {
          console.log(`[IT:${tag}] status ${String(n.params.status)} (${String(n.params.derived)})`);
        } else if (n.method === 'daemon.notice') {
          console.log(`[IT:${tag}] notice ${String(n.params.level)}: ${String(n.params.message)}`);
        }
        for (const w of [...this.waiters]) {
          if (w.pred(n)) {
            this.waiters.splice(this.waiters.indexOf(w), 1);
            w.resolve(n);
          }
        }
        return;
      }
      const w = this.waiting.get(msg.id as number);
      if (!w) return;
      this.waiting.delete(msg.id as number);
      if (msg.error) w.reject(new Error(`rpc error ${JSON.stringify(msg.error)}`));
      else w.resolve(msg.result);
    });
  }

  static connect(port: number, tag: string): Promise<Client> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}`);
      ws.once('open', () => resolve(new Client(ws, tag)));
      ws.once('error', reject);
    });
  }

  call<T>(method: string, params: unknown): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.waiting.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
    });
  }

  waitFor(what: string, pred: (n: Notification) => boolean, timeoutMs: number): Promise<Notification> {
    const hit = this.notifications.find(pred);
    if (hit) return Promise.resolve(hit);
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`timeout waiting for ${what}`)), timeoutMs);
      this.waiters.push({
        pred,
        resolve: (n) => {
          clearTimeout(t);
          resolve(n);
        },
      });
    });
  }

  waitEvent(memberId: string, kind: OfficeEvent['kind'], afterSeq: number, timeoutMs: number, extra?: (e: OfficeEvent) => boolean): Promise<OfficeEvent> {
    return this.waitFor(
      `event ${kind} after #${afterSeq}`,
      (n) => {
        if (n.method !== 'event') return false;
        const e = n.params as unknown as OfficeEvent;
        return e.memberId === memberId && e.kind === kind && e.seq > afterSeq && (extra ? extra(e) : true);
      },
      timeoutMs,
    ).then((n) => n.params as unknown as OfficeEvent);
  }

  waitStatus(memberId: string, status: string, timeoutMs: number): Promise<void> {
    return this.waitFor(`status ${status}`, (n) => n.method === 'member.status' && n.params.memberId === memberId && n.params.status === status, timeoutMs).then(
      () => undefined,
    );
  }

  close(): void {
    this.ws.close();
  }
}

interface Daemon {
  child: ChildProcess;
  lines: string[];
  waitLine(what: string, pred: (line: string) => boolean, timeoutMs: number): Promise<string>;
}

function startDaemon(tag: string, env: Record<string, string>): Daemon {
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
    cwd: DAEMON_DIR,
    env: { ...process.env, ...env, PIXEL_IT: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const lines: string[] = [];
  const waiters: Array<{ pred: (l: string) => boolean; resolve: (l: string) => void }> = [];
  const onLine = (prefix: string) => (buf: Buffer) => {
    for (const line of buf.toString().split(/\r?\n/)) {
      if (!line) continue;
      console.log(`${prefix} ${line}`);
      lines.push(line);
      for (const w of [...waiters]) {
        if (w.pred(line)) {
          waiters.splice(waiters.indexOf(w), 1);
          w.resolve(line);
        }
      }
    }
  };
  child.stdout!.on('data', onLine(`[${tag}:out]`));
  child.stderr!.on('data', onLine(`[${tag}:err]`));
  return {
    child,
    lines,
    waitLine(what, pred, timeoutMs) {
      const hit = lines.find(pred);
      if (hit) return Promise.resolve(hit);
      return new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error(`timeout waiting for ${what} (${tag})`)), timeoutMs);
        const onExit = () => reject(new Error(`${tag} exited (code ${child.exitCode}) before ${what}`));
        child.once('exit', onExit);
        waiters.push({
          pred,
          resolve: (l) => {
            clearTimeout(t);
            child.off('exit', onExit);
            resolve(l);
          },
        });
      });
    },
  };
}

function waitExit(child: ChildProcess, ms: number): Promise<boolean> {
  if (child.exitCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(false), ms);
    child.once('exit', () => {
      clearTimeout(t);
      resolve(true);
    });
  });
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function killTree(pid: number): void {
  try {
    if (process.platform === 'win32') spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    else process.kill(pid, 'SIGKILL');
  } catch {
    // 이미 죽음
  }
}

/**
 * 이 테스트가 띄운 claude 만 골라 죽인다: 데몬이 `--settings <dataDir>/…` 로 스폰하므로 명령줄에 dataDir 이 들어 있다.
 * (이 머신의 다른 claude.exe 는 건드리지 않는다.) win32 전용, 그 외는 pid 목록만.
 */
function sweepClaudeByDataDir(dataDir: string, known: number[]): number[] {
  const killed: number[] = [];
  if (process.platform === 'win32') {
    const pattern = dataDir.replace(/'/g, "''");
    const ps = `Get-CimInstance Win32_Process -Filter "Name='claude.exe'" | Where-Object { $_.CommandLine -like '*${pattern}*' } | Select-Object -ExpandProperty ProcessId`;
    const out = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], { encoding: 'utf8', windowsHide: true, timeout: 20_000 });
    for (const line of (out.stdout ?? '').split(/\r?\n/)) {
      const pid = Number(line.trim());
      if (Number.isInteger(pid) && pid > 0) {
        killTree(pid);
        killed.push(pid);
      }
    }
  }
  for (const pid of known) {
    if (pidAlive(pid)) {
      killTree(pid);
      killed.push(pid);
    }
  }
  return killed;
}

/** ANSI/제어 시퀀스를 걷어낸 화면 평문. */
function stripAnsi(s: string): string {
  return s
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
    .replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, '')
    .replace(/\x1b[()][A-Za-z0-9]/g, '')
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '');
}

/** 두 문장이 같은 인사를 가리키는지: 인사말의 2글자 이상 토큰 중 하나라도 회상문에 있으면 참. */
function sharesToken(greeting: string, recall: string): { ok: boolean; tokens: string[]; hits: string[] } {
  const tokens = greeting
    .replace(/[\p{P}\p{S}]/gu, ' ')
    .split(/\s+/)
    .filter((t) => t.length >= 2);
  const hits = tokens.filter((t) => recall.includes(t));
  return { ok: hits.length > 0, tokens, hits };
}

test('real daemon restart: greet → kill daemon → new daemon resumes member → screen shows prior chat → recalls greeting → clockOut → shutdown', { skip: IT ? false : 'set PIXEL_IT=1 to run', timeout: 480_000 }, async () => {
  assert.ok(fs.existsSync(SANDBOX), `sandbox missing: ${SANDBOX}`);
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pixel-office-t09-it-'));
  const wsPort = await freePort();
  const hookPort = await freePort();
  // T17: TeamTools MCP 도 임시 포트로 — 기본 7422 에 진짜 데몬이 떠 있으면 start() 가 EADDRINUSE 로 죽는다.
  const mcpPort = await freePort();
  const env = { PIXEL_WS_PORT: String(wsPort), PIXEL_HOOK_PORT: String(hookPort), PIXEL_MCP_PORT: String(mcpPort), PIXEL_DATA_DIR: dataDir };
  const claudePids: number[] = [];
  const daemons: Daemon[] = [];
  let client1: Client | undefined;
  let client2: Client | undefined;
  const t0 = Date.now();
  const el = () => `${Date.now() - t0}ms`;

  try {
    // ---- 데몬 #1: 출근 → 인사 ----------------------------------------------------------------
    const d1 = startDaemon('d1', env);
    daemons.push(d1);
    await d1.waitLine('listening', (l) => l.includes('[daemon] listening'), 20_000);
    const info1 = JSON.parse(fs.readFileSync(path.join(dataDir, 'daemon.json'), 'utf8')) as DaemonInfo;
    assert.equal(info1.pid, d1.child.pid);
    client1 = await Client.connect(info1.wsPort, 'c1');
    const hello1 = await client1.call<{ daemon: { pid: number }; snapshot: Snapshot }>('hello', { token: info1.token, client: { name: 't09-it', version: '0' } });
    assert.equal(hello1.daemon.pid, d1.child.pid);
    console.log(`[IT] d1 hello ok (${el()}) snapshot.seq=${hello1.snapshot.seq}`);

    const { team } = await client1.call<{ team: Team }>('team.create', { name: 'it', cwd: SANDBOX, leaderEngine: 'claude' });
    const { member } = await client1.call<{ member: Member }>('member.clockIn', { teamId: team.id, engine: 'claude', name: 'tester' });
    if (member.childPid) claudePids.push(member.childPid);
    console.log(`[IT] clockIn member=${member.id} pid=${member.childPid} (${el()})`);
    await client1.waitStatus(member.id, 'idle', 90_000);
    console.log(`[IT] idle (SessionStart) ${el()}`);

    const seqBeforeGreet = client1.lastSeq;
    const { taskId: greetTask } = await client1.call<{ taskId: number }>('member.instruct', { memberId: member.id, text: GREET });
    const greetText = await client1.waitEvent(member.id, 'text', seqBeforeGreet, 180_000, (e) => typeof e.detail.text === 'string');
    const greeting = String(greetText.detail.text);
    await client1.waitEvent(member.id, 'idle', greetText.seq, 60_000);
    console.log(`[IT] greeting (task#${greetTask}) ${el()}: ${JSON.stringify(greeting)}`);
    assert.ok(greeting.trim().length > 0, 'greeting text');

    // 죽기 직전의 멤버 행(session_id·child_pid)
    const peek = await Client.connect(info1.wsPort, 'peek');
    const snap1 = (await peek.call<{ snapshot: Snapshot }>('hello', { token: info1.token, client: { name: 'peek', version: '0' } })).snapshot;
    peek.close();
    const before = snap1.members.find((m) => m.id === member.id)!;
    console.log(`[IT] before kill: status=${before.status} session_id=${before.sessionId} child_pid=${before.childPid}`);
    assert.equal(before.status, 'idle');
    assert.ok(before.sessionId, 'session_id recorded by SessionStart');
    const seqBeforeKill = client1.lastSeq;

    // ---- 데몬 #1 하드 킬 -------------------------------------------------------------------------
    client1.close();
    client1 = undefined;
    process.kill(d1.child.pid!);
    const d1Exited = await waitExit(d1.child, 10_000);
    console.log(`[IT] d1 killed: exited=${d1Exited} code=${d1.child.exitCode} signal=${d1.child.signalCode} (${el()})`);
    assert.ok(d1Exited, 'daemon #1 did not die');
    await sleep(1500);
    // 설계 전제(데몬이 죽으면 ConPTY 자식도 죽는다)는 하드 킬에서 깨진다(T09 실측: 살아남음) → 데몬#2 의 복구가 유령을 정리해야 한다.
    const claude1Alive = before.childPid ? pidAlive(before.childPid) : false;
    console.log(`[IT] claude#1 pid ${before.childPid} alive after daemon death: ${claude1Alive}`);
    assert.ok(fs.existsSync(path.join(dataDir, 'daemon.json')), 'hard kill leaves daemon.json behind');

    // ---- 데몬 #2: 복구 -------------------------------------------------------------------------
    const d2 = startDaemon('d2', env);
    daemons.push(d2);
    const recoveryLine = await d2.waitLine('recovery notice', (l) => /\[office\] 복구: \d+명 재개/.test(l), 30_000);
    console.log(`[IT] recovery notice (${el()}): ${recoveryLine}`);
    assert.match(recoveryLine, /복구: 1명 재개, 0건 만료/);
    if (claude1Alive) {
      assert.match(recoveryLine, /유령 1개 정리/);
      await sleep(500);
      assert.ok(!pidAlive(before.childPid!), `orphan claude pid ${before.childPid} must be dead after recovery`);
      console.log(`[IT] orphan claude#1 pid ${before.childPid} killed by recovery: ${!pidAlive(before.childPid!)}`);
    }
    await d2.waitLine('listening', (l) => l.includes('[daemon] listening'), 20_000);
    const info2 = JSON.parse(fs.readFileSync(path.join(dataDir, 'daemon.json'), 'utf8')) as DaemonInfo;
    assert.equal(info2.pid, d2.child.pid);
    assert.notEqual(info2.token, info1.token);

    client2 = await Client.connect(info2.wsPort, 'c2');
    const hello2 = await client2.call<{ daemon: { pid: number }; snapshot: Snapshot }>('hello', { token: info2.token, since: seqBeforeKill, client: { name: 't09-it', version: '0' } });
    assert.equal(hello2.daemon.pid, d2.child.pid);
    const after = hello2.snapshot.members.find((m) => m.id === member.id)!;
    console.log(`[IT] after restart: status=${after.status} session_id=${after.sessionId} child_pid=${after.childPid} (${el()})`);
    assert.ok(['starting', 'idle', 'working'].includes(after.status), `member respawned, status=${after.status}`);
    assert.ok(after.childPid && after.childPid !== before.childPid, 'new child pid');
    assert.ok(pidAlive(after.childPid!), 'resumed claude is alive');
    claudePids.push(after.childPid!);
    assert.equal(after.sessionId, before.sessionId, 'session_id kept for --resume');
    assert.equal(hello2.snapshot.pending.length, 0);
    assert.deepEqual(hello2.snapshot.tasks, [], 'no open tasks (greeting task was reported before the kill)');

    // SessionStart(source=resume) → text{summary:'resumed'} (replay 또는 실시간)
    const resumedEv = await client2.waitEvent(member.id, 'text', seqBeforeKill, 90_000, (e) => e.detail.summary === 'resumed');
    console.log(`[IT] resumed event #${resumedEv.seq} (${el()})`);

    // [RESUMED] 턴: thinking 이 [RESUMED] 로 시작 → idle
    const resumedTurn = await client2.waitEvent(member.id, 'thinking', resumedEv.seq, 120_000, (e) => String(e.detail.text ?? '').startsWith('[RESUMED]'));
    console.log(`[IT] [RESUMED] typed (${el()}): ${String(resumedTurn.detail.text)}`);
    const resumedIdle = await client2.waitEvent(member.id, 'idle', resumedTurn.seq, 180_000);
    const resumedReply = client2.notifications
      .map((n) => n.params as unknown as OfficeEvent)
      .find((e) => e.kind === 'text' && e.seq > resumedTurn.seq && e.seq < resumedIdle.seq && typeof e.detail.text === 'string');
    console.log(`[IT] reply to [RESUMED] (${el()}): ${JSON.stringify(resumedReply?.detail.text ?? null)}`);

    // 터미널 화면에 이전 대화가 보인다
    const attach = await client2.call<{ screen: string; cols: number; rows: number }>('member.attach', { memberId: member.id, cols: 120, rows: 40 });
    const plain = stripAnsi(attach.screen);
    const greetingTokens = sharesToken(greeting, plain);
    console.log(`[IT] attach screen=${attach.screen.length} bytes; has instruction=${plain.includes(GREET)} greeting tokens hit=${JSON.stringify(greetingTokens.hits)}`);
    console.log(`[IT] screen tail:\n${plain.split('\n').filter((l) => l.trim()).slice(-25).join('\n')}`);
    assert.ok(plain.includes(GREET) || greetingTokens.ok, 'screen shows the conversation from before the restart');

    // 회상: 앞 인사를 언급해야 한다
    const seqBeforeRecall = client2.lastSeq;
    await client2.call('member.instruct', { memberId: member.id, text: RECALL });
    const recallText = await client2.waitEvent(member.id, 'text', seqBeforeRecall, 180_000, (e) => typeof e.detail.text === 'string');
    await client2.waitEvent(member.id, 'idle', recallText.seq, 60_000);
    const recall = String(recallText.detail.text);
    const cmp = sharesToken(greeting, recall);
    console.log(`[IT] recall (${el()}): ${JSON.stringify(recall)}\n[IT] greeting tokens=${JSON.stringify(cmp.tokens)} hits=${JSON.stringify(cmp.hits)}`);
    assert.ok(cmp.ok, `recall should reference the earlier greeting\n greeting: ${greeting}\n recall: ${recall}`);

    // ---- 정리 ------------------------------------------------------------------------------------
    await client2.call('member.clockOut', { memberId: member.id });
    await client2.waitStatus(member.id, 'exited', 20_000);
    console.log(`[IT] clockOut done (${el()}); claude#2 alive=${pidAlive(after.childPid!)}`);
    await client2.call('daemon.shutdown', {});
    const d2Exited = await waitExit(d2.child, 20_000);
    console.log(`[IT] d2 exited=${d2Exited} code=${d2.child.exitCode} (${el()})`);
    assert.ok(d2Exited, 'daemon #2 did not exit after daemon.shutdown');
    assert.equal(fs.existsSync(path.join(dataDir, 'daemon.json')), false, 'daemon.json removed on clean shutdown');
  } finally {
    client1?.close();
    client2?.close();
    for (const d of daemons) {
      if (d.child.exitCode === null) {
        console.log(`[IT] daemon pid ${d.child.pid} still running — killing`);
        killTree(d.child.pid!);
        await waitExit(d.child, 5000);
      }
    }
    await sleep(500);
    const swept = sweepClaudeByDataDir(dataDir, claudePids);
    if (swept.length > 0) console.log(`[IT] leftover claude pids killed: ${swept.join(', ')}`);
    await sleep(500);
    console.log(`[IT] leftover check: ${[...new Set([...claudePids, ...swept])].map((p) => `${p}=${pidAlive(p) ? 'ALIVE' : 'dead'}`).join(' ') || 'none'}`);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
