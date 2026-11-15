// Behaviour check for the reply-notifier browser half: runs the real client
// bundle against stub services and fake time, then asserts which reminders
// fire, on which channels, and how long each one stays.
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { pathToFileURL } = require('node:url')

const ROOT = path.resolve(__dirname, '..')
const CLIENT = path.join(ROOT, 'client.js')
const HOST = path.join(ROOT, 'index.js')
const FLASH = path.join(ROOT, 'lib', 'taskbar-flash.js')
const PKG = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
const CONFIG_GLOBAL = '__DSH_REPLY_NOTIFIER_CONFIG__'
const CODE = fs.readFileSync(CLIENT, 'utf8')

let failures = 0
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (!ok) failures += 1
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (ok ? '' : `\n  expected ${JSON.stringify(expected)}\n  actual   ${JSON.stringify(actual)}`))
}

function interpolate(text, params) {
  if (typeof text !== 'string') return text
  return text.replace(/\{(\w+)\}/g, (match, key) => (params && key in params ? String(params[key]) : match))
}

// ---- fake clock: every reminder timer runs on a driven timeline ----
let now = 0
let timerSeq = 0
const timers = new Map()

function resetClock() {
  now = 0
  timerSeq = 0
  timers.clear()
}
function fakeSetTimeout(callback, delay) {
  const id = ++timerSeq
  timers.set(id, { callback, at: now + Math.max(0, Number(delay) || 0) })
  return id
}
function fakeClearTimeout(id) {
  timers.delete(id)
}
function advanceClock(ms) {
  const target = now + ms
  for (let guard = 0; guard < 5000; guard += 1) {
    let pickId = null
    let pick = null
    for (const [id, timer] of timers) {
      if (timer.at > target) continue
      if (pick === null || timer.at < pick.at) {
        pick = timer
        pickId = id
      }
    }
    if (pick === null) break
    timers.delete(pickId)
    now = Math.max(now, pick.at)
    pick.callback()
  }
  now = target
}
Date.now = () => now
globalThis.setTimeout = fakeSetTimeout
globalThis.clearTimeout = fakeClearTimeout

function createEventTarget() {
  const listeners = new Map()
  return {
    addEventListener(type, listener) {
      if (!listeners.has(type)) listeners.set(type, new Set())
      listeners.get(type).add(listener)
    },
    removeEventListener(type, listener) {
      listeners.get(type)?.delete(listener)
    },
    dispatch(type, event) {
      for (const listener of [...(listeners.get(type) ?? [])]) listener({ type, relatedTarget: null, ...event })
    },
    count(type) {
      return (listeners.get(type) ?? new Set()).size
    },
  }
}

/** Boot one plugin instance over stub services. */
function boot(options, environment) {
  resetClock()
  const env = { hidden: false, focused: true, ...environment }
  const notifications = []
  const notificationObjects = []
  const notes = []
  const opened = []
  const statusListeners = new Set()
  const listListeners = new Set()
  const disposers = []
  const summaries = {}
  let status = new Map()
  let dictionary = {}
  let registration
  let focusedCalls = 0
  let permissionRequests = 0
  const doc = createEventTarget()
  const win = createEventTarget()

  class FakeNotification {
    static permission = env.notificationPermission ?? 'granted'
    static requestPermission() {
      permissionRequests += 1
      return Promise.resolve('granted')
    }
    constructor(title, config) {
      this.title = title
      this.config = config
      this.closed = false
      this.onclick = null
      notificationObjects.push(this)
      notifications.push({ title, ...config, closed: false })
      this.entry = notifications[notifications.length - 1]
    }
    close() {
      this.closed = true
      this.entry.closed = true
    }
  }

  class FakeAudioContext {
    constructor() {
      this.currentTime = now / 1000
      this.state = env.audioSuspended ? 'suspended' : 'running'
      this.destination = {}
    }
    createOscillator() {
      const value = { at: 0 }
      const oscillator = {
        type: 'sine',
        frequency: { setValueAtTime: (frequency) => { value.at = frequency } },
        connect() {},
        start() { notes.push(value.at) },
        stop() {},
      }
      return oscillator
    }
    createGain() {
      return {
        gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} },
        connect() {},
      }
    }
    close() { return Promise.resolve() }
    resume() { return Promise.resolve() }
  }

  globalThis.Notification = FakeNotification
  globalThis.AudioContext = FakeAudioContext
  globalThis.focus = () => { focusedCalls += 1 }
  globalThis[CONFIG_GLOBAL] = options ?? {}
  globalThis.document = {
    title: 'DeepSeek Harness',
    get visibilityState() { return env.hidden ? 'hidden' : 'visible' },
    hasFocus: () => env.focused,
    addEventListener: (...args) => doc.addEventListener(...args),
    removeEventListener: (...args) => doc.removeEventListener(...args),
  }
  let loaded
  globalThis.window = {
    __ModuleLoader__: { load: (spec) => { loaded = spec } },
    addEventListener: (...args) => win.addEventListener(...args),
    removeEventListener: (...args) => win.removeEventListener(...args),
  }
  vm.runInThisContext(CODE, { filename: CLIENT })
  check('module id', loaded.id, PKG.name)

  const React = {
    Fragment: 'fragment',
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
    useEffect: () => {},
    useState: () => [false, () => {}],
    useSyncExternalStore: (_subscribe, getSnapshot) => getSnapshot(),
  }
  const plugin = loaded.factory((specifier) => (
    specifier === 'react-dom'
      ? { createPortal: (node) => node }
      : React
  ))

  const ctx = {
    effect: (callback) => {
      const disposer = callback()
      if (typeof disposer === 'function') disposers.push(disposer)
      return () => {}
    },
    locale: {
      register: (_namespace, dictionaries) => { dictionary = dictionaries.en; return () => {} },
      bind: () => (key, params) => interpolate(dictionary[key], params),
    },
    slots: {
      inject: (_name, callback) => { callback(); return () => {} },
      register: (config, component) => {
        registration = { config, component }
        return () => {}
      },
    },
    sessions: {
      list: {
        getSnapshot: () => ({ byId: summaries }),
        subscribe: (listener) => {
          listListeners.add(listener)
          return () => { listListeners.delete(listener) }
        },
      },
    },
    uiSession: {
      sessionStatus: {
        getSnapshot: () => status,
        subscribe: (listener) => {
          statusListeners.add(listener)
          return () => { statusListeners.delete(listener) }
        },
      },
    },
    uiWorkspace: {
      openSession: (sessionId) => { opened.push(sessionId) },
    },
  }
  plugin.apply(ctx)

  const injected = registration.config.inject()
  const dictionaryT = (key, params) => interpolate(dictionary[key], params)
  const settle = async () => {
    for (let index = 0; index < 6; index += 1) await Promise.resolve()
  }
  const publish = async (next) => {
    status = new Map(Object.entries(next))
    for (const listener of statusListeners) listener()
    await settle()
  }
  const notifyList = async () => {
    for (const listener of listListeners) listener()
    await settle()
  }
  return {
    env,
    notifications,
    notificationObjects,
    notes,
    opened,
    summaries,
    injected,
    publish,
    notifyList,
    settle,
    toasts: () => injected.store.getSnapshot(),
    kinds: () => injected.store.getSnapshot().map(item => item.kind),
    tones: () => notes.length / 9,
    focused: () => focusedCalls,
    permissionRequests: () => permissionRequests,
    documentTitle: () => globalThis.document.title,
    setDocumentTitle: (title) => { globalThis.document.title = title },
    component: registration.component,
    render: () => registration.component({ ...injected, t: dictionaryT }),
    advance: async (ms) => { advanceClock(ms); await settle() },
    activity: async (target) => { doc.dispatch('pointerdown', target === undefined ? {} : { target }); await settle() },
    focus: async (value = true) => { env.focused = value; win.dispatch(value ? 'focus' : 'blur'); await settle() },
    visibility: async (hidden) => { env.hidden = hidden; doc.dispatch('visibilitychange'); await settle() },
    dispose: () => {
      for (const dispose of disposers.reverse()) dispose()
      disposers.length = 0
    },
  }
}

