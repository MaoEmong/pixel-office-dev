// T12 테스트 공용 픽스처: Member / OfficeEvent / Pending 생성 헬퍼.
// T37(rev 3): 멤버는 부서(`departmentId`) · 트리(`parentId`) · 직급(`rank`)을 갖는다. 기본은 부서 'd1' 의 팀 't1' 팀원.
import 'package:pixel_office/model/models.dart';

Member member(String id,
        {String? name,
        MemberStatus status = MemberStatus.idle,
        Engine engine = Engine.claude,
        String? createdAt,
        String departmentId = 'd1',
        String? teamId = 't1',
        String? parentId,
        MemberRank rank = MemberRank.member}) =>
    Member(
      id: id,
      departmentId: departmentId,
      teamId: rank == MemberRank.head ? null : teamId,
      parentId: parentId,
      name: name ?? id,
      rank: rank,
      engine: engine,
      sessionId: null,
      childPid: null,
      cwd: 'D:/x',
      status: status,
      hiredBy: HiredBy.user,
      memberToken: 'mt',
      instructionsPath: null,
      createdAt: createdAt ?? '2026-09-15T00:00:00.000Z',
      updatedAt: 'u',
    );

/// 부장(부서 직속, 팀 없음).
Member head(String id, {String? name, MemberStatus status = MemberStatus.idle, String departmentId = 'd1', String? createdAt, Engine engine = Engine.claude}) =>
    member(id, name: name, status: status, departmentId: departmentId, rank: MemberRank.head, createdAt: createdAt, engine: engine);

/// 팀장(부장의 자식).
Member lead(String id,
        {String? name,
        MemberStatus status = MemberStatus.idle,
        String departmentId = 'd1',
        String teamId = 't1',
        String? parentId,
        String? createdAt,
        Engine engine = Engine.claude}) =>
    member(id,
        name: name,
        status: status,
        departmentId: departmentId,
        teamId: teamId,
        parentId: parentId,
        rank: MemberRank.lead,
        createdAt: createdAt,
        engine: engine);

Team team(String id, {String name = 'pixel', String departmentId = 'd1', String? leaderId, String createdAt = '2026-09-15T00:00:00.000Z'}) => Team(
      id: id,
      departmentId: departmentId,
      name: name,
      cwd: 'D:/x',
      leaderId: leaderId,
      maxMembers: 4,
      allowedEngines: const [Engine.claude, Engine.codex],
      createdAt: createdAt,
    );

Department department(String id, {String name = 'alpha', String? headId, String createdAt = '2026-09-15T00:00:00.000Z'}) =>
    Department(id: id, name: name, cwd: 'D:/x', headId: headId, createdAt: createdAt);

OfficeEvent event(String memberId, OfficeEventKind kind,
        {int seq = 1, Map<String, dynamic> detail = const {}, EventRef ref = const EventRef()}) =>
    OfficeEvent(
      seq: seq,
      ts: '2026-09-15T00:00:00.000Z',
      departmentId: 'd1',
      teamId: 't1',
      memberId: memberId,
      kind: kind,
      detail: EventDetail(detail),
      ref: ref,
    );

Pending approval(String id, String memberId, String cmd, {String createdAt = '2026-09-15T00:00:00.000Z'}) => Pending(
      id: id,
      memberId: memberId,
      type: PendingType.approval,
      payload: {'tool_name': 'Bash', 'tool_input': {'command': cmd}},
      status: PendingStatus.open,
      createdAt: createdAt,
      answeredAt: null,
      answer: null,
    );

Pending question(String id, String memberId, String q, {String createdAt = '2026-09-15T00:00:00.000Z'}) => Pending(
      id: id,
      memberId: memberId,
      type: PendingType.question,
      payload: {'tool_input': {'questions': [{'question': q}]}},
      status: PendingStatus.open,
      createdAt: createdAt,
      answeredAt: null,
      answer: null,
    );

/// TeamTools `ask_user`(T17) 질문 pending — payload `{source, question, options}`(`tool_input` 없음, D-19).
Pending askUserQuestion(String id, String memberId, String q,
        {List<String> options = const [], String createdAt = '2026-09-15T00:00:00.000Z'}) =>
    Pending(
      id: id,
      memberId: memberId,
      type: PendingType.question,
      payload: {'source': 'ask_user', 'question': q, 'options': options},
      status: PendingStatus.open,
      createdAt: createdAt,
      answeredAt: null,
      answer: null,
    );

/// TeamTools `ask_parent`(T35) 질문 pending — payload `{source, question, options, from, to}`.
/// 사용자 몫이 아니다(T37): 내 책상 줄에 서지 않고 상사 책상으로 간다.
Pending askParentQuestion(String id, String memberId, String q,
        {required String to, List<String> options = const [], String createdAt = '2026-09-15T00:00:00.000Z'}) =>
    Pending(
      id: id,
      memberId: memberId,
      type: PendingType.question,
      payload: {'source': 'ask_parent', 'question': q, 'options': options, 'from': memberId, 'to': to},
      status: PendingStatus.open,
      createdAt: createdAt,
      answeredAt: null,
      answer: null,
    );
