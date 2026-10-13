import 'dart:async';
import 'dart:convert';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../state/office_state.dart';
import '../panel/ui_prefs.dart';

class DeviceDialog extends ConsumerStatefulWidget {
  const DeviceDialog({super.key});
  @override
  ConsumerState<DeviceDialog> createState() => _DeviceDialogState();
}

class _DeviceDialogState extends ConsumerState<DeviceDialog> {
  Map<String, dynamic>? _status, _invite;
  String? _error;
  bool _busy = false;
  Timer? _timer;
  final _url = TextEditingController();
  @override
  void initState() {
    super.initState();
    unawaited(_load());
    _timer = Timer.periodic(
      const Duration(seconds: 3),
      (_) => unawaited(_load()),
    );
  }

  @override
  void dispose() {
    _timer?.cancel();
    _url.dispose();
    super.dispose();
  }

  Future<void> _load() async {
    try {
      final result = await ref.read(rpcClientProvider).call('remote.status');
      if (!mounted) return;
      if (_status == null &&
          (result['publicUrl'] as String? ?? '').startsWith('https://')) {
        _url.text = result['publicUrl'] as String;
      }
      setState(() {
        _status = result;
        _error = null;
      });
    } catch (e) {
      if (mounted) setState(() => _error = e.toString());
    }
  }

