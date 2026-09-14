// 실측 ⑤: Flutter xterm + flutter_pty 로 Claude Code TUI가 깨지지 않고 그려지는지 (한글·wide-char·재그리기)
import 'dart:convert';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_pty/flutter_pty.dart';
import 'package:xterm/xterm.dart';

void main() => runApp(const App());

class App extends StatelessWidget {
  const App({super.key});
  @override
  Widget build(BuildContext context) => MaterialApp(
        debugShowCheckedModeBanner: false,
        theme: ThemeData.dark(),
        home: const TermPage(),
      );
}

class TermPage extends StatefulWidget {
  const TermPage({super.key});
  @override
  State<TermPage> createState() => _TermPageState();
}

class _TermPageState extends State<TermPage> {
  final terminal = Terminal(maxLines: 5000);
  Pty? pty;
  String status = 'starting';

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) => _start());
  }

  void _start() {
    final appData = Platform.environment['APPDATA']!;
    final exe = '$appData\\Claude\\claude-code\\2.1.270\\claude.exe';
    final sandbox = Directory.current.path.contains('flutter_term')
        ? '${Directory.current.path.split('flutter_term').first}sandbox'
        : 'D:\\myproject\\pixel-office\\dev\\spike-0\\sandbox';
    // 데몬과 같은 규칙: CLAUDE_CODE* 환경변수 제거
    final env = <String, String>{};
    Platform.environment.forEach((k, v) {
      if (!RegExp(r'^(CLAUDE_?CODE|CLAUDECODE|CLAUDE_CONFIG_DIR)', caseSensitive: false).hasMatch(k)) env[k] = v;
    });
    final p = Pty.start(
      exe,
      arguments: ['--permission-mode', 'default'],
      workingDirectory: sandbox,
      environment: env,
      columns: terminal.viewWidth,
      rows: terminal.viewHeight,
    );
    pty = p;
    p.output.cast<List<int>>().transform(const Utf8Decoder(allowMalformed: true)).listen(terminal.write);
    p.exitCode.then((c) => setState(() => status = 'exited $c'));
    terminal.onOutput = (data) => p.write(const Utf8Encoder().convert(data));
    terminal.onResize = (w, h, pw, ph) => p.resize(h, w);
    setState(() => status = 'pid ${p.pid} · $sandbox');
    // 8초 뒤 자동으로 한글 프롬프트 입력 (렌더링 확인용)
    Future.delayed(const Duration(seconds: 8), () {
      p.write(const Utf8Encoder().convert('한국어로 세 줄짜리 짧은 시를 써줘. 이모지도 하나 넣어줘. 다른 건 하지 마.'));
      Future.delayed(const Duration(milliseconds: 300), () => p.write(const Utf8Encoder().convert('\r')));
    });
  }

  @override
  Widget build(BuildContext context) => Scaffold(
        appBar: AppBar(title: Text('pixel-office spike · xterm · $status', style: const TextStyle(fontSize: 13))),
        body: TerminalView(
          terminal,
          textStyle: const TerminalStyle(fontSize: 14, fontFamily: 'Cascadia Mono'),
          autofocus: true,
        ),
      );
}
