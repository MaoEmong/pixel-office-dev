// 앱을 끄면 전부 같이 꺼진다(T46-2 · D-47 · 수명주기 §2).
//
//   창 닫기(X · Alt+F4 · 작업 표시줄) 가로채기
//     1. 일하는 중인 캐릭터가 있으면 확인 한 번 — 없으면 묻지 않는다.
//     2. 감시자를 멈추고(죽음을 재시작으로 오해하지 않게) `daemon.shutdown`.
//     3. 데몬 프로세스가 사라질 때까지 **최대 8초**(그동안 `정리하는 중…`). 넘으면 `taskkill /T /F`.
//     4. 앱이 끝난다.
//
//   예외는 둘뿐: 설정 "앱을 닫아도 계속 일하기" 와 `PIXEL_KEEP_DAEMON=1`. 그때는 **묻지도 끄지도 않는다.**
//   앱이 직접 띄운 데몬이 아니어도(콘솔에서 띄운 것) 똑같이 끈다 — 규칙이 하나여야 예측 가능하다.
//
// 이 파일의 [AppExitCoordinator] 는 위젯을 모른다(확인 다이얼로그는 주입받는 함수다). 배선은
// `lifecycle_gate.dart`.

import 'dart:async';
import 'dart:ui' show AppExitResponse;

/// 확인 다이얼로그 제목.
const String exitConfirmTitle = '픽셀 오피스 닫기';

/// 확인 다이얼로그 본문(수명주기 §2-1 의 문구 그대로).
String exitConfirmMessage(int working) =>
    '일하는 중인 캐릭터가 $working명 있습니다. 닫으면 전부 멈춥니다. (다음에 켜면 이어서 합니다)';

const String exitConfirmCloseLabel = '닫기';
const String exitConfirmCancelLabel = '취소';

/// 데몬을 끄는 동안 오버레이에 뜨는 말.
const String exitClosingLabel = '정리하는 중…';

/// 데몬이 스스로 꺼지기를 기다리는 상한(수명주기 §2-3).
const Duration daemonShutdownTimeout = Duration(seconds: 8);

/// 종료 흐름이 무엇을 했는지(로그·테스트용).
class ExitOutcome {
  const ExitOutcome({
    required this.response,
    this.asked = false,
    this.shutdownSent = false,
    this.waitedMs = 0,
    this.treeKilled = false,
    this.keptDaemon = false,
    this.error,
  });

  final AppExitResponse response;

  /// 확인 다이얼로그를 띄웠는가.
  final bool asked;

  /// `daemon.shutdown` 을 보냈는가.
  final bool shutdownSent;

  /// 데몬이 사라지기를 기다린 시간(ms).
  final int waitedMs;

  /// 8초를 넘겨 프로세스 트리를 강제 종료했는가.
  final bool treeKilled;

  /// "계속 일하기" 라 아무것도 안 했는가.
  final bool keptDaemon;

  /// `daemon.shutdown` 이 실패했으면 그 원인(그래도 종료는 계속한다).
  final String? error;

  bool get exiting => response == AppExitResponse.exit;

  @override
  String toString() => 'ExitOutcome(${response.name} asked=$asked shutdown=$shutdownSent '
      'waited=${waitedMs}ms kill=$treeKilled keep=$keptDaemon)';
}

class AppExitCoordinator {
  AppExitCoordinator({
    required this.keepDaemon,
    required this.workingCount,
    required this.confirm,
    required this.daemonPid,
    required this.shutdownDaemon,
    this.stopWatchingParent,
    required this.isAlive,
    required this.killTree,
    this.stopSupervisor,
    this.onClosingChanged,
    Future<void> Function(Duration)? sleep,
    DateTime Function()? now,
    this.shutdownTimeout = daemonShutdownTimeout,
    this.pollInterval = const Duration(milliseconds: 250),
  })  : _sleep = sleep ?? Future<void>.delayed,
        _now = now ?? DateTime.now;

  /// 지금 "앱을 닫아도 계속 일하기" 인가(설정 또는 `PIXEL_KEEP_DAEMON=1`).
  final bool Function() keepDaemon;

