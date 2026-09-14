// 픽셀 오피스 데스크탑 앱 골격(T11). 01-설계문서 §3 레이아웃의 자리만 잡는다:
//   상단 바(연결 상태·데몬 버전·개수) / 왼쪽 사무실(T12) / 오른쪽 패널 탭(T13) / 아래 지시 바(T14).
// 데몬과 끊기면 사무실 위에 회색 오버레이 + "데몬 연결 안 됨".

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import 'model/models.dart';
import 'rpc/rpc_client.dart';
import 'state/office_state.dart';

void main() {
  runApp(const ProviderScope(child: PixelOfficeApp()));
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
    return Scaffold(
      body: Column(
        children: [
          const TopBar(),
          Expanded(
            child: Stack(
              children: [
                const Column(
                  children: [
                    Expanded(
                      child: Row(
                        children: [
                          Expanded(flex: 3, child: OfficeArea()),
                          SizedBox(width: 380, child: RightPanel()),
                        ],
                      ),
                    ),
                    CommandBar(),
                  ],
                ),
                if (connection != RpcConnectionState.connected) const DisconnectedOverlay(),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

class TopBar extends ConsumerWidget {
  const TopBar({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final connection = ref.watch(connectionStateProvider);
    final version = ref.watch(daemonVersionProvider);
    final pid = ref.watch(daemonPidProvider);
    final teams = ref.watch(teamsProvider).length;
    final members = ref.watch(membersProvider).length;
    final pending = ref.watch(openPendingProvider).length;
    final lastSeq = ref.watch(lastSeqProvider);
    final (label, color) = switch (connection) {
      RpcConnectionState.connected => ('연결됨', Colors.greenAccent),
      RpcConnectionState.connecting => ('연결 중', Colors.amber),
      RpcConnectionState.disconnected => ('연결 안 됨', Colors.redAccent),
    };
    final style = Theme.of(context).textTheme.bodyMedium;
    return Container(
      height: 40,
      padding: const EdgeInsets.symmetric(horizontal: 12),
      color: Theme.of(context).colorScheme.surfaceContainerHigh,
      child: Row(
        children: [
          Text('픽셀 오피스', style: style?.copyWith(fontWeight: FontWeight.bold)),
          const SizedBox(width: 16),
          Icon(Icons.circle, size: 10, color: color),
          const SizedBox(width: 6),
          Text('데몬 $label', style: style),
          if (version != null) ...[
            const SizedBox(width: 8),
            Text('v$version${pid != null ? ' · pid $pid' : ''}', style: style?.copyWith(color: Colors.white54)),
          ],
          const Spacer(),
          Text('팀 $teams · 멤버 $members · 대기 $pending · seq $lastSeq', style: style),
        ],
      ),
    );
  }
}

/// 왼쪽 사무실 — T12 에서 CustomPainter 로 교체. 지금은 자리 + 멤버 상태 한 줄씩.
class OfficeArea extends ConsumerWidget {
  const OfficeArea({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final members = ref.watch(membersProvider).values.toList()..sort((a, b) => a.name.compareTo(b.name));
    final teams = ref.watch(teamsProvider);
    return Container(
      color: const Color(0xFF1B1F2A),
      padding: const EdgeInsets.all(16),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text('사무실 (T12 CustomPainter 자리)', style: Theme.of(context).textTheme.titleMedium?.copyWith(color: Colors.white38)),
          const SizedBox(height: 12),
          if (members.isEmpty)
            const Text('멤버 없음', style: TextStyle(color: Colors.white38))
          else
            for (final m in members) _MemberLine(member: m, teamName: teams[m.teamId]?.name ?? m.teamId),
        ],
      ),
    );
  }
}

class _MemberLine extends ConsumerWidget {
  const _MemberLine({required this.member, required this.teamName});

  final Member member;
  final String teamName;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final derived = ref.watch(derivedStatusProvider(member.id));
    final latest = ref.watch(latestEventProvider(member.id));
    final bubble = latest == null ? '' : '  💬 ${latest.kind.wire}: ${latest.detail.oneLine}';
    return Padding(
      padding: const EdgeInsets.only(bottom: 4),
      child: Text(
        '${member.name} [${member.engine.name}] $teamName · ${member.status.wire}'
        '${derived != null && derived.wire != member.status.wire ? ' (${derived.wire})' : ''}$bubble',
        style: const TextStyle(color: Colors.white70, fontSize: 13),
        overflow: TextOverflow.ellipsis,
      ),
    );
  }
}

/// 오른쪽 패널 — T13 에서 터미널(xterm)·로그 탭 구현.
class RightPanel extends StatelessWidget {
  const RightPanel({super.key});

  @override
  Widget build(BuildContext context) => DefaultTabController(
        length: 4,
        child: Container(
          color: Theme.of(context).colorScheme.surfaceContainerLow,
          child: const Column(
            children: [
              TabBar(
                tabs: [Tab(text: '터미널'), Tab(text: '로그'), Tab(text: '보고서'), Tab(text: '지시문')],
                labelStyle: TextStyle(fontSize: 13),
              ),
              Expanded(
                child: TabBarView(
                  children: [
                    _Placeholder('터미널 탭 (T13 · xterm + member.attach)'),
                    _Placeholder('로그 탭 (T13 · events)'),
                    _Placeholder('보고서 (M4)'),
                    _Placeholder('지시문 (M2)'),
                  ],
                ),
              ),
            ],
          ),
        ),
      );
}

class _Placeholder extends StatelessWidget {
  const _Placeholder(this.label);
  final String label;

  @override
  Widget build(BuildContext context) => Center(child: Text(label, style: const TextStyle(color: Colors.white38)));
}

/// 아래 지시 바 — T14 에서 대상 선택·Enter 전송·bracketed paste 구현.
class CommandBar extends StatelessWidget {
  const CommandBar({super.key});

  @override
  Widget build(BuildContext context) => Container(
        height: 56,
        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
        color: Theme.of(context).colorScheme.surfaceContainerHigh,
        child: Row(
          children: [
            const SizedBox(
              width: 140,
              child: TextField(
                enabled: false,
                decoration: InputDecoration(isDense: true, border: OutlineInputBorder(), hintText: '대상 (T14)'),
              ),
            ),
            const SizedBox(width: 8),
            const Expanded(
              child: TextField(
                enabled: false,
                decoration: InputDecoration(isDense: true, border: OutlineInputBorder(), hintText: '지시 입력 — Enter 전송 (T14)'),
              ),
            ),
            const SizedBox(width: 8),
            IconButton(onPressed: null, icon: const Icon(Icons.send)),
          ],
        ),
      );
}

/// 데몬 연결이 끊겼을 때 사무실을 덮는 회색 오버레이. T14 에서 "데몬 시작" 버튼 추가.
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
            OutlinedButton(
              onPressed: () => ref.read(rpcClientProvider).retryNow(),
              child: const Text('다시 연결'),
            ),
          ],
        ),
      ),
    );
  }
}
