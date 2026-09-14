// 데몬 시작(T14). 앱이 데몬과 끊겨 있을 때 `dev/daemon` 에서 `npm start` 를 분리 프로세스로 띄운다.
// 데몬 폴더는 실행 파일 위치와 현재 디렉토리에서 위로 올라가며 `dev/daemon/package.json` 을 찾는다
// (개발 중 `dev/app`, 릴리즈 exe `dev/app/build/windows/x64/runner/Release` 둘 다 저장소 루트에 닿는다).

import 'dart:async';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../state/office_state.dart';

class DaemonLaunchException implements Exception {
  const DaemonLaunchException(this.message);
  final String message;

  @override
  String toString() => message;
}

/// `startPaths` (기본: 현재 디렉토리, 실행 파일 폴더) 각각에서 위로 올라가며 `dev/daemon/package.json` 을 찾는다.
Future<Directory?> findDaemonDir({Iterable<String>? startPaths}) async {
  final sep = Platform.pathSeparator;
  final starts = startPaths ?? [Directory.current.path, File(Platform.resolvedExecutable).parent.path];
  for (final start in starts) {
    var dir = Directory(start).absolute;
    while (true) {
      final candidate = Directory('${dir.path}${sep}dev${sep}daemon');
      if (await File('${candidate.path}${sep}package.json').exists()) return candidate;
      final parent = dir.parent;
      if (parent.path == dir.path) break;
      dir = parent;
    }
  }
  return null;
}

/// 데몬을 새 콘솔 창에서 분리 실행한다(`cmd /c start "" npm start`). 폴더를 못 찾으면 [DaemonLaunchException].
Future<void> launchDaemon({Iterable<String>? startPaths}) async {
  final dir = await findDaemonDir(startPaths: startPaths);
  if (dir == null) {
    throw const DaemonLaunchException('dev/daemon 폴더를 찾지 못했습니다 — 저장소 안에서 앱을 실행하거나 데몬을 직접 시작하세요(dev/daemon 에서 npm start).');
  }
  try {
    if (Platform.isWindows) {
      await Process.start('cmd', ['/c', 'start', '', 'npm', 'start'], workingDirectory: dir.path, mode: ProcessStartMode.detached);
    } else {
      await Process.start('npm', ['start'], workingDirectory: dir.path, mode: ProcessStartMode.detached);
    }
  } on ProcessException catch (e) {
    throw DaemonLaunchException('데몬 실행 실패: ${e.message}');
  }
}

/// 끊김 오버레이용 "데몬 시작" 버튼. 띄운 뒤 `RpcClient.retryNow()` 를 바로, 그리고 2초·4초 뒤에 한 번 더 부른다
/// (데몬이 daemon.json 을 쓰기까지 1~2초).
class DaemonStartButton extends ConsumerStatefulWidget {
  const DaemonStartButton({super.key, this.launcher = launchDaemon});

  /// 테스트용 주입.
  final Future<void> Function() launcher;

  @override
  ConsumerState<DaemonStartButton> createState() => _DaemonStartButtonState();
}

class _DaemonStartButtonState extends ConsumerState<DaemonStartButton> {
  bool _busy = false;
  String? _message;
  bool _isError = false;
  final List<Timer> _timers = [];

  @override
  void dispose() {
    for (final t in _timers) {
      t.cancel();
    }
    super.dispose();
  }

  Future<void> _start() async {
    setState(() {
      _busy = true;
      _message = null;
      _isError = false;
    });
    try {
      await widget.launcher();
      final client = ref.read(rpcClientProvider);
      client.retryNow();
      for (final s in const [2, 4]) {
        _timers.add(Timer(Duration(seconds: s), client.retryNow));
      }
      if (mounted) setState(() => _message = '데몬 시작 중… (npm start)');
    } catch (e) {
      if (mounted) {
        setState(() {
          _message = e.toString();
          _isError = true;
        });
      }
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) => Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          FilledButton.icon(
            key: const Key('daemon.start'),
            onPressed: _busy ? null : _start,
            icon: const Icon(Icons.play_arrow),
            label: const Text('데몬 시작'),
          ),
          if (_message != null) ...[
            const SizedBox(height: 6),
            Text(
              _message!,
              key: const Key('daemon.start.message'),
              style: TextStyle(fontSize: 12, color: _isError ? Theme.of(context).colorScheme.error : Colors.white60),
              textAlign: TextAlign.center,
            ),
          ],
        ],
      );
}
