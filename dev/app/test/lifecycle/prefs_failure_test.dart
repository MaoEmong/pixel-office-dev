import 'dart:io';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pixel_office/panel/ui_prefs.dart';

class FailingPrefs extends MemoryUiPrefsStore {
  bool fail = true;
  FailingPrefs() : super({'panelWidth': 520});
  @override
  Future<void> write(Map<String, dynamic> value) async {
    if (fail) throw const FileSystemException('disk full');
    await super.write(value);
  }
}

void main() {
  test('file save reports real storage failure', () async {
    final dir = Directory.systemTemp.createTempSync('prefs-fail-');
    addTearDown(() => dir.deleteSync(recursive: true));
    final file = File('${dir.path}/blocked')..writeAsStringSync('file');
    await expectLater(
      FileUiPrefsStore(path: '${file.path}/app-ui.json').write({'keepDaemon': true}),
      throwsA(isA<FileSystemException>()),
    );
  });
  test('keep daemon rolls back on failure; retry preserves pending settings and reloads saved state', () async {
    final inner = FailingPrefs();
    String? error;
    final store = ReportingUiPrefsStore(inner, (message) => error = message);
    final container = ProviderContainer(
      overrides: [uiPrefsStoreProvider.overrideWithValue(store), keepDaemonEnvProvider.overrideWithValue(false)],
    );
    addTearDown(container.dispose);
    container.read(keepDaemonProvider);
    await Future<void>.delayed(Duration.zero);
    await container.read(keepDaemonProvider.notifier).set(true);
    expect(container.read(keepDaemonProvider), false);
    expect(inner.value[keepDaemonKey], isNull);
    expect(error, contains('disk full'));
    final pending = await store.read();
    await store.write({...pending, 'panelWidth': 600});
    inner.fail = false;
    await store.retry();
    await container.read(keepDaemonProvider.notifier).reload();
    expect(error, isNull);
    expect(container.read(keepDaemonProvider), true);
    expect(inner.value, {'panelWidth': 600, keepDaemonKey: true});
  });
}
