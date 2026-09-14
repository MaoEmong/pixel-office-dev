// daemon.notice 토스트(T14). `NoticeBanner` 가 `noticesProvider` 를 지켜보다 마지막 알림을 오른쪽 아래에 5초 보여 준다.
//  - `NoticeBanner()`: Stack 의 자식으로 사무실 위에 겹쳐 놓는다(Align bottomRight — 알림이 없으면 아무것도 안 그리고 클릭도 막지 않는다).
//  - `NoticeToaster(child: ...)`: 위 배너를 child 위에 겹쳐 주는 편의 래퍼(`NoticeToaster(child: OfficeShell())`).
//  - `NoticeCard`: 배너 본체(level 별 색). 위치·타이머 없음.

import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../model/models.dart';
import '../state/office_state.dart';

/// 배너 자동 숨김 시간.
const Duration noticeBannerDuration = Duration(seconds: 5);

/// `noticesProvider` 의 마지막 `daemon.notice` 를 오른쪽 아래에 [duration] 동안 보여 주는 오버레이.
/// Stack 안에 그대로 넣는다. 새 알림이 오면 타이머를 다시 시작한다.
class NoticeBanner extends ConsumerStatefulWidget {
  const NoticeBanner({super.key, this.duration = noticeBannerDuration, this.margin = const EdgeInsets.only(right: 16, bottom: 72)});

  final Duration duration;

  /// 오른쪽 아래 여백(기본은 지시 바 위).
  final EdgeInsets margin;

  @override
  ConsumerState<NoticeBanner> createState() => _NoticeBannerState();
}

class _NoticeBannerState extends ConsumerState<NoticeBanner> {
  DaemonNotice? _current;
  Timer? _timer;

  @override
  void dispose() {
    _timer?.cancel();
    super.dispose();
  }

  void _show(DaemonNotice n) {
    _timer?.cancel();
    setState(() => _current = n);
    _timer = Timer(widget.duration, _hide);
  }

  void _hide() {
    _timer?.cancel();
    _timer = null;
    if (mounted && _current != null) setState(() => _current = null);
  }

  @override
  Widget build(BuildContext context) {
    ref.listen<List<DaemonNotice>>(noticesProvider, (prev, next) {
      if (next.isEmpty) return;
      final last = next.last;
      if (prev != null && prev.isNotEmpty && identical(prev.last, last)) return;
      _show(last);
    });
    final n = _current;
    if (n == null) return const SizedBox.shrink();
    return Align(
      alignment: Alignment.bottomRight,
      child: Padding(
        padding: widget.margin,
        child: NoticeCard(notice: n, onClose: _hide),
      ),
    );
  }
}

/// [child] 위에 [NoticeBanner] 를 겹쳐 주는 편의 래퍼.
class NoticeToaster extends StatelessWidget {
  const NoticeToaster({super.key, required this.child, this.duration = noticeBannerDuration});

  final Widget child;
  final Duration duration;

  @override
  Widget build(BuildContext context) => Stack(
        children: [
          child,
          NoticeBanner(duration: duration),
        ],
      );
}

/// 배너 본체. 색은 level 별.
class NoticeCard extends StatelessWidget {
  const NoticeCard({super.key, required this.notice, this.onClose});

  final DaemonNotice notice;
  final VoidCallback? onClose;

  @override
  Widget build(BuildContext context) {
    final (color, icon) = switch (notice.level) {
      NoticeLevel.info => (const Color(0xFF2E3A59), Icons.info_outline),
      NoticeLevel.warn => (const Color(0xFF6B4E00), Icons.warning_amber_outlined),
      NoticeLevel.error => (const Color(0xFF7A1F1F), Icons.error_outline),
    };
    return Material(
      key: const Key('notice.banner'),
      elevation: 6,
      color: color,
      borderRadius: BorderRadius.circular(8),
      child: ConstrainedBox(
        constraints: const BoxConstraints(maxWidth: 420),
        child: Padding(
          padding: const EdgeInsets.fromLTRB(12, 8, 4, 8),
          child: Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              Icon(icon, size: 18, color: Colors.white70),
              const SizedBox(width: 8),
              Flexible(child: Text(notice.message, style: const TextStyle(fontSize: 13, color: Colors.white))),
              const SizedBox(width: 4),
              IconButton(
                key: const Key('notice.close'),
                onPressed: onClose,
                icon: const Icon(Icons.close, size: 16, color: Colors.white54),
                visualDensity: VisualDensity.compact,
                tooltip: '닫기',
              ),
            ],
          ),
        ),
      ),
    );
  }
}
