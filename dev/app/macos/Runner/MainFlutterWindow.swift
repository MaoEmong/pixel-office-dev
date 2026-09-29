import Cocoa
import FlutterMacOS

class MainFlutterWindow: NSWindow {
  override func awakeFromNib() {
    let flutterViewController = FlutterViewController()
    let windowFrame = self.frame
    self.contentViewController = flutterViewController
    self.setFrame(windowFrame, display: true)

    // 창 크기는 윈도우 러너와 같다(windows/runner/main.cpp: 1280×720).
    // 최소 1100×640 은 레이아웃 v2 의 하한이다 — 그 아래로는 상단 바가 넘치고 사무실이 스크롤로 넘어간다.
    self.contentMinSize = NSSize(width: 1100, height: 640)
    self.setContentSize(NSSize(width: 1280, height: 720))
    self.center()
    // 제목도 윈도우와 같은 말(메뉴 막대 이름은 Info.plist 의 CFBundleName).
    self.title = "픽셀 오피스"

    RegisterGeneratedPlugins(registry: flutterViewController)

    super.awakeFromNib()
  }
}
