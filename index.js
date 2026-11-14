/** Host half: publishes the reminder options to the browser half through the page bootstrap. */

/** Global the client half reads its options from. */
const CONFIG_GLOBAL = '__DSH_REPLY_NOTIFIER_CONFIG__'

/** Options the client half understands, with their defaults. */
const DEFAULTS = {
  notifyOnReply: true,
  notifyOnPrompt: true,
  systemNotification: true,
  toast: true,
  sound: true,
  onlyWhenAway: false,
  alertWhileViewing: false,
}

/**
 * Keep only known boolean options, falling back to the defaults.
 * @param config - raw row config from `cordis.patch.yml`.
 * @returns the normalized options.
 */
function normalize(config) {
  const source = config !== null && typeof config === 'object' ? config : {}
  const options = { ...DEFAULTS }
  for (const key of Object.keys(DEFAULTS)) {
    if (typeof source[key] === 'boolean') options[key] = source[key]
  }
  return options
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
}
