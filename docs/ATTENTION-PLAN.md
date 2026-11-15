# Attention outside the DSH window — design plan

## Goal

When an agent finishes, or a prompt waits, and the DSH window is not focused,
signal the user on Windows: a flashing taskbar button, a red taskbar badge, or a
native desktop notification. The in-window card is only the return path.

## What shipped (v1.2.0, plugin-only)

The bundle now flashes the DSH taskbar button without touching the installed
shell:

- `lib/taskbar-flash.js` — host half. On a `turn/end` or a waiting
  approval/question, it starts one hidden `powershell.exe` that resolves the
  window of the Electron process owning the harness
  (`GetProcessById(ppid).MainWindowHandle`, walking up to four ancestors) and
  calls `FlashWindowEx` with `FLASHW_ALL | FLASHW_TIMERNOFG` (`15`), so the
  button flashes until the window comes forward.
- The window is skipped when it already owns the foreground
  (`GetForegroundWindow`), so a user looking at the harness never sees a flash.
- The helper is skipped for `aborted`, `interrupted`, and `forked` turn endings,
  for subagent sessions, when `notifyOnReply`/`notifyOnPrompt` are off, and it
  runs once per 2.5 s (`FLASH_COOLDOWN_MS`).
- `approval/request` and `user-questions/request` listeners delegate to `next()`
  unchanged: the flash never answers or replaces the real answerer.
- New option `flashTaskbar` (default `true`), Desktop only: a taskbar flash on
  Windows, the X11 urgency hint on Linux. Windows runs one hidden
  `powershell.exe` that resolves the Electron window, flashes it every 600 ms
  and stops when the window comes forward, when system-wide input arrives
  900 ms after the start (`GetLastInputInfo`, the only input another process
  can see), after eight seconds when the window started in front, or when the
  window disappears (`IsWindow`); one helper runs at a time and `dispose()`
  kills it. Linux runs `wmctrl -lp` to find the window whose `_NET_WM_PID` is
  the Electron main process, then `wmctrl -i -b add,demands_attention`; without
  `wmctrl`, or on Wayland, it disables itself after one logged warning instead
  of failing every reminder.
- Also shipped: `dismissOnReturn` (default `true`) — a click, alt-tab, or any
  input back in the window clears the reminders instead of waiting for
  `toastSeconds` or a manual close; while the window has the foreground no
  reminder takes the top seat, urgent ones join the corner stack and the next
  click or keystroke drops them.
- `test/check.cjs`: 217 checks green, including the generated payload round
  trip, the cooldown, every off switch, the delegation of both waterfall
  events, dismissal on return and on input, the present/away seat, and the X11
  flag through a stubbed `wmctrl`.

Verified on this machine: the payload exits `0` in 277 ms, resolves the DSH
window (hwnd 786454) from a process inside the harness tree, and reports
`foreground=False` when the window is not in front. A flash launched from a
child of the host process was observed to reach the same window.

## Facts verified in this environment

- The plugin runs in the DSH Desktop renderer (Electron). Its available
  out-of-window channels are `new Notification(...)`, Web Audio, and
  `document.title` — all three are already used.
- A native toast is already raised by the plugin. On this machine Windows
  notifications are globally off:
  `HKCU\Software\Microsoft\Windows\CurrentVersion\PushNotifications\ToastEnabled = 0`.
  No app can bypass that master switch, and a main-process Notification is
  blocked by the same setting.
- The preload (`lib/preload-app.cjs`, `createProductApi()`) exposes
  `fileActions`, `browser`, `fileDrag`, `deviceInfo`, `keyboard`, `shortcuts`,
  and `updates`, with `protocolVersion: 1`. There is no attention, badge, or
  window API.
- `BrowserWindow.flashFrame()` and `BrowserWindow.setOverlayIcon()` are
  main-process only. The host half is a plain Node child of the Electron main
  process (`ELECTRON_RUN_AS_NODE=1`, `spawn` at `lib/main.js:11785`), so it
  cannot call them — but `process.ppid` is the main process whose window can be
  flashed from another process.
- Electron fuses in `DeepSeek Harness.exe`: `EnableEmbeddedAsarIntegrityValidation`
  **disabled**, `OnlyLoadAppFromAsar` **disabled**. A patched `app.asar` would
  load, but DSH auto-updates (`resources/app-update.yml`) and every update
  replaces the archive.

