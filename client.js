/** Browser half: pull the user back when a reply finishes or a prompt waits.
 * Reminders stay until acknowledged; away ones repeat a chime and notification. */
window.__ModuleLoader__.load({
  id: '@xiaozou-wine/reply-notifier',
  factory(require) {
    const React = require('react')
    const ReactDOM = (() => {
      try { return require('react-dom') } catch { return undefined }
    })()
    const h = React.createElement

    const NS = 'reply-notifier'
    const CONFIG_GLOBAL = '__DSH_REPLY_NOTIFIER_CONFIG__'
    const REMINDER_LIMIT = 32
    const VISIBLE_TOASTS = 3
    const TONE_GAP_MS = 1200
    // Three rising strikes of A5-D6-G6: a bell-like call that carries across a room.
    const CHIME = [
      [880, 0, 0.5, 0.28],
      [1174.66, 0.16, 0.5, 0.28],
      [1567.98, 0.32, 0.75, 0.32],
      [880, 1.05, 0.5, 0.28],
      [1174.66, 1.21, 0.5, 0.28],
      [1567.98, 1.37, 0.75, 0.32],
      [880, 2.1, 0.5, 0.28],
      [1174.66, 2.26, 0.5, 0.28],
      [1567.98, 2.42, 0.75, 0.32],
    ]

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
      waitingCount: '{count} reminders',
      stillWaiting: 'Reminder still pending',
      repeatBody: 'Return to DeepSeek Harness to check what needs you.',
      openSession: 'Open session',
      openSessionFor: 'Open session {name}',
      dismissAll: 'Dismiss all',
      dismiss: 'Dismiss reminder',
      awaitingReply: 'Waiting for your reply',
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
      waitingCount: '{count} 项提醒',
      stillWaiting: '提醒仍待处理',
      repeatBody: '回到 DeepSeek Harness 查看需要你处理的事项。',
      openSession: '打开会话',
      openSessionFor: '打开会话 {name}',
      dismissAll: '全部关闭',
      dismiss: '关闭提醒',
      awaitingReply: '等待你的回复',
    }

    const CSS = `
.dsh-reply-notifier-alerts, .dsh-reply-notifier-stack {
  position: fixed; display: flex; flex-direction: column; gap: 8px;
  max-height: min(70vh, calc(100vh - 120px)); overflow-y: auto;
  overscroll-behavior: contain; pointer-events: none;
}
.dsh-reply-notifier-alerts {
  left: 50%; transform: translateX(-50%); top: max(64px, var(--dsh-frame-overlay-top, 0px));
  z-index: 999; width: min(468px, calc(100vw - 32px)); padding: 2px;
}
.dsh-reply-notifier-stack {
  right: 16px; bottom: 16px; z-index: 998;
  width: max-content; max-width: min(360px, calc(100vw - 32px));
  max-height: min(60vh, calc(100vh - 120px));
}
.dsh-reply-notifier-alert-head {
  display: flex; align-items: center; justify-content: space-between; gap: 8px;
  padding: 3px 4px 3px 10px; pointer-events: auto;
  border-radius: var(--dsw-radius-lg); background: var(--dsw-alias-toast-bg);
  box-shadow: var(--dsw-shadow-lv3); color: var(--dsw-alias-toast-label);
  font-size: 12px; line-height: 18px;
}
.dsh-reply-notifier-dismiss-all, .dsh-reply-notifier-open, .dsh-reply-notifier-close {
  font: inherit; cursor: pointer; border-radius: var(--dsw-radius-sm);
}
.dsh-reply-notifier-dismiss-all {
  padding: 4px 8px; border: 0; background: transparent; color: inherit;
}
.dsh-reply-notifier-dismiss-all:hover {
  background: color-mix(in srgb, var(--dsw-alias-toast-label) 14%, transparent);
}
.dsh-reply-notifier-alert, .dsh-reply-notifier-card {
  display: flex; align-items: flex-start; gap: 10px; pointer-events: auto;
  box-sizing: border-box; border-radius: var(--dsw-radius-lg);
  background: var(--dsw-alias-toast-bg); box-shadow: var(--dsw-shadow-lv3);
  color: var(--dsw-alias-toast-label); font-size: 14px; line-height: 22px;
}
.dsh-reply-notifier-alert {
  --dsh-reply-notifier-accent: var(--dsw-alias-state-success-primary);
  padding: 13px 8px 13px 13px;
  border-left: 4px solid var(--dsh-reply-notifier-accent);
  animation: dsh-reply-notifier-rise 180ms ease-out,
    dsh-reply-notifier-pulse 2.6s ease-in-out 0.3s infinite;
}
.dsh-reply-notifier-alert[data-tone="warn"] { --dsh-reply-notifier-accent: var(--dsw-alias-state-warn-primary); }
.dsh-reply-notifier-icon { flex: none; width: 22px; height: 22px; margin-top: 1px; color: var(--dsh-reply-notifier-accent); }
.dsh-reply-notifier-alert[data-tone="warn"] .dsh-reply-notifier-icon {
  animation: dsh-reply-notifier-swing 2.6s ease-in-out infinite; transform-origin: 50% 12%;
}
.dsh-reply-notifier-text { display: flex; flex-direction: column; min-width: 0; flex: 1; }
.dsh-reply-notifier-title { font-weight: 600; }
.dsh-reply-notifier-body { opacity: 0.82; overflow-wrap: anywhere; }
.dsh-reply-notifier-label {
  max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  opacity: 0.6; font-size: 12px; line-height: 18px;
}
.dsh-reply-notifier-actions { display: flex; flex: none; align-items: center; gap: 2px; align-self: flex-start; }
.dsh-reply-notifier-open {
  white-space: nowrap; padding: 3px 8px; font-size: 12px; line-height: 18px;
  border: 1px solid color-mix(in srgb, var(--dsw-alias-toast-label) 26%, transparent);
  background: transparent; color: var(--dsw-alias-toast-label);
}
.dsh-reply-notifier-open:hover {
  border-color: var(--dsh-reply-notifier-accent); color: var(--dsh-reply-notifier-accent);
}
.dsh-reply-notifier-close {
  flex: none; width: 24px; height: 24px; margin: 0; padding: 0; text-align: center;
  border: 0; background: transparent; color: var(--dsw-alias-toast-label); opacity: 0.7; line-height: 24px;
}
.dsh-reply-notifier-close:hover { opacity: 1; background: color-mix(in srgb, var(--dsw-alias-toast-label) 14%, transparent); }
.dsh-reply-notifier-dismiss-all:focus-visible, .dsh-reply-notifier-open:focus-visible,
.dsh-reply-notifier-close:focus-visible { outline: 2px solid var(--dsw-alias-toast-action); outline-offset: 1px; }
.dsh-reply-notifier-card {
  padding: 12px 8px 12px 14px; animation: dsh-reply-notifier-rise 160ms ease-out;
}
.dsh-reply-notifier-dot {
  flex: none; width: 8px; height: 8px; margin-top: 6px; border-radius: 50%;
  background: var(--dsw-alias-state-success-primary);
}
.dsh-reply-notifier-dot[data-tone="warn"] { background: var(--dsw-alias-state-warn-primary); }
@keyframes dsh-reply-notifier-rise {
  from { opacity: 0; transform: translateY(-6px); } to { opacity: 1; transform: translateY(0); }
}
@keyframes dsh-reply-notifier-pulse {
  0%, 100% { box-shadow: var(--dsw-shadow-lv3), 0 0 0 0 color-mix(in srgb, var(--dsh-reply-notifier-accent) 34%, transparent); }
  50% { box-shadow: var(--dsw-shadow-lv3), 0 0 0 7px color-mix(in srgb, var(--dsh-reply-notifier-accent) 0%, transparent); }
}
@keyframes dsh-reply-notifier-swing {
  0%, 62%, 100% { transform: rotate(0); }
  68% { transform: rotate(-11deg); } 74% { transform: rotate(8deg); }
  80% { transform: rotate(-5deg); } 86% { transform: rotate(2deg); }
}
@media (prefers-reduced-motion: reduce) {
  .dsh-reply-notifier-alert, .dsh-reply-notifier-card,
  .dsh-reply-notifier-alert[data-tone="warn"] .dsh-reply-notifier-icon { animation: none; }
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
      dismissOnReturn: true,
      requireInteraction: true,
      toastSeconds: 20,
      idleSeconds: 90,
      repeatSeconds: 20,
      repeatLimit: 0,
    }

    function readConfig() {
      const options = { ...FALLBACK_CONFIG }
      const source = globalThis[CONFIG_GLOBAL]
      if (source === null || typeof source !== 'object') return options
      for (const key of Object.keys(options)) {
        if (typeof options[key] === 'boolean') {
          if (typeof source[key] === 'boolean') options[key] = source[key]
        } else if (typeof source[key] === 'number' && Number.isFinite(source[key])) {
          options[key] = source[key]
        }
      }
      return options
    }

    function userAway() {
      if (typeof document === 'undefined') return false
      if (document.visibilityState === 'hidden') return true
      try {
        return typeof document.hasFocus === 'function' && !document.hasFocus()
      } catch {
        return false
      }
    }

    function describe(kind, params, t) {
      if (kind === 'reply') return { tone: 'ok', title: t('replyTitle'), body: t('replyBody') }
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
      if (kind === 'question') return { tone: 'warn', title: t('questionTitle'), body: t('questionBody') }
      if (kind === 'plan-review') return { tone: 'warn', title: t('planReviewTitle'), body: t('planReviewBody') }
      return { tone: 'warn', title: t('promptTitle'), body: t('promptBody') }
    }

    function promptKind(interaction) {
      if (interaction.kind === 'approval') return 'approval'
      if (interaction.kind === 'question') return 'question'
      if (interaction.kind === 'plan-review') return 'plan-review'
      return 'prompt'
    }

    function createChime() {
      const AudioCtor = globalThis.AudioContext ?? globalThis.webkitAudioContext
      const supported = typeof AudioCtor === 'function'
      let context = null
      let disposed = false

      const ensure = () => {
        if (!supported || disposed) return null
        if (context === null) {
          try {
            context = new AudioCtor()
          } catch {
            context = null
          }
        }
        return context
      }
      const unlock = () => {
        const current = ensure()
        if (current !== null && current.state === 'suspended') current.resume().catch(() => {})
      }
      const play = () => {
        const current = ensure()
        if (current === null) return false
        if (current.state === 'suspended') current.resume().catch(() => {})
        if (current.state !== 'running') return false
        try {
          const origin = current.currentTime + 0.02
          for (const [frequency, offset, duration, peak] of CHIME) {
            const oscillator = current.createOscillator()
            const gain = current.createGain()
            oscillator.type = 'triangle'
            oscillator.frequency.setValueAtTime(frequency, origin + offset)
            gain.gain.setValueAtTime(0.0001, origin + offset)
            gain.gain.exponentialRampToValueAtTime(peak, origin + offset + 0.02)
            gain.gain.exponentialRampToValueAtTime(0.0001, origin + offset + duration)
            oscillator.connect(gain)
            gain.connect(current.destination)
            oscillator.start(origin + offset)
            oscillator.stop(origin + offset + duration + 0.02)
          }
          return true
        } catch {
          return false
        }
      }
      return {
        unlock,
        play,
        dispose: () => {
          disposed = true
          if (context === null) return
          try {
            context.close().catch(() => {})
          } catch {
            // Already closed.
          }
        },
      }
    }

    function createPresence(config, onChange, onInput) {
      const idleMs = Math.max(0, Math.round(config.idleSeconds * 1000))
      const listeners = []
      let lastActivity = Date.now()
      let lastMove = 0
      let idle = false
      let idleTimer = null
      let disposed = false

      const notify = () => { if (!disposed) onChange() }
      const scheduleIdle = () => {
        if (idleTimer !== null) { clearTimeout(idleTimer); idleTimer = null }
        if (idleMs <= 0 || disposed) return
        idleTimer = setTimeout(() => {
          idleTimer = null
          if (disposed) return
          idle = true
          notify()
        }, Math.max(0, idleMs - (Date.now() - lastActivity)))
      }
      const wake = () => {
        lastActivity = Date.now()
        idle = false
        scheduleIdle()
      }
      const activity = () => { wake(); notify() }
      // A real click, key, wheel, or touch is also an acknowledgement.
      const input = (event) => {
        wake()
        if (typeof onInput === 'function' && !disposed) onInput(event)
        notify()
      }
      // A pointer may read without clicking; a quiet mouse still proves presence.
      const hover = () => {
        const now = Date.now()
        if (now - lastMove < 1000) return
        lastMove = now
        const wasIdle = idle
        wake()
        if (wasIdle) notify()
      }

      if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
        for (const type of ['pointerdown', 'keydown', 'touchstart', 'wheel']) {
          document.addEventListener(type, input, { capture: true, passive: true })
          listeners.push(() => document.removeEventListener(type, input, { capture: true }))
        }
        document.addEventListener('mousemove', hover, { passive: true })
        listeners.push(() => document.removeEventListener('mousemove', hover))
        const visibility = () => {
          if (typeof document === 'undefined' || document.visibilityState === 'hidden') notify()
          else activity()
        }
        document.addEventListener('visibilitychange', visibility)
        listeners.push(() => document.removeEventListener('visibilitychange', visibility))
      }
      if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
        window.addEventListener('focus', activity)
        window.addEventListener('blur', notify)
        listeners.push(() => {
          window.removeEventListener('focus', activity)
          window.removeEventListener('blur', notify)
        })
      }
      scheduleIdle()
      return {
        away: () => userAway() || idle,
        lastActivity: () => lastActivity,
        dispose: () => {
          disposed = true
          if (idleTimer !== null) clearTimeout(idleTimer)
          for (const off of listeners) off()
        },
      }
    }

    /** Mirror pending urgent reminders into the window title (taskbar / alt-tab). */
    function createTitleMarker() {
      let count = 0, base = null, applied = null, timer = null, disposed = false
      const stop = () => { if (timer !== null) { clearTimeout(timer); timer = null } }
      const render = () => {
        if (typeof document === 'undefined') return
        if (count === 0) {
          if (applied !== null && document.title === applied && base !== null) document.title = base
          base = applied = null
          return
        }
        if (document.title !== applied) base = document.title
        applied = `🔴 ${count} · ${base ?? ''}`
        document.title = applied
      }
      const tick = () => {
        timer = null
        if (disposed) return
        render()
        if (count > 0) timer = setTimeout(tick, 2000)
      }
      return {
        set: (next) => {
          if (next === count) return
          count = next
          render()
          if (count > 0) { if (timer === null) timer = setTimeout(tick, 2000) } else stop()
        },
        dispose: () => { disposed = true; stop(); count = 0; render() },
      }
    }

    function createNotifier() {
      const supported = typeof globalThis.Notification === 'function'
      const handles = new Map()
      const tokens = new Map()
      let prepared = false
      let disposed = false

      const close = (key) => {
        const handle = handles.get(key)
        handles.delete(key)
        if (handle === undefined) return
        try { handle.close() } catch { /* Already dismissed by the system. */ }
      }
      const ask = () => {
        if (!supported) return Promise.resolve('denied')
        let permission
        try { permission = globalThis.Notification.permission } catch { return Promise.resolve('denied') }
        if (permission === 'granted' || permission === 'denied') return Promise.resolve(permission)
        try {
          return Promise.resolve(globalThis.Notification.requestPermission()).catch(() => 'denied')
        } catch { return Promise.resolve('denied') }
      }
      const raise = (request) => {
        if (!supported || disposed) return
        const { key, title, body, tag, silent, requireInteraction, onClick } = request
        const token = (tokens.get(key) ?? 0) + 1
        tokens.set(key, token)
        close(key)
        void ask().then((state) => {
          if (state !== 'granted' || tokens.get(key) !== token) return
          try {
            const notification = new globalThis.Notification(title, { body, tag, silent, requireInteraction })
            notification.onclick = () => {
              try {
                notification.close()
              } catch {
                // Already gone.
              }
              if (handles.get(key) === notification) handles.delete(key)
              if (typeof onClick === 'function') onClick()
            }
            handles.set(key, notification)
          } catch {
            // A refused notification leaves the card and chime in place.
          }
        })
      }
      const prepare = () => {
        // Chrome only grants notifications from a user gesture.
        if (prepared || !supported || disposed || globalThis.Notification.permission !== 'default') return
        prepared = true
        void ask().catch(() => {})
      }
      return {
        raise,
        prepare,
        close,
        closeAll: () => { for (const key of [...handles.keys()]) close(key) },
        dispose: () => {
          disposed = true
          for (const key of [...handles.keys()]) close(key)
        },
      }
    }

    function createStore() {
      let items = []
      const listeners = new Set()
      const publish = () => { for (const listener of [...listeners]) listener() }
      return {
        getSnapshot: () => items,
        subscribe: (listener) => {
          listeners.add(listener)
          return () => { listeners.delete(listener) }
        },
        add: (item) => { items = [...items, item].slice(-REMINDER_LIMIT); publish() },
        remove: (id) => {
          const next = items.filter(item => item.id !== id)
          if (next.length === items.length) return false
          items = next
          publish()
          return true
        },
        removeWhere: (predicate) => {
          const next = items.filter(item => !predicate(item))
          if (next.length === items.length) return false
          items = next
          publish()
          return true
        },
        update: (id, patch) => {
          if (!items.some(item => item.id === id)) return
          items = items.map(item => (item.id === id ? { ...item, ...patch } : item))
          publish()
        },
      }
    }

    /** Sessions whose last turn ended and whose next turn has not started yet. */
    function createAwaitingStore() {
      const ids = new Set()
      const listeners = new Set()
      let disposed = false
      const publish = () => { if (!disposed) for (const listener of [...listeners]) listener() }
      return {
        has: (sessionId) => ids.has(sessionId),
        mark: (sessionId) => {
          if (ids.has(sessionId)) return
          ids.add(sessionId)
          publish()
        },
        clear: (sessionId) => {
          if (!ids.delete(sessionId)) return
          publish()
        },
        clearAll: () => {
          if (ids.size === 0) return
          ids.clear()
          publish()
        },
        subscribe: (listener) => {
          listeners.add(listener)
          return () => { listeners.delete(listener) }
        },
        dispose: () => {
          disposed = true
          ids.clear()
          listeners.clear()
        },
      }
    }

    function createReminderCenter(options) {
      const { config, store, t, presence, chime, notifier, sessions, titleMarker, openSession } = options
      const autoTimers = new Map()
      const held = new Map()
      let seq = 0
      let lastToneAt = -Infinity
      let repeatTimer = null
      let repeatCount = 0
      let disposed = false

      const isAway = () => presence.away()
      let wasAway = isAway()
      const items = () => store.getSnapshot()
      const summaryOf = (sessionId) => sessions.list.getSnapshot().byId[sessionId]
      const isMainView = (sessionId) => {
        const summary = summaryOf(sessionId)
        return summary !== undefined && (summary.retainedBy?.mainView ?? 0) > 0
      }
      const labelOf = (sessionId) => {
        const label = summaryOf(sessionId)?.displayTitle
        return typeof label === 'string' && label !== '' ? label : undefined
      }
      const urgentItems = () => items().filter(item => item.urgent)
      const playTone = () => {
        if (!config.sound) return false
        const now = Date.now()
        if (now - lastToneAt < TONE_GAP_MS) return false
        const played = chime.play()
        if (played) lastToneAt = now
        return played
      }
      const focusWindow = () => {
        try {
          globalThis.focus()
        } catch {
          // A browser may refuse to focus the window.
        }
      }

      const forget = (id) => {
        held.delete(id)
        const timer = autoTimers.get(id)
        if (timer !== undefined) { clearTimeout(timer); autoTimers.delete(id) }
        notifier.close(`reminder:${id}`)
      }
      const dismiss = (id) => {
        if (!store.remove(id)) return
        forget(id)
        refreshChannels()
      }
      /** Drop every reminder and everything it raised; true when there was one. */
      const clearAll = () => {
        const all = items()
        if (all.length === 0) return false
        store.removeWhere(() => true)
        for (const item of all) forget(item.id)
        return true
      }
      const dismissAll = () => {
        if (!clearAll()) return
        refreshChannels()
      }
      const openItem = (item) => {
        dismiss(item.id)
        if (!item.canOpen || typeof openSession !== 'function') return
        try {
          openSession(item.sessionId)
        } catch {
          // A vanished session leaves only the dismissal.
        }
      }
      const hold = (id) => {
        if (disposed) return
        held.set(id, (held.get(id) ?? 0) + 1)
        const timer = autoTimers.get(id)
        if (timer !== undefined) { clearTimeout(timer); autoTimers.delete(id) }
      }
      const release = (id) => {
        const count = (held.get(id) ?? 0) - 1
        if (count > 0) { held.set(id, count); return }
        if (!held.delete(id)) return
        refreshAutoDismiss()
      }

      const alertOne = (item) => {
        const copy = describe(item.kind, item, t)
        const toned = playTone()
        if (!config.systemNotification) return
        notifier.raise({
          key: `reminder:${item.id}`,
          title: copy.title,
          body: item.label === undefined ? copy.body : `${copy.body} · ${item.label}`,
          tag: `dsh-reply-notifier:${item.sessionId}:${item.kind}`,
          silent: !config.sound || toned || Date.now() - lastToneAt < TONE_GAP_MS,
          requireInteraction: config.requireInteraction,
          onClick: () => { focusWindow(); openItem(item) },
        })
      }
      const raiseRepeatSummary = (pending, toned) => {
        const first = pending[0]
        const copy = describe(first.kind, first, t)
        const many = pending.length > 1
        notifier.raise({
          key: 'repeat',
          title: many ? t('waitingCount', { count: pending.length }) : t('stillWaiting'),
          body: many
            ? t('repeatBody', { count: pending.length })
            : first.label === undefined ? copy.body : `${copy.body} · ${first.label}`,
          tag: 'dsh-reply-notifier:repeat',
          silent: !config.sound || toned,
          requireInteraction: config.requireInteraction,
          onClick: () => { focusWindow(); if (!many) openItem(first) },
        })
      }

      const stopRepeat = () => {
        if (repeatTimer !== null) { clearTimeout(repeatTimer); repeatTimer = null }
        repeatCount = 0
        notifier.close('repeat')
      }
      const scheduleRepeat = () => {
        if (disposed) return
        if (!isAway() || urgentItems().length === 0) { stopRepeat(); return }
        if (config.repeatSeconds <= 0 || config.repeatLimit <= 0) return
        if (repeatTimer !== null) return
        // A few nudges at a fixed interval, then silence: the cards and the
        // last notification stay until acknowledged, but nothing keeps ringing.
        if (repeatCount >= config.repeatLimit) return
        repeatTimer = setTimeout(runRepeat, Math.round(config.repeatSeconds * 1000))
      }
      const runRepeat = () => {
        repeatTimer = null
        if (disposed) return
        if (!isAway()) { stopRepeat(); return }
        const pending = urgentItems()
        if (pending.length === 0) { stopRepeat(); return }
        repeatCount += 1
        const toned = playTone()
        if (config.systemNotification) raiseRepeatSummary(pending, toned)
        refreshAutoDismiss()
        scheduleRepeat()
      }

      const shouldAutoDismiss = (item) => {
        if ((held.get(item.id) ?? 0) > 0) return false
        if (config.toastSeconds <= 0 || isAway()) return false
        // A card the user never came back to clears only after real input.
        if (presence.lastActivity() <= item.createdAt) return false
        if (!config.toast || !item.urgent) return true
        return isMainView(item.sessionId)
      }
      const refreshAutoDismiss = () => {
        if (disposed) return
        const current = items()
        const alive = new Set(current.map(item => item.id))
        for (const [id, timer] of [...autoTimers]) {
          const item = current.find(entry => entry.id === id)
          if (item === undefined || !alive.has(id) || !shouldAutoDismiss(item)) {
            clearTimeout(timer)
            autoTimers.delete(id)
          }
        }
        for (const item of current) {
          if (autoTimers.has(item.id) || !shouldAutoDismiss(item)) continue
          const timer = setTimeout(() => {
            autoTimers.delete(item.id)
            const still = items().find(entry => entry.id === item.id)
            if (still === undefined || !shouldAutoDismiss(still)) return
            dismiss(item.id)
          }, Math.round(config.toastSeconds * 1000))
          autoTimers.set(item.id, timer)
        }
      }
      /** Turn the cards the user walked away from into urgent ones. */
      const escalate = () => {
        if (!userAway()) return
        const quiet = items().filter(item => !item.urgent)
        if (quiet.length === 0) return
        for (const item of quiet) store.update(item.id, { urgent: true })
        const toned = playTone()
        if (config.systemNotification) raiseRepeatSummary(quiet, toned)
      }
      /** Fill in a session label or open action that arrived after the reminder. */
      const refreshMeta = () => {
        for (const item of items()) {
          const patch = {}
          if (!item.canOpen && summaryOf(item.sessionId) !== undefined) patch.canOpen = true
          if (item.label === undefined) {
            const label = labelOf(item.sessionId)
            if (label !== undefined) patch.label = label
          }
          if (Object.keys(patch).length > 0) store.update(item.id, patch)
        }
      }
      const refreshChannels = () => {
        if (disposed) return
        const away = isAway()
        const returned = wasAway && !away
        wasAway = away
        if (returned) {
          // Coming back is the acknowledgement: nothing is waiting for a click.
          if (config.dismissOnReturn) clearAll()
          else for (const item of items()) notifier.close(`reminder:${item.id}`)
        }
        refreshMeta()
        escalate()
        titleMarker.set(urgentItems().length)
        scheduleRepeat()
        refreshAutoDismiss()
      }

      /** A click, key, wheel, or touch anywhere in the window drops every reminder. */
      const acknowledge = (event) => {
        if (disposed || !config.dismissOnReturn || isAway()) return
        // A press inside a card belongs to that card: open, dismiss, hover.
        const target = event?.target
        if (typeof target?.closest === 'function' && target.closest('.dsh-reply-notifier-alert, .dsh-reply-notifier-card') !== null) return
        clearAll()
      }

      const report = (request) => {
        if (disposed) return undefined
        const { kind, sessionId, toolName, key, urgent } = request
        if (config.onlyWhenAway && kind === 'reply' && !isAway()) return undefined
        const item = {
          id: `${kind}:${String(++seq)}`,
          kind,
          sessionId,
          toolName,
          key,
          label: labelOf(sessionId),
          canOpen: summaryOf(sessionId) !== undefined && typeof openSession === 'function',
          urgent: urgent === true,
          createdAt: Date.now(),
        }
        const before = items()
        store.add(item)
        const after = items()
        for (const old of before) {
          if (!after.some(entry => entry.id === old.id)) forget(old.id)
        }
        if (item.urgent || config.alertWhileViewing) alertOne(item)
        refreshChannels()
        return item
      }
      const reconcile = (next) => {
        const stale = items().filter((item) => {
          const entry = next.get(item.sessionId)
          if (entry === undefined) return true
          if (item.kind === 'reply') return entry.running === true
          return entry.interaction === undefined || entry.interaction.key !== item.key
        })
        if (stale.length === 0) return
        const ids = new Set(stale.map(item => item.id))
        store.removeWhere(item => ids.has(item.id))
        for (const id of ids) forget(id)
        refreshChannels()
      }

      return {
        report,
        reconcile,
        dismiss,
        dismissAll,
        acknowledge,
        open: openItem,
        hold,
        release,
        refreshChannels,
        dispose: () => {
          disposed = true
          held.clear()
          if (repeatTimer !== null) clearTimeout(repeatTimer)
          for (const timer of autoTimers.values()) clearTimeout(timer)
          autoTimers.clear()
          titleMarker.dispose()
          notifier.dispose()
        },
      }
    }

    function watchStatus(ctx, config, center, presence, awaiting) {
      const statusSource = ctx.uiSession.sessionStatus
      const sessions = ctx.sessions
      const isAway = () => presence.away()
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
        return summary !== undefined && (summary.origin === 'subagent' || summary.parentId !== undefined)
      }
      const isMainView = (sessionId) => {
        const summary = summaryOf(sessionId)
        return summary !== undefined && (summary.retainedBy?.mainView ?? 0) > 0
      }
      /** Mirror every turn that ended without a new turn or a prompt into the row dot. */
      const trackAwaiting = (next, before) => {
        if (!config.notifyOnReply) {
          awaiting.clearAll()
          return
        }
        for (const [sessionId, entry] of next) {
          if (entry.running || entry.interaction !== undefined || isChildSession(sessionId)) awaiting.clear(sessionId)
          else if (before.get(sessionId)?.running === true) awaiting.mark(sessionId)
        }
        for (const sessionId of before.keys()) {
          if (!next.has(sessionId)) awaiting.clear(sessionId)
        }
      }
      const reportPrompt = (sessionId, interaction) => {
        center.report({
          kind: promptKind(interaction),
          sessionId,
          toolName: interaction.toolName,
          key: interaction.key,
          urgent: isAway() || !isMainView(sessionId),
        })
      }
      const evaluate = () => {
        const next = currentEntries()
        const before = previous
        previous = next
        if (before === null) {
          // A prompt still pending at load is exactly what the user needs to see.
          if (config.notifyOnPrompt) {
            for (const [sessionId, entry] of next) {
              if (entry.interaction !== undefined) reportPrompt(sessionId, entry.interaction)
            }
          }
          center.reconcile(next)
          return
        }
        trackAwaiting(next, before)
        for (const [sessionId, entry] of next) {
          const prior = before.get(sessionId)
          const freshPrompt = entry.interaction !== undefined
            && (prior === undefined || prior.key !== entry.key)
          // One snapshot can carry a stop and a prompt together; the prompt wins.
          if (!freshPrompt && config.notifyOnReply && prior !== undefined
            && prior.running && !entry.running && !isChildSession(sessionId)) {
            center.report({ kind: 'reply', sessionId, urgent: isAway() || entry.unread })
          }
          if (freshPrompt && config.notifyOnPrompt) reportPrompt(sessionId, entry.interaction)
        }
        center.reconcile(next)
      }

      evaluate()
      return statusSource.subscribe(evaluate)
    }

    function BellIcon() {
      return h('svg', {
        className: 'dsh-reply-notifier-icon',
        viewBox: '0 0 24 24',
        fill: 'none',
        'aria-hidden': true,
        focusable: false,
      },
      h('path', {
        d: 'M12 3.5A5.5 5.5 0 0 0 6.5 9v3.2l-1.7 3a.9.9 0 0 0 .8 1.3h12.8a.9.9 0 0 0 .8-1.3l-1.7-3V9A5.5 5.5 0 0 0 12 3.5Z',
        fill: 'currentColor',
      }),
      h('path', {
        d: 'M9.7 18.2a2.4 2.4 0 0 0 4.6 0',
        stroke: 'currentColor',
        strokeWidth: '1.8',
        strokeLinecap: 'round',
      }))
    }

    function CheckIcon() {
      return h('svg', {
        className: 'dsh-reply-notifier-icon',
        viewBox: '0 0 24 24',
        fill: 'none',
        'aria-hidden': true,
        focusable: false,
      },
      h('circle', { cx: '12', cy: '12', r: '8.4', stroke: 'currentColor', strokeWidth: '1.7' }),
      h('path', {
        d: 'm8.4 12.2 2.4 2.4 4.8-5',
        stroke: 'currentColor',
        strokeWidth: '2',
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
      }))
    }

    function cardText(copy, item, alert) {
      return h('div', { className: 'dsh-reply-notifier-text', role: alert ? 'alert' : undefined },
        h('span', { className: 'dsh-reply-notifier-title' }, copy.title),
        h('span', { className: 'dsh-reply-notifier-body' }, copy.body),
        item.label === undefined
          ? null
          : h('span', { className: 'dsh-reply-notifier-label' }, item.label))
    }

    /** Red dot in the session row's trailing seat while that session waits for you. */
    function AwaitingDot({ sessionId, awaiting, t }) {
      const waiting = React.useSyncExternalStore(
        awaiting.subscribe,
        () => awaiting.has(sessionId),
        () => awaiting.has(sessionId),
      )
      if (!waiting) return null
      const label = t('awaitingReply')
      // Inline: the sidebar row is outside the overlay that owns the plugin sheet.
      return h('span', {
        className: 'dsh-reply-notifier-row-dot',
        role: 'img',
        'aria-label': label,
        title: label,
        style: {
          flex: 'none', width: 7, height: 7, borderRadius: '50%',
          background: 'var(--dsw-alias-state-error-primary, #e5484d)',
        },
      })
    }

    function ReminderCard({ item, dismiss, open, t }) {
      const copy = describe(item.kind, item, t)
      return h('div', { className: 'dsh-reply-notifier-alert', 'data-tone': copy.tone },
        item.kind === 'reply' ? h(CheckIcon, null) : h(BellIcon, null),
        cardText(copy, item, true),
        h('div', { className: 'dsh-reply-notifier-actions' },
          item.canOpen
            ? h('button', {
              type: 'button',
              className: 'dsh-reply-notifier-open',
              'aria-label': item.label === undefined
                ? t('openSession')
                : t('openSessionFor', { name: item.label }),
              onClick: () => open(item),
            }, t('openSession'))
            : null,
          h('button', {
            type: 'button',
            className: 'dsh-reply-notifier-close',
            'aria-label': t('dismiss'),
            onClick: () => dismiss(item.id),
          }, '×')))
    }

    function ToastCard({ item, dismiss, hold, release, t }) {
      const copy = describe(item.kind, item, t)
      const leave = (event) => {
        const next = event.relatedTarget
        if (next instanceof Node && event.currentTarget.contains(next)) return
        release(item.id)
      }
      return h('div', {
        className: 'dsh-reply-notifier-card',
        onMouseEnter: () => hold(item.id),
        onMouseLeave: () => release(item.id),
        onFocus: () => hold(item.id),
        onBlur: leave,
      },
      h('span', { className: 'dsh-reply-notifier-dot', 'data-tone': copy.tone, 'aria-hidden': true }),
      cardText(copy, item, false),
      h('button', {
        type: 'button',
        className: 'dsh-reply-notifier-close',
        'aria-label': t('dismiss'),
        onClick: () => dismiss(item.id),
      }, '×'))
    }

    function ReminderOverlay(props) {
      const { store, dismiss, open, dismissAll, hold, release, enabled, t, away } = props
      const items = React.useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)
      const present = typeof away === 'function' && away() !== true
      const urgent = items.filter(item => item.urgent)
      // The top seat belongs to an absent window; while you are at the window every
      // reminder joins the corner stack and the next input clears the urgent ones.
      const alerts = present ? [] : urgent.slice().reverse()
      const corner = present ? [...urgent, ...items.filter(item => !item.urgent)] : items.filter(item => !item.urgent)
      const toasts = corner.slice(-VISIBLE_TOASTS)
      const content = h(React.Fragment, null,
        h('style', { dangerouslySetInnerHTML: { __html: CSS } }),
        enabled && alerts.length > 0
          ? h('div', { className: 'dsh-reply-notifier-alerts' },
            h('div', { className: 'dsh-reply-notifier-alert-head' },
              h('span', { 'aria-live': 'polite' }, t('waitingCount', { count: urgent.length })),
              h('button', {
                type: 'button',
                className: 'dsh-reply-notifier-dismiss-all',
                onClick: dismissAll,
              }, t('dismissAll'))),
            alerts.map(item => h(ReminderCard, { key: item.id, item, dismiss, open, t })))
          : null,
        enabled && toasts.length > 0
          ? h('div', {
            className: 'dsh-reply-notifier-stack',
            'aria-live': 'polite',
            'aria-relevant': 'additions',
          }, toasts.map(item => (item.urgent
            ? h(ReminderCard, { key: item.id, item, dismiss, open, t })
            : h(ToastCard, { key: item.id, item, dismiss, hold, release, t }))))
          : null)
      if (typeof document === 'undefined' || ReactDOM === undefined
        || typeof ReactDOM.createPortal !== 'function') return content
      return ReactDOM.createPortal(content, document.body)
    }

    return {
      inject: ['sessions', 'uiSession', 'slots', 'locale', 'uiWorkspace'],
      apply(ctx) {
        const config = readConfig()
        const store = createStore()
        const awaiting = createAwaitingStore()
        const chime = createChime()
        const notifier = createNotifier()
        const sessions = ctx.sessions
        let center = null
        const mainSessionId = () => {
          const list = sessions.list.getSnapshot()
          for (const id of Object.keys(list.byId)) {
            if ((list.byId[id].retainedBy?.mainView ?? 0) > 0) return id
          }
          return undefined
        }
        // Opening a session is reading its reply: drop that row's dot.
        let viewed = mainSessionId()
        const syncViewed = () => {
          const current = mainSessionId()
          if (current !== undefined && current !== viewed) awaiting.clear(current)
          viewed = current
        }

        ctx.effect(() => ctx.locale.register(NS, { en, zh }), 'reply-notifier: dictionaries')
        const t = ctx.locale.bind(NS)
        const presence = createPresence(config, () => {
          if (center !== null) center.refreshChannels()
        }, (event) => {
          if (center !== null) center.acknowledge(event)
          // A click or key in the window acknowledges the session on screen too.
          const current = mainSessionId()
          if (current !== undefined) awaiting.clear(current)
        })
        center = createReminderCenter({
          config, store, t, presence, chime, notifier, sessions,
          titleMarker: createTitleMarker(),
          openSession: (sessionId) => { ctx.uiWorkspace.openSession(sessionId) },
        })

        ctx.effect(() => () => chime.dispose(), 'reply-notifier: audio')
        ctx.effect(() => () => presence.dispose(), 'reply-notifier: presence')
        ctx.effect(() => () => center.dispose(), 'reply-notifier: reminders')
        ctx.effect(() => {
          const unlock = () => { chime.unlock(); if (config.systemNotification) notifier.prepare() }
          document.addEventListener('pointerdown', unlock, { capture: true, passive: true })
          document.addEventListener('keydown', unlock, { capture: true })
          return () => {
            document.removeEventListener('pointerdown', unlock, { capture: true })
            document.removeEventListener('keydown', unlock, { capture: true })
          }
        }, 'reply-notifier: audio unlock')
        ctx.effect(() => watchStatus(ctx, config, center, presence, awaiting), 'reply-notifier: session status')
        ctx.effect(() => sessions.list.subscribe(() => {
          center.refreshChannels()
          syncViewed()
        }), 'reply-notifier: viewed session')
        ctx.effect(() => () => awaiting.dispose(), 'reply-notifier: reply dots')

        ctx.slots.inject('sidebar.session.row.trailing', () => ctx.slots.register({
          name: 'sidebar.session.row.trailing', id: 'reply-notifier.awaiting', order: 20, locale: NS,
          inject: () => ({ awaiting }),
        }, AwaitingDot))

        ctx.slots.inject('shell.overlay', () => ctx.slots.register({
          name: 'shell.overlay', id: 'reply-notifier.toast', order: 10, locale: NS,
          inject: () => ({
            store, dismiss: center.dismiss, open: center.open, dismissAll: center.dismissAll,
            hold: center.hold, release: center.release, enabled: config.toast,
            away: () => presence.away(),
          }),
        }, ReminderOverlay))
      },
    }
  },
})
