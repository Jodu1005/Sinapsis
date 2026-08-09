# macOS Desktop Pet Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a native macOS desktop-pet `.app` based on the supplied left-side portrait that crawls around screen and app-window edges, with two silent text-bubble interactions.

**Architecture:** A Swift Package executable owns the app lifecycle and is bundled by a shell script. AppKit provides transparent per-display overlays, status-menu controls and system-window access; a pure Swift physics core receives rectangular obstacles and is unit-tested without macOS UI.

**Tech Stack:** Swift 6.1, macOS 15 Command Line Tools, AppKit, SwiftUI, Quartz, ApplicationServices, XCTest, Make.

## Global Constraints

- Deliver macOS only; Windows `.exe` packaging is out of scope.
- Use the supplied photo's left-side person as the visual basis, with transparent background.
- All ordinary motion and both interactions are silent.
- Only the pet and visible interaction controls accept pointer events.
- Use accessibility window data when authorized; fall back to screen-edge-only obstacles when it is not.
- Do not modify the existing control-room documents or untracked files.
- The development machine has Command Line Tools but no full Xcode application, so use Swift Package Manager and a bundling script.

---

## File Structure

- `desktop-pet/Package.swift`: executable and test targets.
- `desktop-pet/Sources/DesktopPet/App/DesktopPetApp.swift`: delegate, menu bar, lifecycle and display refresh.
- `desktop-pet/Sources/DesktopPet/App/PetSettings.swift`: pause, scale and permission mode.
- `desktop-pet/Sources/DesktopPet/Geometry/PetGeometry.swift`: platform-independent point and rectangle types.
- `desktop-pet/Sources/DesktopPet/Physics/PetPhysicsEngine.swift`: movement state machine and collision resolution.
- `desktop-pet/Sources/DesktopPet/System/PermissionService.swift`: accessibility status and system prompt.
- `desktop-pet/Sources/DesktopPet/System/WindowObstacleProvider.swift`: window snapshot conversion and filtering.
- `desktop-pet/Sources/DesktopPet/UI/PetOverlayPanel.swift`: transparent click-through AppKit panel.
- `desktop-pet/Sources/DesktopPet/UI/PetOverlayView.swift`: sprite, choice buttons and speech bubble.
- `desktop-pet/Sources/DesktopPet/UI/PetSpriteAnimator.swift`: named frame-sequence animation.
- `desktop-pet/Sources/DesktopPet/Resources/Assets.xcassets`: portrait PNG frames and icon.
- `desktop-pet/Tests/DesktopPetTests/PetPhysicsEngineTests.swift`: collision and state tests.
- `desktop-pet/Tests/DesktopPetTests/WindowObstacleProviderTests.swift`: filtering tests.
- `desktop-pet/Info.plist`, `desktop-pet/scripts/build-app.sh`, `desktop-pet/Makefile`, `desktop-pet/README.md`: bundle, commands and instructions.

### Task 1: Create the package and collision-tested motion core

**Files:**
- Create: `desktop-pet/Package.swift`
- Create: `desktop-pet/Sources/DesktopPet/Geometry/PetGeometry.swift`
- Create: `desktop-pet/Sources/DesktopPet/Physics/PetPhysicsEngine.swift`
- Create: `desktop-pet/Tests/DesktopPetTests/PetPhysicsEngineTests.swift`
- Create: `desktop-pet/Makefile`

**Interfaces:**
- Produces: `PetRect`, `PetMotionState`, `PetSnapshot`, and `PetPhysicsEngine.update(now:bounds:obstacles:)`.
- Consumes: no Cocoa, SwiftUI, accessibility or image APIs.

- [ ] **Step 1: Write the failing collision tests**

```swift
func testPetTurnsBeforeScreenEdge() {
    var engine = PetPhysicsEngine(seed: 7, initialPosition: .init(x: 90, y: 40))
    engine.setVelocity(.init(dx: 80, dy: 0))
    let result = engine.update(now: 1, bounds: .init(x: 0, y: 0, width: 128, height: 80), obstacles: [])
    XCTAssertEqual(result.state, .turning)
    XCTAssertLessThanOrEqual(result.frame.maxX, 128)
}

func testPetAvoidsWindowRectangle() {
    var engine = PetPhysicsEngine(seed: 3, initialPosition: .init(x: 20, y: 20))
    engine.setVelocity(.init(dx: 120, dy: 0))
    let window = PetRect(x: 65, y: 0, width: 40, height: 80)
    let result = engine.update(now: 1, bounds: .init(x: 0, y: 0, width: 180, height: 100), obstacles: [window])
    XCTAssertEqual(result.state, .turning)
    XCTAssertFalse(result.frame.intersects(window))
}
```