const idle = { running: false, completionUnread: false, pendingInteraction: undefined }
const running = { running: true, completionUnread: false, pendingInteraction: undefined }
const stopped = { running: false, completionUnread: false, pendingInteraction: undefined }
const stoppedUnread = { running: false, completionUnread: true, pendingInteraction: undefined }
const approval = (key, toolName) => ({ running: true, completionUnread: false, pendingInteraction: { kind: 'approval', key, toolName } })
const question = (key) => ({ running: true, completionUnread: false, pendingInteraction: { kind: 'question', key } })

function walkTree(node, visit) {
  if (Array.isArray(node)) {
    for (const child of node) walkTree(child, visit)
    return
  }
  if (node === null || typeof node !== 'object') return
  if (typeof node.type === 'function') {
    walkTree(node.type(node.props), visit)
    return
  }
  visit(node)
  for (const child of node.children ?? []) walkTree(child, visit)
}

function hasClass(node, className) {
  let found = false
  walkTree(node, (element) => {
    const classes = element.props?.className
    if (typeof classes === 'string' && classes.split(/\s+/).includes(className)) found = true
  })
  return found
}

function countClass(node, className) {
  let count = 0
  walkTree(node, (element) => {
    const classes = element.props?.className
    if (typeof classes === 'string' && classes.split(/\s+/).includes(className)) count += 1
  })
  return count
}

function textOf(node) {
  if (Array.isArray(node)) return node.map(textOf).join(' ')
  if (typeof node === 'string') return node
  if (node === null || typeof node !== 'object') return ''
  if (typeof node.type === 'function') return textOf(node.type(node.props))
  return (node.children ?? []).map(textOf).join(' ')
}

async function fullAlerts() {
  const app = boot({ alertWhileViewing: true })
  app.summaries.s1 = { displayTitle: 'Session one', retainedBy: { mainView: 1 } }
  await app.publish({ s1: idle })
  check('idle baseline raises nothing', app.notifications.length, 0)
  check('idle baseline shows no card', app.toasts().length, 0)

  await app.publish({ s1: running })
  check('turn start raises nothing', app.toasts().length, 0)

  await app.publish({ s1: stopped })
  check('reply completion reminds once', app.notifications.map(n => n.title), ['Reply finished'])
  check('reply reminder names the session', app.notifications[0].body, 'The agent finished this reply. · Session one')
  check('reply reminder tone', app.tones(), 1)
  check('system reminder is silent when the tone plays', app.notifications[0].silent, true)
  check('the notification persists until clicked', app.notifications[0].requireInteraction, true)
  check('reply card carries the label', app.toasts().map(item => item.label), ['Session one'])

  await app.publish({ s1: approval('a1', 'bash') })
  check('approval reminds', app.notifications.map(n => n.title), ['Reply finished', 'Permission needed'])
  check('approval names the tool', app.notifications[1].body, 'Tool bash is waiting for your approval. · Session one')

  await app.publish({ s1: approval('a1', 'bash') })
  check('same pending approval does not repeat', app.notifications.length, 2)
  check('same pending approval does not stack cards', app.kinds(), ['approval'])

  await app.publish({ s1: approval('a2', 'write_file') })
  check('replacement approval reminds again', app.notifications.length, 3)
  check('replacement approval replaces the card', app.toasts().map(item => item.key), ['a2'])

  await app.publish({ s1: running })
  check('answered prompt raises nothing', app.notifications.length, 3)
  check('answered prompt clears its card', app.kinds(), [])

  await app.publish({ s1: question('q1') })
  check('question reminds', app.notifications[3]?.title, 'Answer needed')

  await app.publish({ s1: approval('a3') })
  check('approval without a tool name falls back', app.notifications[4].body, 'An operation is waiting for your approval. · Session one')
  check('a replacement prompt leaves one card', app.toasts().length, 1)

  app.injected.dismiss(app.toasts()[0].id)
  check('dismiss removes the card', app.toasts().length, 0)

  await app.publish({ s1: running })
  check('a new turn clears the finished reminder', app.kinds(), [])
  app.dispose()
}

