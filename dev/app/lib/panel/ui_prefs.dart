// 앱 로컬 UI 설정(T40-4, 레이아웃 v2 §3 패스 6) — 데몬과 무관한 "이 컴퓨터의 창 설정"만 담는다.
//
//  패널 폭  드래그 420~720, 기본 480, **앱 로컬 저장**(`%LOCALAPPDATA%\pixel-office\app-ui.json`).
//           터미널 탭을 열면 660 으로 자동 확장(80열 × D2Coding 13px ≈ 624 + 패딩 24 + 스크롤바 12),
//           다른 탭으로 가면 사용자가 정해 둔 폭으로 돌아온다.
//  터미널 오버레이  `Ctrl+T` = 사무실을 덮는 전체 폭 터미널(Esc 로 닫힘). 저장하지 않는다(창을 닫으면 사라짐).
//  부서 폴더      부서 만들기의 폴더 선택기가 처음 여는 폴더(T41) = 마지막으로 고른 폴더의 **부모**.
//                 (프로젝트들은 보통 한 부모 아래 나란히 있다 — `D:\myproject\pixel-office` 를 골랐으면
//                  다음엔 `D:\myproject` 에서 시작하는 게 형제 프로젝트를 고르기 쉽다.)
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

// ---- 부서 폴더(폴더 선택기의 시작 위치, T41) ------------------------------------------

/// 앱 로컬 prefs 의 키.
const String lastDepartmentDirKey = 'lastDepartmentDir';

/// [dir] 의 부모 경로. 루트(부모가 자기 자신)면 null — 저장할 값이 없다는 뜻.
String? parentDirOf(String dir) {
  final trimmed = dir.trim();
  if (trimmed.isEmpty) return null;
  final parent = Directory(trimmed).parent.path;
  return parent == trimmed || parent.isEmpty ? null : parent;
}

/// 부서 만들기 폴더 선택기가 처음 열 폴더. 고른 폴더의 **부모**를 기억한다(형제 프로젝트를 고르기 쉽게).
/// 값이 없으면 null — 그러면 선택기는 OS 기본 위치에서 연다.
class LastDepartmentDirNotifier extends Notifier<String?> {
  late final Future<void> _loaded;

  @override
  String? build() {
    _loaded = _load();
    return null;
  }

  /// 저장된 값을 **다 읽고 나서** 준다 — 선택기를 여는 순간엔 상태가 아직 안 찼을 수 있다.
  Future<String?> initialDir() async {
    await _loaded;
    return state;
  }

  Future<void> _load() async {
    final stored = await ref.read(uiPrefsStoreProvider).read();
    final v = stored[lastDepartmentDirKey];
    if (v is String && v.isNotEmpty) state = v;
  }

  /// 방금 고른 폴더를 기억한다(저장되는 값은 그 **부모**). 저장 실패는 삼킨다.
  Future<void> remember(String pickedDir) async {
    final parent = parentDirOf(pickedDir);
    if (parent == null || parent == state) return;
    state = parent;
    final store = ref.read(uiPrefsStoreProvider);
    final current = await store.read();
    await store.write({...current, lastDepartmentDirKey: parent});
  }
}

final lastDepartmentDirProvider =
    NotifierProvider<LastDepartmentDirNotifier, String?>(LastDepartmentDirNotifier.new);

// ---- 앱을 닫아도 계속 일하기(T46-2, 수명주기 §2) ----------------------------------------

/// 앱 로컬 prefs 의 키. **기본 꺼짐** — D-47 의 기본은 "앱·데몬·세션은 한 몸" 이다.
const String keepDaemonKey = 'keepDaemonOnExit';

/// 설정 이름·설명(상단 바 `⋮` 메뉴).
const String keepDaemonLabel = '앱을 닫아도 계속 일하기';
const String keepDaemonHint = '끄면(기본) 앱을 닫을 때 데몬과 AI 세션이 같이 꺼집니다. 켜면 그대로 남아 계속 일합니다.';

/// 개발용 환경변수 — `1` 이면 설정과 무관하게 켜진 것으로 본다(수명주기 §2).
const String keepDaemonEnvVar = 'PIXEL_KEEP_DAEMON';

bool keepDaemonFromEnv([Map<String, String>? env]) => (env ?? Platform.environment)[keepDaemonEnvVar] == '1';

/// 저장된 값 한 번 읽기(`main()` 이 감시자를 만들기 **전에** 쓴다 — 부모 감시 여부가 여기서 갈린다).
Future<bool> readKeepDaemon(UiPrefsStore store, {Map<String, String>? env}) async {
  if (keepDaemonFromEnv(env)) return true;
  final stored = await store.read();
  return stored[keepDaemonKey] == true;
}

/// `⋮` 메뉴의 토글. 환경변수가 켜져 있으면 **끌 수 없다**(그 세션 내내 켜진 것으로 본다).
class KeepDaemonNotifier extends Notifier<bool> {
  @override
  bool build() {
    if (ref.watch(keepDaemonEnvProvider)) return true;
    unawaited(_load());
    return false;
  }

  Future<void> _load() async {
    final stored = await ref.read(uiPrefsStoreProvider).read();
    if (stored[keepDaemonKey] == true) state = true;
  }

  /// 값을 바꾸고 바로 저장한다. 환경변수로 켜져 있으면 무시.
  Future<void> set(bool value) async {
    if (ref.read(keepDaemonEnvProvider)) return;
    if (state == value) return;
    state = value;
    final store = ref.read(uiPrefsStoreProvider);
    final current = await store.read();
    await store.write({...current, keepDaemonKey: value});
  }

  Future<void> toggle() => set(!state);
}

/// `PIXEL_KEEP_DAEMON=1` 인가(테스트가 덮어쓴다).
final keepDaemonEnvProvider = Provider<bool>((_) => keepDaemonFromEnv());

/// 지금 "앱을 닫아도 계속 일하기" 인가(설정 또는 환경변수).
final keepDaemonProvider = NotifierProvider<KeepDaemonNotifier, bool>(KeepDaemonNotifier.new);
