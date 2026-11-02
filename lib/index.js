/**
 * dsh-search-first — make the agent look before it builds.
 *
 * The problem this plugin targets: an agent that starts writing code the
 * moment a task arrives, instead of first checking whether the work already
 * exists somewhere. Rebuilding a solved problem is the expensive path; finding
 * the mature solution first is the cheap one.
 *
 * Three parts, each optional except the rule:
 *
 *  1. A system-prompt section (`order` configurable) that states the rule.
 *     This is the part that changes behaviour by itself: the model reads it
 *     on every assembly.
 *  2. An optional hard guard on `tools/pre-execute`: once per turn, a
 *     hands-on call (write / edit / shell / install) is refused until some
 *     search tool has actually run in that same turn.
 *  3. A `search_first_status` tool so the user and the model can check what is
 *     actually live instead of guessing.
 *
 * The guard is off by default because it can be annoying on a typo fix; the
 * rule is always on. Both can be changed from the bundle row's `config`.
 */

export const name = 'dsh-search-first'

const SECTION_NAME = 'dsh-search-first:rule'
const DEFAULT_ORDER = 130

const DEFAULT_RULE = `## Look it up before you build it

A task arrived. Before writing, editing, running or installing anything, spend one step finding out whether the work already exists.

- Existing code or packages: \`web_search\`, \`platform_search\`, \`domain_search\`, \`research\`.
- This workspace's own history and decisions: \`memory_search\`, \`memory_project\`.
- One specific page or repo: \`read_page\`, \`web_fetch\`.

Read the best hit, then reuse it (install the package, copy the pattern, cite the source) instead of rebuilding it. Build from scratch only when the search shows nothing usable — and say so in one line before you start.

Skip the search for a trivial one-line fix, or when the user explicitly says to skip.`

/** Tools that count as "I looked before I leapt". */
const DEFAULT_SEARCH_TOOLS = [
  'web_search',
  'web_fetch',
  'read_page',
  'research',
  'platform_search',
  'domain_search',
  'multi_search',
  'advanced_search',
  'video_search',
  'x_search',
  'cache_search',
  'memory_search',
  'memory_project',
  'memory_read',
  'search_context',
  'ops_grep',
  'ops_glob',
  'ops_read_files',
  'ops_inspect_local_file',
  'grep',
  'glob',
  'read',
]

/** Tools that change the world; the guard holds these back until a search ran. */
const DEFAULT_GUARDED_TOOLS = [
  'write',
  'edit',
  'ops_bash',
  'bash',
  'shell',
  'plugin_manager',
  'run_code',
  'present',
]

const STATUS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    enabled: { type: 'boolean', description: 'Whether the plugin runs at all.' },
    rule: { type: 'string', description: 'Where the rule section stands: registered / pending / failed, with its order.' },
    guard: { type: 'string', description: 'Strict guard state: off, or on with the search tools it accepts.' },
    sessionsTracked: { type: 'number', description: 'Live sessions whose current turn is being tracked.' },
  },
}

/**
 * A tool name matches when it is listed, or when it starts with a listed
 * prefix (so `ops_bash` also covers a future `ops_bash_async`).
 */
function matcher(names) {
  return (toolName) => names.some((n) => toolName === n || toolName.startsWith(`${n}_`))
}

function messageOf(error) {
  if (error instanceof Error) return error.message
  return String(error)
}

/** One compact block per call: the model reads this instead of raw JSON. */
function asText(value) {
  return [{ type: 'text', text: Object.entries(value).map(([k, v]) => `${k}: ${v}`).join('\n') }]
}