async function toneThrottle() {
  const app = boot({ alertWhileViewing: true })
  app.summaries.s1 = { displayTitle: 'Session one', retainedBy: { mainView: 1 } }
  app.summaries.s2 = { displayTitle: 'Session two', retainedBy: {} }
  await app.publish({ s1: running, s2: running })
  // Both reminders land in the same burst: one tone, and the second banner keeps its own sound.
  await app.publish({ s1: stopped, s2: { running: true, completionUnread: false, pendingInteraction: { kind: 'approval', key: 'b1', toolName: 'bash' } } })
  check('two reminders in one burst remind twice', app.kinds(), ['reply', 'approval'])
  check('one tone per burst', app.tones(), 1)
  check('the tone keeps its own banner silent', app.notifications[0].silent, true)
  check('a throttled burst leaves the next banner silent', app.notifications[1].silent, true)
  app.dispose()
}

async function combinedSnapshot() {
  const app = boot({ alertWhileViewing: true })
  app.summaries.s1 = { displayTitle: 'Session one', retainedBy: { mainView: 1 } }
  await app.publish({ s1: running })
  await app.publish({ s1: { running: false, completionUnread: false, pendingInteraction: { kind: 'approval', key: 'a1', toolName: 'bash' } } })
  check('a stop and a prompt in one snapshot report the prompt only', app.kinds(), ['approval'])
  check('the prompt reports once', app.notifications.map(n => n.title), ['Permission needed'])
  app.dispose()
}

async function urgency() {
  const app = boot({})
  app.summaries.s1 = { displayTitle: 'Session one', retainedBy: { mainView: 1 } }
  app.summaries.s2 = { displayTitle: 'Session two', retainedBy: {} }
  await app.publish({ s1: idle })
  await app.publish({ s1: running })
  await app.publish({ s1: stopped })
  check('watching a reply keeps only the card', app.notifications.length, 0)
  check('watching a reply plays no tone', app.tones(), 0)
  check('watching a reply still shows the card', app.kinds(), ['reply'])
  app.injected.dismissAll()

  app.env.hidden = true
  await app.visibility(true)
  await app.publish({ s1: running })
  await app.publish({ s1: stopped })
  check('a hidden window alerts', app.notifications.map(n => n.title), ['Reply finished'])

  app.env.hidden = false
  await app.visibility(false)
  app.env.focused = false
  await app.focus(false)
  await app.publish({ s1: running })
  await app.publish({ s1: stopped })
  check('another application holding focus alerts', app.notifications.length, 2)

  app.env.focused = true
  await app.focus(true)
  await app.publish({ s1: running })
  await app.publish({ s1: stoppedUnread })
  check('an unread stop alerts while watching', app.notifications.length, 3)

  await app.publish({ s1: approval('a1', 'bash') })
  check('a prompt on screen keeps only the card', app.notifications.length, 3)

  await app.publish({ s2: approval('b1', 'bash') })
  check('a prompt in another session alerts', app.notifications.length, 4)
  check('the alert names the other session', app.notifications[3].body, 'Tool bash is waiting for your approval. · Session two')
  app.dispose()
}

async function children() {
  const app = boot({ alertWhileViewing: true })
  app.summaries.s1 = { displayTitle: 'Parent', retainedBy: { mainView: 1 } }
  app.summaries.sub = { displayTitle: 'Child', origin: 'subagent' }
  app.summaries.child = { displayTitle: 'Fork', parentId: 's1' }
  await app.publish({ s1: running, sub: running, child: running })
  await app.publish({ s1: running, sub: stopped, child: idle })
  check('a subagent stop stays quiet', app.kinds(), [])

  await app.publish({ s1: running, sub: { running: true, completionUnread: false, pendingInteraction: { kind: 'approval', key: 'x1', toolName: 'bash' } }, child: idle })
  check('a subagent prompt reminds', app.kinds(), ['approval'])
  app.dispose()
}

async function archive() {
  const app = boot({ alertWhileViewing: true })
  app.summaries.s1 = { displayTitle: 'Session one', retainedBy: {} }
  await app.publish({ s1: running })
  await app.publish({})
  check('a session that leaves the list raises nothing', app.kinds(), [])
  app.dispose()
}

async function toggles() {
  const replyOff = boot({ notifyOnReply: false, alertWhileViewing: true })
  await replyOff.publish({ s1: idle })
  await replyOff.publish({ s1: running })
  await replyOff.publish({ s1: stopped })
  check('notifyOnReply false suppresses completions', replyOff.toasts().length, 0)
  await replyOff.publish({ s1: approval('a1', 'bash') })
  check('notifyOnPrompt still reports prompts', replyOff.kinds(), ['approval'])
  replyOff.dispose()

  const promptOff = boot({ notifyOnPrompt: false, alertWhileViewing: true })
  await promptOff.publish({ s1: idle })
  await promptOff.publish({ s1: running })
  await promptOff.publish({ s1: approval('a1', 'bash') })
  check('notifyOnPrompt false suppresses prompts', promptOff.toasts().length, 0)
  await promptOff.publish({ s1: stopped })
  check('notifyOnReply still reports completions', promptOff.kinds(), ['reply'])
  promptOff.dispose()

  const mute = boot({ sound: false, alertWhileViewing: true })
  await mute.publish({ s1: idle })
  await mute.publish({ s1: running })
  await mute.publish({ s1: stopped })
  check('sound false skips the tone', mute.tones(), 0)
  check('sound false silences the system reminder too', mute.notifications[0].silent, true)
  mute.dispose()

  const quiet = boot({ onlyWhenAway: true })
  quiet.summaries.s1 = { displayTitle: 'Session one', retainedBy: { mainView: 1 } }
  quiet.summaries.s2 = { displayTitle: 'Session two', retainedBy: {} }
  await quiet.publish({ s1: idle })
  await quiet.publish({ s1: running })
  await quiet.publish({ s1: stopped })
  check('onlyWhenAway drops the reply card while you are at the window', quiet.toasts().length, 0)
  await quiet.publish({ s2: { running: true, completionUnread: false, pendingInteraction: { kind: 'approval', key: 'b1', toolName: 'bash' } } })
  check('onlyWhenAway still shows a prompt from another session', quiet.kinds(), ['approval'])
  quiet.env.focused = false
  await quiet.focus(false)
  await quiet.publish({ s1: running, s2: { running: true, completionUnread: false, pendingInteraction: { kind: 'approval', key: 'b1', toolName: 'bash' } } })
  await quiet.publish({ s1: stopped, s2: { running: true, completionUnread: false, pendingInteraction: { kind: 'approval', key: 'b1', toolName: 'bash' } } })
  check('onlyWhenAway returns the reply card once you look away', quiet.kinds().filter(kind => kind === 'reply').length, 1)
  quiet.dispose()
}

