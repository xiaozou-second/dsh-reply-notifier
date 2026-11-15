/** Taskbar attention for the Desktop window: a Win32 flash on Windows, the X11
 * urgency hint on Linux. The renderer cannot reach `BrowserWindow`, so the host
 * half marks the window of the Electron process that owns it. */

import { execFile, spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'

/** `FLASHW_ALL`: flash the caption and the taskbar button of the window. */
const FLASH_FLAGS = 3

/** One helper launch covers every reminder inside this window. */
export const FLASH_COOLDOWN_MS = 2500

/** Ancestor hops searched for the window owner before giving up. */
const ANCESTOR_HOPS = 4

/** Budget for one window-manager command; a hung X call must not queue reminders. */
const COMMAND_TIMEOUT_MS = 1500

/** Blinks per burst; the system paints each one for about a second. */
const FLASH_PULSES = 3

/**
 * PowerShell source that flags the first ancestor window of `parentPid`.
 *
 * One `FlashWindowEx` call with `uCount` asks the shell for a whole blink
 * sequence: the taskbar entry turns orange for about a second per count and
 * then keeps the attention highlight until the window is activated. Calling
 * once per count instead would restart the flash every 600 ms and leave only a
 * faint flicker, which is what earlier versions did.
 *
 * `requireMarker` keeps the blink behind the client's red title marker, so a
 * reminder the client suppressed never flashes; it is off by default because
 * the host already decides which turns and prompts deserve attention.
 * @param parentPid - process whose ancestors are searched, normally the Electron main process.
 * @param options - `requireMarker` waits for the client's `🔴` title marker.
 * @returns the script text.
 */
export function flashScript(parentPid, options = {}) {
  const marker = options.requireMarker === true ? `
$title = New-Object System.Text.StringBuilder 512
$marked = $false
for ($attempt = 0; $attempt -lt 30; $attempt++) {
  [void][DshAttention.Window]::GetWindowTextW($handle, $title, $title.Capacity)
  if ($title.ToString().Contains('🔴')) { $marked = $true; break }
  Start-Sleep -Milliseconds 100
}
if (-not $marked) { exit 0 }
` : ''
  return `$ErrorActionPreference = 'SilentlyContinue'
Add-Type -Namespace DshAttention -Name Window -MemberDefinition '[StructLayout(LayoutKind.Sequential)] public struct FLASHWINFO { public uint cbSize; public IntPtr hwnd; public uint dwFlags; public uint uCount; public uint dwTimeout; } [DllImport("user32.dll")] public static extern bool FlashWindowEx(ref FLASHWINFO pfwi); [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr hwnd, System.Text.StringBuilder text, int count);'
$shells = @('explorer','cmd','powershell','pwsh','conhost','windowsterminal','wt','bash','mintty','wezterm-gui')
$cursor = ${parentPid}
$handle = [IntPtr]::Zero
for ($hop = 0; $hop -lt ${ANCESTOR_HOPS} -and $cursor -gt 0 -and $handle -eq [IntPtr]::Zero; $hop++) {
  $process = Get-Process -Id $cursor
  if ($null -eq $process) { break }
  if ($shells -contains $process.ProcessName.ToLower()) { break }
  if ($process.MainWindowHandle -ne 0) { $handle = $process.MainWindowHandle; break }
  $parent = Get-CimInstance Win32_Process -Filter "ProcessId=$cursor"
  $cursor = if ($null -eq $parent) { 0 } else { [int]$parent.ParentProcessId }
}
if ($handle -eq [IntPtr]::Zero) { exit 0 }${marker}
$info = New-Object 'DshAttention.Window+FLASHWINFO'
$info.cbSize = [uint32][System.Runtime.InteropServices.Marshal]::SizeOf([type]'DshAttention.Window+FLASHWINFO')
$info.hwnd = $handle
$info.dwFlags = [uint32]${FLASH_FLAGS}
$info.uCount = [uint32]${FLASH_PULSES}
$info.dwTimeout = [uint32]0
[void][DshAttention.Window]::FlashWindowEx([ref]$info)
exit 0`
}

/**
 * Argument list for one hidden, profile-free PowerShell launch.
 * @param parentPid - process whose ancestors are searched.
 * @param options - `requireMarker` waits for the client's red title marker.
 * @returns the command and its arguments.
 */
export function powerShellArguments(parentPid, options = {}) {
  return [
    '-NoProfile',
    '-NonInteractive',
    '-NoLogo',
    '-ExecutionPolicy',
    'Bypass',
    '-EncodedCommand',
    Buffer.from(flashScript(parentPid, options), 'utf16le').toString('base64'),
  ]
}

/**
 * Read the windows `wmctrl -lp` prints: id, desktop, pid, host, then the title.
 * @param output - command stdout.
 * @returns one entry per parsed line, in printed order.
 */
export function parseWmctrlWindows(output) {
  const windows = []
  for (const line of String(output ?? '').split(/\r?\n/)) {
    const match = /^(0x[0-9a-f]+)\s+(-?\d+)\s+(\d+)\s+\S+\s*(.*)$/i.exec(line.trim())
    if (match === null) continue
    windows.push({ id: match[1], pid: Number(match[3]), title: match[4] })
  }
  return windows
}

/**
 * `wmctrl` arguments that raise the urgency hint of one window, which taskbars
 * and docks render as a demanding entry.
 * @param windowId - X window id as `wmctrl` prints it.
 * @returns the argument list.
 */
export function wmctrlSetArguments(windowId) {
  return ['-i', '-b', 'add,demands_attention', windowId]
}

/**
 * Parent chain of one process, read from `/proc` without spawning anything.
 * @param start - first pid to report.
 * @param limit - hops to walk.
 * @returns the pids, starting with `start`.
 */
export function ancestorPids(start, limit = ANCESTOR_HOPS) {
  const pids = []
  let cursor = Number.isInteger(Number(start)) && Number(start) > 0 ? Number(start) : 0
  for (let hop = 0; hop < limit && cursor > 0; hop += 1) {
    pids.push(cursor)
    cursor = parentOf(cursor)
  }
  return pids
}

/**
 * Parent pid of one Linux process.
 * @param pid - process to read.
 * @returns the parent pid, or 0 when it cannot be read.
 */
function parentOf(pid) {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
    return Number(fields[1]) || 0
  } catch {
    return 0
  }
}

