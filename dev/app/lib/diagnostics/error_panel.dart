import 'package:flutter/material.dart';
import '../rpc/rpc_client.dart' show RpcException;

String errorMessage(Object error) => error is RpcException
    ? error.message
    : error.toString().replaceFirst(RegExp(r'^Exception: '), '');

/// Shared surface for recovery screens. The office stays visible behind it.
class RecoveryPanelFrame extends StatelessWidget {
  const RecoveryPanelFrame({super.key, required this.child, this.error = true});
  final Widget child;
  final bool error;
  @override
  Widget build(BuildContext context) => Container(
    key: const Key('recoveryPanel.surface'),
    padding: const EdgeInsets.all(24),
    decoration: BoxDecoration(
      gradient: const LinearGradient(
        begin: Alignment.topLeft,
        end: Alignment.bottomRight,
        colors: [Color(0xFF272D42), Color(0xFF191D2C)],
      ),
      borderRadius: BorderRadius.circular(20),
      border: Border.all(
        color: error ? const Color(0xFFB76D7D) : const Color(0xFF53668C),
      ),
      boxShadow: const [
        BoxShadow(
          color: Color(0x66000000),
          blurRadius: 32,
          offset: Offset(0, 12),
        ),
      ],
    ),
    child: child,
  );
}

class ErrorPanel extends StatelessWidget {
  const ErrorPanel({
    super.key,
    required this.title,
    required this.message,
    this.details,
    this.onRetry,
    this.retryLabel = '다시 시도',
    this.compact = false,
    this.actions = const [],
  });
  final String title, message, retryLabel;
  final String? details;
  final VoidCallback? onRetry;
  final bool compact;
  final List<Widget> actions;
  @override
  Widget build(BuildContext context) => Container(
    width: double.infinity,
    padding: EdgeInsets.all(compact ? 12 : 20),
    decoration: BoxDecoration(
      color: const Color(0xFF262837),
      borderRadius: BorderRadius.circular(12),
      border: Border.all(color: const Color(0xFF73505E)),
    ),
    child: Column(
      mainAxisSize: MainAxisSize.min,
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Row(
          children: [
            Container(
              padding: const EdgeInsets.all(8),
              decoration: BoxDecoration(
                color: const Color(0xFF493140),
                borderRadius: BorderRadius.circular(10),
              ),
              child: const Icon(
                Icons.error_outline_rounded,
                color: Color(0xFFFFB4BF),
                size: 22,
              ),
            ),
            const SizedBox(width: 12),
            Expanded(
              child: Text(
                title,
                style: TextStyle(
                  fontWeight: FontWeight.w700,
                  fontSize: compact ? 14 : 18,
                  color: const Color(0xFFFFD2DB),
                ),
              ),
            ),
          ],
        ),
        const SizedBox(height: 12),
        SelectableText(
          message,
          style: const TextStyle(
            color: Color(0xFFE1E4EF),
            height: 1.5,
            fontSize: 13,
          ),
        ),
        if (details != null)
          Material(
            color: Colors.transparent,
            child: ExpansionTile(
              tilePadding: EdgeInsets.zero,
              title: const Text('오류 상세', style: TextStyle(fontSize: 12)),
              children: [
                SizedBox(
                  width: double.infinity,
                  child: SelectableText(
                    details!,
                    style: const TextStyle(fontSize: 11, color: Colors.white60),
                  ),
                ),
              ],
            ),
          ),
        if (onRetry != null)
          Padding(
            padding: const EdgeInsets.only(top: 16),
            child: FilledButton.icon(
              onPressed: onRetry,
              icon: const Icon(Icons.refresh, size: 18),
              label: Text(retryLabel),
            ),
          ),
        if (actions.isNotEmpty) Wrap(spacing: 8, children: actions),
      ],
    ),
  );
}

Future<void> showErrorPanel(
  BuildContext context, {
  required String title,
  required String message,
  void Function(BuildContext dialogContext)? onOpened,
  List<Widget> actions = const [],
}) => showDialog<void>(
  context: context,
  builder: (context) {
    onOpened?.call(context);
    return Dialog(
      backgroundColor: Colors.transparent,
      child: ConstrainedBox(
        constraints: const BoxConstraints(maxWidth: 560),
        child: SingleChildScrollView(
          child: RecoveryPanelFrame(
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                ErrorPanel(title: title, message: message),
                const SizedBox(height: 12),
                if (actions.isNotEmpty) Wrap(spacing: 8, children: actions),
                Align(
                  alignment: Alignment.centerRight,
                  child: TextButton(
                    onPressed: () => Navigator.pop(context),
                    child: const Text('닫기'),
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  },
);