async function primedWithPendingPrompt() {
  const app = boot({})
  app.summaries.s1 = { displayTitle: 'Session one', retainedBy: {} }
  await app.publish({ s1: approval('a1', 'bash') })
  check('pending prompt at load reminds once', app.kinds(), ['approval'])
  check('pending prompt at load is urgent off the main view', app.notifications.length, 1)

  const child = boot({})
  child.summaries.sub = { displayTitle: 'Child', origin: 'subagent' }
  await child.publish({ sub: approval('x1', 'bash') })
  check('a pending child-session prompt reminds at load', child.kinds(), ['approval'])
  app.dispose()
  child.dispose()
}

async function persistentAlerts() {
  const app = boot({ repeatSeconds: 0 })
  app.summaries.s1 = { displayTitle: 'Session one', retainedBy: { mainView: 1 } }
  await app.publish({ s1: idle })
  await app.publish({ s1: running })
  app.env.hidden = true
  await app.visibility(true)
  await app.publish({ s1: stopped })
  check('an away reply becomes an urgent card', app.toasts().length, 1)
  check('the urgent card is marked urgent', app.toasts()[0].urgent, true)
  check('the away reply raises one notification', app.notifications.length, 1)
  check('the window title marks the waiting reminder', app.documentTitle(), '🔴 1 · DeepSeek Harness')
  app.setDocumentTitle('Session one — DSH')
  await app.advance(2000)
  check('the window title marker survives an app title change', app.documentTitle(), '🔴 1 · Session one — DSH')

  await app.advance(30000)
  check('an urgent card does not expire while away', app.toasts().length, 1)

  app.env.hidden = false
  await app.visibility(false)
  await app.focus(true)
  check('returning closes the reminder notification', app.notifications[0].closed, true)
  check('returning clears the urgent card at once', app.toasts().length, 0)
  check('returning restores the window title at once', app.documentTitle(), 'Session one — DSH')
  await app.advance(20000)
  check('the cleared card never comes back', app.toasts().length, 0)
  app.dispose()
}

async function dismissOnReturn() {
  const clickBack = async (app) => {
    app.env.focused = true
    app.env.hidden = false
    await app.focus(true)
  }

  const instant = boot({ repeatSeconds: 0 })
  instant.summaries.s1 = { displayTitle: 'Session one', retainedBy: { mainView: 1 } }
  await instant.publish({ s1: idle })
  await instant.publish({ s1: running })
  await instant.focus(false)
  await instant.publish({ s1: stopped })
  check('a reply raised while another window has focus is urgent', instant.toasts().map(item => item.urgent), [true])
  await clickBack(instant)
  check('clicking back into the window dismisses the popup', instant.toasts().length, 0)
  check('clicking back into the window closes its notification', instant.notifications[0].closed, true)

  const pointer = boot({ repeatSeconds: 0 })
  pointer.summaries.s1 = { displayTitle: 'Session one', retainedBy: { mainView: 1 } }
  await pointer.publish({ s1: idle })
  await pointer.publish({ s1: running })
  pointer.env.hidden = true
  await pointer.visibility(true)
  await pointer.publish({ s1: stopped })
  check('a hidden window holds the reminder', pointer.toasts().length, 1)
  pointer.env.hidden = false
  await pointer.activity()
  check('any click in the page dismisses the popup', pointer.toasts().length, 0)

  const keeping = boot({ repeatSeconds: 0, dismissOnReturn: false })
  keeping.summaries.s1 = { displayTitle: 'Session one', retainedBy: { mainView: 1 } }
  await keeping.publish({ s1: idle })
  await keeping.publish({ s1: running })
  keeping.env.hidden = true
  await keeping.visibility(true)
  await keeping.publish({ s1: stopped })
  await keeping.visibility(false)
  await keeping.focus(true)
  check('dismissOnReturn false keeps the card you came back to', keeping.toasts().length, 1)
  check('dismissOnReturn false still closes its notification', keeping.notifications[0].closed, true)
  await keeping.advance(1000)
  await keeping.activity()
  await keeping.advance(20000)
  check('dismissOnReturn false clears it after toastSeconds', keeping.toasts().length, 0)
  instant.dispose()
  pointer.dispose()
  keeping.dispose()
}

