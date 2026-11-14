// Behaviour check for the reply-notifier browser half: runs the real client
// bundle against stub services and asserts which reminders fire, on which
// channels, at which urgency.
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const ROOT = path.resolve(__dirname, '..')
const CLIENT = path.join(ROOT, 'client.js')
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

/** Boot one plugin instance over stub services. */
function boot(options, environment) {
  const env = { hidden: false, focused: true, ...environment }
  const notifications = []
  const tones = []
  const statusListeners = new Set()
  const summaries = {}
  let status = new Map()
  let dictionary = {}
  let registration

  class FakeNotification {
    static permission = 'granted'
    static requestPermission() { return Promise.resolve('granted') }
    constructor(title, config) {
      notifications.push({ title, body: config.body, tag: config.tag, silent: config.silent })
    }
    close() {}
  }

  class FakeAudioContext {
    constructor() {
      this.currentTime = 0
      this.state = 'running'
      this.destination = {}
    }
    createOscillator() {
      return {
        type: 'sine',
        frequency: { setValueAtTime() {} },
        connect() {},
        start() {},
        stop() { tones.push('tone') },
      }
    }
    createGain() {
      return { gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect() {} }
    }
    close() { return Promise.resolve() }
    resume() { return Promise.resolve() }
  }

  globalThis.Notification = FakeNotification
  globalThis.AudioContext = FakeAudioContext
  globalThis[CONFIG_GLOBAL] = options ?? {}
  globalThis.document = {
    get visibilityState() { return env.hidden ? 'hidden' : 'visible' },
    hasFocus: () => env.focused,
  }

  let loaded
  globalThis.window = { __ModuleLoader__: { load: (spec) => { loaded = spec } } }
  vm.runInThisContext(CODE, { filename: CLIENT })
  check('module id', loaded.id, PKG.name)

  const React = {
    Fragment: 'fragment',
    createElement: () => null,
    useEffect: () => {},
    useState: () => [false, () => {}],
    useSyncExternalStore: () => [],
  }
  const plugin = loaded.factory(() => React)

  const ctx = {
    effect: (callback) => { callback(); return () => {} },
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
    sessions: { list: { getSnapshot: () => ({ byId: summaries }) } },
    uiSession: {
      sessionStatus: {
        getSnapshot: () => status,
        subscribe: (listener) => { statusListeners.add(listener); return () => { statusListeners.delete(listener) } },
      },
    },
  }
  plugin.apply(ctx)

  const injected = registration.config.inject()
  const settle = async () => {
    for (let index = 0; index < 4; index += 1) await Promise.resolve()
  }
  const publish = async (next) => {
    status = new Map(Object.entries(next))
    for (const listener of statusListeners) listener()
    await settle()
  }
  return {
    env,
    notifications,
    tones,
    summaries,
    injected,
    publish,
    toasts: () => injected.store.getSnapshot(),
    kinds: () => injected.store.getSnapshot().map(item => item.kind),
  }
}

const idle = { running: false, completionUnread: false, pendingInteraction: undefined }
const running = { running: true, completionUnread: false, pendingInteraction: undefined }
const stopped = { running: false, completionUnread: false, pendingInteraction: undefined }
const stoppedUnread = { running: false, completionUnread: true, pendingInteraction: undefined }
const approval = (key, toolName) => ({ running: true, completionUnread: false, pendingInteraction: { kind: 'approval', key, toolName } })
const question = (key) => ({ running: true, completionUnread: false, pendingInteraction: { kind: 'question', key } })

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
  check('reply reminder tone', app.tones.length, 1)
  check('system reminder is silent when the tone plays', app.notifications[0].silent, true)
  check('reply card carries the label', app.toasts().map(item => item.label), ['Session one'])

  await app.publish({ s1: approval('a1', 'bash') })
  check('approval reminds', app.notifications.map(n => n.title), ['Reply finished', 'Permission needed'])
  check('approval names the tool', app.notifications[1].body, 'Tool bash is waiting for your approval. · Session one')

  await app.publish({ s1: approval('a1', 'bash') })
  check('same pending approval does not repeat', app.notifications.length, 2)
  check('same pending approval does not stack cards', app.kinds(), ['reply', 'approval'])

  await app.publish({ s1: approval('a2', 'write_file') })
  check('replacement approval reminds again', app.notifications.length, 3)

  await app.publish({ s1: { running: true, completionUnread: false, pendingInteraction: undefined } })
  check('answered prompt raises nothing', app.notifications.length, 3)

  await app.publish({ s1: question('q1') })
  check('question reminds', app.notifications[3]?.title, 'Answer needed')

  await app.publish({ s1: approval('a3') })
  check('approval without a tool name falls back', app.notifications[4].body, 'An operation is waiting for your approval. · Session one')

  await app.publish({ s1: running })
  app.injected.dismiss(app.toasts()[0].id)
  check('dismiss removes one card', app.toasts().length, 2)
}

