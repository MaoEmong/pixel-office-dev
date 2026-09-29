#!/usr/bin/env bash
# 창 하나만 캡처해 PNG 로 저장한다(전체 화면은 절대 찍지 않는다) — capture-window.ps1 의 맥판.
#
# 사용법: tool/capture-window.sh [-p "픽셀 오피스"] -o ../../docs/worklog/img/shot.png
#
# 이름이 두 가지다 — CGWindowList 의 소유자 이름은 **번들 표시 이름**(Info.plist CFBundleDisplayName =
# `픽셀 오피스`)이고, System Events 의 프로세스 이름은 **실행 파일 이름**(`pixel_office`)이다. 기본값으로
# 둘 다 넣어 두었으니 보통은 -p 를 줄 필요가 없다.
#
# 왜 이렇게 복잡한가: `screencapture -l <CGWindowID>` 가 진짜 "창 단위" 캡처인데(-o 로 그림자까지 뺀다)
# CGWindowID 를 셸에서 얻을 방법이 기본 도구에 없다. `osascript` 의 `id of window 1` 은 Cocoa 앱에서
# CGWindowID 가 아니고, python3 에는 Quartz(pyobjc)가 없다(맥 기본). Xcode 가 깔려 있으면 `swift` 로
# CGWindowListCopyWindowInfo 를 한 번 부르는 것이 가장 확실하다 → 1순위.
# Xcode 가 없으면 System Events 로 창 위치·크기를 받아 `screencapture -R` 로 그 사각형만 찍는다 → 2순위.
# (-R 은 화면의 사각형이라 창 위에 뭐가 겹쳐 있으면 같이 찍힌다. 캡처 전에 창을 맨 앞으로 올려 둘 것.)
#
# 권한: 처음 실행하면 macOS 가 "화면 기록" 권한을 물어본다(터미널 앱 기준). 2순위 경로는 "손쉬운 사용"
# 권한도 필요하다. 둘 다 시스템 설정 → 개인정보 보호 및 보안.
set -euo pipefail

# 찾을 이름 후보(앞이 우선). -p 를 주면 그 이름만 쓴다.
CANDIDATES=("픽셀 오피스" "pixel_office")
OUT="shot.png"
while getopts "p:o:" opt; do
  case "$opt" in
    p) CANDIDATES=("$OPTARG") ;;
    o) OUT="$OPTARG" ;;
    *) echo "사용법: $0 [-p 프로세스이름] -o 출력.png" >&2; exit 2 ;;
  esac
done

mkdir -p "$(dirname "$OUT")"

# ---- 1순위: swift 로 CGWindowID 를 찾아 창 단위 캡처 -------------------------------------------
if command -v swift >/dev/null 2>&1; then
  SWIFT_SRC="$(mktemp -t cgwin).swift"
  trap 'rm -f "$SWIFT_SRC"' EXIT
  cat > "$SWIFT_SRC" <<'SWIFT'
import CoreGraphics
import Foundation

// 화면에 있는 창 중 소유 프로세스 이름이 인자와 같고 크기가 있는 첫 창의 CGWindowID 를 찍는다.
// 인자로 받은 이름 후보 중 하나와 맞으면 된다(정확히 같거나, 포함).
let wanted = Array(CommandLine.arguments.dropFirst())
guard
  let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID)
    as? [[String: Any]]
else { exit(1) }
for w in list {
  guard
    let owner = w[kCGWindowOwnerName as String] as? String,
    wanted.contains(where: { owner == $0 || owner.contains($0) }),
    let id = w[kCGWindowNumber as String] as? Int,
    let b = w[kCGWindowBounds as String] as? [String: Any],
    let width = b["Width"] as? Double, let height = b["Height"] as? Double,
    width > 100, height > 100
  else { continue }
  print(id)
  exit(0)
}
exit(1)
SWIFT
  if WID="$(swift "$SWIFT_SRC" "${CANDIDATES[@]}" 2>/dev/null)" && [ -n "$WID" ]; then
    screencapture -x -o -l "$WID" "$OUT"
    echo "mode=window(CGWindowID) id=$WID saved=$(cd "$(dirname "$OUT")" && pwd)/$(basename "$OUT")"
    exit 0
  fi
  echo "창을 못 찾았다(swift 경로) — System Events 로 넘어간다: ${CANDIDATES[*]}" >&2
fi

# ---- 2순위: System Events 의 창 위치·크기로 사각형 캡처 ----------------------------------------
BOUNDS=""
for NAME in "${CANDIDATES[@]}"; do
  BOUNDS="$(osascript <<OSA 2>/dev/null || true
tell application "System Events"
  if not (exists process "$NAME") then return ""
  tell process "$NAME"
    if (count of windows) is 0 then return ""
    set p to position of window 1
    set s to size of window 1
    return ((item 1 of p) as text) & "," & ((item 2 of p) as text) & "," & ((item 1 of s) as text) & "," & ((item 2 of s) as text)
  end tell
end tell
OSA
)"
  [ -n "$BOUNDS" ] && break
done
if [ -z "$BOUNDS" ]; then
  echo "창을 찾지 못했습니다: ${CANDIDATES[*]} (앱이 떠 있는지, 손쉬운 사용 권한이 있는지 확인)" >&2
  exit 1
fi
screencapture -x -R "$BOUNDS" "$OUT"
echo "mode=rect(System Events) rect=$BOUNDS saved=$(cd "$(dirname "$OUT")" && pwd)/$(basename "$OUT")"
