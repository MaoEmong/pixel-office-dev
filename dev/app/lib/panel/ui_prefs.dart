// 앱 로컬 UI 설정(T40-4, 레이아웃 v2 §3 패스 6) — 데몬과 무관한 "이 컴퓨터의 창 설정"만 담는다.
//
//  패널 폭  드래그 420~720, 기본 480, **앱 로컬 저장**(`%LOCALAPPDATA%\pixel-office\app-ui.json`).
//           터미널 탭을 열면 660 으로 자동 확장(80열 × D2Coding 13px ≈ 624 + 패딩 24 + 스크롤바 12),
//           다른 탭으로 가면 사용자가 정해 둔 폭으로 돌아온다.
//  터미널 오버레이  `Ctrl+T` = 사무실을 덮는 전체 폭 터미널(Esc 로 닫힘). 저장하지 않는다(창을 닫으면 사라짐).
//
// 저장은 실패해도 삼킨다 — 폭 하나 때문에 앱이 죽으면 안 된다. 테스트는 [uiPrefsStoreProvider] 를 덮어쓴다.

import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter_riverpod/flutter_riverpod.dart';

/// 패널 폭 하한·상한·기본(패스 6 표).
const double panelWidthMin = 420;
const double panelWidthMax = 720;
const double panelWidthDefault = 480;

/// 터미널 탭이 열렸을 때의 자동 확장 폭(80열이 들어가는 폭).
const double panelWidthTerminal = 660;

/// 드래그 손잡이 폭(클릭 목표 ≥ 8px, 히트 영역은 좌우로 더 넓다).
const double panelDividerWidth = 6;

// ---- 저장소 --------------------------------------------------------------------------

abstract class UiPrefsStore {
  Future<Map<String, dynamic>> read();
  Future<void> write(Map<String, dynamic> value);
}

/// `%LOCALAPPDATA%\pixel-office\app-ui.json`(또는 `PIXEL_DATA_DIR`). 데몬이 쓰는 `daemon.json` 과 같은 폴더.
class FileUiPrefsStore implements UiPrefsStore {
  const FileUiPrefsStore({this.path});

  final String? path;

  static String? defaultPath() {
    final env = Platform.environment;
    final dir = env['PIXEL_DATA_DIR'] ?? (env['LOCALAPPDATA'] == null ? null : '${env['LOCALAPPDATA']}\\pixel-office');
    return dir == null ? null : '$dir${Platform.pathSeparator}app-ui.json';
  }

  @override
  Future<Map<String, dynamic>> read() async {
    try {
      final p = path ?? defaultPath();
      if (p == null) return const {};
      final f = File(p);
      if (!await f.exists()) return const {};
      final v = jsonDecode(await f.readAsString());
      return v is Map ? Map<String, dynamic>.from(v) : const {};
    } catch (_) {
      return const {};
    }
  }

  @override
  Future<void> write(Map<String, dynamic> value) async {
    try {
      final p = path ?? defaultPath();
      if (p == null) return;
      final f = File(p);
      await f.parent.create(recursive: true);
      await f.writeAsString(jsonEncode(value));
    } catch (_) {
      // 삼킨다 — 창 설정 저장 실패로 앱이 흔들리면 안 된다.
    }
  }
}

/// 테스트·첫 실행용(디스크를 건드리지 않는다).
class MemoryUiPrefsStore implements UiPrefsStore {
  MemoryUiPrefsStore([Map<String, dynamic>? initial]) : _value = {...?initial};

  Map<String, dynamic> _value;

  Map<String, dynamic> get value => Map.unmodifiable(_value);

  @override
  Future<Map<String, dynamic>> read() async => Map<String, dynamic>.from(_value);

  @override
  Future<void> write(Map<String, dynamic> value) async => _value = Map<String, dynamic>.from(value);
}

final uiPrefsStoreProvider = Provider<UiPrefsStore>((ref) => const FileUiPrefsStore());

// ---- 패널 폭 -------------------------------------------------------------------------

class PanelWidthState {
  const PanelWidthState({required this.preferred, this.terminalActive = false});

  /// 사용자가 드래그로 정한 폭(저장되는 값).
  final double preferred;

  /// 터미널 탭이 열려 있는가(그동안 [width] 가 [panelWidthTerminal] 이상으로 벌어진다).
  final bool terminalActive;

  /// 실제로 그려지는 폭.
  double get width {
    if (!terminalActive) return preferred;
    return preferred > panelWidthTerminal ? preferred : panelWidthTerminal;
  }

  PanelWidthState copyWith({double? preferred, bool? terminalActive}) =>
      PanelWidthState(preferred: preferred ?? this.preferred, terminalActive: terminalActive ?? this.terminalActive);
}

double clampPanelWidth(double w) => w.clamp(panelWidthMin, panelWidthMax);

class PanelWidthNotifier extends Notifier<PanelWidthState> {
  Timer? _save;

  @override
  PanelWidthState build() {
    ref.onDispose(() => _save?.cancel());
    unawaited(_load());
    return const PanelWidthState(preferred: panelWidthDefault);
  }

  Future<void> _load() async {
    final stored = await ref.read(uiPrefsStoreProvider).read();
    final w = (stored['panelWidth'] as num?)?.toDouble();
    if (w == null) return;
    state = state.copyWith(preferred: clampPanelWidth(w));
  }

  /// 드래그·복원으로 사용자가 정한 폭(하한·상한 안으로 자른다). 저장은 300ms 모아서.
  void setPreferred(double w) {
    final next = clampPanelWidth(w);
    if (next == state.preferred) return;
    state = state.copyWith(preferred: next);
    _save?.cancel();
    _save = Timer(const Duration(milliseconds: 300), flush);
  }

  /// 드래그 델타.
  void dragBy(double dx) => setPreferred(state.preferred - dx);

  /// 터미널 탭이 활성인가 — 켜지면 [panelWidthTerminal] 로 벌어지고, 꺼지면 원래 폭으로 돌아온다.
  void setTerminalActive(bool active) {
    if (state.terminalActive == active) return;
    state = state.copyWith(terminalActive: active);
  }

  /// 대기 중인 저장을 바로 쓴다(테스트·종료 시).
  Future<void> flush() async {
    _save?.cancel();
    _save = null;
    final store = ref.read(uiPrefsStoreProvider);
    final current = await store.read();
    await store.write({...current, 'panelWidth': state.preferred});
  }
}

final panelWidthProvider = NotifierProvider<PanelWidthNotifier, PanelWidthState>(PanelWidthNotifier.new);

// ---- 터미널 오버레이 -----------------------------------------------------------------

class TerminalOverlayNotifier extends Notifier<bool> {
  @override
  bool build() => false;

  void toggle() => state = !state;
  void open() => state = true;
  void close() => state = false;
}

/// `Ctrl+T` 로 켜고 `Esc` 로 끄는 전체 폭 터미널(사무실 위를 덮는다).
final terminalOverlayProvider = NotifierProvider<TerminalOverlayNotifier, bool>(TerminalOverlayNotifier.new);