/**
 * Whether this process belongs to the Desktop shell rather than a plain `node`.
 * Electron's Node mode carries both facts; the browser transport carries neither.
 * @param runtime - process-like object to inspect.
 * @returns whether a taskbar exists to flag.
 */
export function isDesktopHost(runtime = process) {
  return typeof runtime?.versions?.electron === 'string' || runtime?.env?.ELECTRON_RUN_AS_NODE === '1'
}

/**
 * Build the taskbar-attention channel.
 * @param deps - options plus injectable platform facts and child-process calls (tests replace them).
 * @returns `enabled` and the flash operation.
 */
export function createTaskbarFlash(deps = {}) {
  const options = deps.options ?? {}
  const platform = deps.platform ?? process.platform
  const desktop = deps.desktop ?? isDesktopHost(deps.runtime)
  const parentPid = deps.parentPid ?? process.ppid
  const spawnProcess = deps.spawn ?? spawn
  const exec = deps.exec ?? execFile
  const now = deps.now ?? Date.now
  const log = deps.log ?? (() => {})
  const windows = platform === 'win32'
  const x11 = platform === 'linux'
  const enabled = options.flashTaskbar !== false
    && desktop
    && (windows || x11)
    && Number.isInteger(parentPid)
    && parentPid > 0
  const parents = deps.parents ?? (x11 ? ancestorPids(parentPid, ANCESTOR_HOPS) : [parentPid])
  // A client that only reminds you while you are away decides the urgency; the
  // red title marker carries that decision to the helper.
  const requireMarker = options.onlyWhenAway === true
  let launchedAt = -Infinity
  let disposed = false
  let broken = false
  let flasher = null

  const run = (file, args) => new Promise((resolve) => {
    try {
      exec(file, args, { timeout: COMMAND_TIMEOUT_MS }, (error, stdout) => {
        resolve({ error, stdout: typeof stdout === 'string' ? stdout : '' })
      })
    } catch (error) {
      resolve({ error, stdout: '' })
    }
  })

  // A missing window-manager helper or a vanished display never recovers.
  const fail = (reason, error) => {
    broken = true
    log('warn', `taskbar attention failed for ${reason}: ${error?.message ?? error}`)
  }

  const flashWindows = (reason) => {
    try {
      const launched = spawnProcess('powershell.exe', powerShellArguments(parentPid, { requireMarker }), {
        windowsHide: true,
        stdio: 'ignore',
      })
      // Only dispose() needs the handle; a missed exit event must never block
      // later reminders, and the cooldown already spaces the helpers out.
      flasher = launched
      launched.once?.('error', (error) => {
        if (flasher === launched) flasher = null
        fail(reason, error)
      })
      launched.once?.('exit', () => {
        if (flasher === launched) flasher = null
      })
      launched.unref?.()
      return true
    } catch (error) {
      fail(reason, error)
      return false
    }
  }

  const flashX11 = async (reason) => {
    const listed = await run('wmctrl', ['-lp'])
    if (listed.error) {
      fail(reason, listed.error)
      return false
    }
    const found = parseWmctrlWindows(listed.stdout)
    const owner = parents.find(pid => found.some(window => window.pid === pid))
    const window = found.find(entry => entry.pid === owner)
    if (window === undefined) return false
    const set = await run('wmctrl', wmctrlSetArguments(window.id))
    if (set.error) {
      fail(reason, set.error)
      return false
    }
    return true
  }

  return {
    enabled,
    /**
     * Flag the taskbar entry.
     * @param reason - what asked for attention, for the failure log only.
     * @returns whether the channel started working on it.
     */
    flash(reason = 'reminder') {
      if (!enabled || disposed || broken) return false
      const at = now()
      if (at - launchedAt < FLASH_COOLDOWN_MS) return false
      // A skipped launch leaves the cooldown untouched, so the next reminder retries.
      if (windows) {
        if (!flashWindows(reason)) return false
        launchedAt = at
        return true
      }
      launchedAt = at
      void flashX11(reason)
      return true
    },
    dispose: () => {
      disposed = true
      try {
        flasher?.kill?.()
      } catch {
        // The helper had already stopped.
      }
      flasher = null
    },
  }
}