async function repeatAlerts() {
  const app = boot({ repeatSeconds: 5, repeatLimit: 2 })
  app.summaries.s1 = { displayTitle: 'Session one', retainedBy: { mainView: 1 } }
  await app.publish({ s1: idle })
  await app.publish({ s1: running })
  app.env.hidden = true
  await app.visibility(true)
  await app.publish({ s1: stopped })
  check('the first reminder chimes once', app.tones(), 1)
  check('the first reminder raises one notification', app.notifications.length, 1)

  await app.advance(5000)
  check('the reminder repeats once', app.notifications.length, 2)
  check('the repeat chimes again', app.tones(), 2)
  check('the repeat is a summary notification', app.notifications[1].title, 'Reminder still pending')
  check('the repeat keeps the session name', app.notifications[1].body, 'The agent finished this reply. · Session one')

  await app.advance(5000)
  check('the reminder repeats twice', app.notifications.length, 3)
  await app.advance(60000)
  check('the slow tail keeps nudging', app.notifications.length, 4)
  await app.advance(60000)
  check('the slow tail keeps nudging again', app.notifications.length, 5)

  app.env.hidden = false
  await app.visibility(false)
  await app.advance(10000)
  check('returning stops the repeats', app.notifications.length, 5)
  check('returning closes the reminder notification', app.notifications[0].closed, true)
  check('returning closes the repeat notification', app.notifications[4].closed, true)
  app.dispose()
}

async function idleAndEscalation() {
  const app = boot({ idleSeconds: 5, repeatSeconds: 0 })
  app.summaries.s1 = { displayTitle: 'Session one', retainedBy: { mainView: 1 } }
  await app.publish({ s1: idle })
  await app.advance(5000)
  await app.publish({ s1: running })
  await app.publish({ s1: stopped })
  check('an idle window treats a reply as away', app.toasts()[0]?.urgent, true)
  check('an idle window alerts', app.notifications.length, 1)
  check('an idle window chimes', app.tones(), 1)

  await app.activity()
  await app.publish({ s1: running })
  await app.publish({ s1: stopped })
  check('a returning user sees a quiet card', app.toasts().slice(-1)[0]?.urgent, false)
  check('a returning user hears no new tone', app.tones(), 1)

  const leaving = boot({ idleSeconds: 0 })
  leaving.summaries.s1 = { displayTitle: 'Session one', retainedBy: { mainView: 1 } }
  await leaving.publish({ s1: idle })
  await leaving.publish({ s1: running })
  await leaving.publish({ s1: stopped })
  check('a watched reply starts quiet', leaving.toasts()[0]?.urgent, false)
  leaving.env.focused = false
  await leaving.focus(false)
  check('losing focus escalates the quiet card', leaving.toasts()[0]?.urgent, true)
  check('losing focus alerts for the escalated card', leaving.notifications.length, 1)
  app.dispose()
  leaving.dispose()
}

async function autoDismissAndHold() {
  const app = boot({ toastSeconds: 5 })
  app.summaries.s1 = { displayTitle: 'Session one', retainedBy: { mainView: 1 } }
  await app.publish({ s1: idle })
  await app.publish({ s1: running })
  await app.publish({ s1: stopped })
  await app.advance(10000)
  check('a card the user never touched stays', app.toasts().length, 1)

  // Window focus counts as presence without acknowledging: the lifetime runs.
  await app.focus(true)
  await app.advance(5000)
  check('a card clears after viewing without input', app.toasts().length, 0)
  app.dispose()

  const held = boot({ toastSeconds: 5 })
  held.summaries.s1 = { displayTitle: 'Session one', retainedBy: { mainView: 1 } }
  await held.publish({ s1: idle })
  await held.publish({ s1: running })
  await held.publish({ s1: stopped })
  await held.advance(1000)
  await held.focus(true)
  held.injected.hold(held.toasts()[0].id)
  held.injected.hold(held.toasts()[0].id)
  await held.advance(10000)
  check('hovering holds the card', held.toasts().length, 1)
  held.injected.release(held.toasts()[0].id)
  await held.advance(10000)
  check('one release keeps the card held', held.toasts().length, 1)
  held.injected.release(held.toasts()[0].id)
  await held.advance(5000)
  check('leaving the card restarts its lifetime', held.toasts().length, 0)
  held.dispose()
}

async function openSession() {
  const app = boot({})
  app.summaries.s1 = { displayTitle: 'Session one', retainedBy: { mainView: 1 } }
  await app.publish({ s1: idle })
  await app.publish({ s1: running })
  await app.publish({ s1: stopped })
  app.injected.open(app.toasts()[0])
  check('opening a card selects its session', app.opened, ['s1'])
  check('opening a card acknowledges it', app.toasts().length, 0)

  app.env.hidden = true
  await app.visibility(true)
  await app.publish({ s1: running })
  await app.publish({ s1: stopped })
  check('the away reply raises a clickable notification', app.notificationObjects.length, 1)
  app.notificationObjects[0].onclick()
  await app.settle()
  check('a notification click opens the session', app.opened, ['s1', 's1'])
  check('a notification click dismisses the card', app.toasts().length, 0)
  check('a notification click focuses the window', app.focused(), 1)
  app.dispose()
}

async function reconcile() {
  const app = boot({ alertWhileViewing: true })
  app.summaries.s1 = { displayTitle: 'Session one', retainedBy: { mainView: 1 } }
  await app.publish({ s1: idle })
  await app.publish({ s1: approval('a1', 'bash') })
  check('the prompt card appears', app.toasts().map(item => item.key), ['a1'])
  await app.publish({ s1: approval('a2', 'bash') })
  check('a replaced prompt keeps one card', app.toasts().map(item => item.key), ['a2'])
  await app.publish({ s1: running })
  check('an answered prompt clears its card', app.kinds(), [])

  await app.publish({ s1: running })
  await app.publish({ s1: stopped })
  check('the finished reply gets a card', app.kinds(), ['reply'])
  await app.publish({ s1: running })
  check('a new turn clears the reply card', app.kinds(), [])
  app.dispose()
}

