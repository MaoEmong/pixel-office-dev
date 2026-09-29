// 데몬 시작(T14). 앱이 데몬과 끊겨 있을 때 `dev/daemon` 의 데몬을 띄운다 — 윈도우는 보이는 콘솔 창
// (`cmd /c start "" npm start`), 맥·리눅스는 창 없이 감시자와 **같은 스포너**(T48-2 · D-48).
// 데몬 폴더는 실행 파일 위치와 현재 디렉토리에서 위로 올라가며 `dev/daemon/package.json` 을 찾는다
// (개발 중 `dev/app`, 릴리즈 exe `dev/app/build/windows/x64/runner/Release` 둘 다 저장소 루트에 닿는다).

import 'dart:async';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../lifecycle/daemon_process.dart' show spawnDaemon;
import '../platform/platform.dart' as plat;
import '../rpc/daemon_info.dart';
import '../rpc/rpc_client.dart';
import '../state/office_state.dart';

class DaemonLaunchException implements Exception {
  const DaemonLaunchException(this.message);
  final String message;

  @override
  String toString() => message;
}

/// `startPaths` (기본: 현재 디렉토리, 실행 파일 폴더) 각각에서 위로 올라가며 `dev/daemon/package.json` 을 찾는다.
Future<Directory?> findDaemonDir({Iterable<String>? startPaths, plat.AppPlatform? platform}) async {
  final sep = (platform ?? plat.currentPlatform).pathSeparator;
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

/// 폴백 스포너(테스트 주입용) — 맥·리눅스에서 데몬을 띄우는 길.
typedef FallbackSpawn = Future<void> Function(Directory daemonDir);

Future<void> _spawnPipeMode(Directory daemonDir) async {
  // 감시자와 **같은 스포너**다(`node --import tsx …`, 파이프 모드). node 를 못 찾으면
  // [DaemonNodeNotFoundException] 이 그대로 올라가 버튼 아래 문구로 보인다.
  await spawnDaemon(daemonDir: daemonDir);
}

/// 데몬을 띄운다. 폴더를 못 찾으면 [DaemonLaunchException].
///
/// - 윈도우: 새 **콘솔 창**에서 분리 실행(`cmd /c start "" npm start`) — 실패 화면에서 원인을 눈으로 보는 용도.
/// - 맥·리눅스: `open -a Terminal` 같은 것을 쓰지 않는다. 창 없이 **감시자와 같은 스포너**로 띄운다
///   (D-48: 폴백 경로가 다른 길을 타면 맥에서 이 버튼만 따로 고장난다). 로그는 `daemon.log` 에 남는다.
Future<void> launchDaemon({Iterable<String>? startPaths, plat.AppPlatform? platform, FallbackSpawn? spawn}) async {
  final p = platform ?? plat.currentPlatform;
  final dir = await findDaemonDir(startPaths: startPaths, platform: p);
  if (dir == null) {
    throw const DaemonLaunchException('dev/daemon 폴더를 찾지 못했습니다 — 저장소 안에서 앱을 실행하거나 데몬을 직접 시작하세요(dev/daemon 에서 npm start).');
  }
  try {
    if (p.isWindows) {
      await Process.start('cmd', ['/c', 'start', '', 'npm', 'start'], workingDirectory: dir.path, mode: ProcessStartMode.detached);
      return;
    }
    await (spawn ?? _spawnPipeMode)(dir);
  } on ProcessException catch (e) {
    throw DaemonLaunchException('데몬 실행 실패: ${e.message}');
  }
}

/// 데몬을 띄운 뒤 daemon.json 이 나타나기를 기다리는 시간(실측 1~2초). 넘기면 [daemonNotStartedMessage].
const Duration daemonStartTimeout = Duration(seconds: 6);

/// 띄운 데몬이 조용히 죽었을 때(T41 실기): `cmd /c start` 는 분리 실행이라 **종료 코드를 못 본다** —
/// 대신 "daemon.json 이 안 생겼다" 로 판정하고 콘솔 창을 보라고 한다. 가장 흔한 원인이 포트 충돌이다
/// (다른 환경에서 띄운 데몬이 7420~7422 를 쥐고 있으면 daemon.json 은 그 환경에만 있다).
const String daemonNotStartedMessage =
    '데몬이 뜨지 않았습니다 — dev/daemon 콘솔 창의 오류를 확인하세요 (포트 7420~7422 를 다른 데몬이 쓰고 있을 수 있음)';

/// 데몬이 떴는가 = daemon.json 을 읽을 수 있는가.
Future<bool> daemonJsonPresent() async => (await DaemonInfo.read()) != null;

/// 끊김 오버레이용 "데몬 시작" 버튼. 띄운 뒤 `RpcClient.retryNow()` 를 바로, 그리고 2초·4초 뒤에 한 번 더 부른다
/// (데몬이 daemon.json 을 쓰기까지 1~2초). [daemonStartTimeout] 안에 daemon.json 이 안 나타나면 실패로 본다.
class DaemonStartButton extends ConsumerStatefulWidget {
  const DaemonStartButton({
    super.key,
    this.launcher = launchDaemon,
    this.checkDaemonJson = daemonJsonPresent,
    this.startTimeout = daemonStartTimeout,
  });

  /// 테스트용 주입.
  final Future<void> Function() launcher;

  /// daemon.json 이 생겼는지 확인(테스트용 주입 — 위젯 테스트에서 `dart:io` 를 직접 부르면 안 끝난다).
  final Future<bool> Function() checkDaemonJson;

  /// 이 시간 뒤에 한 번 확인한다.
  final Duration startTimeout;

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
      // 분리 실행이라 종료 코드를 못 본다 — daemon.json 이 안 생기면 콘솔 창을 보라고 한다(T41).
      _timers.add(Timer(widget.startTimeout, _checkStarted));
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

  /// [daemonStartTimeout] 뒤 한 번: 붙었으면 아무 말도 안 하고, daemon.json 이 없으면 실패로 알린다.
  Future<void> _checkStarted() async {
    if (!mounted) return;
    if (ref.read(connectionStateProvider) == RpcConnectionState.connected) return;
    final up = await widget.checkDaemonJson();
    if (!mounted || up) return;
    setState(() {
      _message = daemonNotStartedMessage;
      _isError = true;
    });
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
