// 부서 만들기 다이얼로그(T41): **폴더 선택** + 기본값.
//
//  - 작업 폴더는 "폴더 선택…"(file_selector) 으로 고른다. 테스트는 네이티브 창을 절대 열지 않는다 —
//    `CreateDepartmentDialog(pickDirectory: ...)` 에 가짜 선택기를 주입한다.
//  - 폴더 존재 확인도 진짜 `dart:io` 를 안 쓴다(`directoryExistsProvider` 오버라이드) — 위젯 테스트의
//    fake-async 존에서는 dart:io Future 가 영영 안 끝난다(T41 함정).
//  - 기본값: 부서 이름 = 폴더 이름(사용자가 고치기 전까지), 부장 이름 = "부장", 엔진 = claude.
//    → **폴더만 고르면 한 글자도 안 치고 만들 수 있다.**
//  - 마지막으로 고른 폴더의 **부모**는 앱 로컬 prefs 에 남아 다음 선택기의 시작 폴더가 된다.
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pixel_office/panel/ui_prefs.dart';
import 'package:pixel_office/topbar/top_bar.dart';

import 'fake_rpc_client.dart';

const String pickedFolder = r'D:\myproject\pixel-office';
const String otherFolder = r'D:\myproject\hanul';

/// 가짜 폴더 선택기 — 호출 인자를 기록하고 [result] 를 돌려준다(null = 취소).
class FakePicker {
  FakePicker([this.result]);

  String? result;
  Object? error;
  final List<String?> initialDirectories = [];

  int get calls => initialDirectories.length;

  Future<String?> call({String? initialDirectory}) async {
    initialDirectories.add(initialDirectory);
    if (error != null) throw error!;
    return result;
  }
}

/// 다이얼로그를 띄운다(상단 바와 같은 `showCreateDepartmentDialog` 경로).
Future<void> openDialog(
  WidgetTester tester, {
  required FakeRpcClient fake,
  required FakePicker picker,
  required UiPrefsStore prefs,
  Set<String> existing = const {pickedFolder, otherFolder},
}) async {
  await tester.pumpWidget(ProviderScope(
    overrides: [
      ...fake.overrides,
      uiPrefsStoreProvider.overrideWithValue(prefs),
      directoryExistsProvider.overrideWithValue((path) async => existing.contains(path)),
    ],
    child: MaterialApp(
      home: Scaffold(
        body: Builder(
          builder: (ctx) => TextButton(
            onPressed: () => showCreateDepartmentDialog(ctx, pickDirectory: picker.call),
            child: const Text('열기'),
          ),
        ),
      ),
    ),
  ));
  await tester.pump();
  await tester.tap(find.text('열기'));
  await tester.pumpAndSettle();
}

String textOf(WidgetTester tester, String key) =>
    tester.widget<TextField>(find.byKey(Key(key))).controller?.text ?? '';

Future<void> tapPick(WidgetTester tester) async {
  await tester.tap(find.byKey(const Key('createDepartment.pickFolder')));
  await tester.pumpAndSettle();
}

