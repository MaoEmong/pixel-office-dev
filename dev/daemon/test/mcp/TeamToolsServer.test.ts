// TeamToolsServer(T17 ask_user + T25 hire/dismiss/delegate/report + **T35 직급별 도구**): 임시 포트에 띄우고 SDK 의
// Client + StreamableHTTPClientTransport 로 `/mcp/<token>` 에 붙어 tools/list(직급별 3종) → 도구 호출 → 가짜 호스트가
// 받은 인자·도구 결과 텍스트 검증. 직급에 없는 도구·세션 중 직급 변화. 모르는 토큰·다른 경로는 404. dispose/close.
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {
  ASK_USER_HEAD_ONLY_MESSAGE,
  RANK_TOOLS,
  TeamToolsServer,
  askParentResultText,
  askUserResultText,
  createTeamResultText,
  delegateResultText,
  dismissResultText,
  dismissTeamResultText,
  hireResultText,
  rankToolMessage,
  replyResultText,
  reportResultText,
  tokenFromUrl,
  type AskParentInput,
  type AskUserInput,
  type CreateTeamToolInput,
  type DelegateInput,
  type DismissInput,
  type DismissTeamInput,
  type HireInput,
  type ReplyInput,
  type ReportInput,
  type TeamToolsHost,
  type TeamToolsMember,
} from '../../src/mcp/TeamToolsServer.js';

const TOKEN = 'tok_abc123';
/** 팀장 토큰(팀장 도구 검증용). */
const LEAD = 'tok_leader';
/** 부장 토큰(T35 부장 전용 도구 검증용). */
const HEAD = 'tok_head';

class FakeHost implements TeamToolsHost {
  readonly asks: Array<{ memberId: string; input: AskUserInput }> = [];
  readonly askParents: Array<{ memberId: string; input: AskParentInput }> = [];
  readonly createdTeams: Array<{ memberId: string; input: CreateTeamToolInput }> = [];
  readonly dismissedTeams: Array<{ memberId: string; input: DismissTeamInput }> = [];
  readonly hires: Array<{ memberId: string; input: HireInput }> = [];
  readonly dismissals: Array<{ memberId: string; input: DismissInput }> = [];
  readonly delegations: Array<{ memberId: string; input: DelegateInput }> = [];
  readonly replies: Array<{ memberId: string; input: ReplyInput }> = [];
  readonly reports: Array<{ memberId: string; input: ReportInput }> = [];
  members = new Map<string, TeamToolsMember>([
    [TOKEN, { id: 'm_1', name: 'kim', rank: 'member' }],
    [LEAD, { id: 'm_lead', name: '반장', rank: 'lead' }],
    [HEAD, { id: 'm_head', name: '부장', rank: 'head' }],
  ]);
  failNext?: string;
  /** reply 가 열린 ask_parent 를 닫았다고 답할지. */
  replyQuestionId?: string;
  private n = 0;
  resolveMember(token: string) {
    return this.members.get(token);
  }
  private boom(): void {
    if (!this.failNext) return;
    const msg = this.failNext;
    this.failNext = undefined;
    throw new Error(msg);
  }
  askUser(memberId: string, input: AskUserInput) {
    this.boom();
    this.asks.push({ memberId, input });
    return { questionId: `q_${++this.n}` };
  }
  askParent(memberId: string, input: AskParentInput) {
    this.boom();
    this.askParents.push({ memberId, input });
    return { questionId: `q_${++this.n}`, parentName: '반장' };
  }
  createTeam(memberId: string, input: CreateTeamToolInput) {
    this.boom();
    this.createdTeams.push({ memberId, input });
    return { teamId: 't_1', teamName: input.name, leadName: input.leadName, leadMemberId: 'm_lead2' };
  }
  async dismissTeam(memberId: string, input: DismissTeamInput) {
    this.boom();
    this.dismissedTeams.push({ memberId, input });
    return { teamName: '개발', dismissed: ['팀장A', '이음'] };
  }
  hire(memberId: string, input: HireInput) {
    this.boom();
    this.hires.push({ memberId, input });
    return { memberId: 'm_new', name: input.name, engine: input.engine ?? 'claude' };
  }
  async dismiss(memberId: string, input: DismissInput) {
    this.boom();
    this.dismissals.push({ memberId, input });
    return { memberId: input.memberId, name: '이음' };
  }
  delegate(memberId: string, input: DelegateInput) {
    this.boom();
    this.delegations.push({ memberId, input });
    return { taskId: 12, name: '이음', status: 'assigned' as const };
  }
  reply(memberId: string, input: ReplyInput) {
    this.boom();
    this.replies.push({ memberId, input });
    return { name: '이음', questionId: this.replyQuestionId };
  }
  report(memberId: string, input: ReportInput) {
    this.boom();
    this.reports.push({ memberId, input });
    return { taskId: input.taskId, status: input.status, to: 'parent' as const };
  }
}

