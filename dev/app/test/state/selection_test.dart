// 선택 멤버 provider(T24b: main.dart → lib/state/selection.dart 로 이전).
// 고른 멤버를 기억하고, 행이 사라지면(팀 삭제·스냅샷에서 빠짐) 자동 해제한다. 퇴근(exited)은 행이 남으므로 유지.
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pixel_office/state/office_state.dart';
import 'package:pixel_office/state/selection.dart';

import '../command/fake_rpc_client.dart';

/// 브로드캐스트 스트림 → 리스너 → state 반영까지 한 틱.
Future<void> settle() => Future<void>.delayed(Duration.zero);

void main() {
  late FakeRpcClient fake;
  late ProviderContainer container;

  setUp(() {
    fake = FakeRpcClient();
    container = ProviderContainer(overrides: fake.overrides);
    // provider 를 살려 둔다 — build 안의 `ref.listen(membersProvider)` 가 돌아야 자동 해제가 동작한다.
    container.listen(selectedMemberIdProvider, (_, _) {});
  });

  tearDown(() async {
    container.dispose();
    await fake.close();
  });

  test('select: 고른 멤버를 기억하고 null 로 직접 해제할 수 있다', () async {
    fake.emitHello(teams: [fakeTeam('t1')], members: [fakeMember('m1'), fakeMember('m2')]);
    await settle();
    expect(container.read(selectedMemberIdProvider), isNull);

    container.read(selectedMemberIdProvider.notifier).select('m1');
    expect(container.read(selectedMemberIdProvider), 'm1');
    container.read(selectedMemberIdProvider.notifier).select(null);
    expect(container.read(selectedMemberIdProvider), isNull);
  });

  test('퇴근(exited)은 행이 남으므로 선택 유지, 행이 사라지면 자동 해제', () async {
    fake.emitHello(teams: [fakeTeam('t1')], members: [fakeMember('m1'), fakeMember('m2')]);
    await settle();
    container.read(selectedMemberIdProvider.notifier).select('m1');

    fake.pushNotification('member.status', {'memberId': 'm1', 'status': 'exited', 'derived': 'exited'});
    await settle();
    expect(container.read(membersProvider)['m1']!.status.isGone, isTrue);
    expect(container.read(selectedMemberIdProvider), 'm1', reason: '퇴근한 멤버도 패널에서 로그를 볼 수 있어야 한다');

    // team.delete → 새 스냅샷에 그 멤버가 없다.
    fake.pushNotification('snapshot', {'seq': 9, 'teams': <Object>[], 'members': <Object>[], 'pending': <Object>[], 'tasks': <Object>[]});
    await settle();
    expect(container.read(selectedMemberIdProvider), isNull);
  });
}