  Future<void> _run(
    String method, [
    Map<String, dynamic> params = const {},
  ]) async {
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      final result = await ref.read(rpcClientProvider).call(method, params);
      if (!mounted) return;
      if (method == 'remote.pair.create') setState(() => _invite = result);
      if (method == 'remote.configure') setState(() => _invite = null);
      await _load();
    } catch (e) {
      if (mounted) setState(() => _error = e.toString());
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final devices = (_status?['devices'] as List? ?? [])
        .whereType<Map>()
        .toList();
    final pending = devices.where((d) => d['status'] == 'pending').toList();
    final registered = devices.where((d) => d['status'] == 'approved').toList();
    final keep = ref.watch(keepDaemonProvider);
    return Dialog(
      child: SizedBox(
        width: 780,
        height: 650,
        child: Padding(
          padding: const EdgeInsets.all(20),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Row(
                children: [
                  const Expanded(
                    child: Text(
                      '기기 연결 · 원격 조작',
                      style: TextStyle(
                        fontSize: 21,
                        fontWeight: FontWeight.bold,
                      ),
                    ),
                  ),
                  IconButton(
                    tooltip: '닫기',
                    onPressed: () => Navigator.pop(context),
                    icon: const Icon(Icons.close),
                  ),
                ],
              ),
              const Text('QR 또는 연결 키로 요청한 기기를 승인하세요. 등록은 연결을 해제할 때까지 유지됩니다.'),
              const Divider(),
              Expanded(
                child: SingleChildScrollView(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      if (_error != null)
                        Padding(
                          padding: const EdgeInsets.only(bottom: 12),
                          child: SelectableText(
                            _error!,
                            style: TextStyle(
                              color: Theme.of(context).colorScheme.error,
                            ),
                          ),
                        ),
                      const Text(
                        '접속 주소',
                        style: TextStyle(fontWeight: FontWeight.bold),
                      ),
                      SelectableText(
                        _status?['publicUrl']?.toString() ?? '불러오는 중',
                      ),
                      if (!(_status?['publicUrl']?.toString() ?? '').startsWith(
                        'https://',
                      ))
                        const Text(
                          '기본은 이 PC에서 사용하는 로컬 모드입니다. 모바일·다른 PC 연결은 아래 선택 설정을 사용하세요.',
                        ),
                      const SizedBox(height: 8),
                      ExpansionTile(
                        title: const Text('외부 접속 설정 · 선택 (Tailscale)'),
                        children: [
                          const Text(
                            '로컬 사용에는 설치·가입·도메인이 필요 없습니다. 외출 중 연결할 사용자만 Tailscale을 설정하세요. 앱이 자동으로 설치하거나 연결을 공개하지 않습니다.',
                          ),
                          const SizedBox(height: 8),
                          const Text(
                            '1. 작업 PC와 접속할 기기에 Tailscale을 설치하고 같은 네트워크에 연결합니다.\n2. 작업 PC에서 아래 명령으로 HTTPS 주소를 만듭니다.\n3. 표시된 https://…ts.net 주소를 입력·저장한 뒤 QR로 기기를 등록합니다.',
                          ),
                          SelectableText(
                            'tailscale serve --bg ${_status?["localUrl"] ?? "http://127.0.0.1:7423"}',
                          ),
                          const Text(
                            'Serve는 Tailscale 네트워크 안에서만 접속됩니다. 일반 브라우저만으로 접속하려면 Serve 대신 tailscale funnel --bg <위 로컬 주소>를 사용하세요. Funnel은 인터넷에 접속 경로를 공개하지만 작업 조작에는 여전히 PC의 기기 승인이 필요합니다.',
                          ),
                          const SizedBox(height: 8),
                          TextField(
                            controller: _url,
                            enabled: !_busy,
                            decoration: const InputDecoration(
                              labelText: '선택 연결의 HTTPS 주소',
                              hintText: 'https://my-pc.example.ts.net',
                              border: OutlineInputBorder(),
                            ),
                          ),
                          const SizedBox(height: 8),
                          Wrap(
                            spacing: 8,
                            children: [
                              OutlinedButton(
                                onPressed: _busy
                                    ? null
                                    : () => _run('remote.configure', {
                                        'publicUrl': _url.text.trim(),
                                      }),
                                child: const Text('접속 주소 저장'),
                              ),
                              TextButton(
                                onPressed: _busy
                                    ? null
                                    : () {
                                        _url.clear();
                                        unawaited(
                                          _run('remote.configure', {
                                            'publicUrl': '',
                                          }),
                                        );
                                      },
                                child: const Text('로컬 주소로 돌아가기'),
                              ),
                            ],
                          ),
                          const Text(
                            '로컬 주소로 돌아가도 Tailscale 서비스는 종료되지 않습니다. 종료는 Tailscale에서 별도로 해 주세요. 접속 주소가 바뀌면 브라우저 기기 등록이 필요합니다.',
                          ),
                        ],
                      ),
                      const SizedBox(height: 8),
                      Wrap(
                        spacing: 8,
                        children: [
                          FilledButton.icon(
                            onPressed: _busy || _status == null
                                ? null
                                : () => _run('remote.pair.create'),
                            icon: const Icon(Icons.qr_code),
                            label: const Text('QR · 연결 키 만들기'),
                          ),
                        ],
                      ),
                      if (_invite != null)
                        Padding(
                          padding: const EdgeInsets.symmetric(vertical: 16),
                          child: Column(
                            crossAxisAlignment: CrossAxisAlignment.start,
                            children: [
                              Image.memory(
                                base64Decode(
                                  (_invite!['qrPngDataUrl'] as String)
                                      .split(',')
                                      .last,
                                ),
                                width: 200,
                                height: 200,
                                errorBuilder: (_, _, _) => const Text(
                                  'QR을 표시할 수 없습니다. 아래 연결 키를 사용하세요.',
                                ),
                              ),
                              Text(
                                '5분 안에 등록 요청 · ${DateTime.fromMillisecondsSinceEpoch(_invite!['expiresAt'] as int).toLocal()} 만료',
                              ),
                              SelectableText(_invite!['code'] as String),
                              Wrap(
                                spacing: 8,
                                children: [
                                  TextButton(
                                    onPressed: () => Clipboard.setData(
                                      ClipboardData(
                                        text: _invite!['code'] as String,
                                      ),
                                    ),
                                    child: const Text('연결 키 복사'),
                                  ),
                                  TextButton(
                                    onPressed: () => Clipboard.setData(
                                      ClipboardData(
                                        text: _invite!['url'] as String,
                                      ),
                                    ),
                                    child: const Text('QR 링크 복사'),
                                  ),
                                ],
                              ),
                            ],
                          ),
                        ),
                      SwitchListTile(
                        contentPadding: EdgeInsets.zero,
                        title: const Text(keepDaemonLabel),
                        subtitle: const Text(
                          '원격으로 계속 조작하려면 PC가 켜져 있고 데몬이 실행 중이어야 합니다.',
                        ),
                        value: keep,
                        onChanged: ref.watch(keepDaemonEnvProvider)
                            ? null
                            : (value) => ref
                                  .read(keepDaemonProvider.notifier)
                                  .set(value),
                      ),
                      const Divider(),
                      const Text(
                        '승인 대기',
                        style: TextStyle(
                          fontSize: 16,
                          fontWeight: FontWeight.bold,
                        ),
                      ),
                      if (pending.isEmpty) const Text('승인을 기다리는 기기가 없습니다.'),
                      for (final d in pending) _device(d, pending: true),
                      const SizedBox(height: 16),
                      const Text(
                        '등록된 기기',
                        style: TextStyle(
                          fontSize: 16,
                          fontWeight: FontWeight.bold,
                        ),
                      ),
                      if (registered.isEmpty) const Text('등록된 기기가 없습니다.'),
                      for (final d in registered) _device(d, pending: false),
                      const SizedBox(height: 12),
                      const Text(
                        '작업 파일·세션·회의록은 이 PC에 저장됩니다. 브라우저 데이터를 지우거나 접속 주소가 바뀌면 새로 등록해야 합니다.',
                      ),
                    ],
                  ),
                ),
              ),
              if (_busy) const LinearProgressIndicator(),
            ],
          ),
        ),
      ),
    );
  }

  Widget _device(Map d, {required bool pending}) => Card(
    child: Padding(
      padding: const EdgeInsets.all(12),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            d['name'].toString(),
            style: const TextStyle(fontWeight: FontWeight.bold),
          ),
          SelectableText('지문: ${d['fingerprint']}'),
          if (pending) const Text('요청한 기기의 화면에도 같은 지문이 표시되는지 확인하세요.'),
          Wrap(
            spacing: 8,
            children: [
              if (pending)
                FilledButton(
                  onPressed: _busy
                      ? null
                      : () => _run('remote.device.approve', {
                          'deviceId': d['id'],
                        }),
                  child: const Text('기기 승인'),
                ),
              TextButton(
                onPressed: _busy
                    ? null
                    : () => _run('remote.device.revoke', {'deviceId': d['id']}),
                child: Text(pending ? '등록 거부' : '연결 해제'),
              ),
            ],
          ),
        ],
      ),
    ),
  );
}
