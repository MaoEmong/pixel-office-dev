import 'dart:async';
import 'dart:convert';
import 'dart:io';

class DaemonSetupException implements Exception {
  const DaemonSetupException(this.message);
  final String message;
  @override
  String toString() => message;
}

typedef PreflightRunner =
    Future<ProcessResult> Function(
      String executable,
      List<String> arguments,
      String cwd,
    );

Future<void> checkDaemonEnvironment(
  String node,
  Directory directory, {
  PreflightRunner? run,
}) async {
  try {
    final json = jsonDecode(
      await File('${directory.path}/package.json').readAsString(),
    );
    if (json is! Map ||
        json['scripts'] is! Map ||
        json['scripts']['start'] is! String) {
      throw const FormatException();
    }
  } catch (_) {
    throw DaemonSetupException(
      '데몬 소스가 없거나 package.json이 손상됐습니다. 저장소 전체를 다시 받고 dev/daemon 폴더를 확인하세요.\n경로: ${directory.path}',
    );
  }
  const script = r'''
const fail=(reason)=>{console.log(JSON.stringify({ok:false,reason}));process.exit(1)};
if(Number(process.versions.node.split('.')[0])<24)fail('node-version');
for(const name of ['node:sqlite','tsx','node-pty','ws','qrcode','zod','@xterm/headless','@xterm/addon-serialize','@modelcontextprotocol/sdk/server/index.js']){
 try{await import(name)}catch{fail(name)}
}
console.log(JSON.stringify({ok:true}));
''';
  ProcessResult result;
  try {
    result = await (run ?? _runProbe)(node, [
      '--input-type=module',
      '-e',
      script,
    ], directory.path).timeout(const Duration(seconds: 15));
  } on ProcessException {
    throw const DaemonSetupException(
      'Node.js를 실행하지 못했습니다. Node.js 24 이상을 설치한 뒤 앱을 다시 열거나 PIXEL_NODE에 node 실행 파일의 전체 경로를 지정하세요.',
    );
  } on TimeoutException {
    throw const DaemonSetupException(
      '환경 검사 응답이 지연됐습니다. Node 실행과 보안 프로그램의 차단 여부를 확인한 뒤 다시 시도하세요.',
    );
  }
  Map? report;
  try {
    report = jsonDecode(result.stdout.toString().trim()) as Map;
  } catch (_) {}
  if (result.exitCode == 0 && report?['ok'] == true) return;
  if (report?['reason'] == 'node-version') {
    throw const DaemonSetupException(
      'Node.js 버전이 너무 낮습니다. Node.js 24 이상을 설치하고 앱을 다시 실행하세요.',
    );
  }
  final reason = report?['reason']?.toString() ?? 'Node 모듈 로딩';
  throw DaemonSetupException(
    '데몬 의존성을 불러오지 못했습니다 ($reason).\n${directory.path} 폴더에서 npm ci를 실행한 뒤 다시 시도하세요.\nnode-pty가 계속 실패하면 Node 버전·운영체제에 맞는 네이티브 모듈 설치와 npm 설치 로그를 확인하세요.',
  );
}

Future<ProcessResult> _runProbe(
  String exe,
  List<String> args,
  String cwd,
) async {
  final proc = await Process.start(exe, args, workingDirectory: cwd);
  final output = proc.stdout
      .transform(const Utf8Decoder(allowMalformed: true))
      .join();
  final errors = proc.stderr
      .transform(const Utf8Decoder(allowMalformed: true))
      .join();
  try {
    final code = await proc.exitCode.timeout(const Duration(seconds: 14));
    return ProcessResult(proc.pid, code, await output, await errors);
  } on TimeoutException {
    proc.kill();
    await proc.exitCode;
    throw TimeoutException('Node environment probe');
  }
}
