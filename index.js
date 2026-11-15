/** Host half: publishes the reminder options to the browser half and blinks the
 * Desktop taskbar button, which stays visible while Windows notifications are off. */

import { createTaskbarFlash } from './lib/taskbar-flash.js'

/** Global the client half reads its options from. */
const CONFIG_GLOBAL = '__DSH_REPLY_NOTIFIER_CONFIG__'

/** Options the client half understands, with their defaults. */
const DEFAULTS = {
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

/** Inclusive range of every numeric option, in its own unit. */
const RANGES = {
  toastSeconds: [0, 3600],
  idleSeconds: [0, 3600],
  repeatSeconds: [0, 600],
  repeatLimit: [0, 100],
}

/** Turn endings where nothing waits for the user: a cancel, a crash repair, a fork seed. */
const QUIET_TURN_ENDS = new Set(['aborted', 'interrupted', 'forked'])

/**
 * Keep only known options, falling back to the defaults.
 * @param config - raw row config from `cordis.patch.yml`.
 * @returns the normalized options.
 */
function normalize(config) {
  const source = config !== null && typeof config === 'object' ? config : {}
  const options = { ...DEFAULTS }
  for (const key of Object.keys(DEFAULTS)) {
    if (typeof DEFAULTS[key] === 'boolean') {
      if (typeof source[key] === 'boolean') options[key] = source[key]
      continue
    }
    if (typeof source[key] !== 'number' || !Number.isFinite(source[key])) continue
    const [min, max] = RANGES[key]
    options[key] = Math.min(max, Math.max(min, Math.round(source[key])))
  }
  return options
}

/**
 * Build the logger the host composition provides, falling back to the console.
 * @param ctx - Host context.
 * @returns a `log(level, message)` sink.
 */
function makeLog(ctx) {
  return (level, message) => {
    try {
      const logger = typeof ctx.logger === 'function' ? ctx.logger('reply-notifier') : undefined
      const write = logger?.[level]
      if (typeof write === 'function') {
        write.call(logger, message)
        return
      }
    } catch {
      // A missing or unusual logger service must not break the notifier.
    }
    const sink = level === 'error' ? console.error : console.log
    sink(`[reply-notifier] ${message}`)
  }
}

/**
 * Blink the taskbar when a turn ends or a prompt appears.
 *
 * The renderer owns the in-window reminder; this watcher only reaches outside
 * the window. Approval and question listeners delegate to `next()` untouched,
 * so the answerer that follows them still decides the outcome.
 * @param ctx - Host context.
 * @param options - normalized options.
 * @param attention - flash channel.
 * @returns the disposer.
 */
export function watchAttention(ctx, options, attention) {
  if (!attention.enabled) return () => {}
  const offTurn = ctx.on('session/event', (session, event) => {
    if (!options.notifyOnReply || event?.type !== 'turn/end') return
    const header = session?.header
    if (session?.origin === 'subagent' || header?.origin === 'subagent') return
    if (session?.parentSession !== undefined || header?.parentSession !== undefined) return
    if (session?.parentSessionId !== undefined || header?.parentSessionId !== undefined) return
    if (QUIET_TURN_ENDS.has(event?.data?.reason?.kind)) return
    attention.flash('reply')
  })
  const prompt = (name) => ctx.on(name, (_request, next) => {
    if (options.notifyOnPrompt) attention.flash('prompt')
    return typeof next === 'function' ? next() : undefined
  })
  const offApproval = prompt('approval/request')
  const offQuestion = prompt('user-questions/request')
  return () => {
    offTurn()
    offApproval()
    offQuestion()
  }
}

/**
 * Publish the options before the page is served.
 * @param ctx - Host context.
 * @param config - raw row config.
 */
export function apply(ctx, config) {
  const options = normalize(config)
  ctx.on('webserver/index-inject', (table) => {
    table.push({ kind: 'global', name: CONFIG_GLOBAL, value: options })
  })
  const attention = createTaskbarFlash({ options, log: makeLog(ctx) })
  ctx.effect(() => watchAttention(ctx, options, attention), 'reply-notifier: taskbar flash')
  ctx.effect(() => () => attention.dispose(), 'reply-notifier: taskbar flash lifetime')
}
