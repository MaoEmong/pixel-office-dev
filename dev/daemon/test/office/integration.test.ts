// 통합 테스트(opt-in): 실제 데몬(src/index.ts)을 자식 프로세스로 띄우고 WS JSON-RPC 로 Claude 멤버를 출근 → 지시 → 허가 → idle → 퇴근.
// 실행: PIXEL_IT=1 npx tsx --test test/office/integration.test.ts   (bash)
// 전제: dev/spike-0/sandbox(또는 `PIXEL_IT_SANDBOX`)가 신뢰된 폴더이고 claude 로그인이 끝나 있다(첫 실행 다이얼로그는 InputQueue 가 자동 통과한다).
// T44: 여기도 rev 3 경로로 — `team.create`+`member.clockIn`(디버그 전용, -32004) 대신 `department.create` 하나.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import type { DaemonInfo } from '../../src/office/types.js';
import type { Department, Member, OfficeEvent, Snapshot } from '../../src/store/types.js';
import { SANDBOX } from './it-helpers.js';

const IT = process.env.PIXEL_IT === '1';
const DAEMON_DIR = path.resolve(import.meta.dirname, '..', '..');
const TARGET = path.join(SANDBOX, 't07.txt');
// "네가 직접" 을 못 박는다 — rev 3 의 부장은 create_team·delegate 를 들고 있어서, 그냥 시키면 팀을 만들어 팀장에게
// 넘긴다(T44 실측: 허가 요청이 팀장 쪽에서 떠서 이 테스트가 부장의 waiting_approval 을 영영 기다렸다).
const INSTRUCTION = '팀을 만들거나 위임하지 말고 네가 직접 셸 명령 "echo t07 > t07.txt" 를 실행해라. 그 외에는 아무것도 하지 마라.';

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

  private constructor(readonly ws: WebSocket) {
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString()) as Record<string, unknown>;
      if (typeof msg.method === 'string') {
        const n = { method: msg.method, params: (msg.params ?? {}) as Record<string, unknown> };
        this.notifications.push(n);
        if (n.method === 'event') {
          const e = n.params as unknown as OfficeEvent;
          console.log(`[IT] event #${e.seq} ${e.kind} ${JSON.stringify(e.detail).slice(0, 120)}`);
        } else if (n.method === 'member.status') {
          console.log(`[IT] status ${String(n.params.status)} (${String(n.params.derived)})`);
        } else if (n.method === 'daemon.notice') {
          console.log(`[IT] notice ${String(n.params.level)}: ${String(n.params.message)}`);
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

  static connect(port: number): Promise<Client> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}`);
      ws.once('open', () => resolve(new Client(ws)));
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

  waitEvent(memberId: string, kind: OfficeEvent['kind'], afterSeq: number, timeoutMs: number): Promise<OfficeEvent> {
    return this.waitFor(
      `event ${kind}`,
      (n) => n.method === 'event' && n.params.memberId === memberId && n.params.kind === kind && (n.params.seq as number) > afterSeq,
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

test('real daemon: department.create(claude head) → instruct → waiting_approval → allow → idle → file exists → clockOut → shutdown', { skip: IT ? false : 'set PIXEL_IT=1 to run', timeout: 300_000 }, async () => {
  assert.ok(fs.existsSync(SANDBOX), `sandbox missing: ${SANDBOX}`);
  fs.rmSync(TARGET, { force: true });
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pixel-office-t07-it-'));
  const wsPort = await freePort();
  const hookPort = await freePort();
  // T17: TeamTools MCP 도 임시 포트로(기본 7422 충돌 방지).
  const mcpPort = await freePort();

  const child = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
    cwd: DAEMON_DIR,
    env: { ...process.env, PIXEL_WS_PORT: String(wsPort), PIXEL_HOOK_PORT: String(hookPort), PIXEL_MCP_PORT: String(mcpPort), PIXEL_DATA_DIR: dataDir, PIXEL_IT: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let listening = false;
  const onLine = (prefix: string) => (buf: Buffer) => {
    for (const line of buf.toString().split(/\r?\n/)) {
      if (!line) continue;
      console.log(`${prefix} ${line}`);
      if (line.includes('[daemon] listening')) listening = true;
    }
  };
  child.stdout!.on('data', onLine('[daemon:out]'));
  child.stderr!.on('data', onLine('[daemon:err]'));

  let claudePid: number | null = null;
  let client: Client | undefined;
  try {
    for (let i = 0; i < 100 && !listening; i++) {
      if (child.exitCode !== null) throw new Error(`daemon exited early with code ${child.exitCode}`);
      await sleep(200);
    }
    assert.ok(listening, 'daemon did not print "listening" within 20s');
    const info = JSON.parse(fs.readFileSync(path.join(dataDir, 'daemon.json'), 'utf8')) as DaemonInfo;
    console.log(`[IT] daemon.json wsPort=${info.wsPort} hookPort=${info.hookPort} pid=${info.pid} version=${info.version}`);
    assert.equal(info.wsPort, wsPort);
    assert.equal(info.hookPort, hookPort);
    assert.equal(info.pid, child.pid);

    client = await Client.connect(info.wsPort);
    const hello = await client.call<{ daemon: { version: string; pid: number }; snapshot: Snapshot }>('hello', {
      token: info.token,
      client: { name: 't07-it', version: '0' },
    });
    assert.equal(hello.daemon.pid, child.pid);
    console.log(`[IT] hello ok: snapshot.seq=${hello.snapshot.seq} teams=${hello.snapshot.teams.length}`);

    const t0 = Date.now();
    const { department, head: member } = await client.call<{ department: Department; head: Member }>('department.create', {
      name: 'it07',
      cwd: SANDBOX,
      headEngine: 'claude',
      headName: 'tester',
    });
    claudePid = member.childPid;
    console.log(`[IT] department=${department.id} head=${member.id} rank=${member.rank} pid=${member.childPid} status=${member.status}`);
    await client.waitStatus(member.id, 'idle', 90_000);
    console.log(`[IT] idle (SessionStart) after ${Date.now() - t0}ms`);

    const { taskId } = await client.call<{ taskId: number }>('member.instruct', { memberId: member.id, text: INSTRUCTION });
    console.log(`[IT] instruct taskId=${taskId}`);
    const approval = await client.waitEvent(member.id, 'waiting_approval', hello.snapshot.seq, 180_000);
    console.log(`[IT] waiting_approval after ${Date.now() - t0}ms: ${JSON.stringify(approval.detail)} ref=${JSON.stringify(approval.ref)}`);
    assert.ok(approval.ref.approvalId);
    assert.match(String(approval.detail.cmd ?? ''), /echo t07/);

    await client.call('approval.respond', { pendingId: approval.ref.approvalId, behavior: 'allow' });
    const idle = await client.waitEvent(member.id, 'idle', approval.seq, 180_000);
    console.log(`[IT] idle after ${Date.now() - t0}ms (seq ${idle.seq})`);
    await sleep(500);
    assert.ok(fs.existsSync(TARGET), `expected ${TARGET} to exist`);
    console.log(`[IT] t07.txt = ${JSON.stringify(fs.readFileSync(TARGET, 'utf8'))}`);
    const reporting = client.notifications.find((n) => n.method === 'event' && n.params.kind === 'reporting');
    console.log(`[IT] reporting event: ${reporting ? JSON.stringify(reporting.params) : 'none'}`);

    const attach = await client.call<{ screen: string; cols: number; rows: number }>('member.attach', { memberId: member.id, cols: 120, rows: 40 });
    console.log(`[IT] attach screen=${attach.screen.length} bytes ${attach.cols}x${attach.rows}`);
    assert.ok(attach.screen.length > 0);

    await client.call('member.clockOut', { memberId: member.id });
    await client.waitStatus(member.id, 'exited', 20_000);
    console.log(`[IT] clockOut done after ${Date.now() - t0}ms; claude alive=${claudePid ? pidAlive(claudePid) : 'n/a'}`);

    await client.call('daemon.shutdown', {});
    const exited = await waitExit(child, 20_000);
    console.log(`[IT] daemon exited=${exited} code=${child.exitCode}`);
    assert.ok(exited, 'daemon did not exit after daemon.shutdown');
    assert.equal(fs.existsSync(path.join(dataDir, 'daemon.json')), false, 'daemon.json removed on clean shutdown');
  } finally {
    client?.close();
    if (child.exitCode === null) {
      console.log('[IT] daemon still running — killing');
      killTree(child.pid!);
      await waitExit(child, 5000);
    }
    if (claudePid && pidAlive(claudePid)) {
      console.log(`[IT] leftover claude pid ${claudePid} — killing`);
      killTree(claudePid);
    }
    fs.rmSync(TARGET, { force: true });
    await sleep(300);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
