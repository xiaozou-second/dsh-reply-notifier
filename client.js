/**
 * Browser half: reminds the user when an agent reply finishes and when a
 * permission prompt (or any pending interaction) waits for input.
 *
 * Every event shows a toast. The tone and the operating-system notification
 * fire only when the user is not looking at that session — the window is
 * hidden, the session is not the main view, or the host already recorded the
 * stop as unread.
 */
window.__ModuleLoader__.load({
  id: '@xiaozou/reply-notifier',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const NS = 'reply-notifier'
    const CONFIG_GLOBAL = '__DSH_REPLY_NOTIFIER_CONFIG__'
    const TOAST_LIMIT = 3
    const TOAST_LIFETIME_MS = 6000
    const TONE_GAP_MS = 800
    const SOUND_HZ = 880

    const en = {
      replyTitle: 'Reply finished',
      replyBody: 'The agent finished this reply.',
      approvalTitle: 'Permission needed',
      approvalBody: 'Tool {toolName} is waiting for your approval.',
      approvalBodyUnknown: 'An operation is waiting for your approval.',
      questionTitle: 'Answer needed',
      questionBody: 'The agent is waiting for your answer.',
      planReviewTitle: 'Plan awaiting confirmation',
      planReviewBody: 'A plan is waiting for your confirmation.',
      promptTitle: 'Input needed',
      promptBody: 'The agent is waiting for your input.',
      dismiss: 'Dismiss reminder',
    }

    const zh = {
      replyTitle: '回复已完成',
      replyBody: '智能体已结束本轮回复。',
      approvalTitle: '等待你的授权',
      approvalBody: '工具 {toolName} 正在等待你的授权。',
      approvalBodyUnknown: '有一个操作正在等待你的授权。',
      questionTitle: '等待你的回答',
      questionBody: '智能体正在等待你的回答。',
      planReviewTitle: '计划等待确认',
      planReviewBody: '有一份计划正在等待你的确认。',
      promptTitle: '等待你的操作',
      promptBody: '智能体正在等待你的操作。',
      dismiss: '关闭提醒',
    }

    const CSS = `
.dsh-reply-notifier-stack {
  position: fixed; right: 16px; bottom: 16px; z-index: 40;
  display: flex; flex-direction: column; gap: 8px;
  width: max-content; max-width: min(360px, calc(100vw - 32px));
}
.dsh-reply-notifier-card {
  display: flex; align-items: flex-start; gap: 10px;
  box-sizing: border-box; padding: 12px 8px 12px 14px;
  border-radius: var(--dsw-radius-md);
  background: var(--dsw-alias-toast-bg);
  box-shadow: var(--dsw-elevation-panel);
  color: var(--dsw-alias-toast-label);
  font-size: 13px; line-height: 20px;
}
.dsh-reply-notifier-dot {
  flex: none; width: 8px; height: 8px; margin-top: 6px; border-radius: 50%;
  background: var(--dsw-alias-state-success-primary);
}
.dsh-reply-notifier-dot[data-tone="warn"] { background: var(--dsw-alias-state-warn-primary); }
.dsh-reply-notifier-text { display: flex; flex-direction: column; min-width: 0; }
.dsh-reply-notifier-title { font-weight: 500; }
.dsh-reply-notifier-body {
  color: var(--dsw-alias-toast-label); opacity: 0.78;
  overflow-wrap: anywhere;
}
.dsh-reply-notifier-label {
  max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  color: var(--dsw-alias-toast-label); opacity: 0.6; font-size: 12px; line-height: 18px;
}
.dsh-reply-notifier-close {
  flex: none; width: 24px; height: 24px; margin: -2px -2px 0 0; padding: 0;
  border: 0; border-radius: var(--dsw-radius-sm);
  background: transparent; color: var(--dsw-alias-toast-label); opacity: 0.7;
  font: inherit; line-height: 24px; text-align: center; cursor: pointer;
}
.dsh-reply-notifier-close:hover {
  opacity: 1;
  background: color-mix(in srgb, var(--dsw-alias-toast-label) 14%, transparent);
}
.dsh-reply-notifier-close:focus-visible {
  outline: 2px solid var(--dsw-alias-toast-action);
  outline-offset: 1px;
}
`

    const FALLBACK_CONFIG = {
      notifyOnReply: true,
      notifyOnPrompt: true,
      systemNotification: true,
      toast: true,
      sound: true,
      onlyWhenAway: false,
      alertWhileViewing: false,
    }

    /**
     * Read the options the Host published before the page was served.
     * @returns the options, with defaults for anything missing.
     */
    function readConfig() {
      const options = { ...FALLBACK_CONFIG }
      const source = globalThis[CONFIG_GLOBAL]
      if (source === null || typeof source !== 'object') return options
      for (const key of Object.keys(options)) {
        if (typeof source[key] === 'boolean') options[key] = source[key]
      }
      return options
    }

    /**
     * Whether the user is looking elsewhere: the window is hidden or minimized,
     * or another application holds the focus.
     * @returns true while the user cannot see this page.
     */
    function userAway() {
      if (typeof document === 'undefined') return false
      if (document.visibilityState === 'hidden') return true
      try {
        return typeof document.hasFocus === 'function' && !document.hasFocus()
      } catch {
        return false
      }
    }

    /**
     * Play one short reminder tone.
     * @returns whether an audible tone was scheduled; a blocked audio device is silent.
     */
    function beep() {
      try {
        const AudioCtor = globalThis.AudioContext ?? globalThis.webkitAudioContext
        if (typeof AudioCtor !== 'function') return false
        const context = new AudioCtor()
        if (context.state === 'suspended') context.resume().catch(() => {})
        const at = context.currentTime
        const oscillator = context.createOscillator()
        const gain = context.createGain()
        oscillator.type = 'sine'
        oscillator.frequency.setValueAtTime(SOUND_HZ, at)
        gain.gain.setValueAtTime(0.0001, at)
        gain.gain.exponentialRampToValueAtTime(0.12, at + 0.02)
        gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.24)
        oscillator.connect(gain)
        gain.connect(context.destination)
        oscillator.start(at)
        oscillator.stop(at + 0.26)
        // Release the context on a timer: `onended` never fires on a suspended one.
        setTimeout(() => { context.close().catch(() => {}) }, 400)
        // A suspended context schedules silently, so the notification keeps its own sound.
        return context.state === 'running'
      } catch {
        // A blocked AudioContext is not worth reporting: the toast stays visible.
        return false
      }
    }

    /**
     * Raise one operating-system notification when the browser allows it.
     * @param copy - localized title and body.
     * @param label - session label appended to the body, when known.
     * @param tag - replaces an older notification of the same kind.
     * @param silent - true when the separate reminder tone already plays.
     * @returns whether a notification was raised.
     */
    function showSystemNotification(copy, label, tag, silent) {
      if (typeof globalThis.Notification !== 'function') return Promise.resolve(false)
      const permission = globalThis.Notification.permission
      if (permission === 'denied') return Promise.resolve(false)
      const ready = permission === 'granted'
        ? Promise.resolve('granted')
        : Promise.resolve(globalThis.Notification.requestPermission()).catch(() => 'denied')
      return ready.then((state) => {
        if (state !== 'granted') return false
        try {
          const notification = new globalThis.Notification(copy.title, {
            body: label === undefined ? copy.body : `${copy.body} · ${label}`,
            tag,
            silent,
          })
          notification.onclick = () => {
            notification.close()
            try { globalThis.focus() } catch { /* the window may refuse focus */ }
          }
          return true
        } catch {
          return false
        }
      })
    }

    /**
     * Localized copy for one reminder kind.
     * @param kind - reminder kind.
     * @param params - reminder details, such as the pending tool name.
     * @param t - translate function of this plugin's namespace.
     * @returns the title, body, and tone dot of the reminder.
     */
    function describe(kind, params, t) {
      if (kind === 'reply') {
        return { tone: 'ok', title: t('replyTitle'), body: t('replyBody') }
      }
      if (kind === 'approval') {
        const toolName = params.toolName
        return {
          tone: 'warn',
          title: t('approvalTitle'),
          body: typeof toolName === 'string' && toolName !== ''
            ? t('approvalBody', { toolName })
            : t('approvalBodyUnknown'),
        }
      }
      if (kind === 'question') {
        return { tone: 'warn', title: t('questionTitle'), body: t('questionBody') }
      }
      if (kind === 'plan-review') {
        return { tone: 'warn', title: t('planReviewTitle'), body: t('planReviewBody') }
      }
      return { tone: 'warn', title: t('promptTitle'), body: t('promptBody') }
    }

    /**
     * Map a pending interaction onto a reminder kind.
     * @param interaction - pending interaction published by its own domain.
     * @returns the reminder kind.
     */
    function promptKind(interaction) {
      if (interaction.kind === 'approval') return 'approval'
      if (interaction.kind === 'question') return 'question'
      if (interaction.kind === 'plan-review') return 'plan-review'
      return 'prompt'
    }

    /** Reminders currently on screen, oldest first. */
    function createToastStore() {
      let items = []
      const listeners = new Set()
      const publish = () => { for (const listener of [...listeners]) listener() }
      return {
        getSnapshot: () => items,
        subscribe: (listener) => {
          listeners.add(listener)
          return () => { listeners.delete(listener) }
        },
        add: (item) => {
          items = [...items, item].slice(-TOAST_LIMIT)
          publish()
        },
        remove: (id) => {
          const next = items.filter(item => item.id !== id)
          if (next.length === items.length) return
          items = next
          publish()
        },
      }
    }

    /**
     * Watch session status and turn each new completion or pending prompt into
     * one reminder.
     * @param ctx - client context with `sessions` and `uiSession`.
     * @param config - reminder options.
     * @param report - receives every reminder, with the urgency it arrives at.
     * @returns the status subscription disposer.
     */
    function watchStatus(ctx, config, report) {
      const statusSource = ctx.uiSession.sessionStatus
      const sessions = ctx.sessions
      let previous = null

      const currentEntries = () => {
        const entries = new Map()
        for (const [sessionId, status] of statusSource.getSnapshot()) {
          entries.set(sessionId, {
            running: status.running === true,
            unread: status.completionUnread === true,
            key: status.pendingInteraction === undefined ? null : status.pendingInteraction.key,
            interaction: status.pendingInteraction,
          })
        }
        return entries
      }

      const summaryOf = (sessionId) => sessions.list.getSnapshot().byId[sessionId]

      const isChildSession = (sessionId) => {
        const summary = summaryOf(sessionId)
        return summary !== undefined
          && (summary.origin === 'subagent' || summary.parentId !== undefined)
      }

      const isMainView = (sessionId) => {
        const summary = summaryOf(sessionId)
        return summary !== undefined && (summary.retainedBy?.mainView ?? 0) > 0
      }

      const reportPrompt = (sessionId, interaction) => {
        report({
          kind: promptKind(interaction),
          sessionId,
          toolName: interaction.toolName,
          urgent: userAway() || !isMainView(sessionId),
        })
      }

      const evaluate = () => {
        const next = currentEntries()
        const before = previous
        previous = next
        if (before === null) {
          // A prompt still pending at load is exactly what the user needs to see.
          if (!config.notifyOnPrompt) return
          for (const [sessionId, entry] of next) {
            if (entry.interaction === undefined) continue
            reportPrompt(sessionId, entry.interaction)
          }
          return
        }
        for (const [sessionId, entry] of next) {
          const prior = before.get(sessionId)
          const freshPrompt = entry.interaction !== undefined
            && (prior === undefined || prior.key !== entry.key)
          // One snapshot can carry a stop and a prompt together; the prompt wins.
          if (!freshPrompt && config.notifyOnReply && prior !== undefined
            && prior.running && !entry.running && !isChildSession(sessionId)) {
            report({
              kind: 'reply',
              sessionId,
              urgent: userAway() || entry.unread,
            })
          }
          if (freshPrompt && config.notifyOnPrompt) reportPrompt(sessionId, entry.interaction)
        }
      }

      evaluate()
      return statusSource.subscribe(evaluate)
    }

    /**
     * One reminder card; hovering or focusing it holds the auto-dismiss.
     * @param props - the reminder, its dismissal, and the locale seat.
     * @returns the card markup.
     */
    function ToastCard({ item, dismiss, t }) {
      const copy = describe(item.kind, item, t)
      const [held, setHeld] = React.useState(false)
      React.useEffect(() => {
        if (held) return undefined
        const timer = setTimeout(() => dismiss(item.id), TOAST_LIFETIME_MS)
        return () => clearTimeout(timer)
      }, [held, item.id, dismiss])
      const release = (event) => {
        const next = event.relatedTarget
        if (next instanceof Node && event.currentTarget.contains(next)) return
        setHeld(false)
      }
      return h('div', {
        className: 'dsh-reply-notifier-card',
        onMouseEnter: () => setHeld(true),
        onMouseLeave: () => setHeld(false),
        onFocus: () => setHeld(true),
        onBlur: release,
      },
      h('span', {
        className: 'dsh-reply-notifier-dot',
        'data-tone': copy.tone,
        'aria-hidden': true,
      }),
      h('div', { className: 'dsh-reply-notifier-text' },
        h('span', { className: 'dsh-reply-notifier-title' }, copy.title),
        h('span', { className: 'dsh-reply-notifier-body' }, copy.body),
        item.label === undefined
          ? null
          : h('span', { className: 'dsh-reply-notifier-label' }, item.label)),
      h('button', {
        type: 'button',
        className: 'dsh-reply-notifier-close',
        'aria-label': t('dismiss'),
        onClick: () => dismiss(item.id),
      }, '×'))
    }

    /**
     * Render every reminder on screen inside one polite live region.
     * @param props - the reminder store, its dismissal, and the locale seat.
     * @returns the reminder stack.
     */
    function ToastStack(props) {
      const { store, dismiss, t } = props
      const items = React.useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)
      return h(React.Fragment, null,
        h('style', { dangerouslySetInnerHTML: { __html: CSS } }),
        h('div', {
          className: 'dsh-reply-notifier-stack',
          'aria-live': 'polite',
          'aria-relevant': 'additions',
        }, items.map(item => h(ToastCard, { key: item.id, item, dismiss, t }))))
    }

    return {
      inject: ['sessions', 'uiSession', 'slots', 'locale'],
      apply(ctx) {
        const config = readConfig()
        const store = createToastStore()
        const dismiss = (id) => { store.remove(id) }
        const sessions = ctx.sessions

        ctx.effect(() => ctx.locale.register(NS, { en, zh }), 'reply-notifier: dictionaries')
        const t = ctx.locale.bind(NS)

        const labelOf = (sessionId) => {
          const label = sessions.list.getSnapshot().byId[sessionId]?.displayTitle
          return typeof label === 'string' && label !== '' ? label : undefined
        }

        let seq = 0
        let lastToneAt = 0
        // One tone per burst; a throttled or blocked tone leaves the notification audible.
        const playTone = () => {
          if (!config.sound) return false
          const now = Date.now()
          if (now - lastToneAt < TONE_GAP_MS) return false
          lastToneAt = now
          return beep()
        }
        const report = ({ kind, sessionId, toolName, urgent }) => {
          if (config.onlyWhenAway && !userAway() && kind === 'reply') return
          seq += 1
          const copy = describe(kind, { toolName }, t)
          const label = labelOf(sessionId)
          if (config.toast) store.add({ id: `${kind}:${String(seq)}`, kind, toolName, label })
          if (!urgent && !config.alertWhileViewing) return
          const toned = playTone()
          if (config.systemNotification) {
            void showSystemNotification(copy, label, `dsh-reply-notifier:${kind}:${sessionId}`, toned)
          }
        }

        ctx.effect(() => watchStatus(ctx, config, report), 'reply-notifier: session status')
        ctx.slots.inject('shell.overlay', () => ctx.slots.register({
          name: 'shell.overlay',
          id: 'reply-notifier.toast',
          order: 10,
          locale: NS,
          inject: () => ({ store, dismiss }),
        }, ToastStack))
      },
    }
  },
})