async function renderedCards() {
  const app = boot({})
  app.summaries.s1 = { displayTitle: 'Session one', retainedBy: { mainView: 1 } }
  await app.publish({ s1: idle })
  await app.publish({ s1: running })
  await app.publish({ s1: stopped })
  const ambient = app.render()
  check('an ambient reminder renders in the corner stack', hasClass(ambient, 'dsh-reply-notifier-stack'), true)
  check('an ambient reminder has no alert stack', hasClass(ambient, 'dsh-reply-notifier-alerts'), false)
  check('an ambient reminder names its session', textOf(ambient).includes('Session one'), true)

  app.env.hidden = true
  await app.visibility(true)
  app.summaries.s2 = { displayTitle: 'Session two', retainedBy: {} }
  await app.publish({ s1: running })
  await app.publish({ s1: stopped, s2: approval('b1', 'bash') })
  const urgent = app.render()
  check('an urgent reminder renders the alert stack', hasClass(urgent, 'dsh-reply-notifier-alerts'), true)
  check('an urgent reminder offers its session', textOf(urgent).includes('Open session'), true)
  check('an urgent reminder names its session', textOf(urgent).includes('Session one'), true)
  check('several urgent reminders offer dismiss all', textOf(urgent).includes('Dismiss all'), true)
  app.dispose()
}

async function escalationSummary() {
  const app = boot({})
  app.summaries.s1 = { displayTitle: 'Session one', retainedBy: { mainView: 1 } }
  app.summaries.s2 = { displayTitle: 'Session two', retainedBy: { mainView: 1 } }
  await app.publish({ s1: idle, s2: idle })
  await app.publish({ s1: running, s2: running })
  await app.publish({ s1: stopped, s2: stopped })
  check('two watched replies stay quiet', app.notifications.length, 0)
  check('two watched replies show two cards', app.toasts().length, 2)

  app.env.focused = false
  await app.focus(false)
  check('leaving escalates both cards', app.toasts().every(item => item.urgent), true)
  check('leaving coalesces one notification', app.notifications.length, 1)
  check('the coalesced alert counts both', app.notifications[0].title, '2 reminders')
  app.dispose()
}

async function visibleCaps() {
  const app = boot({})
  const names = ['a', 'b', 'c', 'd', 'e']
  const status = {}
  for (const name of names) {
    app.summaries[name] = { displayTitle: `Session ${name}`, retainedBy: {} }
    status[name] = approval(`${name}1`, 'bash')
  }
  await app.publish(status)
  check('every pending prompt is tracked', app.toasts().length, 5)

  const present = app.render()
  check('a prompt seen from the window stays out of the top seat', hasClass(present, 'dsh-reply-notifier-alerts'), false)
  check('the corner stack keeps the newest three prompts', countClass(present, 'dsh-reply-notifier-alert'), 3)

  app.env.focused = false
  await app.focus(false)
  const away = app.render()
  check('the alert stack shows every tracked prompt', countClass(away, 'dsh-reply-notifier-alert'), 5)
  check('the alert header counts every card', textOf(away).includes('5 reminders'), true)
  app.injected.dismissAll()
  check('dismiss all clears every tracked prompt', app.toasts().length, 0)
  app.dispose()
}

async function acknowledgeOnInput() {
  const app = boot({})
  app.summaries.s1 = { displayTitle: 'Session one', retainedBy: { mainView: 1 } }
  app.summaries.s2 = { displayTitle: 'Session two', retainedBy: {} }
  await app.publish({ s1: idle })
  await app.publish({ s1: idle, s2: approval('b1', 'bash') })
  check('another session waiting is an urgent reminder', app.toasts().map(item => item.urgent), [true])
  const tree = app.render()
  check('an urgent reminder sits in the corner while you are present', hasClass(tree, 'dsh-reply-notifier-alerts'), false)
  check('the corner card keeps its open button', textOf(tree).includes('Open session'), true)
  await app.activity()
  check('a click in the window clears it', app.toasts().length, 0)
  check('the click also closes its notification', app.notifications.every(note => note.closed), true)

  const quiet = boot({})
  quiet.summaries.s1 = { displayTitle: 'Session one', retainedBy: { mainView: 1 } }
  await quiet.publish({ s1: idle })
  await quiet.publish({ s1: running })
  await quiet.publish({ s1: stopped })
  check('a watched reply is a quiet corner card', quiet.toasts().map(item => item.urgent), [false])
  await quiet.activity({ closest: () => ({}) })
  check('a press inside a card leaves it to the card', quiet.toasts().length, 1)
  await quiet.activity()
  check('a click in the window clears a quiet card too', quiet.toasts().length, 0)

  await quiet.publish({ s1: running })
  await quiet.publish({ s1: stopped })
  quiet.env.focused = false
  await quiet.focus(false)
  check('leaving moves the card to the top', hasClass(quiet.render(), 'dsh-reply-notifier-alerts'), true)
  await quiet.activity()
  check('an input while away keeps the away reminder', quiet.toasts().length, 1)

  const keeping = boot({ dismissOnReturn: false })
  keeping.summaries.s1 = { displayTitle: 'Session one', retainedBy: { mainView: 1 } }
  keeping.summaries.s2 = { displayTitle: 'Session two', retainedBy: {} }
  await keeping.publish({ s1: idle, s2: approval('b1', 'bash') })
  await keeping.activity()
  check('dismissOnReturn false keeps it after a click', keeping.toasts().length, 1)
  keeping.injected.dismissAll()
  check('dismiss all still clears it', keeping.toasts().length, 0)

  app.dispose()
  quiet.dispose()
  keeping.dispose()
}

async function blockedAudio() {
  const app = boot({ alertWhileViewing: true }, { audioSuspended: true })
  app.summaries.s1 = { displayTitle: 'Session one', retainedBy: { mainView: 1 } }
  await app.publish({ s1: idle })
  await app.publish({ s1: running })
  await app.publish({ s1: stopped })
  check('a blocked audio device plays no chime', app.tones(), 0)
  check('a blocked audio device keeps the notification audible', app.notifications[0].silent, false)
  app.dispose()
}

async function notificationPermission() {
  const app = boot({}, { notificationPermission: 'default' })
  await app.publish({ s1: idle })
  await app.activity()
  check('the first gesture asks for notification permission', app.permissionRequests(), 1)
  await app.activity()
  check('the permission request is not repeated', app.permissionRequests(), 1)
  app.dispose()
}

