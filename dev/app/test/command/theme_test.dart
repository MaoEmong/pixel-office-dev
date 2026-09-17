// 팔레트 포커스 링 · 스크롤바(T40-5, 패스 6 접근성). 브라우저/Flutter 기본 대신 §4 토큰을 쓴다.
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pixel_office/main.dart';
import 'package:pixel_office/panel/labels.dart';

void main() {
  test('스크롤바는 6px 팔레트 색', () {
    final theme = pixelOfficeTheme();
    expect(theme.scrollbarTheme.thickness!.resolve({}), panelScrollbarThickness);
    expect(theme.scrollbarTheme.thickness!.resolve({}), 6);
    expect(theme.scrollbarTheme.thumbColor!.resolve({}), panelScrollbarThumb);
  });

  test('포커스 링은 2px #FFFFFF 알파 0.8', () {
    final theme = pixelOfficeTheme();
    expect(panelFocusRing, const Color(0xCCFFFFFF));
    expect(panelFocusRingWidth, 2);
    final border = theme.inputDecorationTheme.focusedBorder! as OutlineInputBorder;
    expect(border.borderSide.color, panelFocusRing);
    expect(border.borderSide.width, panelFocusRingWidth);
    expect(theme.focusColor, panelFocusRing);
  });

  test('다크 단일 테마(§4 범위 밖: 라이트 전환 없음)', () {
    expect(pixelOfficeTheme().brightness, Brightness.dark);
  });
}
