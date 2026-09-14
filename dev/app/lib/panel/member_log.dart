// 멤버 로그(표시 전용) — 04-결정기록 D-21.
//
// 상태 층의 링버퍼(`memberEventsProvider`)는 앱이 켜진 뒤 라이브로 받은 이벤트만 담고, 재접속 replay 는
// 버려진다(재접속 규칙 2). 로그 탭은 그래서 `events.query{memberId, limit}` 로 과거를 따로 받아(백필)
// 라이브 링과 seq 로 합친다. 백필은 연결될 때마다(첫 접속·재접속) 다시 받는다.
//
//  memberBackfillProvider(id) : Notifier — events.query 결과(seq → 이벤트) + loading/error. 라이브 이벤트를
//                               watch 하지 않으므로 이벤트마다 재생성되지 않는다(Riverpod 3 는 rebuild 시
//                               Notifier 를 새로 만든다 — 진행 중인 요청이 버려지지 않게 분리).
//  memberLogProvider(id)      : 백필 ∪ 라이브 링, seq 오름차순·중복 제거.
//  latestTextEventProvider(id): 보고서 탭 자리용 — 로그 중 마지막 `text` 이벤트.

import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../model/models.dart';
import '../rpc/rpc_client.dart';
import '../state/office_state.dart';

/// `events.query` 한 번에 받는 건수.
const int logBackfillLimit = 200;

class MemberBackfill {
  const MemberBackfill({this.events = const {}, this.loading = false, this.error, this.loadedCount = 0});

  /// seq → 이벤트.
  final Map<int, OfficeEvent> events;
  final bool loading;

  /// 마지막 백필 실패 원인(표시용). 성공하면 null.
  final String? error;

  /// 성공한 백필 횟수(테스트·디버그).
  final int loadedCount;

  MemberBackfill copyWith({Map<int, OfficeEvent>? events, bool? loading, String? error, bool clearError = false, int? loadedCount}) =>
      MemberBackfill(
        events: events ?? this.events,
        loading: loading ?? this.loading,
        error: clearError ? null : (error ?? this.error),
        loadedCount: loadedCount ?? this.loadedCount,
      );
}

class MemberBackfillNotifier extends Notifier<MemberBackfill> {
  MemberBackfillNotifier(this.memberId);

  final String memberId;
  int _inflight = 0;

  @override
  MemberBackfill build() {
    // watch 가 아니라 listen — 연결 상태가 바뀌어도 이 Notifier 는 재생성되지 않는다.
    ref.listen<RpcConnectionState>(connectionStateProvider, (prev, next) {
      if (next == RpcConnectionState.connected && prev != RpcConnectionState.connected) refresh();
    });
    if (ref.read(connectionStateProvider) == RpcConnectionState.connected) {
      Future.microtask(refresh);
    }
    return const MemberBackfill();
  }

  /// `events.query{memberId, limit}` 를 다시 받는다. 동시 호출은 마지막 결과만 반영.
  Future<void> refresh() async {
    if (!ref.mounted) return;
    final client = ref.read(rpcClientProvider);
    final ticket = ++_inflight;
    state = state.copyWith(loading: true);
    try {
      final r = await client.call('events.query', {'memberId': memberId, 'limit': logBackfillLimit});
      if (!ref.mounted || ticket != _inflight) return;
      final merged = <int, OfficeEvent>{...state.events};
      for (final raw in (r['events'] as List?) ?? const []) {
        try {
          final ev = OfficeEvent.fromJson(Map<String, dynamic>.from(raw as Map));
          merged[ev.seq] = ev;
        } on FormatException {
          // 모르는 kind(프로토콜 확장) — 건너뜀
        } on TypeError {
          // 필드 누락
        }
      }
      state = MemberBackfill(events: merged, loading: false, loadedCount: state.loadedCount + 1);
    } on RpcException catch (e) {
      if (!ref.mounted || ticket != _inflight) return;
      state = state.copyWith(loading: false, error: e.message);
    } catch (e) {
      if (!ref.mounted || ticket != _inflight) return;
      state = state.copyWith(loading: false, error: e.toString());
    }
  }
}

final memberBackfillProvider =
    NotifierProvider.family<MemberBackfillNotifier, MemberBackfill, String>(MemberBackfillNotifier.new);

/// 로그 탭이 그리는 목록: 백필 ∪ 라이브 링, seq 오름차순(최신이 아래), seq 중복 제거.
final memberLogProvider = Provider.family<List<OfficeEvent>, String>((ref, id) {
  final backfill = ref.watch(memberBackfillProvider(id)).events;
  final live = ref.watch(memberEventsProvider(id));
  if (backfill.isEmpty) return live;
  final merged = <int, OfficeEvent>{...backfill};
  for (final ev in live) {
    merged[ev.seq] = ev;
  }
  final list = merged.values.toList(growable: false)..sort((a, b) => a.seq.compareTo(b.seq));
  return list;
});

/// 보고서 탭 자리(v1a): 그 멤버의 마지막 `text` 이벤트(턴 단위 응답). 없으면 null.
final latestTextEventProvider = Provider.family<OfficeEvent?, String>((ref, id) {
  final log = ref.watch(memberLogProvider(id));
  for (var i = log.length - 1; i >= 0; i--) {
    final ev = log[i];
    if (ev.kind == OfficeEventKind.text && (ev.detail.text ?? '').isNotEmpty) return ev;
  }
  return null;
});