async function hostOptions() {
  const { apply } = await import(pathToFileURL(HOST).href)
  const defaults = {
    notifyOnReply: true,
    notifyOnPrompt: true,
    systemNotification: true,
    toast: true,
    sound: true,
    flashTaskbar: true,
    onlyWhenAway: false,
    alertWhileViewing: false,
    dismissOnReturn: true,
    requireInteraction: true,
    toastSeconds: 20,
    idleSeconds: 90,
    repeatSeconds: 20,
    repeatLimit: 12,
  }
  const inject = (config) => {
    const table = []
    apply({
      on: (_event, handler) => { if (_event === 'webserver/index-inject') handler(table) },
      effect: (callback) => { callback(); return () => {} },
      logger: () => ({ warn() {}, info() {} }),
    }, config)
    return table[0].value
  }
  check('host publishes the defaults', inject(undefined), defaults)
  check('host clamps numeric options', inject({ toastSeconds: 5, idleSeconds: -3, repeatSeconds: 9999, repeatLimit: 1.7, sound: false }), {
    ...defaults,
    toastSeconds: 5,
    idleSeconds: 0,
    repeatSeconds: 600,
    repeatLimit: 2,
    sound: false,
  })
}

async function taskbarFlash() {
  const { createTaskbarFlash, isDesktopHost, powerShellArguments, flashScript, FLASH_COOLDOWN_MS } = await import(pathToFileURL(FLASH).href)
  check('the Desktop shell is recognised by its Electron runtime',
    [isDesktopHost({ versions: { electron: '30.0.0' } }), isDesktopHost({ versions: {}, env: { ELECTRON_RUN_AS_NODE: '1' } }), isDesktopHost({ versions: {}, env: {} })],
    [true, true, false])
  const script = flashScript(4242)
  check('the flash script names the process it starts from', script.includes('$cursor = 4242'), true)
  check('the flash script pulses the window', script.includes('FlashWindowEx') && script.includes('dwFlags = [uint32]3'), true)
  check('one pulse per interval', script.includes('uCount = [uint32]1'), true)
  check('the pulse burst has a deadline', script.includes('6000'), true)
  check('the flash script starts only for an urgent title', script.includes('GetWindowTextW') && script.includes('🔴'), true)
  check('the flash script skips a window that already has the focus', script.includes('GetForegroundWindow'), true)
  check('the flash stops the pulse and leaves the solid highlight', script.includes('dwFlags = [uint32]0') && script.includes('uCount = [uint32]0'), true)
  check('the flash script stops when the window is gone', script.includes('IsWindow'), true)
  check('the flash script never falls through to the desktop', script.includes("'explorer'") && script.includes('break'), true)
  const args = powerShellArguments(4242)
  check('the flash payload is one encoded command', args.at(-2), '-EncodedCommand')
  check('the flash payload round-trips', Buffer.from(args.at(-1), 'base64').toString('utf16le'), script)

  const launches = []
  const children = []
  const makeChild = () => {
    const handlers = {}
    const child = {
      killed: false,
      once: (event, handler) => { handlers[event] = handler },
      unref() {},
      kill() { child.killed = true; handlers.exit?.() },
      finish() { handlers.exit?.() },
    }
    children.push(child)
    return child
  }
  const spawnStub = (file, argv, options) => { launches.push({ file, argv, options }); return makeChild() }
  let clock = 1000
  const build = (overrides) => createTaskbarFlash({
    options: { flashTaskbar: true },
    platform: 'win32',
    desktop: true,
    parentPid: 4242,
    spawn: spawnStub,
    now: () => clock,
    log: () => {},
    ...overrides,
  })

  const channel = build({})
  check('the desktop flashes its taskbar button', channel.flash('reply'), true)
  check('the flash helper is PowerShell', launches.map(launch => launch.file), ['powershell.exe'])
  check('the flash helper runs without a console window', launches[0].options.windowsHide, true)
  check('the flash helper output is discarded', launches[0].options.stdio, 'ignore')
  check('one reminder inside the cooldown reuses the flash', channel.flash('prompt'), false)
  clock += FLASH_COOLDOWN_MS
  check('a reminder while the helper still runs reuses the flash', channel.flash('prompt'), false)
  children[0].finish()
  check('a later reminder flashes again once the helper stops', channel.flash('prompt'), true)
  channel.dispose()
  check('disposing stops a running helper', children[1].killed, true)
  clock += FLASH_COOLDOWN_MS
  check('a disposed channel flashes nothing', channel.flash('reply'), false)
  check('the disposed channel launched only twice', launches.length, 2)

  for (const [name, overrides] of [
    ['an unsupported platform', { platform: 'darwin' }],
    ['a browser host', { desktop: false }],
    ['flashTaskbar false', { options: { flashTaskbar: false } }],
    ['a host without a parent process', { parentPid: 0 }],
  ]) {
    const off = build(overrides)
    const before = launches.length
    check(`${name} never flashes`, [off.enabled, off.flash('reply'), launches.length], [false, false, before])
  }

  const broken = build({ spawn: () => { throw new Error('spawn refused') } })
  check('a refused helper is reported as no flash', broken.flash('reply'), false)
}

