// T46-2 · 수명주기 §1: 앱은 한 번에 하나(app.lock).
//   깨끗한 폴더 → 잡는다 / 죽은 pid 의 낡은 잠금 → 빼앗는다 / 살아 있는 앱 → null(안내 후 종료).
import 'dart:convert';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pixel_office/lifecycle/already_running_app.dart';
import 'package:pixel_office/lifecycle/app_lock.dart';

void main() {
  late Directory tmp;
  late String lockPath;

  setUp(() {
    tmp = Directory.systemTemp.createTempSync('pixel-lock-');
    lockPath = '${tmp.path}/app.lock';
  });
  tearDown(() => tmp.deleteSync(recursive: true));

  Future<bool> alwaysAlive(int pid, {String? imageContains}) async => true;
  Future<bool> neverAlive(int pid, {String? imageContains}) async => false;

  test('데이터 폴더 아래 app.lock', () {
    expect(AppLock.defaultPath({'PIXEL_DATA_DIR': r'C:\data'}), r'C:\data' '${Platform.pathSeparator}app.lock');
    expect(AppLock.defaultPath(const {}), isNull);
  });

  test('처음 켤 때: 잠금을 잡고 pid·시각·실행 파일 이름을 적는다', () async {
    final lock = await AppLock.acquire(path: lockPath, myPid: 111, image: 'pixel_office.exe', isAlive: neverAlive);
    expect(lock, isNotNull);
    expect(lock!.pid, 111);
    final j = jsonDecode(File(lockPath).readAsStringSync()) as Map;
    expect(j['pid'], 111);
    expect(j['image'], 'pixel_office.exe');
    expect(DateTime.tryParse(j['startedAt'] as String), isNotNull);
  });

  test('두 번째 실행: 앞 창이 살아 있으면 null', () async {
    await AppLock.acquire(path: lockPath, myPid: 111, image: 'pixel_office.exe', isAlive: neverAlive);
    final second = await AppLock.acquire(path: lockPath, myPid: 222, image: 'pixel_office.exe', isAlive: alwaysAlive);
    expect(second, isNull);
    // 잠금 파일은 앞 창의 것 그대로다.
    expect((jsonDecode(File(lockPath).readAsStringSync()) as Map)['pid'], 111);
  });

  test('낡은 잠금(pid 가 죽음): 빼앗는다', () async {
    File(lockPath).writeAsStringSync(jsonEncode({'pid': 999, 'startedAt': 'x', 'image': 'pixel_office.exe'}));
    final lock = await AppLock.acquire(path: lockPath, myPid: 222, image: 'pixel_office.exe', isAlive: neverAlive);
    expect(lock, isNotNull);
    expect((jsonDecode(File(lockPath).readAsStringSync()) as Map)['pid'], 222);
  });

  test('pid 재사용 가드: 이미지 이름까지 넘겨 묻는다', () async {
    File(lockPath).writeAsStringSync(jsonEncode({'pid': 999, 'startedAt': 'x', 'image': 'pixel_office.exe'}));
    String? asked;
    await AppLock.acquire(
      path: lockPath,
      myPid: 222,
      isAlive: (pid, {String? imageContains}) async {
        asked = imageContains;
        return false;
      },
    );
    expect(asked, 'pixel_office.exe');
  });

  test('깨진 잠금 파일은 없는 것으로 본다', () async {
    File(lockPath).writeAsStringSync('{ 깨짐');
    expect(await AppLock.read(path: lockPath), isNull);
    final lock = await AppLock.acquire(path: lockPath, myPid: 222, isAlive: alwaysAlive);
    expect(lock, isNotNull, reason: '읽을 수 없는 잠금 때문에 앱이 영영 안 켜지면 안 된다');
  });

  test('같은 pid 가 다시 잡는 것은 막지 않는다(재진입)', () async {
    await AppLock.acquire(path: lockPath, myPid: 111, isAlive: alwaysAlive);
    expect(await AppLock.acquire(path: lockPath, myPid: 111, isAlive: alwaysAlive), isNotNull);
  });

  test('release: 내 잠금만 지운다', () async {
    final lock = await AppLock.acquire(path: lockPath, myPid: 111, isAlive: neverAlive);
    // 다른 앱이 빼앗아 간 뒤라면 지우지 않는다.
    File(lockPath).writeAsStringSync(jsonEncode({'pid': 222, 'startedAt': 'x', 'image': ''}));
    await lock!.release();
    expect(File(lockPath).existsSync(), isTrue);
    File(lockPath).writeAsStringSync(jsonEncode(lock.toJson()));
    await lock.release();
    expect(File(lockPath).existsSync(), isFalse);
  });

  test('데이터 폴더가 없는 환경에서는 잠그지 않고 그냥 켠다', () async {
    final lock = await AppLock.acquire(env: const {}, isAlive: alwaysAlive);
    expect(lock, isNotNull);
    expect(lock!.path, isEmpty);
    await lock.release(); // 아무 일도 없어야 한다
  });

  testWidgets('두 번째 실행 창: 문구 + 이유 한 줄 + 닫기', (tester) async {
    var closed = 0;
    await tester.pumpWidget(AlreadyRunningApp(onClose: () => closed++, theme: ThemeData.dark()));
    expect(find.text(alreadyRunningMessage), findsOneWidget);
    expect(find.byKey(const Key('alreadyRunning.hint')), findsOneWidget);
    await tester.tap(find.byKey(const Key('alreadyRunning.close')));
    expect(closed, 1);
  });
}
