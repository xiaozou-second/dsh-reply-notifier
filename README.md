# Reply notifier

A DeepSeek Harness bundle that reminds you when an agent reply finishes, and
when a permission prompt, plan review, or question waits for your input.

It only reads session status: it never answers a prompt, never touches the
approval flow, and writes no session events.

## Install

In DeepSeek Harness, open **Plugins**, choose **Add plugin**, and enter the
package name:

```
@xiaozou/reply-notifier
```

The bundle installs its own row and works with no further configuration. Turn
it off with the plugin switch, or uninstall it from the same page.

Built and tested with DeepSeek Harness `0.2.2-rc.3`. The bundle only consumes
published client services (`sessions`, `uiSession`, `slots`, `locale`) and the
`shell.overlay` slot, so a later Harness release either keeps working or drops
the overlay entry without disturbing the rest of the UI.

## What you see

- Every reminder is a card in the frame-wide overlay, bottom right. It names the
  session, holds open while you hover or focus it, and otherwise disappears
  after six seconds; its close button dismisses it immediately.
- A short tone and an operating-system notification are added only while you are
  away: the window is hidden or minimized, another application has focus, the
  session is not the one on screen, or the host already recorded the stop as
  unread. While you watch the session that finished, the card is the whole
  reminder.
- Set `alertWhileViewing: true` to sound the tone and raise the notification
  even while you watch.

## Options

The bundle ships every option with its default. Override the row by id in the
profile's `cordis.patch.yml`; the patch replaces the whole config, so restate
the keys you want to keep:

```yaml
- id: reply-notifier
  name: '@xiaozou/reply-notifier'
  config:
    notifyOnReply: true
    notifyOnPrompt: true
    systemNotification: true
    toast: true
    sound: false
    onlyWhenAway: true
    alertWhileViewing: false
```

| Key | Default | Meaning |
|---|---|---|
| `notifyOnReply` | `true` | Remind when a session stops running. |
| `notifyOnPrompt` | `true` | Remind when an approval, plan review, or question appears. |
| `systemNotification` | `true` | Raise an operating-system notification. |
| `toast` | `true` | Show the in-window card. |
| `sound` | `true` | Play a short tone; when it plays, the system notification stays silent. |
| `onlyWhenAway` | `false` | Show no reply reminder while you are at the window; prompts still reach you. |
| `alertWhileViewing` | `false` | Tone and notification even while you watch the session. |

## Limits

- Reminders describe the session, not its content: no message text is read or
  copied into a reminder.
- The first status snapshot at page load primes the watch, so a reply finishing
  before the page connects raises no reminder; a prompt still pending when the
  page loads does raise one.
- A subagent session's stop raises no reminder, because its parent keeps
  running; a prompt that a subagent waits for does raise one.
- The operating-system notification needs the page to be allowed to use
  notifications. A browser tab that blocks them still shows the card and plays
  the tone.
- No sound or notification is stored, sent, or logged anywhere; the bundle makes
  no network requests.

## Development

```sh
npm test
```

runs the browser half against stub services and asserts 40+ transitions: reply
completion, prompt arrival and replacement, the urgency rules, session labels,
subagent filtering, and every option. No browser is needed.

| Path | Role |
|---|---|
| `index.js` | Host half: publishes the options into the page bootstrap. |
| `client.js` | Client half: watches `uiSession.sessionStatus`, renders the card, raises the tone and the notification. |
| `cordis.patch.yml` | The loader row the bundle inserts, with the default options. |
| `locale/en.json`, `locale/zh.json` | Plugin title, description, and the detail page. |
| `docs/DETAIL.md` | The image-only detail page shown in Plugin Manager. |
| `test/check.cjs` | Behaviour checks. |

## License

MIT.
