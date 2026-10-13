import 'package:file_selector/file_selector.dart' show getDirectoryPath;
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../diagnostics/error_panel.dart';
import '../state/office_state.dart';

class RelocateDepartmentDialog extends ConsumerStatefulWidget {
  const RelocateDepartmentDialog({
    super.key,
    required this.departmentId,
    required this.cwd,
  });
  final String departmentId, cwd;
  @override
  ConsumerState<RelocateDepartmentDialog> createState() =>
      _RelocateDepartmentDialogState();
}

class _RelocateDepartmentDialogState
    extends ConsumerState<RelocateDepartmentDialog> {
  late final TextEditingController path = TextEditingController(
    text: widget.cwd,
  );
  bool busy = false;
  String? error;
  @override
  void dispose() {
    path.dispose();
    super.dispose();
  }

  Future<void> save() async {
    setState(() {
      busy = true;
      error = null;
    });
    try {
      await ref.read(rpcClientProvider).call('department.update', {
        'departmentId': widget.departmentId,
        'cwd': path.text.trim(),
      });
      if (mounted) Navigator.pop(context);
    } catch (e) {
      if (mounted) setState(() => error = errorMessage(e));
    } finally {
      if (mounted) setState(() => busy = false);
    }
  }

  @override
  Widget build(BuildContext context) => AlertDialog(
    title: const Text('프로젝트 폴더 다시 연결'),
    content: SizedBox(
      width: 560,
      child: SingleChildScrollView(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            const Text(
              '부서의 모든 멤버를 퇴근시킨 뒤 이동한 원래 프로젝트 폴더를 선택하세요. 파일을 이동하거나 삭제하지 않고 저장 위치를 다시 연결합니다. .pixel-office 폴더도 함께 이동되어 있어야 기존 세션을 이어갈 수 있습니다.',
            ),
            const SizedBox(height: 16),
            TextField(
              key: const Key('relocate.path'),
              controller: path,
              onChanged: (_) => setState(() {}),
              decoration: InputDecoration(
                labelText: '프로젝트 폴더',
                suffixIcon: IconButton(
                  tooltip: '폴더 선택',
                  onPressed: busy
                      ? null
                      : () async {
                          final selected = await getDirectoryPath();
                          if (mounted && selected != null) {
                            setState(() => path.text = selected);
                          }
                        },
                  icon: const Icon(Icons.folder_open),
                ),
              ),
            ),
            if (error != null)
              Padding(
                padding: const EdgeInsets.only(top: 16),
                child: ErrorPanel(
                  title: '폴더를 연결하지 못했어요',
                  message: error!,
                  compact: true,
                ),
              ),
          ],
        ),
      ),
    ),
    actions: [
      TextButton(
        onPressed: busy ? null : () => Navigator.pop(context),
        child: const Text('취소'),
      ),
      FilledButton(
        key: const Key('relocate.save'),
        onPressed:
            busy || path.text.trim().isEmpty || path.text.trim() == widget.cwd
            ? null
            : save,
        child: Text(busy ? '연결 중…' : '폴더 연결'),
      ),
    ],
  );
}
