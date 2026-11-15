# Reply notifier

A DeepSeek Harness bundle that pulls you back when an agent reply finishes, and
when a permission prompt, plan review, or question waits for your input.

It only reads session status: it never answers a prompt, never touches the
approval flow, and writes no session events.

## Install

In DeepSeek Harness, open **Plugins**, choose **Add plugin**, and enter the
package name:

```
@xiaozou-wine/reply-notifier
```

The bundle installs its own row and works with no further configuration. Turn
it off with the plugin switch, or uninstall it from the same page.

Built and tested with DeepSeek Harness `0.2.2-rc.3`. The bundle only consumes
published client services (`sessions`, `uiSession`, `uiWorkspace`, `slots`,
`locale`) and the `shell.overlay` slot, so a later Harness release either keeps
working or drops the overlay entry without disturbing the rest of the UI.

## What you see

- **Urgent reminders** are the ones you have to be told about: the window is
  hidden or unfocused, the session is not the one on screen, the host recorded
  the stop as unread, or you have not touched the app for `idleSeconds`. While
  you are away they take the top seat, in the middle, with a pulsing accent and
  a bell (a check for a finished reply), a count, **Dismiss all**, an **Open
  session** button, and they render above fullscreen panels and the sidebar
  drawer. They stay while you are away and clear the moment you come back to the
  window — a click, an alt-tab, or any input. While you are at the window they
  never take the top seat: they join the corner stack, where the same click or
  keystroke clears them.
- **Ambient reminders** appear as a card in the bottom-right corner while you
  watch the session that finished. Left alone they clear after `toastSeconds`;
  hovering or focusing the card holds that timer, and any click or keystroke in
  the window clears every reminder on screen at once.
- **Away from the keyboard**, an urgent reminder plays one three-strike chime
  and raises a persistent operating-system notification. `repeatSeconds` and
  `repeatLimit` can add a few repeats; both default to no repeats, so the chime
  rings once and the cards and the notification stay until you come back or
  dismiss them. The window title is prefixed with `🔴 N ·` while urgent
  reminders wait, so the taskbar and alt-tab entry carry a red count. The
  notification stays on screen until clicked where the operating system
  supports it, and clicking it focuses the window and opens the session.
- **The session list marks the session that waits for you**: after a turn ends, a
  red dot sits in that session's row until you open it, click in it, start its
  next turn, or a prompt takes over — the open session is marked too, so the row
  tells you which session is yours to answer. A waiting permission, plan review,
  or question keeps the harness's own status dot and adds no red dot, and
  `notifyOnReply: false` turns the red dot off.
- **Outside the window**, in DeepSeek Harness Desktop, the taskbar entry is
  flagged when a turn ends or a prompt waits — in front or behind: the button
  blinks three times, about a second per blink, and behind another window the
  orange highlight then stays until you activate the harness. The X11 urgency
  hint is used on Linux. It needs no change to the Desktop shell and is skipped
  when `flashTaskbar` is off; with `onlyWhenAway` on, only a reminder the client
  counted as urgent flashes.
- A reminder clears itself when its prompt is answered, a new turn starts in
  its session, or the session leaves the list; the row dot also clears as soon
  as you open that session or click inside it.

## Options

The bundle ships every option with its default. Override the row by id in the
profile's `cordis.patch.yml`; the patch replaces the whole config, so restate
the keys you want to keep:

```yaml
- id: reply-notifier
  name: '@xiaozou-wine/reply-notifier'
  config:
    notifyOnReply: true
    notifyOnPrompt: true
    systemNotification: true
    toast: true
    sound: true
    flashTaskbar: true
    onlyWhenAway: false
    alertWhileViewing: false
    dismissOnReturn: true
    requireInteraction: true
    toastSeconds: 20
    idleSeconds: 90
    repeatSeconds: 20
    repeatLimit: 0
```