## Option A — DSH Desktop attention bridge (deferred upgrade)

Chosen as a later upgrade, after the plugin-only flash has been lived with. It
adds a red overlay badge, which no plugin-only channel can reach.

### Main process (`lib/main.js`)

- Add names to `DESKTOP_IPC` in **both** bundled copies: `lib/main.js` (line 1441)
  and `lib/preload-app.cjs` (line 4): `attentionFlash`, `attentionClear`,
  `attentionBadge`.
- Register `ipcMain.handle` near the existing handlers (~line 1602):
  - `attentionFlash`: resolve the sender `BrowserWindow`; if it exists, is not
    destroyed, and is not focused, call `win.flashFrame(true)` on Win32/Linux,
    `app.dock.bounce('informational')` on macOS (keep the returned id).
  - `attentionClear`: `win.flashFrame(false)`, cancel the dock bounce, clear the
    overlay/badge.
  - `attentionBadge`: Windows `win.setOverlayIcon(redDot ?? null, label)` using
    `nativeImage.createFromDataURL`; macOS `app.dock.setBadge(...)`; Linux
    `app.setBadgeCount(count)`.
  - Clear the flash on the window's `focus` event.
- Keep the handler attention-only: no data, no file/process access; check the
  sender window and main-frame origin (`assertDesktopSender`, line 1484).

### Preload (`lib/preload-app.cjs`)

- Extend `createProductApi()` (line 1998–2078) with
  `attention: { flash, clear, badge }` and bump `protocolVersion` to `2`.

### Plugin (`public/client.js`)

- Feature-detect `globalThis.dshDesktop?.attention`; in `refreshChannels()`,
  beside `titleMarker.set(...)`: `bridge?.badge(urgentItems().length)`, and
  `bridge?.flash()` when the count rises while away; `clear()` at zero and on
  focus. Keep the chime, title, notification, and taskbar-flash fallbacks.

### Risks

- This is a **shell change**: build a patched `app.asar` (or drop an unpacked
  `resources/app`), keep the original archive as the restore path, and re-apply
  after every DSH update. Do not edit the installed `app.asar` without a tested
  restore copy.

## Option B — plugin-only helper (shipped, see above)

The original assessment was "not recommended" for its ~1 s startup and antivirus
noise. Measured on this machine it is 277 ms for the fast path (parent process
already owns the window) and the payload is one hidden `powershell.exe` with
`FlashWindowEx`; that is cheap enough per reminder burst, and it is the only
route that survives DSH updates. A `MessageBox` or always-on-top WPF window
remains rejected as intrusive.

## Option C — enable Windows notifications (no code)

Turn on **Settings → System → Notifications** (set `ToastEnabled=1`, then
restart Explorer/WpnUserService). The plugin's existing `Notification` then
appears outside DSH. This is the cheapest extra route if the user accepts
notifications; it also makes the repeat reminders visible.

## Current state (handoff)

- `public/client.js` (1033 lines): sticky urgent alerts portaled above panels;
  3-round chime; 12 rapid repeats + 2-minute tail; `🔴 N ·` title marker; audio
  unlock; native notification with click-to-open; prompt/reply reconciliation;
  every reminder cleared by the next click back into the window.
- `public/index.js` (125 lines): normalized options, page bootstrap, and the
  taskbar-flash watcher; `public/lib/taskbar-flash.js` (229 lines) builds the
  PowerShell payload and the `wmctrl` calls.
- `public/test/check.cjs` (1116 lines): 217 checks passing on a fake clock, no
  child process spawned.
- Windows `ToastEnabled=0` verified; taskbar flash verified manually against
  hwnd 786454.
- The host half changed, so the harness needs one restart to load the new
  `index.js`; the client half hot-swaps as usual.

## Next-session prompt

> The plugin-only taskbar flash is shipped and verified. If a red taskbar badge
> is still wanted, implement Option A from `public/docs/ATTENTION-PLAN.md`:
> patch `lib/main.js` and `lib/preload-app.cjs` in a copy of `app.asar`, feature
> detect `dshDesktop.attention` in `client.js`, and keep a restore script plus
> instructions for re-applying the patch after each DSH update.
