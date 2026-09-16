// T12 테스트 공용 픽스처: Member / OfficeEvent / Pending 생성 헬퍼.
import 'package:pixel_office/model/models.dart';

Member member(String id,
        {String? name,
        MemberStatus status = MemberStatus.idle,
        Engine engine = Engine.claude,
        String? createdAt,
        String teamId = 't1',
        MemberRank rank = MemberRank.member}) =>
    Member(
      id: id,
      teamId: teamId,
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

OfficeEvent event(String memberId, OfficeEventKind kind, {int seq = 1, Map<String, dynamic> detail = const {}, EventRef ref = const EventRef()}) =>
    OfficeEvent(seq: seq, ts: '2026-09-15T00:00:00.000Z', teamId: 't1', memberId: memberId, kind: kind, detail: EventDetail(detail), ref: ref);

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
