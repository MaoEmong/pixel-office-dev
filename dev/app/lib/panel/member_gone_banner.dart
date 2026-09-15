// 헤더 아래 배너 둘(T18) — 01 §데몬 재시작 복구, 성공 기준 6·10, PROTOCOL `member.rehire`.
//
//  MemberGoneBanner(member)   status 가 exited/error 일 때: "퇴근함" / "⚠ 오류로 종료됨 (code N)" + 재고용 버튼.
//     - code N 은 마지막 턴 경계 뒤의 `error{process exited (code N), exitCode}` 에서.
//     - 그 밖의 error 요약(`resume failed; started fresh session`, `restart: no session id to resume`, …)은 한 줄 더.
//     - 재고용 → `member.rehire{memberId}`. -32003(아직 살아 있음) 등 오류는 message 를 배너 안에. 성공하면 member.status 로
//       status 가 바뀌어 배너가 저절로 내려간다.
//  RecoveryHint(memberId)     데몬이 재시작되며 만료시킨 요청(`error{summary:'재지시 필요…', pendingId}`)이 마지막 턴 경계 뒤에 있으면
//     "데몬이 재시작됐어요 — 만료된 요청 N건" 한 줄. 복구 알림(`daemon.notice{복구: …}`)은 WS 가 열리기 전에 나가 클라이언트가
//     받지 못하므로(PROTOCOL 재시작 복구 8) 이벤트로 대신한다. 멤버가 새 턴을 끝내면 사라진다.

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../model/models.dart';
import '../rpc/rpc_client.dart';
import '../state/office_state.dart';
import 'member_log.dart';
import 'redo_card.dart' show isTurnBoundary;

/// 마지막 턴 경계(idle / 본문 있는 text) 뒤의 pendingId 없는 error 이벤트(오래된 순).
final memberFailureEventsProvider = Provider.family<List<OfficeEvent>, String>((ref, memberId) {
  final log = ref.watch(memberLogProvider(memberId));
  var out = <OfficeEvent>[];
  for (final ev in log) {
    if (isTurnBoundary(ev)) {
      out = [];
    } else if (ev.kind == OfficeEventKind.error && ev.detail.pendingId == null) {
      out.add(ev);
    }
  }
  return out;
});

/// 마지막 턴 경계 뒤의 `재지시 필요` error 건수.
final recoveryExpiredCountProvider = Provider.family<int, String>((ref, memberId) {
  final log = ref.watch(memberLogProvider(memberId));
  final ids = <String>{};
  for (final ev in log) {
    if (isTurnBoundary(ev)) {
      ids.clear();
    } else if (ev.kind == OfficeEventKind.error && ev.detail.pendingId != null && (ev.detail.summary ?? '').startsWith('재지시 필요')) {
      ids.add(ev.detail.pendingId!);
    }
  }
  return ids.length;
});

class MemberGoneBanner extends ConsumerStatefulWidget {
  const MemberGoneBanner({super.key, required this.member});

  final Member member;

  @override
  ConsumerState<MemberGoneBanner> createState() => _MemberGoneBannerState();
}

class _MemberGoneBannerState extends ConsumerState<MemberGoneBanner> {
  bool _busy = false;
  String? _error;

  Future<void> _rehire() async {
    if (_busy) return;
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      await ref.read(rpcClientProvider).call('member.rehire', {'memberId': widget.member.id});
      // 성공: member.status{starting} 가 오면 status 가 바뀌어 배너가 내려간다.
    } on RpcException catch (e) {
      if (mounted) setState(() => _error = e.code == RpcException.badState ? '재고용 실패: ${e.message}' : '재고용 실패: ${e.message} (${e.code})');
    } catch (e) {
      if (mounted) setState(() => _error = '재고용 실패: $e');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final m = widget.member;
    if (!m.status.isGone) return const SizedBox.shrink();
    final connected = ref.watch(connectionStateProvider) == RpcConnectionState.connected;
    final failures = ref.watch(memberFailureEventsProvider(m.id));
    int? exitCode;
    final extra = <String>[];
    for (final ev in failures) {
      final s = ev.detail.summary ?? '';
      if (s.startsWith('process exited')) {
        exitCode = ev.detail.exitCode ?? exitCode;
      } else if (s.isNotEmpty) {
        extra.add(s);
      }
    }
    final isError = m.status == MemberStatus.error;
    final title = isError ? '⚠ 오류로 종료됨${exitCode == null ? '' : ' (code $exitCode)'}' : '퇴근함';
    final color = isError ? const Color(0xFF5A2323) : const Color(0xFF3A3A3A);
    return Container(
      key: const Key('panel.goneBanner'),
      width: double.infinity,
      padding: const EdgeInsets.fromLTRB(12, 6, 8, 6),
      color: color,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        mainAxisSize: MainAxisSize.min,
        children: [
          Row(
            children: [
              Expanded(child: Text(title, style: const TextStyle(fontSize: 12.5, color: Colors.white, fontWeight: FontWeight.w600))),
              if (_busy)
                const SizedBox(width: 12, height: 12, child: CircularProgressIndicator(strokeWidth: 1.5, color: Colors.white54))
              else
                FilledButton.tonal(
                  key: const Key('panel.rehire'),
                  style: ButtonStyle(
                    visualDensity: VisualDensity.compact,
                    padding: const WidgetStatePropertyAll(EdgeInsets.symmetric(horizontal: 10, vertical: 2)),
                    minimumSize: const WidgetStatePropertyAll(Size(0, 28)),
                    tapTargetSize: MaterialTapTargetSize.shrinkWrap,
                    textStyle: const WidgetStatePropertyAll(TextStyle(fontSize: 12)),
                    shape: WidgetStatePropertyAll(RoundedRectangleBorder(borderRadius: BorderRadius.circular(3))),
                  ),
                  onPressed: connected ? _rehire : null,
                  child: const Text('재고용'),
                ),
            ],
          ),
          for (final line in extra)
            Padding(
              padding: const EdgeInsets.only(top: 2),
              child: Text(line, style: const TextStyle(fontSize: 11, color: Colors.white70)),
            ),
          if (!connected)
            const Padding(
              padding: EdgeInsets.only(top: 2),
              child: Text('데몬 연결 안 됨 — 재접속되면 재고용할 수 있습니다', style: TextStyle(fontSize: 11, color: Colors.white54)),
            ),
          if (_error != null)
            Padding(
              padding: const EdgeInsets.only(top: 2),
              child: Text(_error!, key: const Key('panel.rehire.error'), style: const TextStyle(fontSize: 11, color: Colors.redAccent)),
            ),
        ],
      ),
    );
  }
}

class RecoveryHint extends ConsumerWidget {
  const RecoveryHint({super.key, required this.memberId});

  final String memberId;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final n = ref.watch(recoveryExpiredCountProvider(memberId));
    if (n == 0) return const SizedBox.shrink();
    return Container(
      key: const Key('panel.recoveryHint'),
      width: double.infinity,
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 4),
      color: const Color(0xFF4A3A10),
      child: Row(
        children: [
          const Icon(Icons.restart_alt, size: 14, color: Colors.amber),
          const SizedBox(width: 6),
          Expanded(child: Text('데몬이 재시작됐어요 — 만료된 요청 $n건', style: const TextStyle(fontSize: 11.5, color: Colors.white70))),
        ],
      ),
    );
  }
}
