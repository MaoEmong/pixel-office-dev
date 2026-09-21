// 두 번째 실행이 보여 주는 창(T46-2 · 수명주기 §1). 사무실을 그리지 않고 한 줄만 말하고 끝낸다.
import 'package:flutter/material.dart';

import 'app_lock.dart';

/// `main()` 이 잠금을 못 잡았을 때 띄우는 최소한의 앱.
class AlreadyRunningApp extends StatelessWidget {
  const AlreadyRunningApp({super.key, required this.onClose, this.theme});

  /// "닫기" 를 눌렀을 때(보통 `exit(0)`).
  final VoidCallback onClose;

  final ThemeData? theme;

  @override
  Widget build(BuildContext context) => MaterialApp(
        title: '픽셀 오피스',
        debugShowCheckedModeBanner: false,
        theme: theme,
        home: Scaffold(
          body: Center(
            child: Padding(
              padding: const EdgeInsets.all(24),
              child: Column(
                mainAxisSize: MainAxisSize.min,
                children: [
                  const Icon(Icons.desktop_windows_outlined, size: 40, color: Colors.white38),
                  const SizedBox(height: 12),
                  const Text(
                    alreadyRunningMessage,
                    key: Key('alreadyRunning.message'),
                    style: TextStyle(fontSize: 18, color: Colors.white),
                    textAlign: TextAlign.center,
                  ),
                  const SizedBox(height: 8),
                  const Text(
                    alreadyRunningHint,
                    key: Key('alreadyRunning.hint'),
                    style: TextStyle(fontSize: 12, color: Colors.white54),
                    textAlign: TextAlign.center,
                  ),
                  const SizedBox(height: 16),
                  FilledButton(
                    key: const Key('alreadyRunning.close'),
                    onPressed: onClose,
                    child: const Text('닫기'),
                  ),
                ],
              ),
            ),
          ),
        ),
      );
}
