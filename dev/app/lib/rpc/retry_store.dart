import 'dart:convert';
import 'dart:io';
import '../platform/platform.dart' as plat;

class FileRpcRetryStore {
  String? get path => plat.dataFilePath('rpc-retries.json');
  Future<Map<String, String>> read() async {
    final p = path;
    if (p == null) throw const FileSystemException('요청 기록 저장 폴더를 찾지 못했습니다.');
    final f = File(p);
    if (!await f.exists()) return {};
    return Map<String, String>.from(jsonDecode(await f.readAsString()) as Map);
  }

  Future<void> write(Map<String, String> value) async {
    final p = path;
    if (p == null) throw const FileSystemException('요청 기록 저장 폴더를 찾지 못했습니다.');
    final f = File(p);
    await f.parent.create(recursive: true);
    final temp = File('$p.$pid.tmp');
    try {
      await temp.writeAsString(jsonEncode(value), flush: true);
      await temp.rename(p);
    } finally {
      if (await temp.exists()) await temp.delete();
    }
  }
}
