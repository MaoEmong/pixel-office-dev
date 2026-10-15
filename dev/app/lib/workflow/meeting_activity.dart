import '../model/models.dart';

String? meetingMemberActivity(
  Map<String, dynamic>? workflow,
  Member member,
  DerivedStatus? derived,
) {
  if (workflow == null ||
      !['meeting', 'blocked', 'executing'].contains(workflow['phase'])) {
    return null;
  }
  if (member.status.isGone || member.status == MemberStatus.suspended) {
    return null;
  }
  final assignments = (workflow['assignments'] as List? ?? [])
      .whereType<Map>()
      .toList();
  if (assignments.isNotEmpty &&
      ['executing', 'blocked'].contains(workflow['phase'])) {
    if (workflow['phase'] == 'blocked') {
      return member.rank == MemberRank.head ||
              assignments.any((a) => a['leadId'] == member.id)
          ? '작업 중단 · 문제 확인 필요'
          : null;
    }
    if (derived == DerivedStatus.waitingApproval ||
        member.status == MemberStatus.waitingApproval) {
      return '업무 중 · 승인 대기';
    }
    if (derived == DerivedStatus.waitingAnswer ||
        member.status == MemberStatus.waitingAnswer) {
      return '업무 중 · 질문 답변 대기';
    }
    if (member.rank == MemberRank.head) {
      return assignments.every((a) => a['status'] == 'done')
          ? '팀별 결과 확인 · 최종 보고'
          : '팀별 업무 진행 · 보고 대기';
    }
    final assignment = assignments
        .where((a) => a['leadId'] == member.id)
        .firstOrNull;
    if (assignment == null) return null;
    return switch (assignment['status']) {
      'queued' => '선행 업무 완료 대기',
      'assigned' =>
        member.status == MemberStatus.working ? '배정 업무 진행 중' : '배정 업무 응답 대기',
      'done' => '담당 업무 완료 · 다른 팀 대기',
      _ => null,
    };
  }
  final meeting = workflow['meeting'] as Map?;
  final participants = (meeting?['participants'] as List? ?? []);
  if (member.rank != MemberRank.head && !participants.contains(member.id)) {
    return workflow['phase'] == 'meeting' &&
            meeting == null &&
            member.rank == MemberRank.lead
        ? '회의 소집 대기'
        : null;
  }
  if (workflow['phase'] == 'blocked') return '회의 중단 · 문제 확인 필요';
  if (derived == DerivedStatus.waitingApproval ||
      member.status == MemberStatus.waitingApproval) {
    return '회의 중 · 승인 대기';
  }
  if (derived == DerivedStatus.waitingAnswer ||
      member.status == MemberStatus.waitingAnswer) {
    return '회의 중 · 질문 답변 대기';
  }
  if (meeting == null) return '회의 준비 · 팀 구성 중';
  if (meeting['state'] == 'deciding') {
    return member.rank == MemberRank.head
        ? '의견 조율 · 회의 결정 중'
        : '의견 제출 완료 · 부장 결정 대기';
  }
  final round = meeting['round'] ?? (meeting['state'] == 'reviewing' ? 2 : 1);
  if (member.rank == MemberRank.head) return '$round차 회의 진행 · 참석자 의견 대기';
  final submitted = (meeting['contributions'] as List? ?? [])
      .whereType<Map>()
      .any((c) => c['memberId'] == member.id && c['round'] == round);
  if (submitted) return '$round차 의견 제출 완료 · 다음 차례 대기';
  return member.status == MemberStatus.working
      ? '$round차 의견 작성 중'
      : '$round차 의견 제출 대기';
}