export function apply(ctx, config = {}) {
  const cfg = config && typeof config === 'object' ? config : {}
  const enabled = cfg.enabled !== false
  const order = Number.isFinite(cfg.order) ? Number(cfg.order) : DEFAULT_ORDER
  const rule = typeof cfg.rule === 'string' && cfg.rule.trim() !== '' ? cfg.rule : DEFAULT_RULE
  const searchTools = Array.isArray(cfg.searchTools) && cfg.searchTools.length > 0
    ? cfg.searchTools.filter((n) => typeof n === 'string')
    : DEFAULT_SEARCH_TOOLS
  const guardedTools = Array.isArray(cfg.guardedTools) && cfg.guardedTools.length > 0
    ? cfg.guardedTools.filter((n) => typeof n === 'string')
    : DEFAULT_GUARDED_TOOLS
  const allowTools = Array.isArray(cfg.allowTools) ? cfg.allowTools.filter((n) => typeof n === 'string') : []
  const strict = cfg.strict === true

  const isSearch = matcher(searchTools)
  const isGuarded = matcher(guardedTools)
  const isAllowed = matcher(allowTools)

  /** sessionId -> { turn, searched } — only used when the guard is on. */
  const turns = new Map()
  const sectionState = { status: 'pending', error: '' }

  if (!enabled) {
    ctx.logger?.info?.('dsh-search-first: disabled by config')
  } else {
    // ---- 1. system prompt rule ----------------------------------------------
    // The systemPrompt service can mount after this plugin; retry briefly
    // instead of dropping the rule for the life of the process.
    let disposeSection
    let timer
    let settled = false
    const tryRegisterSection = (attempt) => {
      if (settled) return
      let svc
      try {
        svc = ctx.get?.('systemPrompt')
      } catch {
        svc = undefined
      }
      if (svc === undefined || typeof svc.section !== 'function') {
        if (attempt < 20) {
          timer = setTimeout(() => tryRegisterSection(attempt + 1), 1000)
          if (typeof timer.unref === 'function') timer.unref()
        } else {
          settled = true
          sectionState.status = 'failed'
          sectionState.error = 'systemPrompt service never appeared'
          ctx.logger?.warn?.('dsh-search-first: systemPrompt service never appeared; rule not injected')
        }
        return
      }
      try {
        const dispose = svc.section({ name: SECTION_NAME, order, text: rule })
        settled = true
        sectionState.status = 'registered'
        if (typeof dispose === 'function') disposeSection = dispose
        ctx.logger?.info?.(`dsh-search-first: rule section registered (order ${order})`)
      } catch (error) {
        settled = true
        sectionState.status = 'failed'
        sectionState.error = messageOf(error)
        ctx.logger?.warn?.(`dsh-search-first: section registration failed: ${messageOf(error)}`)
      }
    }
    tryRegisterSection(0)

    ctx.on('dispose', () => {
      if (timer !== undefined) clearTimeout(timer)
      if (typeof disposeSection === 'function') {
        try {
          disposeSection()
        } catch {
          // Disposal is best-effort.
        }
      }
    })

    // ---- 2. optional hard guard ---------------------------------------------
    if (strict) {
      ctx.on('agent/pre-step', async (payload, next) => {
        const decision = await next()
        try {
          const agent = payload?.agent
          const turn = payload?.turn
          if (agent && typeof agent.id === 'string' && Number.isFinite(turn)) {
            const prev = turns.get(agent.id)
            if (prev === undefined || prev.turn !== turn) {
              turns.set(agent.id, { turn, searched: false })
            }
          }
        } catch {
          // Never let bookkeeping break a step.
        }
        return decision
      })

      ctx.on('tools/pre-execute', async (exec, next) => {
        const toolName = exec?.name
        if (typeof toolName !== 'string') return next()
        const sid = exec?.agent?.id
        if (isSearch(toolName)) {
          if (typeof sid === 'string') {
            const entry = turns.get(sid)
            turns.set(sid, { turn: entry?.turn ?? -1, searched: true })
          }
          return next()
        }
        if (!isGuarded(toolName) || isAllowed(toolName)) return next()
        if (typeof sid !== 'string') return next()
        const entry = turns.get(sid)
        if (entry !== undefined && entry.searched) return next()
        return {
          kind: 'deny',
          reason:
            `Blocked by dsh-search-first: this turn has not searched yet, so ${toolName} is held back. ` +
            'Run a search tool first (web_search / platform_search / research, or memory_search / ops_grep ' +
            'when the answer should already exist here), then retry this call. ' +
            'To turn the guard off, set strict: false on the dsh-search-first row.',
        }
      })

      ctx.logger?.info?.('dsh-search-first: strict guard active')
    }
  }

  // ---- 3. status tool -------------------------------------------------------
  const statusTool = {
    name: 'search_first_status',
    description:
      'Report whether dsh-search-first is active: whether the "search first" rule is registered in the system prompt, its order, whether the strict guard is on, and how many sessions it is tracking.',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    output: { schema: STATUS_SCHEMA, render: (args, value) => asText(value) },
    async execute() {
      const ruleText = !enabled
        ? 'off (plugin disabled)'
        : sectionState.status === 'registered'
          ? `registered (order ${order}, ${rule.length} chars)`
          : sectionState.status === 'failed'
            ? `failed: ${sectionState.error}`
            : 'pending (systemPrompt service not ready yet)'
      return {
        enabled,
        rule: ruleText,
        guard: strict ? `on (${searchTools.length} search tools, ${guardedTools.length} guarded tools)` : 'off',
        sessionsTracked: turns.size,
      }
    },
  }

  ctx.inject(['tools'], (toolCtx) => {
    toolCtx.effect(() => toolCtx.tools.register(statusTool), 'dsh-search-first: search_first_status')
  })
}