- [ ] **Step 2: Verify the tests fail**

Run: `cd desktop-pet && swift test --filter PetPhysicsEngineTests`

Expected: package or `PetPhysicsEngine` is missing.

- [ ] **Step 3: Create the package and geometry types**

```swift
let package = Package(
    name: "DesktopPet",
    platforms: [.macOS(.v15)],
    products: [.executable(name: "DesktopPet", targets: ["DesktopPet"])],
    targets: [.executableTarget(name: "DesktopPet"), .testTarget(name: "DesktopPetTests", dependencies: ["DesktopPet"])]
)

struct PetRect: Equatable {
    var x: Double; var y: Double; var width: Double; var height: Double
    var maxX: Double { x + width }
    func intersects(_ other: PetRect) -> Bool { x < other.maxX && maxX > other.x && y < other.y + other.height && y + height > other.y }
}
```

- [ ] **Step 4: Implement deterministic collision resolution**

```swift
mutating func update(now: TimeInterval, bounds: PetRect, obstacles: [PetRect]) -> PetSnapshot {
    let proposed = frame.offsetBy(dx: velocity.dx * tick, dy: velocity.dy * tick)
    if !bounds.contains(proposed) || obstacles.contains(where: proposed.intersects) {
        state = .turning
        velocity.dx = -velocity.dx
        velocity.dy = velocity.dy == 0 ? verticalNudge() : -velocity.dy
    } else {
        frame = proposed
        state = .crawling
    }
    return PetSnapshot(frame: frame, direction: velocity.dx >= 0 ? .right : .left, state: state)
}
```

- [ ] **Step 5: Run tests and add commands**

Run: `cd desktop-pet && swift test`

Expected: all collision tests pass. Add `make test` for `swift test` and `make run` for `swift run DesktopPet`.

- [ ] **Step 6: Commit the motion core**

```bash
git add desktop-pet/Package.swift desktop-pet/Sources/DesktopPet/Geometry/PetGeometry.swift desktop-pet/Sources/DesktopPet/Physics/PetPhysicsEngine.swift desktop-pet/Tests/DesktopPetTests/PetPhysicsEngineTests.swift desktop-pet/Makefile
git commit -m "feat: add desktop pet physics core"
```

### Task 2: Add accessibility permissions, window obstacles and transparent overlays

**Files:**
- Create: `desktop-pet/Sources/DesktopPet/System/PermissionService.swift`
- Create: `desktop-pet/Sources/DesktopPet/System/WindowObstacleProvider.swift`
- Create: `desktop-pet/Sources/DesktopPet/UI/PetOverlayPanel.swift`
- Create: `desktop-pet/Sources/DesktopPet/App/PetSettings.swift`
- Create: `desktop-pet/Sources/DesktopPet/App/DesktopPetApp.swift`
- Create: `desktop-pet/Tests/DesktopPetTests/WindowObstacleProviderTests.swift`

**Interfaces:**
- Consumes: `PetRect` and `PetPhysicsEngine`.
- Produces: `PermissionMode`, `WindowObstacleProvider.obstacles()`, and one `PetOverlayPanel` per screen.

- [ ] **Step 1: Write a failing filtering test**

```swift
func testFiltersSelfAndInvisibleWindows() {
    let records = [
        WindowRecord(ownerPID: 42, bounds: .init(x: 0, y: 0, width: 30, height: 30), alpha: 1, layer: 0),
        WindowRecord(ownerPID: 99, bounds: .init(x: 0, y: 0, width: 30, height: 30), alpha: 0, layer: 0),
        WindowRecord(ownerPID: 99, bounds: .init(x: 5, y: 5, width: 30, height: 30), alpha: 1, layer: 0)
    ]
    XCTAssertEqual(WindowObstacleProvider.filter(records, excludingPID: 42), [records[2].bounds])
}
```

- [ ] **Step 2: Verify failure**

Run: `cd desktop-pet && swift test --filter WindowObstacleProviderTests`

Expected: missing `WindowRecord` or `WindowObstacleProvider`.

- [ ] **Step 3: Implement permission and filtering**