  /// 일하는 중인 캐릭터 수(범례 "작업" 칸 — `lifecycle_gate.dart` 의 `workingMemberCount`).
  final int Function() workingCount;

  /// 확인 다이얼로그. true = 닫기, false = 취소.
  final Future<bool> Function(int working) confirm;

  /// 지금 도는 데몬의 pid(`daemon.json`). 없으면 null — 기다릴 것도 죽일 것도 없다.
  final Future<int?> Function() daemonPid;

  /// `daemon.shutdown` RPC.
  final Future<void> Function() shutdownDaemon;

  /// `daemon.stopWatchingParent` RPC — "계속 일하기" 로 닫을 때 **데몬의 부모 감시를 끈다**(T46-3).
  final Future<void> Function()? stopWatchingParent;

  final Future<bool> Function(int pid) isAlive;
  final Future<void> Function(int pid) killTree;

  /// 감시자 정지(재시작이 끼어들지 않게). 확인을 통과한 **뒤** 부른다.
  final Future<void> Function()? stopSupervisor;

  /// `정리하는 중…` 표시 on/off.
  final void Function(bool closing)? onClosingChanged;

  final Future<void> Function(Duration) _sleep;
  final DateTime Function() _now;
  final Duration shutdownTimeout;
  final Duration pollInterval;

  bool _running = false;

  /// `AppLifecycleListener.onExitRequested` 가 그대로 부르는 것.
  Future<ExitOutcome> onExitRequested() async {
    // 두 번 눌러도 한 번만 돈다(그 사이의 요청은 그냥 종료를 허락한다 — 이미 정리 중이다).
    if (_running) return const ExitOutcome(response: AppExitResponse.exit);

    if (keepDaemon()) {
      // 옛 D-02 동작: 데몬과 세션이 그대로 남는다. 멈출 것이 없으니 묻지도 않는다.
      //
      // 단 **데몬의 부모 감시를 꺼 줘야 한다**(T46-3 실기 결함 ⑤). 설정을 앱을 켠 **뒤에** 켰다면
      // 데몬은 이미 `PIXEL_PARENT_PID` 를 들고 기동한 뒤다 — 그대로 닫으면 데몬이 "부모가 사라졌다" 로
      // 보고 §3 정리를 해 버려 **정반대 결과**가 된다(실기에서 세션 5개가 그대로 닫혔다).
      // 실패해도 종료는 막지 않는다(못 껐으면 옛날처럼 같이 꺼질 뿐이다).
      String? err;
      try {
        await stopWatchingParent?.call();
      } catch (e) {
        err = e.toString();
      }
      return ExitOutcome(response: AppExitResponse.exit, keptDaemon: true, error: err);
    }

    final working = workingCount();
    if (working > 0) {
      final ok = await confirm(working);
      if (!ok) return const ExitOutcome(response: AppExitResponse.cancel, asked: true);
    }

    _running = true;
    onClosingChanged?.call(true);
    var shutdownSent = false;
    var treeKilled = false;
    String? error;
    final started = _now();
    try {
      await stopSupervisor?.call();
      final pid = await daemonPid();
      try {
        await shutdownDaemon();
        shutdownSent = true;
      } catch (e) {
        // 이미 끊겼거나 데몬이 답하지 않는다 — 그래도 프로세스는 치운다.
        error = e.toString();
      }
      if (pid != null && pid > 0) {
        final deadline = started.add(shutdownTimeout);
        while (_now().isBefore(deadline)) {
          if (!await isAlive(pid)) break;
          await _sleep(pollInterval);
        }
        if (await isAlive(pid)) {
          await killTree(pid);
          treeKilled = true;
        }
      }
    } finally {
      onClosingChanged?.call(false);
      _running = false;
    }
    return ExitOutcome(
      response: AppExitResponse.exit,
      asked: working > 0,
      shutdownSent: shutdownSent,
      waitedMs: _now().difference(started).inMilliseconds,
      treeKilled: treeKilled,
      error: error,
    );
  }
}