| Key | Default | Meaning |
|---|---|---|
| `notifyOnReply` | `true` | Remind when a session stops running. |
| `notifyOnPrompt` | `true` | Remind when an approval, plan review, or question appears. |
| `systemNotification` | `true` | Raise an operating-system notification. |
| `toast` | `true` | Show the in-window cards. |
| `sound` | `true` | Play the plugin chime and keep system notifications silent; turn it off to silence both. |
| `flashTaskbar` | `true` | Blink the taskbar entry when a turn ends or a prompt waits, in front or behind; behind another window the orange highlight stays until activation (the X11 urgency hint on Linux renders only behind). |
| `onlyWhenAway` | `false` | Show no reply reminder while you are at the window; prompts still reach you, and the taskbar blink now waits for the client's urgent marker. |
| `alertWhileViewing` | `false` | Chime and notify even while you watch the session. |
| `dismissOnReturn` | `true` | Clear every reminder as soon as you come back to the window or press anything in it; `false` keeps the older timings. |
| `requireInteraction` | `true` | Keep the system notification until it is clicked or dismissed. |
| `toastSeconds` | `20` | Seconds a card stays after your next input once you are present; `0` keeps every card until dismissed. |
| `idleSeconds` | `90` | Seconds without keyboard, pointer, wheel, or mouse input before you count as away; `0` disables idle detection. |
| `repeatSeconds` | `20` | Seconds between repeated chimes while away; `0` disables repeats. |
| `repeatLimit` | `0` | Extra chimes after the first three-strike alert, then silence; `0` keeps only that first chime. |

Numeric values are clamped to sane ranges: `toastSeconds` and `idleSeconds` to
`0..3600`, `repeatSeconds` to `0..600`, and `repeatLimit` to `0..100`.

## Limits

- Reminders describe the session, not its content: no message text is read or
  copied into a reminder.
- At most 32 reminders are tracked; the urgent stack lists every one of them in
  a scrollable column (newest first), the ambient stack shows the newest three,
  and the header counts all urgent reminders. All operating-system
  notifications close when you return to the window; the cards stay.
- The first status snapshot at page load primes the watch, so a reply finishing
  before the page connects raises no reminder; a prompt still pending when the
  page loads does raise one.
- A subagent session's stop raises no reminder, because its parent keeps
  running; a prompt that a subagent waits for does raise one.
- The chime needs one pointer or keyboard event in the page after load to unlock
  the browser's audio device. Before that, the system notification carries the
  alert; after it, the chime also works while the window is unattended.
- The page must be allowed to use notifications; in a browser the plugin asks
  for that permission on your first pointer or keyboard event. A page that
  blocks notifications still shows the card and plays the chime. If the
  operating system itself hides notifications (for example Windows
  notifications are turned off), the native toast cannot appear; the chime, the
  window title marker, the row dot, and the taskbar flash still signal the
  reminder.
- The taskbar flag is the host half's one out-of-window channel, and both
  platforms go through a helper process: Windows starts a hidden
  `powershell.exe` that calls `FlashWindowEx` on the window of the Electron
  process that owns the harness, and Linux runs `wmctrl` to add
  `_NET_WM_STATE_DEMANDS_ATTENTION` to that window. The Windows helper asks the
  shell for three blinks in one `FlashWindowEx` call; each blink paints the
  taskbar button for about a second, and behind another window the orange
  highlight then stays until activation. Only `onlyWhenAway` makes it wait for
  the red urgent title count. Nothing is installed, downloaded, or sent over the
  network. A browser tab has no window to flag, Wayland sessions have no
  portable urgency hint, and a machine that blocks the helper keeps the chime,
  the title marker, the row dot, and the notification.
- A browser or desktop shell may throttle timers in a hidden or minimized
  window, so repeats can arrive later than `repeatSeconds`.
- No sound or notification is stored, sent, or logged anywhere; the bundle makes
  no network requests.

## Development

```sh
npm test
```

runs the browser half against stub services on a fake clock and asserts 200+
transitions: reply completion, prompt arrival and replacement, urgency and idle
detection, dismissal the moment you come back, sticky and escalating cards, the
repeat burst that stops after its limit, notification clicks, session opening, prompt and
reply reconciliation, the red reply dot on the session row, the taskbar blink on
every turn with the `onlyWhenAway` marker gate, and every option for both
Windows and X11, plus the host's option normalisation. No browser is needed.

| Path | Role |
|---|---|
| `index.js` | Host half: publishes the options into the page bootstrap and watches turns and prompts for the taskbar blink. |
| `lib/taskbar-flash.js` | Host half: builds the PowerShell payload and the `wmctrl` calls that flag the window. |
| `client.js` | Client half: watches `uiSession.sessionStatus`, renders the cards and the red reply dot, raises the chime and the notification. |
| `cordis.patch.yml` | The loader row the bundle inserts, with the default options. |
| `locale/en.json`, `locale/zh.json` | Plugin title, description, and the detail page. |
| `docs/DETAIL.md` | The image-only detail page shown in Plugin Manager. |
| `test/check.cjs` | Behaviour checks. |

## License

MIT.
