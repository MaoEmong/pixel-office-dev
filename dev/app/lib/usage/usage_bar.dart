// 사용량 막대 하나(T43-2). 칩·팝오버·패널 한 줄·표가 같은 것을 쓴다.
// 레이아웃 v2 패스 4: 곡률 4px 하나, 그림자·글로우·그라데이션 없음. 색은 usage_format.dart 의 토큰.

import 'package:flutter/material.dart';

import 'usage_format.dart';

/// 얇은 가로 막대. [percent] 는 **채울 비율**(0~100), 색은 호출부가 정한다.
class UsageBar extends StatelessWidget {
  const UsageBar({
    super.key,
    required this.percent,
    required this.color,
    this.width = 56,
    this.height = 4,
  });

  final double percent;
  final Color color;
  final double width;
  final double height;

  @override
  Widget build(BuildContext context) => SizedBox(
        width: width,
        height: height,
        child: Stack(
          children: [
            Container(
              decoration: BoxDecoration(
                color: usageTrackColor,
                borderRadius: BorderRadius.circular(4),
              ),
            ),
            SizedBox(
              width: barFillWidth(width, percent),
              height: height,
              child: DecoratedBox(
                decoration: BoxDecoration(
                  color: color,
                  borderRadius: BorderRadius.circular(4),
                ),
              ),
            ),
          ],
        ),
      );
}
