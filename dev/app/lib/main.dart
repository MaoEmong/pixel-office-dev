// 픽셀 오피스 데스크탑 앱 (M1 배선). 01-설계문서 §3 레이아웃:
//   상단 바(TopBar, T14) / 왼쪽 사무실(OfficeView, T12) / 오른쪽 패널(RightPanel, T13) / 아래 지시 바(CommandBar, T14).
// 데몬과 끊기면 사무실 위에 회색 오버레이 + "데몬 연결 안 됨" + "데몬 시작"(T14 launcher).

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import 'command/command_bar.dart';
import 'office/office_view.dart';
import 'panel/right_panel.dart';
import 'rpc/rpc_client.dart';
import 'state/office_state.dart';
import 'topbar/daemon_launcher.dart';
import 'topbar/notices.dart';
import 'topbar/top_bar.dart';

void main() {
  runApp(const ProviderScope(child: PixelOfficeApp()));
}

/// 사무실에서 클릭해 선택한 멤버. 오른쪽 패널·지시 바·상단 바 퇴근 버튼이 공유한다.
final selectedMemberIdProvider = NotifierProvider<SelectedMemberId, String?>(SelectedMemberId.new);

class SelectedMemberId extends Notifier<String?> {
  @override
  String? build() {
    // 선택된 멤버가 사라지면(퇴근·팀 삭제) 선택 해제.
    ref.listen(membersProvider, (_, members) {
      final id = state;
      if (id != null && !members.containsKey(id)) state = null;
    });
    return null;
  }

  void select(String? id) => state = id;
}

class PixelOfficeApp extends StatelessWidget {
  const PixelOfficeApp({super.key});

  @override
  Widget build(BuildContext context) => MaterialApp(
        title: '픽셀 오피스',
        debugShowCheckedModeBanner: false,
        theme: ThemeData(
          brightness: Brightness.dark,
          colorScheme: ColorScheme.fromSeed(seedColor: const Color(0xFF6C8EFF), brightness: Brightness.dark),
          useMaterial3: true,
        ),
        home: const OfficeShell(),
      );
}

/// 전체 레이아웃. 오버레이는 상단 바 아래 전부를 덮는다.
class OfficeShell extends ConsumerWidget {
  const OfficeShell({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final connection = ref.watch(connectionStateProvider);
    final selected = ref.watch(selectedMemberIdProvider);
    final teamId = ref.watch(activeTeamIdProvider);
    return Scaffold(
      body: Column(
        children: [
          TopBar(selectedMemberId: selected),
          Expanded(
            child: Stack(
              children: [
                Column(
                  children: [
                    Expanded(
                      child: Row(
                        children: [
                          Expanded(
                            flex: 3,
                            child: OfficeView(
                              selectedMemberId: selected,
                              teamId: teamId,
                              onSelectMember: (id) => ref.read(selectedMemberIdProvider.notifier).select(id),
                            ),
                          ),
                          SizedBox(width: 420, child: RightPanel(memberId: selected)),
                        ],
                      ),
                    ),
                    CommandBar(selectedMemberId: selected),
                  ],
                ),
                if (connection != RpcConnectionState.connected) const DisconnectedOverlay(),
                const NoticeBanner(),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

/// 데몬 연결이 끊겼을 때 사무실을 덮는 회색 오버레이 + "데몬 시작".
class DisconnectedOverlay extends ConsumerWidget {
  const DisconnectedOverlay({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final attempts = ref.watch(reconnectAttemptsProvider);
    final connection = ref.watch(connectionStateProvider);
    final error = ref.watch(officeProvider.select((s) => s.lastError));
    return Positioned.fill(
      child: Container(
        color: Colors.grey.shade900.withValues(alpha: 0.82),
        alignment: Alignment.center,
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            const Icon(Icons.power_off, size: 48, color: Colors.white54),
            const SizedBox(height: 12),
            const Text('데몬 연결 안 됨', style: TextStyle(fontSize: 22, color: Colors.white)),
            const SizedBox(height: 8),
            Text(
              connection == RpcConnectionState.connecting ? '연결 중…' : '재접속 대기 중 (시도 $attempts회)',
              style: const TextStyle(color: Colors.white60),
            ),
            if (error != null) ...[
              const SizedBox(height: 4),
              Text(error, style: const TextStyle(color: Colors.white38, fontSize: 12), textAlign: TextAlign.center),
            ],
            const SizedBox(height: 16),
            Row(
              mainAxisSize: MainAxisSize.min,
              children: [
                OutlinedButton(
                  onPressed: () => ref.read(rpcClientProvider).retryNow(),
                  child: const Text('다시 연결'),
                ),
                const SizedBox(width: 12),
                const DaemonStartButton(),
              ],
            ),
          ],
        ),
      ),
    );
  }
}