async function x11Attention() {
  const { createTaskbarFlash, parseWmctrlWindows, wmctrlSetArguments } = await import(pathToFileURL(FLASH).href)
  const listing = [
    '0x00a00003  0 900  studio  Some other window',
    '0x00a00007  0 4242 studio 插件提示可见性优化 — DeepSeek Harness',
    'not a window line',
  ].join('\n')
  check('wmctrl windows are read with their owning process',
    parseWmctrlWindows(listing).map(window => [window.id, window.pid]),
    [['0x00a00003', 900], ['0x00a00007', 4242]])
  check('the window title survives parsing', parseWmctrlWindows(listing)[1].title, '插件提示可见性优化 — DeepSeek Harness')
  check('the urgency hint is raised in place', wmctrlSetArguments('0x00a00007'), ['-i', '-b', 'add,demands_attention', '0x00a00007'])

  const settle = async () => { for (let index = 0; index < 8; index += 1) await Promise.resolve() }
  const calls = []
  const logs = []
  let clock = 1000
  const fakeExec = (file, args, _options, callback) => {
    calls.push({ file, args })
    callback(null, args[0] === '-lp' ? listing : '', '')
  }
  const build = (overrides) => createTaskbarFlash({
    options: { flashTaskbar: true },
    platform: 'linux',
    desktop: true,
    parentPid: 4242,
    parents: [4242],
    exec: fakeExec,
    now: () => clock,
    log: (level, message) => logs.push(`${level}:${message}`),
    ...overrides,
  })

  const channel = build({})
  check('an X11 desktop flags the taskbar entry', [channel.enabled, channel.flash('reply')], [true, true])
  await settle()
  check('the flag goes to the harness window',
    calls.map(call => [call.file, call.args]),
    [['wmctrl', ['-lp']], ['wmctrl', ['-i', '-b', 'add,demands_attention', '0x00a00007']]])
  check('one reminder inside the cooldown reuses the flag', channel.flash('prompt'), false)
  clock += 2500
  check('a later reminder flags again', channel.flash('prompt'), true)
  await settle()
  check('every flag lists windows first', calls.length, 4)

  const other = build({ parents: [7, 8] })
  const beforeOther = calls.length
  other.flash('reply')
  await settle()
  check('a window with no owning process is left alone', calls.slice(beforeOther).map(call => call.args), [['-lp']])

  const missing = build({
    exec: (_file, _args, _options, callback) => {
      calls.push({ file: 'wmctrl', args: [] })
      const error = new Error('spawn wmctrl ENOENT')
      error.code = 'ENOENT'
      callback(error, '', '')
    },
  })
  check('a missing wmctrl still accepts the reminder', missing.flash('reply'), true)
  await settle()
  clock += 2500
  check('a missing wmctrl is reported once and then dropped',
    [missing.flash('reply'), logs.length, logs[0]?.startsWith('warn:taskbar attention failed')],
    [false, 1, true])
  check('a browser host on Linux never flags', build({ desktop: false }).enabled, false)
}

async function attentionWatch() {
  const { watchAttention } = await import(pathToFileURL(HOST).href)
  const flashes = []
  const attention = { enabled: true, flash: (reason) => { flashes.push(reason) } }
  const listeners = new Map()
  const ctx = {
    on: (name, handler) => { listeners.set(name, handler); return () => { listeners.delete(name) } },
  }
  const emit = (name, ...params) => listeners.get(name)?.(...params)
  const turnEnd = (kind, session = { id: 's1' }) => emit('session/event', session, {
    type: 'turn/end', data: { turn: 1, reason: { kind } },
  })

  const off = watchAttention(ctx, { notifyOnReply: true, notifyOnPrompt: true }, attention)
  turnEnd('completed')
  check('a finished turn flashes the taskbar', flashes, ['reply'])
  turnEnd('error')
  check('a failed turn flashes the taskbar', flashes, ['reply', 'reply'])
  turnEnd('aborted')
  turnEnd('interrupted')
  turnEnd('forked')
  check('a cancelled or repaired turn stays quiet', flashes, ['reply', 'reply'])
  turnEnd('completed', { id: 'sub', header: { origin: 'subagent' } })
  check('a subagent turn stays quiet', flashes, ['reply', 'reply'])
  turnEnd('completed', { id: 'child', header: { parentSession: 's1' } })
  check('a forked turn stays quiet', flashes, ['reply', 'reply'])
  emit('session/event', { id: 's1' }, { type: 'assistant/message', data: {} })
  check('a non-turn event stays quiet', flashes, ['reply', 'reply'])

  let delegated = 0
  const outcome = emit('approval/request', { toolName: 'bash' }, () => { delegated += 1; return 'allowed-once' })
  check('a waiting approval flashes the taskbar', flashes, ['reply', 'reply', 'prompt'])
  check('the approval still reaches the next answerer', [delegated, outcome], [1, 'allowed-once'])
  emit('user-questions/request', { questions: [] }, () => { delegated += 1; return 'answered' })
  check('a waiting question flashes the taskbar', flashes, ['reply', 'reply', 'prompt', 'prompt'])
  check('the question still reaches the next answerer', delegated, 2)

  off()
  turnEnd('completed')
  check('the watcher stops with its disposer', flashes.length, 4)

  const silent = { enabled: true, flash: () => { throw new Error('must not flash') } }
  const quietListeners = new Map()
  const quietCtx = { on: (name, handler) => { quietListeners.set(name, handler); return () => {} } }
  watchAttention(quietCtx, { notifyOnReply: false, notifyOnPrompt: false }, silent)
  let passed = 0
  quietListeners.get('session/event')({ id: 's1' }, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
  const nextResult = quietListeners.get('approval/request')({}, () => { passed += 1; return 'delegated' })
  check('the switches keep the taskbar quiet', passed, 1)
  check('a quiet prompt still delegates', nextResult, 'delegated')
  check('a disabled channel registers no watcher',
    watchAttention({ on: () => { throw new Error('must not subscribe') } }, { notifyOnReply: true, notifyOnPrompt: true }, { enabled: false, flash() {} })(), undefined)
}


async function main() {
  await fullAlerts()
  await combinedSnapshot()
  await toneThrottle()
  await urgency()
  await children()
  await archive()
  await toggles()
  await primedWithPendingPrompt()
  await persistentAlerts()
  await dismissOnReturn()
  await idleAndEscalation()
  await repeatAlerts()
  await autoDismissAndHold()
  await openSession()
  await reconcile()
  await renderedCards()
  await escalationSummary()
  await visibleCaps()
  await acknowledgeOnInput()
  await blockedAudio()
  await notificationPermission()
  await taskbarFlash()
  await x11Attention()
  await attentionWatch()
  await hostOptions()
  console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) failed`)
  process.exit(failures === 0 ? 0 : 1)
}

main()
