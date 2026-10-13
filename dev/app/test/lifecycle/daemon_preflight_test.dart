import 'dart:io';
import 'package:flutter_test/flutter_test.dart';
import 'package:pixel_office/lifecycle/daemon_preflight.dart';

void main() {
  late Directory dir;
  setUp(() async {
    dir = await Directory.systemTemp.createTemp('office-preflight-');
    await File(
      '${dir.path}/package.json',
    ).writeAsString('{"scripts":{"start":"tsx src/index.ts"}}');
  });
  tearDown(() async => dir.delete(recursive: true));
  test('missing source fails before running commands', () async {
    await File('${dir.path}/package.json').delete();
    await expectLater(
      checkDaemonEnvironment(
        'node',
        dir,
        run: (_, _, _) async => throw StateError('must not run'),
      ),
      throwsA(
        isA<DaemonSetupException>().having(
          (e) => e.message,
          'repair',
          contains('저장소 전체'),
        ),
      ),
    );
  });
  test(
    'old Node and missing native dependency give distinct repair steps',
    () async {
      await expectLater(
        checkDaemonEnvironment(
          'node',
          dir,
          run: (_, _, _) async =>
              ProcessResult(0, 1, '{"reason":"node-version"}', ''),
        ),
        throwsA(
          isA<DaemonSetupException>().having(
            (e) => e.message,
            'version',
            contains('24 이상'),
          ),
        ),
      );
      await expectLater(
        checkDaemonEnvironment(
          'node',
          dir,
          run: (_, _, _) async =>
              ProcessResult(0, 1, '{"reason":"node-pty"}', ''),
        ),
        throwsA(
          isA<DaemonSetupException>().having(
            (e) => e.message,
            'dependency',
            contains('npm ci'),
          ),
        ),
      );
    },
  );
  test(
    'missing executable gives installation guidance; repaired check succeeds',
    () async {
      await expectLater(
        checkDaemonEnvironment(
          'node',
          dir,
          run: (_, _, _) async =>
              throw const ProcessException('node', [], 'missing'),
        ),
        throwsA(
          isA<DaemonSetupException>().having(
            (e) => e.message,
            'repair',
            contains('PIXEL_NODE'),
          ),
        ),
      );
      await checkDaemonEnvironment(
        'node',
        dir,
        run: (_, _, _) async => ProcessResult(0, 0, '{"ok":true}', ''),
      );
    },
  );
}