void main() {
  test('departmentNameForPath: 마지막 조각, 꼬리 구분자·드라이브 루트·슬래시', () {
    expect(departmentNameForPath(r'D:\myproject\pixel-office'), 'pixel-office');
    expect(departmentNameForPath(r'D:\myproject\pixel-office\'), 'pixel-office');
    expect(departmentNameForPath('D:/myproject/hanul'), 'hanul');
    expect(departmentNameForPath(r'D:\'), 'D');
    expect(departmentNameForPath('  '), '');
  });

  test('parentDirOf: 고른 폴더의 부모를 다음 시작 폴더로, 루트면 null', () {
    expect(parentDirOf(pickedFolder), r'D:\myproject');
    expect(parentDirOf(''), isNull);
    expect(parentDirOf(r'D:\'), isNull, reason: '루트는 부모가 자기 자신');
  });

  testWidgets('폴더를 고르면 이름·부장 이름·엔진이 기본값으로 차고, 한 글자도 안 치고 만들 수 있다', (tester) async {
    final fake = FakeRpcClient(responder: (m, p) => {
          'department': fakeDepartment('dNew', name: p['name'] as String, headId: 'mH'),
          'head': fakeMember('mH', rank: 'head', status: 'starting', departmentId: 'dNew'),
        });
    addTearDown(fake.close);
    final picker = FakePicker(pickedFolder);
    await openDialog(tester, fake: fake, picker: picker, prefs: MemoryUiPrefsStore());

    // 고르기 전: 만들기는 꺼져 있고 이유가 붙어 있다.
    expect(tester.widget<FilledButton>(find.byKey(const Key('createDepartment.submit'))).onPressed, isNull);
    expect(find.byKey(const Key('createDepartment.submitHint')), findsOneWidget);
    expect(textOf(tester, 'createDepartment.headName'), kDefaultHeadName);

    await tapPick(tester);
    expect(picker.calls, 1);
    expect(textOf(tester, 'createDepartment.cwd'), pickedFolder);
    expect(textOf(tester, 'createDepartment.name'), 'pixel-office');
    expect(find.byKey(const Key('createDepartment.submitHint')), findsNothing);

    await tester.tap(find.byKey(const Key('createDepartment.submit')));
    await tester.pumpAndSettle();
    expect(fake.callList, [
      ['department.create', {'name': 'pixel-office', 'cwd': pickedFolder, 'headEngine': 'claude', 'headName': kDefaultHeadName}],
    ]);
    expect(find.byType(CreateDepartmentDialog), findsNothing);
  });

  testWidgets('이름을 직접 고치면 폴더를 바꿔도 안 덮어쓴다(비우면 다시 따라온다)', (tester) async {
    final fake = FakeRpcClient();
    addTearDown(fake.close);
    final picker = FakePicker(pickedFolder);
    await openDialog(tester, fake: fake, picker: picker, prefs: MemoryUiPrefsStore());

    await tapPick(tester);
    expect(textOf(tester, 'createDepartment.name'), 'pixel-office');

    await tester.enterText(find.byKey(const Key('createDepartment.name')), '알파');
    picker.result = otherFolder;
    await tapPick(tester);
    expect(textOf(tester, 'createDepartment.cwd'), otherFolder);
    expect(textOf(tester, 'createDepartment.name'), '알파', reason: '사용자가 고친 이름은 폴더가 바뀌어도 그대로');

    // 이름 칸을 비우면 "안 고친 상태" 로 돌아가 다시 폴더 이름을 따라간다.
    await tester.enterText(find.byKey(const Key('createDepartment.name')), '');
    picker.result = pickedFolder;
    await tapPick(tester);
    expect(textOf(tester, 'createDepartment.name'), 'pixel-office');
  });

  testWidgets('선택기를 취소하면(null) 아무것도 안 바뀌고, 선택기가 던지면 오류 문구', (tester) async {
    final fake = FakeRpcClient();
    addTearDown(fake.close);
    final picker = FakePicker(); // null = 취소
    final prefs = MemoryUiPrefsStore();
    await openDialog(tester, fake: fake, picker: picker, prefs: prefs);

    await tapPick(tester);
    expect(textOf(tester, 'createDepartment.cwd'), '');
    expect(prefs.value, isEmpty);
    expect(tester.widget<FilledButton>(find.byKey(const Key('createDepartment.submit'))).onPressed, isNull);

    picker.error = StateError('선택기 고장');
    await tapPick(tester);
    expect(find.textContaining('폴더 선택 실패'), findsOneWidget);
    // 다이얼로그는 살아 있다.
    expect(find.byType(CreateDepartmentDialog), findsOneWidget);
  });

  testWidgets('손으로 친 경로 폴백: 없는 폴더면 오류 + 만들기 꺼짐, 있는 폴더면 켜진다', (tester) async {
    final fake = FakeRpcClient();
    addTearDown(fake.close);
    await openDialog(tester, fake: fake, picker: FakePicker(), prefs: MemoryUiPrefsStore());

    await tester.enterText(find.byKey(const Key('createDepartment.cwd')), r'D:\없는폴더');
    await tester.pumpAndSettle();
    expect(find.text(createDepartmentMissingFolder), findsOneWidget);
    expect(tester.widget<FilledButton>(find.byKey(const Key('createDepartment.submit'))).onPressed, isNull);

    await tester.enterText(find.byKey(const Key('createDepartment.cwd')), pickedFolder);
    await tester.pumpAndSettle();
    expect(find.text(createDepartmentMissingFolder), findsNothing);
    expect(textOf(tester, 'createDepartment.name'), 'pixel-office');
    expect(tester.widget<FilledButton>(find.byKey(const Key('createDepartment.submit'))).onPressed, isNotNull);
  });

  testWidgets('고른 폴더의 부모를 앱 로컬 prefs 에 남기고 다음 선택기의 시작 폴더로 준다', (tester) async {
    final fake = FakeRpcClient();
    addTearDown(fake.close);
    final picker = FakePicker(pickedFolder);
    final prefs = MemoryUiPrefsStore();
    await openDialog(tester, fake: fake, picker: picker, prefs: prefs);

    await tapPick(tester);
    expect(picker.initialDirectories, [null], reason: '첫 번째는 기억한 폴더가 없다');
    expect(prefs.value[lastDepartmentDirKey], r'D:\myproject');

    // 같은 앱(같은 ProviderScope)에서 다시 열면 그 폴더에서 시작한다.
    await tester.tap(find.text('취소'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('열기'));
    await tester.pumpAndSettle();
    await tapPick(tester);
    expect(picker.initialDirectories.last, r'D:\myproject');
  });

  testWidgets('저장된 폴더가 있으면 앱 시작 직후에도 그 폴더에서 연다', (tester) async {
    final fake = FakeRpcClient();
    addTearDown(fake.close);
    final picker = FakePicker(pickedFolder);
    await openDialog(
      tester,
      fake: fake,
      picker: picker,
      prefs: MemoryUiPrefsStore({lastDepartmentDirKey: r'D:\myproject'}),
    );
    await tapPick(tester);
    expect(picker.initialDirectories, [r'D:\myproject']);
  });
}