```swift
enum PermissionMode { case windowAware, screenEdgesOnly }

final class PermissionService {
    var mode: PermissionMode { AXIsProcessTrusted() ? .windowAware : .screenEdgesOnly }
    func promptForAccessibility() {
        AXIsProcessTrustedWithOptions([kAXTrustedCheckOptionPrompt.takeRetainedValue() as String: true] as CFDictionary)
    }
}

static func filter(_ records: [WindowRecord], excludingPID: pid_t) -> [PetRect] {
    records.filter { $0.ownerPID != excludingPID && $0.alpha > 0.05 && $0.layer == 0 && $0.bounds.width > 1 && $0.bounds.height > 1 }.map(\.bounds)
}
```

- [ ] **Step 4: Add an exact-hit transparent panel**

```swift
final class PetOverlayPanel: NSPanel {
    init(screen: NSScreen, content: NSView) {
        super.init(contentRect: screen.frame, styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
        isOpaque = false
        backgroundColor = .clear
        level = .floating
        collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        contentView = content
    }
}
```

The content view's `hitTest(_:) -> NSView?` returns a view only for the current pet frame or visible interaction controls. It returns `nil` everywhere else so ordinary desktop clicks pass through.

- [ ] **Step 5: Connect snapshots to each display engine**

Every second, the app delegate checks `PermissionService.mode`. In `.windowAware` it queries `CGWindowListCopyWindowInfo`, filters the current process and passes obstacles to each screen's engine. In `.screenEdgesOnly`, it passes an empty array. The status menu shows `窗口避障已开启` or `仅屏幕边缘`.

- [ ] **Step 6: Verify**

Run: `cd desktop-pet && swift test && swift run DesktopPet`

Expected: tests pass; without permission the app shows `仅屏幕边缘`, the overlay is transparent, and clicks away from the pet reach other apps.

- [ ] **Step 7: Commit**

```bash
git add desktop-pet/Sources/DesktopPet/System desktop-pet/Sources/DesktopPet/UI/PetOverlayPanel.swift desktop-pet/Sources/DesktopPet/App desktop-pet/Tests/DesktopPetTests/WindowObstacleProviderTests.swift
git commit -m "feat: add macOS overlay and window obstacles"
```

### Task 3: Create portrait frames and complete interactive pet behavior

**Files:**
- Create: `desktop-pet/Sources/DesktopPet/UI/PetOverlayView.swift`
- Create: `desktop-pet/Sources/DesktopPet/UI/PetSpriteAnimator.swift`
- Create: `desktop-pet/Sources/DesktopPet/Resources/Assets.xcassets/PetFrames/*.imageset/Contents.json`
- Add: `desktop-pet/Sources/DesktopPet/Resources/Assets.xcassets/PetFrames/*.imageset/*.png`
- Modify: `desktop-pet/Sources/DesktopPet/App/DesktopPetApp.swift`
- Modify: `desktop-pet/Sources/DesktopPet/App/PetSettings.swift`
- Create: `desktop-pet/Tests/DesktopPetTests/PetSpriteAnimatorTests.swift`

**Interfaces:**
- Consumes: `PetSnapshot`, `PetOverlayPanel` and `PetMotionState`.
- Produces: `PetSpriteAnimator.frameNames(for:)`, a visible choice menu and `PetInteraction`.

- [ ] **Step 1: Prepare image assets**

From the supplied photo retain only the left-side man, remove the second person and background, and create transparent PNGs on a consistent canvas of at least 512 by 512 pixels: one idle frame, four crawl frames, two turning frames and three shouting frames. Retain recognizable dark shirt, glasses, hairstyle and photo-realistic lighting. Store each PNG in a named Xcode asset set.

- [ ] **Step 2: Write and run a failing animation-mapping test**

```swift
func testShoutStateUsesShoutFrames() {
    let animator = PetSpriteAnimator(bundle: .module)
    XCTAssertTrue(animator.frameNames(for: .shouting).allSatisfy { $0.hasPrefix("shout-") })
}
```

Run: `cd desktop-pet && swift test --filter PetSpriteAnimatorTests`

Expected: missing animator before its implementation.

- [ ] **Step 3: Implement animator, menu and silent interaction sequence**

```swift
enum PetInteraction: String { case dad, noMoneyNoMeal }

func trigger(_ interaction: PetInteraction) {
    isMenuVisible = false
    motionState = .shouting
    bubbleText = interaction == .dad ? "爸爸" : "《没钱》不请吃饭"
    DispatchQueue.main.asyncAfter(deadline: .now() + 1.8) {
        self.bubbleText = nil
        self.motionState = .crawling
    }
}
```