async function connect(port: number, token: string): Promise<{ client: Client; transport: StreamableHTTPClientTransport }> {
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp/${token}`));
  const client = new Client({ name: 't17-test', version: '0' });
  await client.connect(transport);
  return { client, transport };
}

describe('TeamToolsServer (T17)', () => {
  let host: FakeHost;
  let server: TeamToolsServer;
  let port: number;

  beforeEach(async () => {
    host = new FakeHost();
    server = new TeamToolsServer({ host, version: '9.9.9' });
    port = await server.listen(0);
    assert.ok(port > 0);
    assert.equal(server.port, port);
  });
  afterEach(async () => {
    await server.close();
  });

  test('tools/list exposes ask_user with question(required)/options(optional) schema (부장)', async () => {
    const { client } = await connect(port, HEAD);
    try {
      const { tools } = await client.listTools();
      const ask = tools.find((t) => t.name === 'ask_user')!;
      const schema = ask.inputSchema as { properties: Record<string, unknown>; required?: string[] };
      assert.deepEqual(Object.keys(schema.properties).sort(), ['options', 'question']);
      assert.deepEqual(schema.required, ['question']);
      assert.match(ask.description ?? '', /\[ANSWER q#<id>\]/);
      assert.equal(client.getServerVersion()?.name, 'team');
      assert.equal(client.getServerVersion()?.version, '9.9.9');
    } finally {
      await client.close();
    }
  });

  test('ask_user → host.askUser(memberId, {question, options}) and returns the registration text (non-blocking)', async () => {
    const { client } = await connect(port, HEAD);
    try {
      const r = await client.callTool({ name: 'ask_user', arguments: { question: '좋아하는 색은?', options: ['빨강', '파랑'] } });
      assert.equal(r.isError ?? false, false);
      assert.deepEqual(host.asks, [{ memberId: 'm_head', input: { question: '좋아하는 색은?', options: ['빨강', '파랑'] } }]);
      const content = r.content as Array<{ type: string; text: string }>;
      assert.equal(content.length, 1);
      assert.equal(content[0]!.type, 'text');
      assert.equal(content[0]!.text, askUserResultText('q_1'));
      assert.equal(content[0]!.text, '질문 q#q_1 등록됨. 사용자의 답은 "[ANSWER q#q_1]" 메시지로 도착한다. 답이 필요하면 이 턴을 끝내고 기다려라.');

      // options 생략
      const r2 = await client.callTool({ name: 'ask_user', arguments: { question: '두 번째?' } });
      assert.equal((r2.content as Array<{ text: string }>)[0]!.text, askUserResultText('q_2'));
      assert.deepEqual(host.asks[1], { memberId: 'm_head', input: { question: '두 번째?', options: undefined } });
    } finally {
      await client.close();
    }
  });

  test('host throw → isError result with the message; schema violation (empty question) → error', async () => {
    const { client } = await connect(port, HEAD);
    try {
      host.failNext = 'member m_1 is not running';
      const r = await client.callTool({ name: 'ask_user', arguments: { question: 'x' } });
      assert.equal(r.isError, true);
      assert.match((r.content as Array<{ text: string }>)[0]!.text, /ask_user 실패: member m_1 is not running/);
      assert.equal(host.asks.length, 0);

      const bad = await client.callTool({ name: 'ask_user', arguments: { question: '' } });
      assert.equal(bad.isError, true);
      assert.equal(host.asks.length, 0);
    } finally {
      await client.close();
    }
  });

  test('unknown token → 404 (client connect fails); wrong path → 404', async () => {
    await assert.rejects(connect(port, 'nope'), /unknown member token/);
    const res = await fetch(`http://127.0.0.1:${port}/other/${TOKEN}`, { method: 'POST', body: '{}' });
    assert.equal(res.status, 404);
    const body = (await res.json()) as { error: { message: string } };
    assert.equal(body.error.message, 'unknown member token');
    assert.deepEqual(server.knownTokens(), []);
  });

  test('two members are separated by token; dispose(token) drops that member only; close() ends everything', async () => {
    host.members.set('tok_two', { id: 'm_2', name: 'lee', rank: 'head' });
    const a = await connect(port, HEAD);
    const b = await connect(port, 'tok_two');
    try {
      await a.client.callTool({ name: 'ask_user', arguments: { question: 'A?' } });
      await b.client.callTool({ name: 'ask_user', arguments: { question: 'B?' } });
      assert.deepEqual(
        host.asks.map((x) => x.memberId),
        ['m_head', 'm_2'],
      );
      assert.deepEqual(server.knownTokens().sort(), [HEAD, 'tok_two'].sort());
      // 무상태 모드: POST 응답이 끝나면 그 연결은 정리된다. 남는 것은 SDK 클라이언트가 initialize 뒤에 여는 standalone GET SSE
      // 스트림 하나(서버→클라이언트 알림용) — Claude 도 같은 SDK 라 같은 모양일 것.
      await new Promise((r) => setTimeout(r, 50));
      assert.ok(server.liveConnections(HEAD) <= 1, `live=${server.liveConnections(HEAD)}`);

      server.dispose(HEAD);
      assert.equal(server.liveConnections(HEAD), 0);
      assert.deepEqual(server.knownTokens(), ['tok_two']);
      // 항목이 없어도 다음 요청이 다시 만든다(토큰이 여전히 유효하므로)
      await a.client.callTool({ name: 'ask_user', arguments: { question: 'A2?' } });
      assert.deepEqual(server.knownTokens().sort(), [HEAD, 'tok_two'].sort());

      // 멤버가 사라지면(퇴근) 같은 토큰도 404
      host.members.delete(HEAD);
      await assert.rejects(a.client.callTool({ name: 'ask_user', arguments: { question: 'A3?' } }), /unknown member token/);
    } finally {
      await a.client.close();
      await b.client.close();
    }
    await server.close();
    await assert.rejects(fetch(`http://127.0.0.1:${port}/mcp/tok_two`, { method: 'POST', body: '{}' }));
  });

  // ---- T35: 직급별 도구 목록(3종) · 직급 전용 도구 --------------------------------------------

  test('T35 tools/list: 부장 6개 / 팀장 6개 / 팀원 2개 — RANK_TOOLS 와 정확히 같다', async () => {
    const asMember = await connect(port, TOKEN);
    const asLeader = await connect(port, LEAD);
    const asHead = await connect(port, HEAD);
    try {
      const names = async (c: Client) => (await c.listTools()).tools.map((t) => t.name).sort();
      assert.deepEqual(await names(asMember.client), ['ask_parent', 'report']);
      assert.deepEqual(await names(asLeader.client), ['ask_parent', 'delegate', 'dismiss', 'hire', 'reply', 'report']);
      assert.deepEqual(await names(asHead.client), ['ask_user', 'create_team', 'delegate', 'dismiss_team', 'reply', 'report']);
      // 표 자체가 단일 출처다 — 지시문 템플릿의 도구 이름 줄도 이것을 읽는다.
      assert.deepEqual(await names(asMember.client), [...RANK_TOOLS.member].sort());
      assert.deepEqual(await names(asLeader.client), [...RANK_TOOLS.lead].sort());
      assert.deepEqual(await names(asHead.client), [...RANK_TOOLS.head].sort());

      const headTools = (await asHead.client.listTools()).tools;
      const createTeam = headTools.find((t) => t.name === 'create_team')!;
      const ctSchema = createTeam.inputSchema as { properties: Record<string, unknown>; required?: string[] };
      assert.deepEqual(Object.keys(ctSchema.properties).sort(), ['engine', 'instructions', 'leadName', 'name']);
      assert.deepEqual(ctSchema.required?.sort(), ['leadName', 'name']);
      assert.match(createTeam.description ?? '', /부장 전용/);
      const dismissTeam = headTools.find((t) => t.name === 'dismiss_team')!;
      assert.deepEqual((dismissTeam.inputSchema as { required?: string[] }).required, ['teamId']);
      const reply = headTools.find((t) => t.name === 'reply')!;
      assert.deepEqual((reply.inputSchema as { required?: string[] }).required?.sort(), ['text', 'to_member']);
      const askParent = (await asMember.client.listTools()).tools.find((t) => t.name === 'ask_parent')!;
      assert.deepEqual((askParent.inputSchema as { required?: string[] }).required, ['question']);
      assert.match(askParent.description ?? '', /\[ANSWER q#<id>\]/);

      const leaderTools = (await asLeader.client.listTools()).tools;
      const hire = leaderTools.find((t) => t.name === 'hire')!;
      const hireSchema = hire.inputSchema as { properties: Record<string, unknown>; required?: string[] };
      assert.deepEqual(Object.keys(hireSchema.properties).sort(), ['engine', 'instructions', 'name', 'role']);
      assert.deepEqual(hireSchema.required?.sort(), ['name', 'role']);
      assert.match(hire.description ?? '', /팀장 전용/);
      const report = leaderTools.find((t) => t.name === 'report')!;
      const reportSchema = report.inputSchema as { properties: Record<string, unknown>; required?: string[] };
      assert.deepEqual(Object.keys(reportSchema.properties).sort(), ['files', 'status', 'summary', 'taskId']);
      assert.deepEqual(reportSchema.required?.sort(), ['status', 'summary', 'taskId']);
      const delegate = leaderTools.find((t) => t.name === 'delegate')!;
      assert.deepEqual((delegate.inputSchema as { required?: string[] }).required?.sort(), ['task', 'to_member']);
    } finally {
      await asMember.client.close();
      await asLeader.client.close();
      await asHead.client.close();
    }
  });

  test('T35 부장 도구: create_team / dismiss_team / reply 가 호스트를 부르고 결과 문구를 돌려준다', async () => {
    const { client } = await connect(port, HEAD);
    try {
      const c = await client.callTool({ name: 'create_team', arguments: { name: '개발', leadName: '팀장A' } });
      assert.equal(c.isError ?? false, false);
      assert.deepEqual(host.createdTeams, [{ memberId: 'm_head', input: { name: '개발', leadName: '팀장A' } }]);
      assert.equal((c.content as Array<{ text: string }>)[0]!.text, createTeamResultText('개발', '팀장A', 'm_lead2'));
      assert.equal((c.content as Array<{ text: string }>)[0]!.text, '팀 개발 생성, 팀장 팀장A(m_lead2) 출근.');

      const d = await client.callTool({ name: 'dismiss_team', arguments: { teamId: 't_1' } });
      assert.deepEqual(host.dismissedTeams, [{ memberId: 'm_head', input: { teamId: 't_1' } }]);
      assert.equal((d.content as Array<{ text: string }>)[0]!.text, dismissTeamResultText('개발', ['팀장A', '이음']));

      host.replyQuestionId = 'q_77';
      const r = await client.callTool({ name: 'reply', arguments: { to_member: 'm_lead2', text: '그대로 진행해' } });
      assert.deepEqual(host.replies, [{ memberId: 'm_head', input: { to_member: 'm_lead2', text: '그대로 진행해' } }]);
      assert.equal((r.content as Array<{ text: string }>)[0]!.text, replyResultText('이음', 'q_77'));
      host.replyQuestionId = undefined;
      const r2 = await client.callTool({ name: 'reply', arguments: { to_member: 'm_lead2', text: '참고만 해' } });
      assert.equal((r2.content as Array<{ text: string }>)[0]!.text, replyResultText('이음'));
    } finally {
      await client.close();
    }
  });

  test('T35 ask_parent: 팀원·팀장이 쓰고 결과 문구에 상사 이름과 [ANSWER q#id] 가 들어간다', async () => {
    const { client } = await connect(port, TOKEN);
    try {
      const r = await client.callTool({ name: 'ask_parent', arguments: { question: '어느 폴더에 쓸까요?', options: ['a', 'b'] } });
      assert.equal(r.isError ?? false, false);
      assert.deepEqual(host.askParents, [{ memberId: 'm_1', input: { question: '어느 폴더에 쓸까요?', options: ['a', 'b'] } }]);
      assert.equal((r.content as Array<{ text: string }>)[0]!.text, askParentResultText('q_1', '반장'));
      assert.match((r.content as Array<{ text: string }>)[0]!.text, /질문 q#q_1 등록됨\(→ 반장\)\./);
    } finally {
      await client.close();
    }
  });

  test('T25 팀장 도구: hire / dismiss / delegate 가 호스트를 부르고 결과 문구를 돌려준다', async () => {
    const { client } = await connect(port, LEAD);
    try {
      const h = await client.callTool({ name: 'hire', arguments: { name: '이음', role: '파일 작성', engine: 'claude' } });
      assert.equal(h.isError ?? false, false);
      assert.deepEqual(host.hires, [{ memberId: 'm_lead', input: { name: '이음', role: '파일 작성', engine: 'claude' } }]);
      assert.equal((h.content as Array<{ text: string }>)[0]!.text, hireResultText('이음', 'm_new', 'claude'));
      assert.equal((h.content as Array<{ text: string }>)[0]!.text, '팀원 이음 (m_new) 출근. 엔진 claude.');

      const d = await client.callTool({ name: 'delegate', arguments: { to_member: 'm_new', task: 'hello.txt 를 써라' } });
      assert.deepEqual(host.delegations, [{ memberId: 'm_lead', input: { to_member: 'm_new', task: 'hello.txt 를 써라' } }]);
      assert.match((d.content as Array<{ text: string }>)[0]!.text, /^task#12 → 이음 \(assigned\)/);
      assert.equal((d.content as Array<{ text: string }>)[0]!.text, delegateResultText(12, '이음', 'assigned'));

      const x = await client.callTool({ name: 'dismiss', arguments: { memberId: 'm_new' } });
      assert.deepEqual(host.dismissals, [{ memberId: 'm_lead', input: { memberId: 'm_new' } }]);
      assert.equal((x.content as Array<{ text: string }>)[0]!.text, dismissResultText('이음', 'm_new'));
    } finally {
      await client.close();
    }
  });

  test('T25 report: 전원이 쓸 수 있고 taskId 는 문자열로 와도 숫자로 강제된다', async () => {
    const { client } = await connect(port, TOKEN);
    try {
      const r = await client.callTool({ name: 'report', arguments: { taskId: '7', summary: '끝', status: 'done', files: ['a.txt'] } });
      assert.equal(r.isError ?? false, false);
      assert.deepEqual(host.reports, [{ memberId: 'm_1', input: { taskId: 7, summary: '끝', status: 'done', files: ['a.txt'] } }]);
      assert.equal((r.content as Array<{ text: string }>)[0]!.text, reportResultText(7, 'done', 'parent'));
      assert.equal((r.content as Array<{ text: string }>)[0]!.text, 'task#7 보고 접수(status=done). 직속 상사(으)로 올라간다.');

      const bad = await client.callTool({ name: 'report', arguments: { taskId: 7, summary: '끝', status: '몰라' } });
      assert.equal(bad.isError, true);
      assert.equal(host.reports.length, 1);
    } finally {
      await client.close();
    }
  });

  test('T35 직급 강제: 직급에 없는 도구는 등록조차 안 되고, 세션 중 직급이 바뀌거나 사라지면 isError(한국어 사유)', async () => {
    const asMember = await connect(port, TOKEN);
    const asLead = await connect(port, LEAD);
    try {
      // 등록조차 되지 않는다 — 모델이 이름만 알고 불러도 실패한다(SDK 버전에 따라 reject 이거나 isError 결과).
      const notFound = async (c: Client, name: string, args: Record<string, unknown>) =>
        c.callTool({ name, arguments: args }).catch((e: unknown) => ({ isError: true, content: [{ text: String(e) }] }));
      for (const [name, args] of [
        ['hire', { name: 'x', role: 'y' }],
        ['delegate', { to_member: 'm_2', task: 'x' }],
        ['reply', { to_member: 'm_2', text: 'x' }],
        ['ask_user', { question: 'x' }],
        ['create_team', { name: 'x', leadName: 'y' }],
      ] as Array<[string, Record<string, unknown>]>) {
        const r = await notFound(asMember.client, name, args);
        assert.equal(r.isError, true, name);
        assert.match((r.content as Array<{ text: string }>)[0]!.text, new RegExp(name));
      }
      assert.equal(host.hires.length, 0);
      assert.equal(host.asks.length, 0);
      // 팀장에게도 부장 도구는 없다.
      for (const name of ['create_team', 'dismiss_team', 'ask_user']) {
        const r = await notFound(asLead.client, name, { name: 'x', leadName: 'y', teamId: 't', question: 'q' });
        assert.equal(r.isError, true, name);
      }
      assert.equal(host.createdTeams.length, 0);
    } finally {
      await asMember.client.close();
      await asLead.client.close();
    }

    // 두 번째 겹: 서버를 만들 때는 부장이었는데 **콜백이 도는 사이 팀장으로 내려앉으면** 한국어 사유로 거절된다
    // (요청마다 목록을 다시 만들므로, 이 틈을 보려면 resolveMember 가 두 번 다르게 답해야 한다).
    const asHead = await connect(port, HEAD);
    try {
      assert.ok((await asHead.client.listTools()).tools.some((t) => t.name === 'ask_user'));
      const real = host.resolveMember.bind(host);
      let first = true;
      host.resolveMember = (token: string) => {
        if (token !== HEAD) return real(token);
        if (first) {
          first = false;
          return { id: 'm_head', name: '부장', rank: 'head' };
        }
        return { id: 'm_head', name: '부장', rank: 'lead' }; // 콜백의 재확인 시점엔 이미 팀장
      };
      const r = await asHead.client.callTool({ name: 'ask_user', arguments: { question: 'x' } });
      assert.equal(r.isError, true);
      assert.equal((r.content as Array<{ text: string }>)[0]!.text, `ask_user 실패: ${ASK_USER_HEAD_ONLY_MESSAGE}`);
      assert.equal((r.content as Array<{ text: string }>)[0]!.text, 'ask_user 실패: 부장만 사용자에게 질문할 수 있습니다. ask_parent를 쓰세요.');
      assert.equal(host.asks.length, 0);
    } finally {
      await asHead.client.close();
    }

    // 두 번째 겹: 도구가 등록된 뒤(요청 시작 시점엔 팀장) 콜백이 도는 사이 멤버가 사라지면 한국어 isError.
    // 직급 자체가 뒤집힌 경우는 다음 요청의 도구 목록에서 빠지므로(위) 여기선 "멤버 없음" 경로를 본다.
    const asLeader = await connect(port, LEAD);
    try {
      assert.ok((await asLeader.client.listTools()).tools.some((t) => t.name === 'hire'));
      const gone = new Map(host.members);
      host.resolveMember = (token: string) => {
        const m = gone.get(token);
        gone.delete(token); // 서버 빌드 때는 보이고, 콜백의 재확인 때는 사라진다
        return m;
      };
      const r = await asLeader.client.callTool({ name: 'hire', arguments: { name: 'x', role: 'y' } });
      assert.equal(r.isError, true);
      assert.match((r.content as Array<{ text: string }>)[0]!.text, /^hire 실패: 멤버를 찾을 수 없습니다/);
      assert.equal(host.hires.length, 0);
      // 문구 자체는 export 되어 PROTOCOL·Office 와 같은 문장을 쓴다.
      assert.equal(
        rankToolMessage('hire', 'member'),
        'hire 는 팀원이(가) 쓸 수 있는 도구가 아닙니다. 팀원의 도구: report, ask_parent.',
      );
      assert.equal(rankToolMessage('ask_user', 'lead'), ASK_USER_HEAD_ONLY_MESSAGE);
    } finally {
      await asLeader.client.close();
    }
  });

  test('T25 호스트가 throw 하면 isError + 한국어 사유(턴을 죽이지 않는다)', async () => {
    const { client } = await connect(port, LEAD);
    try {
      host.failNext = 'team alpha is full (4/4)';
      const r = await client.callTool({ name: 'hire', arguments: { name: '이음', role: '파일 작성' } });
      assert.equal(r.isError, true);
      assert.equal((r.content as Array<{ text: string }>)[0]!.text, 'hire 실패: team alpha is full (4/4)');

      host.failNext = 'task#3 은(는) 당신에게 배정된 작업이 아닙니다';
      const r2 = await client.callTool({ name: 'report', arguments: { taskId: 3, summary: 'x', status: 'done' } });
      assert.equal(r2.isError, true);
      assert.match((r2.content as Array<{ text: string }>)[0]!.text, /^report 실패: task#3/);
    } finally {
      await client.close();
    }
  });

  test('tokenFromUrl', () => {
    assert.equal(tokenFromUrl('/mcp/abc'), 'abc');
    assert.equal(tokenFromUrl('/mcp/abc/'), 'abc');
    assert.equal(tokenFromUrl('/mcp/abc?x=1'), 'abc');
    assert.equal(tokenFromUrl('/mcp/'), undefined);
    assert.equal(tokenFromUrl('/mcp'), undefined);
    assert.equal(tokenFromUrl('/hook/abc'), undefined);
    assert.equal(tokenFromUrl('/mcp/a b'), undefined);
  });
});
