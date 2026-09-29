// daemon.json 경로 규칙과 **못 찾았을 때의 진단 문구**(T41).
//
// 실기 사고: 탐색기에서 띄운 앱이 `daemon.json 없음(데몬 미기동)` 만 보여 줬는데, 파일은 다른 환경
// (샌드박스)의 %LOCALAPPDATA% 에 있었다. "없다" 는 말만으로는 어느 폴더를 본 건지 알 수가 없다.
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:pixel_office/rpc/daemon_info.dart';

import 'platform/fake_platform.dart';

void main() {
  const local = {'LOCALAPPDATA': r'C:\Users\User\AppData\Local'};
  const override = {'PIXEL_DATA_DIR': r'D:\po-data', 'LOCALAPPDATA': r'C:\Users\User\AppData\Local'};
  // 이 파일의 경로 규칙 검사는 **윈도우 규칙**(`%LOCALAPPDATA%`·`\`)을 본다 — 그러니 호스트가 아니라
  // 주입한 윈도우 플랫폼에 물어야 한다(D-48 원칙 4). 맥에서 호스트로 물으면 `LOCALAPPDATA` 는 아무 의미가
  // 없어 `dataDir` 이 null 이 되고 이 검사 전체가 무너진다(T48-3 M7). 맥·리눅스 규칙은
  // test/platform/platform_test.dart 가 본다.
  final win = FakePlatform(os: 'windows');
  final winSep = win.pathSeparator;
  // 임시 폴더를 쓰는 아래 `read` 검사는 진짜 파일을 만들므로 호스트 구분자를 쓴다.
  final sep = Platform.pathSeparator;

  test('dataDir/defaultPath: PIXEL_DATA_DIR 이 우선, 없으면 %LOCALAPPDATA%\\pixel-office, 둘 다 없으면 null', () {
    expect(DaemonInfo.dataDir(override, win), r'D:\po-data');
    expect(DaemonInfo.defaultPath(override, win), 'D:\\po-data${winSep}daemon.json');
    expect(DaemonInfo.dataDir(local, win), 'C:\\Users\\User\\AppData\\Local${winSep}pixel-office');
    expect(DaemonInfo.defaultPath(local, win), endsWith('pixel-office${winSep}daemon.json'));
    expect(DaemonInfo.dataDir(const {}, win), isNull);
    expect(DaemonInfo.defaultPath(const {}, win), isNull);
    expect(DaemonInfo.dataDir(const {'LOCALAPPDATA': ''}, win), isNull);
  });

  test('daemonJsonMissingMessage: 찾아본 경로 + 환경변수 유무가 문구에 들어간다', () {
    final m = daemonJsonMissingMessage(local, win);
    expect(m, contains('daemon.json 없음(데몬 미기동)'));
    expect(m, contains(DaemonInfo.defaultPath(local, win)!), reason: '어느 파일을 못 찾았는지가 없으면 진단이 안 된다');
    expect(m, contains('PIXEL_DATA_DIR 없음'));
    expect(m, contains('LOCALAPPDATA 있음'));

    expect(daemonJsonMissingMessage(override, win), contains('PIXEL_DATA_DIR 있음'));
    expect(daemonJsonMissingMessage(override, win), contains(r'D:\po-data'));
  });

  test('daemonJsonMissingMessage: 경로를 정할 수조차 없으면 그렇다고 말한다', () {
    // 문구도 같은 플랫폼으로 물어야 한다 — 호스트 기준 `daemonNoDataDir` 은 맥에서 HOME 을,
    // win 으로 만든 문구는 LOCALAPPDATA 를 말한다.
    expect(daemonJsonMissingMessage(const {}, win), contains(daemonNoDataDirMessage(platform: win)));
  });

  test('read: 없는 파일·깨진 파일은 null, 정상 파일은 wsUrl 까지', () async {
    final dir = Directory.systemTemp.createTempSync('pixel-daemon-info-');
    addTearDown(() => dir.deleteSync(recursive: true));
    final path = '${dir.path}${sep}daemon.json';

    expect(await DaemonInfo.read(path: path), isNull);
    File(path).writeAsStringSync('{ not json');
    expect(await DaemonInfo.read(path: path), isNull);

    File(path).writeAsStringSync(
      '{"wsPort":7420,"hookPort":7421,"token":"t","pid":42,"startedAt":"s","version":"1.0.0"}',
    );
    final info = await DaemonInfo.read(path: path);
    expect(info?.pid, 42);
    expect(info?.wsUrl.toString(), 'ws://127.0.0.1:7420');
  });
}
