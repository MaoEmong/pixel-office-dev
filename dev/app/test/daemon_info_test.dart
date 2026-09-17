// daemon.json 경로 규칙과 **못 찾았을 때의 진단 문구**(T41).
//
// 실기 사고: 탐색기에서 띄운 앱이 `daemon.json 없음(데몬 미기동)` 만 보여 줬는데, 파일은 다른 환경
// (샌드박스)의 %LOCALAPPDATA% 에 있었다. "없다" 는 말만으로는 어느 폴더를 본 건지 알 수가 없다.
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:pixel_office/rpc/daemon_info.dart';

void main() {
  const local = {'LOCALAPPDATA': r'C:\Users\User\AppData\Local'};
  const override = {'PIXEL_DATA_DIR': r'D:\po-data', 'LOCALAPPDATA': r'C:\Users\User\AppData\Local'};
  final sep = Platform.pathSeparator;

  test('dataDir/defaultPath: PIXEL_DATA_DIR 이 우선, 없으면 %LOCALAPPDATA%\\pixel-office, 둘 다 없으면 null', () {
    expect(DaemonInfo.dataDir(override), r'D:\po-data');
    expect(DaemonInfo.defaultPath(override), 'D:\\po-data${sep}daemon.json');
    expect(DaemonInfo.dataDir(local), 'C:\\Users\\User\\AppData\\Local${sep}pixel-office');
    expect(DaemonInfo.defaultPath(local), endsWith('pixel-office${sep}daemon.json'));
    expect(DaemonInfo.dataDir(const {}), isNull);
    expect(DaemonInfo.defaultPath(const {}), isNull);
    expect(DaemonInfo.dataDir(const {'LOCALAPPDATA': ''}), isNull);
  });

  test('daemonJsonMissingMessage: 찾아본 경로 + 환경변수 유무가 문구에 들어간다', () {
    final m = daemonJsonMissingMessage(local);
    expect(m, contains('daemon.json 없음(데몬 미기동)'));
    expect(m, contains(DaemonInfo.defaultPath(local)!), reason: '어느 파일을 못 찾았는지가 없으면 진단이 안 된다');
    expect(m, contains('PIXEL_DATA_DIR 없음'));
    expect(m, contains('LOCALAPPDATA 있음'));

    expect(daemonJsonMissingMessage(override), contains('PIXEL_DATA_DIR 있음'));
    expect(daemonJsonMissingMessage(override), contains(r'D:\po-data'));
  });

  test('daemonJsonMissingMessage: 경로를 정할 수조차 없으면 그렇다고 말한다', () {
    expect(daemonJsonMissingMessage(const {}), contains(daemonNoDataDir));
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