On a pet click, freeze physics and present exactly two labeled SwiftUI buttons: `叫爸爸` and `《没钱》不请吃饭`. The sprite uses shout frames while the bubble appears above its head. There is no audio player, speech synthesizer or sound asset.

- [ ] **Step 4: Add status-menu controls**

Implement `暂停爬行`/ `继续爬行`, a small/medium/large scale submenu, `打开辅助功能设置`, and `退出`. Global pause preserves the current frame and prevents automatic resume after an interaction.

- [ ] **Step 5: Verify behavior**

Run: `cd desktop-pet && swift test && swift run DesktopPet`

Expected: a transparent-background portrait crawls in either direction; clicking it reveals two choices; either choice performs a silent shout with the matching bubble and then resumes.

- [ ] **Step 6: Commit**

```bash
git add desktop-pet/Sources/DesktopPet/UI desktop-pet/Sources/DesktopPet/App desktop-pet/Sources/DesktopPet/Resources desktop-pet/Tests/DesktopPetTests
git commit -m "feat: add animated pet interactions"
```

### Task 4: Bundle, document and perform full acceptance verification

**Files:**
- Create: `desktop-pet/Info.plist`
- Create: `desktop-pet/scripts/build-app.sh`
- Create: `desktop-pet/README.md`
- Modify: `desktop-pet/Makefile`

**Interfaces:**
- Consumes: the executable generated by `swift build -c release`.
- Produces: `desktop-pet/dist/DesktopPet.app`.

- [ ] **Step 1: Add a source-controlled bundle definition and bundling script**

```bash
#!/usr/bin/env bash
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root"
swift build -c release
app="$root/dist/DesktopPet.app"
rm -rf "$app"
mkdir -p "$app/Contents/MacOS" "$app/Contents/Resources"
cp ".build/release/DesktopPet" "$app/Contents/MacOS/DesktopPet"
cp Info.plist "$app/Contents/Info.plist"
```

Create `Info.plist` with `CFBundleExecutable=DesktopPet`, `CFBundleIdentifier=local.sinapsis.desktoppet`, `CFBundleName=DesktopPet`, and `LSUIElement=true`.

- [ ] **Step 2: Build and launch the release bundle**

Run: `cd desktop-pet && chmod +x scripts/build-app.sh && scripts/build-app.sh && open dist/DesktopPet.app`

Expected: the bundle opens without a Dock icon and exposes the menu-bar item and pet overlay.

- [ ] **Step 3: Document operation and permission behavior**

Document `make test`, `make run`, and `make app`; explain Accessibility permission, screen-edge-only fallback, the status-menu controls, the two interactions, and that the app has no network or sound behavior.

- [ ] **Step 4: Complete manual acceptance**

1. Launch without permission and verify edge-only crawling plus normal desktop clicks.
2. Grant Accessibility permission, open/move/close Finder, and observe avoidance or edge-following within one second.
3. Choose `叫爸爸`; verify a silent shout with `爸爸`.
4. Choose `《没钱》不请吃饭`; verify the complete matching text bubble.
5. Pause, resize, resume and quit; verify the overlay and background process disappear.

- [ ] **Step 5: Run final verification**

Run: `cd desktop-pet && make test && make app && test -x dist/DesktopPet.app/Contents/MacOS/DesktopPet && plutil -lint dist/DesktopPet.app/Contents/Info.plist`

Expected: tests pass, executable exists and `plutil` reports `OK`.

- [ ] **Step 6: Commit**

```bash
git add desktop-pet/Info.plist desktop-pet/scripts/build-app.sh desktop-pet/README.md desktop-pet/Makefile
git commit -m "build: package macOS desktop pet"
```

## Plan Self-Review

- Spec coverage: Tasks 1-2 implement stable movement, permissions, app-window obstacles, screen-edge fallback and click-through overlays; Task 3 implements the provided-person visual treatment, silent crawl/shout sequences, exact menu labels and controls; Task 4 implements the macOS bundle, documentation and every manual acceptance check.
- Placeholder scan: no undecided work remains. The application icon is optional and does not block app operation.
- Type consistency: `PetRect` is the sole physics/system obstacle type; the provider emits `[PetRect]`; the UI reads `PetSnapshot`; interactions are constrained to `.dad` and `.noMoneyNoMeal`.