async function toneThrottle() {
  const app = boot({ alertWhileViewing: true })
  app.summaries.s1 = { displayTitle: 'Session one', retainedBy: { mainView: 1 } }
  app.summaries.s2 = { displayTitle: 'Session two', retainedBy: {} }
  await app.publish({ s1: running, s2: running })
  // Both reminders land in the same burst: one tone, and the second banner keeps its own sound.
  await app.publish({ s1: stopped, s2: { running: true, completionUnread: false, pendingInteraction: { kind: 'approval', key: 'b1', toolName: 'bash' } } })
  check('two reminders in one burst remind twice', app.kinds(), ['reply', 'approval'])
  check('one tone per burst', app.tones.length, 1)
  check('the tone keeps its own banner silent', app.notifications[0].silent, true)
  check('a throttled tone leaves the next banner audible', app.notifications[1].silent, false)
}

async function combinedSnapshot() {
  const app = boot({ alertWhileViewing: true })
  app.summaries.s1 = { displayTitle: 'Session one', retainedBy: { mainView: 1 } }
  await app.publish({ s1: running })
  await app.publish({ s1: { running: false, completionUnread: false, pendingInteraction: { kind: 'approval', key: 'a1', toolName: 'bash' } } })
  check('a stop and a prompt in one snapshot report the prompt only', app.kinds(), ['approval'])
  check('the prompt reports once', app.notifications.map(n => n.title), ['Permission needed'])
}

async function urgency() {
  const app = boot({})
  app.summaries.s1 = { displayTitle: 'Session one', retainedBy: { mainView: 1 } }
  app.summaries.s2 = { displayTitle: 'Session two', retainedBy: {} }
  await app.publish({ s1: idle })
  await app.publish({ s1: running })
  await app.publish({ s1: stopped })
  check('watching a reply keeps only the card', app.notifications.length, 0)
  check('watching a reply plays no tone', app.tones.length, 0)
  check('watching a reply still shows the card', app.kinds(), ['reply'])

  app.env.hidden = true
  await app.publish({ s1: running })
  await app.publish({ s1: stopped })
  check('a hidden window alerts', app.notifications.map(n => n.title), ['Reply finished'])

  app.env.hidden = false
  app.env.focused = false
  await app.publish({ s1: running })
  await app.publish({ s1: stopped })
  check('another application holding focus alerts', app.notifications.length, 2)

  app.env.focused = true
  await app.publish({ s1: running })
  await app.publish({ s1: stoppedUnread })
  check('an unread stop alerts while watching', app.notifications.length, 3)

  await app.publish({ s1: { running: true, completionUnread: false, pendingInteraction: { kind: 'approval', key: 'a1', toolName: 'bash' } } })
  check('a prompt on screen keeps only the card', app.notifications.length, 3)

  await app.publish({ s2: { running: true, completionUnread: false, pendingInteraction: { kind: 'approval', key: 'b1', toolName: 'bash' } } })
  check('a prompt in another session alerts', app.notifications.length, 4)
  check('the alert names the other session', app.notifications[3].body, 'Tool bash is waiting for your approval. · Session two')
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
}

async function archive() {
  const app = boot({ alertWhileViewing: true })
  app.summaries.s1 = { displayTitle: 'Session one', retainedBy: {} }
  await app.publish({ s1: running })
  await app.publish({})
  check('a session that leaves the list raises nothing', app.kinds(), [])
}

async function toggles() {
  const replyOff = boot({ notifyOnReply: false, alertWhileViewing: true })
  await replyOff.publish({ s1: idle })
  await replyOff.publish({ s1: running })
  await replyOff.publish({ s1: stopped })
  check('notifyOnReply false suppresses completions', replyOff.toasts().length, 0)
  await replyOff.publish({ s1: approval('a1', 'bash') })
  check('notifyOnPrompt still reports prompts', replyOff.kinds(), ['approval'])

  const promptOff = boot({ notifyOnPrompt: false, alertWhileViewing: true })
  await promptOff.publish({ s1: idle })
  await promptOff.publish({ s1: running })
  await promptOff.publish({ s1: approval('a1', 'bash') })
  check('notifyOnPrompt false suppresses prompts', promptOff.toasts().length, 0)
  await promptOff.publish({ s1: stopped })
  check('notifyOnReply still reports completions', promptOff.kinds(), ['reply'])

  const mute = boot({ sound: false, alertWhileViewing: true })
  await mute.publish({ s1: idle })
  await mute.publish({ s1: running })
  await mute.publish({ s1: stopped })
  check('sound false skips the tone', mute.tones.length, 0)
  check('system reminder keeps its own sound when the tone is off', mute.notifications[0].silent, false)

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
  await quiet.publish({ s1: running, s2: { running: true, completionUnread: false, pendingInteraction: { kind: 'approval', key: 'b1', toolName: 'bash' } } })
  await quiet.publish({ s1: stopped, s2: { running: true, completionUnread: false, pendingInteraction: { kind: 'approval', key: 'b1', toolName: 'bash' } } })
  check('onlyWhenAway returns the reply card once you look away', quiet.kinds().filter(kind => kind === 'reply').length, 1)
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
  console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) failed`)
  process.exit(failures === 0 ? 0 : 1)
}

main()
