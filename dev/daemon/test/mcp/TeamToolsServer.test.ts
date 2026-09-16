// TeamToolsServer(T17): 임시 포트에 띄우고 SDK 의 Client + StreamableHTTPClientTransport 로 `/mcp/<token>` 에 붙어
// tools/list → ask_user 호출 → 가짜 호스트가 받은 인자·도구 결과 텍스트 검증. 모르는 토큰·다른 경로는 404. dispose/close.
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { TeamToolsServer, askUserResultText, tokenFromUrl, type AskUserInput, type TeamToolsHost } from '../../src/mcp/TeamToolsServer.js';

const TOKEN = 'tok_abc123';

class FakeHost implements TeamToolsHost {
  readonly asks: Array<{ memberId: string; input: AskUserInput }> = [];
  members = new Map<string, { id: string; name: string }>([[TOKEN, { id: 'm_1', name: 'kim' }]]);
  failNext?: string;
  private n = 0;
  resolveMember(token: string) {
    return this.members.get(token);
  }
  askUser(memberId: string, input: AskUserInput) {
    if (this.failNext) {
      const msg = this.failNext;
      this.failNext = undefined;
      throw new Error(msg);
    }
    this.asks.push({ memberId, input });
    return { questionId: `q_${++this.n}` };
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

  test('tools/list exposes ask_user with question(required)/options(optional) schema', async () => {
    const { client } = await connect(port, TOKEN);
    try {
      const { tools } = await client.listTools();
      assert.deepEqual(
        tools.map((t) => t.name),
        ['ask_user'],
      );
      const ask = tools[0]!;
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
    const { client } = await connect(port, TOKEN);
    try {
      const r = await client.callTool({ name: 'ask_user', arguments: { question: '좋아하는 색은?', options: ['빨강', '파랑'] } });
      assert.equal(r.isError ?? false, false);
      assert.deepEqual(host.asks, [{ memberId: 'm_1', input: { question: '좋아하는 색은?', options: ['빨강', '파랑'] } }]);
      const content = r.content as Array<{ type: string; text: string }>;
      assert.equal(content.length, 1);
      assert.equal(content[0]!.type, 'text');
      assert.equal(content[0]!.text, askUserResultText('q_1'));
      assert.equal(content[0]!.text, '질문 q#q_1 등록됨. 사용자의 답은 "[ANSWER q#q_1]" 메시지로 도착한다. 답이 필요하면 이 턴을 끝내고 기다려라.');

      // options 생략
      const r2 = await client.callTool({ name: 'ask_user', arguments: { question: '두 번째?' } });
      assert.equal((r2.content as Array<{ text: string }>)[0]!.text, askUserResultText('q_2'));
      assert.deepEqual(host.asks[1], { memberId: 'm_1', input: { question: '두 번째?', options: undefined } });
    } finally {
      await client.close();
    }
  });

  test('host throw → isError result with the message; schema violation (empty question) → error', async () => {
    const { client } = await connect(port, TOKEN);
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
    host.members.set('tok_two', { id: 'm_2', name: 'lee' });
    const a = await connect(port, TOKEN);
    const b = await connect(port, 'tok_two');
    try {
      await a.client.callTool({ name: 'ask_user', arguments: { question: 'A?' } });
      await b.client.callTool({ name: 'ask_user', arguments: { question: 'B?' } });
      assert.deepEqual(
        host.asks.map((x) => x.memberId),
        ['m_1', 'm_2'],
      );
      assert.deepEqual(server.knownTokens().sort(), [TOKEN, 'tok_two']);
      // 무상태 모드: POST 응답이 끝나면 그 연결은 정리된다. 남는 것은 SDK 클라이언트가 initialize 뒤에 여는 standalone GET SSE
      // 스트림 하나(서버→클라이언트 알림용) — Claude 도 같은 SDK 라 같은 모양일 것.
      await new Promise((r) => setTimeout(r, 50));
      assert.ok(server.liveConnections(TOKEN) <= 1, `live=${server.liveConnections(TOKEN)}`);

      server.dispose(TOKEN);
      assert.equal(server.liveConnections(TOKEN), 0);
      assert.deepEqual(server.knownTokens(), ['tok_two']);
      // 항목이 없어도 다음 요청이 다시 만든다(토큰이 여전히 유효하므로)
      await a.client.callTool({ name: 'ask_user', arguments: { question: 'A2?' } });
      assert.deepEqual(server.knownTokens().sort(), [TOKEN, 'tok_two']);

      // 멤버가 사라지면(퇴근) 같은 토큰도 404
      host.members.delete(TOKEN);
      await assert.rejects(a.client.callTool({ name: 'ask_user', arguments: { question: 'A3?' } }), /unknown member token/);
    } finally {
      await a.client.close();
      await b.client.close();
    }
    await server.close();
    await assert.rejects(fetch(`http://127.0.0.1:${port}/mcp/tok_two`, { method: 'POST', body: '{}' }));
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
