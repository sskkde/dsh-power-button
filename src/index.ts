/**
 * dsh-power-button — host half.
 *
 * Fully self-contained restart & shutdown engine for DeepSeek Harness — no
 * dependency on any other plugin (the earlier revision delegated to
 * anweat/dsh-restart; this one reimplements the engine here so the plugin is
 * an independent repo that works standalone).
 *
 * Endpoints:
 *   POST /api/dsh-power-button/restart   — relaunch DSH (detached helper)
 *   POST /api/dsh-power-button/shutdown  — stop DSH (graceful exit, no relaunch)
 *   GET  /api/dsh-power-button/health    — liveness probe for the client flow
 *
 * Model tool:
 *   restart_harness — registers the SAME tool name as anweat/dsh-restart so
 *   this plugin can stand in for it. If that plugin already registered the
 *   name (both installed), the registration is skipped to avoid the
 *   "already registered" collision; if only this plugin is installed, the
 *   model gets OUR restart tool backed by this host's own engine.
 *
 * Restart mechanism (Node-native, verified reliable):
 *   - The helper MUST run outside this process tree, otherwise killing the
 *     dsh web process (which owns this plugin) also kills the helper
 *     mid-flight. So the helper is written to a real .cjs FILE under
 *     $USERPROFILE\.dsh and spawned as `node <file>` (detached + windowsHide,
 *     no console window). A `node -e` one-liner with a multiline script gets
 *     mangled on Windows (CreateProcess command line) and dies with a silent
 *     SyntaxError — the button then "restarts" into a dead instance.
 *   - The helper waits for the listen port to free, then relaunches DSH with
 *     the SAME execPath/execArgv/argv/cwd as the current process. The old
 *     process self-exits after a short delay so the HTTP response flushes.
 *   - No taskkill /T /F (it walks the parent-child chain and kills the helper),
 *     no PowerShell (window popup + quoting traps).
 *
 * Shutdown: prefers DSH's `ctx.appExit` graceful tree dispose (with
 * `process.exit(0)` as fallback for non-standard embeddings); nothing
 * relaunches, so DSH stays down until the user starts it again.
 *
 * Design note (license): the detached-helper relaunch idea is the same
 * approach used by anweat/dsh-restart (MIT); the implementation here is
 * original — the helper is written to a real .cjs file rather than a `node
 * -e` one-liner, which avoids a Windows CreateProcess mangling failure. See
 * README for the full attribution note.
 * @module dsh-power-button
 */

import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import z from '@deepseek-ai/schemastery'
import { createUserMessage } from '@deepseek-ai/dsh-llm'

/** Plugin version, read from package.json so /health can report it. */
const require = createRequire(import.meta.url)
const PLUGIN_VERSION = (require('../package.json') as { version?: string }).version ?? '0.0.0'

export const name = 'dsh-power-button'
export const inject = ['webServer', 'tools', 'commands', 'sessions', 'settings']

/** Plugin configuration (editable via the profile's cordis config / settings). */
export interface Config {
  /** Register the `restart_harness` model tool. On by default: the owner uses
   * this plugin with the agent, and the restart is a graceful `ctx.appExit`
   * (tree dispose), not a hard kill. Set false to disable the model tool and
   * keep restart exclusively on the GUI power button. */
  enableModelTool: boolean
  /** Upper bound (ms) for the model tool's delayMs argument. */
  maxDelayMs: number
  /** After a restart that was triggered from inside a session (model tool or
   * /restart command), notify that session on the new process. */
  notifySession: boolean
  /** How the restart-complete notice reaches the session:
   * - 'followup': queue a follow-up turn and wake the driver - the model sees
   *   the notice immediately and can continue its interrupted work (costs one
   *   model round).
   * - 'inject': queue model-facing context WITHOUT waking the driver - the
   *   notice is durable in the session inbox and is seen on the next wake
   *   (zero model cost). */
  notifyMode: 'followup' | 'inject'
  /** Delay (ms) after boot before the restart-complete notice is delivered -
   * gives the freshly-relaunched process time to finish loading services. */
  notifyDelayMs: number
  /** Busy guard: before a restart, check whether any OTHER session is running
   * (agent status === 'running'). If so, the restart is blocked on the HTTP
   * and tool/command paths until the user explicitly confirms it (force) — a
   * restart would cut a running task's turn mid-flight, so at-restart (=after
   * boot) behavior never depends on this flag: it gates the RESTART trigger. */
  busyGuard: boolean
  /** How long (ms) a MODEL-triggered restart waits for the user to confirm it
   * in the GUI before the pending request times out. The busy guard turns the
   * model tool / /restart command into a SUSPENDED wait ("pending restart"),
   * surfaced to the GUI as a confirm dialog via /health; if the user neither
   * confirms nor cancels within this window, the wait resolves to 'timeout'
   * and the tool/command returns a timeout result. Floor of 30s so a misconfig
   * cannot silently make model restarts hang for only a few seconds. */
  busyConfirmTimeoutMs: number
}

/** Schemastery schema; cordis validates and provides it as apply(ctx, config). */
export const Config: z<Config> = z.object({
  enableModelTool: z.boolean().default(true),
  // The model delay floor (MIN_MODEL_DELAY_MS) is only meaningful while the
  // configured ceiling is at least that floor — clampModelDelayMs then always
  // lands in [1000, maxDelayMs]. A ceiling below the floor would let a config
  // value silently defeat the 1000ms floor (e.g. maxDelayMs: 200 → clamp
  // returns 200), so reject it at schema validation time.
  maxDelayMs: z.number().default(5000).min(1000),
  notifySession: z.boolean().default(true),
  notifyMode: z.union([z.const('followup'), z.const('inject')] as const).default('followup'),
  notifyDelayMs: z.number().default(8000).min(0),
  // Busy guard on by default: a restart while another session is running must
  // be explicitly confirmed first (the only bypass is the force flag, which is
  // reachable only from the GUI / an HTTP caller — never from the model).
  busyGuard: z.boolean().default(true),
  // Model-triggered restart confirmation wait: 3min default, never under 30s
  // (see the config field comment above).
  busyConfirmTimeoutMs: z.number().default(180000).min(30000),
})

const BASE = '/api/dsh-power-button'

/** DSH home per the official contract: explicit $DSH_HOME, else ~/.dsh. */
function dshHome(): string {
  const env = process.env.DSH_HOME?.trim()
  if (env !== undefined && env !== '') return path.resolve(env)
  return path.join(os.homedir(), '.dsh')
}
const RUNTIME_DIR = dshHome()

/** Port this instance serves, resolved at apply time. Markers are keyed by
 * port so concurrent instances (e.g. :3080 and :3081) never read each other's
 * restart markers — otherwise instance B would consume instance A's marker
 * and wrongly report "restarted from A". */
let CURRENT_PORT = 3080

/** Per-port marker path. Exported for tests (isolated via DSH_HOME). */
export function markerPath(): string {
  return path.join(RUNTIME_DIR, `dsh-power-marker-${CURRENT_PORT}.json`)
}

/** Per-process identity: fixed for this instance's lifetime. The client can
 * compare it across a restart to confirm a NEW process answered (stronger
 * than "saw a down, then an up" — works even if the down was missed). */
const INSTANCE_ID = randomUUID()

/** Set at apply time when this process is the freshly-restarted instance:
 * health reports `restarted: true, fromInstanceId: <old>` so a /restart
 * command, the model tool, or a UI click can be confirmed after the fact.
 * `originSessionId`/`originSource` (when the restart was triggered from
 * inside a session) drive the restart-complete notice. */
interface RestartConfirmation {
  fromInstanceId: string
  originSessionId?: string
  originSource?: string
  requestedAt?: string
}
let restartConfirmation: RestartConfirmation | null = null

/** Where a restart request came from, captured at the trigger site so the
 * new process can notify the originating session. */
export interface RestartOrigin {
  /** The session that asked for the restart (the agent driving the model
   * tool or /restart command), when triggered from inside a session. */
  sessionId?: string
  /** Trigger site: 'tool' (restart_harness), 'command' (/restart),
   * 'http' (power button / external POST). */
  source: 'tool' | 'command' | 'http'
}

/** Capture the session a restart is being triggered from, when the trigger
 * runs inside an agent driver (model tool execution or command handler).
 * Uses `ctx.get('agents')` (optional service - no inject dependency) and the
 * registry's currentInitiator(), the same attribution the goal tools rely
 * on. Returns the origin with no sessionId when not inside a driver (UI
 * button, external curl) - those paths get no session notice. */
function captureOrigin(ctx: any, source: RestartOrigin['source']): RestartOrigin {
  try {
    const agents = ctx.get?.('agents') as
      | { currentInitiator?: () => { id?: string } | undefined }
      | undefined
    const initiator = agents?.currentInitiator?.()
    if (initiator !== undefined && typeof initiator.id === 'string' && initiator.id !== '') {
      return { sessionId: initiator.id, source }
    }
  } catch { /* not inside an agent driver */ }
  return { source }
}

/**
 * Ids of every CURRENTLY RUNNING session, except the caller's own session.
 * The busy-guard truth source is the AgentRegistry (`ctx.get('agents')` — the
 * same optional service `captureOrigin` reads, and the same registry the GUI's
 * per-session running indicator derives from, so the two never disagree).
 * `agents.list()` returns all live agents, each with `id` and a `status`
 * getter ('idle' | 'running').
 *
 * Robust to the service being absent or malformed: never throws, returns []
 * unless it can positively observe at least one running OTHER session. The
 * `exceptId` is the ORIGINATING session (the model tool / /restart command runs
 * inside it) — the caller restarting its own session is not "another session".
 *
 * NOTE on method binding: `agents.list()` is a REAL method that reads
 * `this.store` (AgentRegistry extends Service, list() iterates its Map) — it
 * MUST be invoked with the service as its receiver. A `const list =
 * agents.list; list()` would lose `this`, throw inside the try, and return []
 * from the catch below: the guard would silently never fire. Always call it
 * as `agents.list()`.
 */
export function runningSessionIds(ctx: any, exceptId?: string): string[] {
  try {
    const agents = ctx.get?.('agents') as
      | { list?: () => Array<{ id?: unknown; status?: unknown }> }
      | undefined
    if (agents === undefined || typeof agents.list !== 'function') return []
    const out: string[] = []
    // Keep the receiver: list() reads this.store on the real registry.
    for (const agent of agents.list() ?? []) {
      if (typeof agent?.id !== 'string' || agent.id === '') continue
      if (agent.id === exceptId) continue
      // status is a getter on the live agent handle ('idle' | 'running').
      if (agent.status === 'running') out.push(agent.id)
    }
    return out
  } catch { /* service unavailable or a bad shape — treat as not busy */ }
  return []
}

/** Render the bilingual blocked-by-busy notice (mirrors renderRestartNoticeText).
 * Tells the model / command caller which sessions are running and that the
 * restart would interrupt their in-flight task, and how to proceed: either
 * wait for them to finish and retry, or force the restart from the GUI power
 * button — the trust model is: the model tool and commands can NEVER pass
 * force; any trusted loopback HTTP caller (normally the GUI) can. */
export function renderBusyBlockedText(en: boolean, ids: string[]): string {
  const listed = ids.length > 0 ? ids.join(', ') : '-'
  if (en) {
    return `Restart blocked: other session(s) are running (${listed}). `
      + `Restarting would interrupt their in-flight task. Wait for them to finish and retry, `
      + `or confirm a forced restart in the GUI power button.`
  }
  return `重启被拦截：其他会话正在运行（${listed}）。`
    + `重启会中断它们正在进行的任务。请等待其结束后重试，或在 GUI 电源按钮中确认强制重启。`
}

/** The outcome of a pending (suspended) restart request, resolved by the GUI
 * (or by the timeout timer). */
export type PendingOutcome = 'confirmed' | 'cancelled' | 'timeout'

/** Render the bilingual result the MODEL sees after its suspended restart wait
 * resolves to a timeout (the user never confirmed/cancelled within the window).
 * Mirrors renderBusyBlockedText's voice; distinct so the model can tell a plain
 * busy-block apart from a confirmation that lapsed. */
export function renderPendingTimeoutText(en: boolean, ids: string[]): string {
  const listed = ids.length > 0 ? ids.join(', ') : '-'
  if (en) {
    return `Restart cancelled: the confirmation timed out. The restart was paused because other session(s) are running (${listed}), `
      + `and no-one confirmed it within the allowed time, so it did not happen. Wait for the sessions to finish and retry, `
      + `or confirm the restart in the GUI power button.`
  }
  return `重启已取消：等待确认超时。由于其他会话正在运行（${listed}），重启被挂起等待确认，`
    + `但在允许的时间内无人确认，因此未执行重启。请等待会话结束后重试，或在 GUI 电源按钮中确认重启。`
}

/** Render the bilingual result the model sees when the user explicitly CANCELS
 * the pending restart in the GUI. */
export function renderPendingCancelledText(en: boolean, ids: string[]): string {
  const listed = ids.length > 0 ? ids.join(', ') : '-'
  if (en) {
    return `Restart cancelled: the user declined the restart confirmation. `
      + `Other session(s) are running (${listed}) and the restart would interrupt them; `
      + `the user chose not to proceed. Wait for the sessions to finish and retry if you still need to restart.`
  }
  return `重启已取消：用户拒绝了重启确认。`
    + `其他会话正在运行（${listed}），重启会中断它们，因此用户选择不继续。`
    + `请等待会话结束后，若仍需重启再重试。`
}

/**
 * A suspended, user-pending restart request.
 *
 * The busy guard no longer DIRECTLY blocks a model tool / /restart command when
 * another session is running: it records a PendingConfirm here (module-level,
 * in-process, exported only to the plugin's own endpoints/tool/command), the
 * /health probe makes the GUI show the SAME confirm dialog as the GUI-clicked
 * busy flow, and the tool/command execution AWAITS (`waitPendingConfirm`) the
 * user's decision — confirmed → the actual restart proceeds at the single
 * execution point; cancelled/timeout → the caller gets a readable result.
 *
 * Only ONE pending request may exist at a time (a second `create` is refused —
 * concurrent suspensions would let two callers each think they own the restart
 * latch). The wait/resolve pair is one-shot: `resolvePendingConfirm` fires the
 * bound promise at most once and `settled` guards against the confirm and
 * timeout timers both arriving.
 */
export interface PendingConfirm {
  /** Opaque one-time token; the GUI echoes it back to confirm/cancel. */
  token: string
  /** Which trigger created the pending request ('tool' | 'command'). */
  origin: RestartOrigin
  /** The sessions that were busy when the pending request was created. */
  busySessions: string[]
  /** Whether the trigger was a model tool or a /restart command. */
  source: 'tool' | 'command'
  /** Creation timestamp (ISO). */
  createdAt: string
  /** Absolute ISO time at which the wait self-resolves to 'timeout'. */
  expiresAt: string
  /** The suspended wait promise + resolver (bound at create, fired once by a
   * successful resolve). `waitPendingConfirm` awaits this promise. */
  resolve?: { promise: Promise<PendingOutcome>, resolve: (o: PendingOutcome) => void }
  /** One-shot settle marker: prevents confirm/cancel/timeout racing double-fire. */
  settled?: boolean
}

/** Global (in-process) pending confirmation; at most one at a time. */
let pendingConfirm: PendingConfirm | null = null

/** The auto-timeout timer for the CURRENT pending confirmation (cleared on any
 * earlier settle so a resolved request never leaves a stray ticker). */
let pendingTimer: ReturnType<typeof setTimeout> | null = null

/** Create a PendingConfirm for a busy-bound model restart. Refuses (returns
 * null) if one is already pending — a second concurrent suspension must not
 * exist (each caller would otherwise race for the single restart latch).
 * The timeout timer is stored (module-level, unref'd) so a resolve can clear it
 * instead of leaving a stray ticker. */
export function createPendingConfirm(
  origin: RestartOrigin,
  busySessions: string[],
  timeoutMs: number,
): PendingConfirm | null {
  if (pendingConfirm !== null) return null
  const now = Date.now()
  // Bind the wait promise BEFORE publishing the pending slot: once
  // `pendingConfirm = pending` is visible, a resolve can fire it at any time.
  let fire: ((o: PendingOutcome) => void) | null = null
  const promise = new Promise<PendingOutcome>((resolve) => { fire = resolve })
  const pending: PendingConfirm = {
    token: randomUUID(),
    origin,
    busySessions,
    // `source` is a projection of the origin's trigger: a model tool or a
    // command. `origin.source` is 'tool' | 'command' already.
    source: origin.source === 'tool' ? 'tool' : 'command',
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + timeoutMs).toISOString(),
    // Resolver bound now; a later resolve fires it exactly once.
    resolve: { promise, resolve: (o: PendingOutcome) => { fire?.(o) } },
  }
  pendingConfirm = pending
  // Auto-timeout: resolve once to 'timeout' after the window. The timer is
  // cleared on any earlier settle (clearPendingTimer). unref so a lone pending
  // request never holds the process open.
  const timer = setTimeout(() => { resolvePendingConfirm(pending.token, 'timeout') }, timeoutMs)
  timer.unref?.()
  pendingTimer = timer
  return pending
}

function clearPendingTimer(): void {
  if (pendingTimer !== null) {
    clearTimeout(pendingTimer)
    pendingTimer = null
  }
}

/** Peek at the current pending confirmation, if any. /health uses this to
 * surface the pending state to the GUI watcher. */
export function peekPendingConfirm(): PendingConfirm | null {
  return pendingConfirm
}

/** Resolve (settle) the pending confirmation, exactly once. Returns the
 * resolved PendingConfirm, or null when the token does not match an active
 * pending request (already settled, or never created). `settled` guards the
 * confirm/cancel and timeout paths racing: only the FIRST settle wins; every
 * later resolve returns null and leaves the global slot untouched. */
export function resolvePendingConfirm(
  token: string,
  outcome: PendingOutcome,
): PendingConfirm | null {
  if (pendingConfirm === null || pendingConfirm.token !== token) return null
  if (pendingConfirm.settled) return null
  const pending = pendingConfirm
  pending.settled = true
  clearPendingTimer()
  pendingConfirm = null
  // Fire the bound wait promise exactly once. The resolver stays bound (no
  // attempt to clear it): `settled` already prevents a double-fire, and a
  // stale resolver is unreachable — the pending slot is null, so no new
  // waitPendingConfirm(token) can bind to it.
  pending.resolve?.resolve(outcome)
  return pending
}

/** Wait (suspend) for the pending confirmation to be resolved. The tool /
 * command execution calls this right after createPendingConfirm and does not
 * return until the user confirms/cancels or the timeout fires. Resolves once:
 * subsequent calls (and the resolve happen-before) resolve to the SAME outcome,
 * but only if the token is still the active pending request. */
export function waitPendingConfirm(token: string): Promise<PendingOutcome> {
  if (pendingConfirm !== null && pendingConfirm.token === token && pendingConfirm.resolve) {
    return pendingConfirm.resolve.promise
  }
  // No active matching pending request: if it was settled (or timed out) in
  // between, the caller should not hang — return a settled 'cancelled' so the
  // wait never blocks forever after settle.
  return Promise.resolve('cancelled')
}

/** Unique helper file + per-pid log so concurrent DSH instances (e.g. a
 * profile on :3080 and the test copy on :3081) cannot overwrite each other's
 * restart helper, and logs are attributable per instance. */
const HELPER_FILE = path.join(RUNTIME_DIR, `dsh-restart-helper-${process.pid}-${Date.now()}.cjs`)
const LOG_FILE = path.join(RUNTIME_DIR, `restart-helper-${process.pid}.log`)

/** Restart marker: durable evidence that a restart happened and the current
 * process is the NEW instance. Written by restartDsh (intent), updated by the
 * helper (relaunch confirmation), read by the new process at apply time.
 * Lets a /restart command, the model tool, or a UI click answer the question
 * "did it really restart?" — the new instance reports
 * `restarted: true, fromInstanceId: <old>` on /health. Keyed by port. */
function readMarker(): Record<string, unknown> | null {
  try {
    return JSON.parse(fs.readFileSync(markerPath(), 'utf8')) as Record<string, unknown>
  } catch {
    return null
  }
}

/** Record restart intent. Exported for tests (isolated via DSH_HOME). */
export function writeMarker(data: Record<string, unknown>): void {
  try {
    fs.mkdirSync(RUNTIME_DIR, { recursive: true, mode: 0o700 })
    fs.writeFileSync(markerPath(), JSON.stringify(data), { encoding: 'utf8', mode: 0o600 })
  } catch { /* best-effort */ }
}

/**
 * Whether THIS process runs under a process supervisor that relaunches it on
 * exit (systemd `Restart=always`, etc). Detection: systemd sets
 * `INVOCATION_ID` for every unit-started process. Under a supervisor the
 * detached-helper relaunch is BOTH unnecessary (the supervisor re-executes
 * the service) and unreliable (systemd's default `KillMode=control-group`
 * kills every process in the service cgroup when the main process exits —
 * the helper included, however detached). In that environment restart works
 * by exiting and letting the supervisor relaunch, and restart confirmation
 * relies on the intent marker alone within a freshness window.
 */
export function supervisorManaged(): boolean {
  const id = process.env.INVOCATION_ID
  return typeof id === 'string' && id !== ''
}

/** How fresh a supervisor-mode intent marker must be for this process to
 * claim the restart. The supervisor relaunches within seconds; a much older
 * marker belongs to a previous restart whose consume was skipped (e.g. the
 * new instance never booted) and must not let a later MANUAL boot misreport
 * as "restarted". */
const SUPERVISOR_ACCEPT_WINDOW_MS = 10 * 60 * 1000

/** Whether THIS process is the freshly-restarted instance. Exported for tests. */
export function consumeRestartConfirmation(): RestartConfirmation | null {
  const marker = readMarker()
  if (marker === null) return null
  const rawOld = marker.fromInstanceId
  if (typeof rawOld !== 'string' || rawOld === INSTANCE_ID) {
    try { fs.unlinkSync(markerPath()) } catch { /* ignore */ }
    return null
  }
  const oldId = rawOld
  const finish = (): RestartConfirmation | null => {
    // Consume the marker NOW so a LATER ordinary boot of this profile cannot
    // mistake itself for the restarted instance: B restarts from A, exits
    // normally, then a manual C boot must NOT report "restarted from A".
    try { fs.unlinkSync(markerPath()) } catch { /* ignore */ }
    const result: RestartConfirmation = { fromInstanceId: oldId }
    if (typeof marker.originSessionId === 'string') result.originSessionId = marker.originSessionId
    if (typeof marker.originSource === 'string') result.originSource = marker.originSource
    if (typeof marker.requestedAt === 'string') result.requestedAt = marker.requestedAt
    return result
  }
  if (marker.supervisor === true) {
    // Supervisor-managed environment: there is no helper confirmation
    // (relaunchedAt/newPid) — the supervisor re-executed us. Accept only a
    // FRESH intent marker (within the window): that is the evidence this
    // boot is the supervised relaunch of the marker's author.
    const ra = marker.requestedAt
    const requested = typeof ra === 'string' ? Date.parse(ra) : Number.NaN
    if (!Number.isFinite(requested) || Date.now() - requested > SUPERVISOR_ACCEPT_WINDOW_MS) {
      // Stale supervisor intent (the relaunch never happened, or this is a
      // much later MANUAL boot): clear it and report nothing.
      try { fs.unlinkSync(markerPath()) } catch { /* ignore */ }
      return null
    }
    return finish()
  }
  const relaunched = typeof marker.relaunchedAt === 'string'
    && Number.isInteger(marker.newPid)
    && (marker.newPid as number) === process.pid
  if (!relaunched) {
    // Stale or intent-only marker in the NON-supervisor path (the helper
    // wrote it but never confirmed a relaunch — e.g. the helper died before
    // spawning, and this process is a MANUAL boot): clear it and report
    // nothing. Without the relaunchedAt/newPid check, a stale intent marker
    // would make a manual boot falsely report "restarted" and show the
    // "已重启" toast.
    try { fs.unlinkSync(markerPath()) } catch { /* ignore */ }
    return null
  }
  // This is the exact process the helper spawned (newPid === process.pid),
  // so it IS the freshly-restarted instance.
  return finish()
}

/**
 * Resolve the port the current web server listens on. Prefer the actual
 * `--port` argument (the CLI accepts `--port 0` for an OS-assigned port, in
 * which case the real port is only known after listen — fall back to the
 * webServer service's bound address when available). The helper must wait for
 * THIS port to free; a hardcoded 3080 breaks restart on any other port
 * (e.g. the test copy on 3081).
 */
function resolvePort(ctx: any): number {
  try {
    const bound = ctx.webServer?.server?.address?.()
    if (bound && typeof bound === 'object' && typeof bound.port === 'number' && bound.port > 0) {
      return bound.port
    }
  } catch { /* webServer shape differs across versions */ }
  const argv = process.argv
  const idx = argv.indexOf('--port')
  if (idx >= 0 && idx + 1 < argv.length) {
    const n = Number(argv[idx + 1])
    if (Number.isFinite(n) && n > 0) return n
  }
  return 3080
}

function json(res: any, status: number, payload: unknown) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(payload))
}

/**
 * Read a JSON request body, defensively. The HTTP endpoints historically take
 * NO body (bare POSTs from curl / the classic power button), and must stay
 * backwards compatible — so a body is only read when the framing says one is
 * present (Content-Length > 0 or Transfer-Encoding: chunked), capped at 16KB,
 * and any parse/read failure resolves to {} instead of throwing. This lets the
 * restart handler opt into an optional `{ force: boolean }` body (the busy-guard
 * bypass) without ever letting a malformed body crash the endpoint.
 *
 * Exported for tests (module-level symbol, never part of the public API).
 */
export function readJsonBody(req: any): object {
  if (typeof req?.on !== 'function') return {}
  const hasBody = typeof req.headers?.['content-length'] === 'string' && Number(req.headers['content-length']) > 0
    || typeof req.headers?.['transfer-encoding'] === 'string'
  if (!hasBody) return {}
  return new Promise((resolve) => {
    let chunks = ''
    let tooBig = false
    const MAX = 16 * 1024
    req.on('data', (c: Buffer) => {
      // Stop accumulating once over the cap — the body is still drained to
      // 'end' (the connection must not stall), but no further bytes are kept.
      if (tooBig) return
      chunks += c.toString('utf8')
      if (chunks.length > MAX) tooBig = true
    })
    // 'aborted' (client hung up) and 'error' both mean no usable body; either
    // way the guard treats the request as unforced.
    req.on('end', () => {
      if (tooBig) return resolve({})
      try {
        const parsed = JSON.parse(chunks)
        if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) return resolve(parsed as object)
      } catch { /* bad body - ignore */ }
      resolve({})
    })
    req.on('error', () => resolve({}))
  })
}

/** Whether a candidate object carries a truthy `force` flag (busy-guard bypass).
 * Exported for tests (module-level symbol, never part of the public API). */
export function wantsForce(body: object): boolean {
  return (body as { force?: unknown })?.force === true
}

/** Append to a log file, rotating (truncating) once it exceeds 1MB so an
 * 长期运行的实例不会无限增长。Best-effort: never throws. */
const LOG_MAX_BYTES = 1024 * 1024
function appendLog(file: string, line: string): void {
  try {
    const { size } = fs.statSync(file)
    if (size > LOG_MAX_BYTES) fs.writeFileSync(file, '', 'utf8')
  } catch { /* first write or missing file */ }
  try { fs.appendFileSync(file, line, 'utf8') } catch { /* ignore */ }
}

/**
 * Redact credential-shaped content from a command line before logging.
 * Handles both shapes:
 *   --api-key=sk-xxx          (inline key=value → value redacted)
 *   --api-key sk-xxx          (separate key token → next value redacted)
 * Long bare tokens that look like secrets are redacted as a whole so a
 * plugin CLI arg that passes a raw credential value cannot leak. Ordinary
 * long words ("description", a repo path) would be over-redacted, so the
 * bare-token rule only fires when the previous token is a credential key
 * OR the token itself looks secret-shaped (starts with a known secret
 * prefix such as `sk-`, `ghp_`, `xox`).
 */
export function redactCommandLine(parts: readonly string[]): string {
  const KEY = /^(--?[a-z0-9_-]*)?(api[_-]?key|token|secret|password|passwd|auth|bearer)$/i
  const INLINE = /((?:api[_-]?key|token|secret|password|passwd|auth|bearer)[=:]\s*)([\w-]{8,})/i
  const BARE_SECRET = /^(sk-|ghp_|gho_|xox[bap]-|AKIA|-----BEGIN)[\w-]+/i
  return parts.map((part, index) => {
    // The value following a credential KEY token is the secret.
    if (index > 0 && KEY.test(parts[index - 1] ?? '')) return '***'
    return part
      .replace(INLINE, '$1***')
      .replace(BARE_SECRET, '***')
  }).join(' ')
}

/** Floor/clamp the model-visible restart delay: the model must never be able
 * to kill the process before its own tool/result and turn boundary settle.
 * The floor applies whenever a numeric positive delay is given; the ceiling
 * (config.maxDelayMs, schema-validated >= 1000) caps every outcome INCLUDING
 * the non-numeric fallback, so clamp(anything, maxDelayMs) ∈ [1000, maxDelayMs]. */
export function clampModelDelayMs(raw: number, maxDelayMs: number): number {
  const MIN_MODEL_DELAY_MS = 1000
  const desired = Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 2000
  return Math.min(Math.max(desired, MIN_MODEL_DELAY_MS), maxDelayMs)
}

/** Startup housekeeping: prune old restart-helper logs and helper scripts so
 * ~/.dsh does not accumulate one file per restart forever. Only files older
 * than the cutoff are removed, so a JUST-spawned helper (current restart in
 * flight) is never touched. Best-effort, never throws. */
export function pruneOldRestartLogs(maxAgeDays = 7): void {
  try {
    const cutoff = Date.now() - maxAgeDays * 24 * 3600 * 1000
    for (const name of fs.readdirSync(RUNTIME_DIR)) {
      if (!name.startsWith('restart-helper-')) continue
      if (!name.endsWith('.log') && !name.endsWith('.cjs')) continue
      const full = path.join(RUNTIME_DIR, name)
      try {
        if (fs.statSync(full).mtimeMs < cutoff) fs.unlinkSync(full)
      } catch { /* ignore */ }
    }
  } catch { /* ignore */ }
}

/** Boot breadcrumb with an ALLOWLIST of diagnostic fields only. The full
 * argv is never logged: plugin CLI args can carry credentials (--api-key
 * sk-xxx etc), and even a good redactor is one regex away from leaking a
 * value. Keep execPath/script/port/profile/pid/cwd-basename only. */
function bootBreadcrumb(): string {
  const argv = process.argv
  const portIndex = argv.indexOf('--port')
  const profileIndex = argv.indexOf('--profile')
  const script = argv.find(a => /(^|[\\/])bin\.(ts|js)$/.test(a)) ?? argv[1] ?? ''
  return [
    `pid=${process.pid}`,
    `execPath=${process.execPath}`,
    `script=${script}`,
    profileIndex > 0 ? `profile=${argv[profileIndex + 1] ?? ''}` : '',
    portIndex > 0 ? `port=${argv[portIndex + 1] ?? ''}` : '',
    `cwd=${path.basename(process.cwd())}`,
  ].filter(Boolean).join(' ')
}

// Boot-time breadcrumb: record the invocation allowlist so relaunch
// derivation can be checked against reality, without ever logging argv.
try {
  fs.mkdirSync(RUNTIME_DIR, { recursive: true, mode: 0o700 })
  appendLog(LOG_FILE, `${new Date().toISOString()} loaded ${bootBreadcrumb()}\n`)
} catch { /* ignore */ }

/**
 * Relaunch DSH. Returns immediately. Two modes:
 *  - NORMAL (no supervisor): a detached helper waits for the old process to
 *    exit and the port to free, then re-executes the same command line and
 *    confirms the relaunch in the marker (newPid/relaunchedAt).
 *  - SUPERVISOR (systemd `Restart=always` etc): no helper — systemd kills
 *    the whole service cgroup (KillMode=control-group) and re-executes the
 *    unit. The marker carries `supervisor: true` and the fresh intent; the
 *    new process claims the restart within a freshness window.
 */
function restartDsh(ctx: any, delayMs = 1500, origin: RestartOrigin = { source: 'http' }) {
  try {
    const port = resolvePort(ctx)
    const supervisor = supervisorManaged()
    // Record restart intent: the new process reads this to confirm it IS the
    // restarted instance (its own instanceId differs from the recorded old),
    // and - when the restart was triggered from inside a session - which
    // session to notify once the new process is up.
    const requestedAt = new Date().toISOString()
    writeMarker({
      fromInstanceId: INSTANCE_ID,
      requestedAt,
      originSessionId: origin.sessionId,
      originSource: origin.source,
      ...(supervisor ? { supervisor: true } : {}),
    })
    if (supervisor) {
      // The supervisor (systemd Restart=always) relaunches this service on
      // exit; a detached helper would be killed with the cgroup anyway, and
      // its relaunch would race the supervisor's own re-exec. Skip the
      // helper: just exit (scheduleExit below) and let the supervisor act.
      try {
        appendLog(LOG_FILE, `${new Date().toISOString()} supervisor-managed restart requested (fromInstanceId=${INSTANCE_ID}); systemd will relaunch\n`)
      } catch { /* ignore */ }
      // Total watchdog from the restart request: covers the ENTIRE exit chain
      // (session flush + appExit dispose) so a hung dispose cannot strand this
      // process alive with the port released while systemd waits for an exit
      // that never comes (the observed restart-closure break).
      armExitWatchdog(delayMs + EXIT_WATCHDOG_MS)
      scheduleExit(ctx, delayMs)
      return { ok: true, action: 'restart', note: isEnglishLocale(ctx) ? 'DeepSeek Harness is restarting' : 'DeepSeek Harness 正在重启' }
    }
    // Replay the CURRENT invocation, portably (no hard-coded paths):
    // execArgv carries node flags (e.g. --import tsx/esm), argv the entry
    // script + app args. Spawned children inherit env, so any NODE_OPTIONS
    // that launched us is preserved too.
    const relaunch = JSON.stringify([process.execPath, ...process.execArgv, ...process.argv.slice(1)])
    const cwd = process.cwd()
    const serverLog = path.join(RUNTIME_DIR, 'dsh-web.log')
    // Origin passthrough: the helper REWRITES the marker on relaunch success,
    // so the session-notice fields must be re-embedded in the helper script
    // (they would otherwise be lost exactly when the restart succeeds).
    const helperScript = `'use strict';
const { spawn } = require('node:child_process');
const net = require('node:net');
const fs = require('node:fs');
const relaunch = ${relaunch};
const cwd = ${JSON.stringify(cwd)};
const PORT = ${port};
const OLD_PID = ${process.pid};
const OLD_INSTANCE = ${JSON.stringify(INSTANCE_ID)};
const REQUESTED_AT = ${JSON.stringify(requestedAt)};
const ORIGIN_SESSION = ${JSON.stringify(origin.sessionId ?? null)};
const ORIGIN_SOURCE = ${JSON.stringify(origin.source)};
const MARKER = ${JSON.stringify(markerPath())};
const LOG = ${JSON.stringify(LOG_FILE)};
const SERVER_LOG = ${JSON.stringify(serverLog)};
const SESSIONS_ROOT = ${JSON.stringify(path.join(RUNTIME_DIR, 'sessions'))};
function log(m) {
  try { fs.appendFileSync(LOG, new Date().toISOString() + ' ' + m + '\\n'); } catch {}
}
function pidGone(pid) {
  try { process.kill(pid, 0); return false; } catch { return true; }
}
function portFree(p) {
  return new Promise((resolve) => {
    const s = net.createConnection({ host: '127.0.0.1', port: p });
    s.once('connect', () => { s.destroy(); resolve(false); });
    s.once('error', () => resolve(true));
  });
}
// Durable-write quiescence check: the OLD process may still be draining its
// session write-behind buffer after its main loop exits (a message or a
// tool/result landing just before the exit). Relaunching before that drain
// finishes lets the NEW process read a file the old one is still appending
// to, and its first writes then interleave stale seq numbers onto the same
// log — the corruption that repeatedly broke sessions. So after the old pid
// is gone and the port is free, poll every session log's (size, mtimeMs)
// until two consecutive samples are identical: only then is the disk quiescent.
// Bounded (~15s): never block the restart forever on a stuck writer.
function sessionsQuiescent(maxWaitMs) {
  const nodePath = require('node:path');
  const walk = (dir, out) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = dir + nodePath.sep + e.name;
      if (e.isDirectory()) walk(p, out);
      else if (/session\.jsonl/.test(e.name)) {
        try {
          const s = fs.statSync(p);
          out.push(p + ':' + s.size + ':' + Math.floor(s.mtimeMs));
        } catch {}
      }
    }
  };
  const stamp = () => { const out = []; walk(SESSIONS_ROOT, out); return out.sort().join('|'); };
  const deadline = Date.now() + maxWaitMs;
  let prev = stamp();
  return new Promise((resolve) => {
    const tick = () => {
      setTimeout(() => {
        if (Date.now() >= deadline) return resolve(false);
        const cur = stamp();
        if (cur === prev) return resolve(true);
        prev = cur;
        tick();
      }, 400);
    };
    tick();
  });
}
(async () => {
  log('helper up: old pid ' + OLD_PID + ', waiting for it to exit');
  let gone = false;
  for (let i = 0; i < 60; i++) {
    if (pidGone(OLD_PID)) { gone = true; break; }
    await new Promise((r) => setTimeout(r, 500));
  }
  if (!gone) { log('old process never exited - giving up'); cleanup(); return; }
  log('old pid gone, waiting for port ' + PORT + ' to free');
  let freed = false;
  for (let i = 0; i < 60; i++) {
    if (await portFree(PORT)) { freed = true; break; }
    await new Promise((r) => setTimeout(r, 500));
  }
  if (!freed) { log('port never freed - giving up'); cleanup(); return; }
  await new Promise((r) => setTimeout(r, 500)); // settle: let the socket fully release
  // Wait for the old process's session write-behind to drain completely
  // (durable files stable) before the new process touches them. This closes
  // the restart-time corruption window: the new instance must never read a
  // session file the old one is still appending to.
  const quiescent = await sessionsQuiescent(15000);
  log(quiescent ? 'session logs quiescent' : 'session logs still moving after 15s - proceeding anyway');
  // Relaunch breadcrumb with an ALLOWLIST only: the full argv is never logged
  // (plugin CLI args can carry credentials, and even a good redactor is one
  // regex away from leaking a value — same rule as the host boot breadcrumb).
  const relaunchExec = relaunch[0] ?? '';
  const relaunchScript = relaunch.find((a) => /(^|[\\/])bin\.(ts|js)$/.test(a)) ?? '';
  log('relaunching: exec=' + relaunchExec + ' script=' + relaunchScript + ' argc=' + relaunch.length);
  const out = fs.openSync(SERVER_LOG, 'a');
  // spawn() reports many failures asynchronously ('error'), not synchronously;
  // wait for 'spawn' to confirm the new process is actually up, retry with
  // short backoff, and only then clean up the helper.
  const RELAUNCH_RETRIES = 3;
  async function tryRelaunch(attempt) {
    if (attempt > RELAUNCH_RETRIES) {
      log('relaunch failed after ' + RELAUNCH_RETRIES + ' attempts - giving up');
      cleanup();
      return;
    }
    const child = spawn(relaunch[0], relaunch.slice(1), {
      cwd, detached: true, stdio: ['ignore', out, out], windowsHide: true,
    });
    const spawned = await new Promise((resolve) => {
      child.once('spawn', () => resolve(true));
      child.once('error', () => resolve(false));
    });
    if (spawned) {
      child.unref();
      log('spawned pid ' + child.pid + ' (attempt ' + attempt + ')');
      // Confirm the relaunch in the marker so the new process can prove it
      // is the restarted instance. Origin fields pass through so the new
      // process knows which session (if any) to notify.
      try {
        fs.writeFileSync(MARKER, JSON.stringify({
          fromInstanceId: OLD_INSTANCE,
          requestedAt: REQUESTED_AT,
          originSessionId: ORIGIN_SESSION,
          originSource: ORIGIN_SOURCE,
          newPid: child.pid,
          relaunchedAt: new Date().toISOString(),
        }), 'utf8');
      } catch {}
      cleanup();
    } else {
      log('spawn error on attempt ' + attempt + ', retrying in ' + (attempt * 800) + 'ms');
      await new Promise((r) => setTimeout(r, attempt * 800));
      tryRelaunch(attempt + 1);
    }
  }
  await tryRelaunch(1);
  function cleanup() { try { fs.unlinkSync(__filename); } catch {} }
})();
`
    fs.mkdirSync(RUNTIME_DIR, { recursive: true, mode: 0o700 })
    // 0600: the helper embeds the full relaunch argv, which can carry
    // credentials (e.g. --api-key in a plugin CLI arg).
    fs.writeFileSync(HELPER_FILE, helperScript, { encoding: 'utf8', mode: 0o600 })
    const helper = spawn(process.execPath, [HELPER_FILE], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    })
    helper.unref()
    scheduleExit(ctx, delayMs)
    return { ok: true, action: 'restart', note: isEnglishLocale(ctx) ? 'DeepSeek Harness is restarting' : 'DeepSeek Harness 正在重启' }
  } catch (e) {
    return { ok: false, action: 'restart', error: String(e) }
  }
}

/** Best-effort pre-exit durability checkpoint: flush every live session
 * before the exit timer starts so the visible write-behind window is small.
 * Events appended after this point (e.g. this tool's own tool/result, or a
 * message landing during the delay) are covered by Harness's `ctx.appExit`
 * disposal final drain on session/disposed — that teardown lifecycle, not
 * this flush, is the durability authority. Then schedule the old process to
 * exit AFTER the HTTP response flushes. Prefer DSH's `ctx.appExit` (graceful
 * tree dispose); fall back to process.exit in non-standard embeddings. */
/** Last-resort hard exit after a restart/shutdown is requested. The graceful
 * `ctx.appExit` tree dispose is trusted to complete, but a hang has been
 * observed: the web server releases its port while the process stays alive,
 * so systemd `Restart=always` never fires and the restart intent marker goes
 * stale — the supervisor restart never closes. A `.unref()`d watchdog keeps
 * normal exits unchanged (nothing keeps the loop alive) while forcing the
 * process out when the dispose hangs, letting the supervisor relaunch. */
const EXIT_WATCHDOG_MS = 15_000
function armExitWatchdog(ms: number = EXIT_WATCHDOG_MS): NodeJS.Timeout {
  const t = setTimeout(() => {
    try {
      process.exit(0)
    } catch { /* ignore */ }
  }, ms)
  if (typeof t.unref === 'function') t.unref()
  return t
}
function scheduleExit(ctx: any, delayMs: number): void {
  const exit = (): void => {
    setTimeout(() => {
      const appExit = ctx.appExit
      if (typeof appExit === 'function') {
        armExitWatchdog()
        appExit(0)
      } else {
        try { process.exit(0) } catch { /* ignore */ }
      }
    }, delayMs)
  }
  try {
    const live = typeof ctx.sessions?.list === 'function' ? ctx.sessions.list() : []
    if (live.length === 0) {
      exit()
    } else {
      Promise.allSettled(live.map((session: any) => ctx.sessions.flush(session)))
        .then(exit)
        .catch(exit)
    }
  } catch {
    exit()
  }
}

/**
 * Shut down DSH gracefully. Prefers DSH's official `ctx.appExit` channel
 * (launcher-provided), which disposes the plugin tree (sessions, watchers,
 * subprocesses) with a bounded grace period instead of hard-killing via
 * `process.exit`. Falls back to `process.exit` only when the launcher did
 * not provide `appExit` (non-standard embedding).
 *
 * The exit is armed on THIS response's 'finish' so the client sees the ack
 * before the connection drops. Nothing relaunches — the user must start DSH
 * again manually.
 */
function shutdownDsh(ctx: any, res: any) {
  try {
    const exitNow = (): void => {
      armExitWatchdog()
      const appExit = ctx.appExit
      if (typeof appExit === 'function') {
        appExit(0)
      } else {
        try { process.exit(0) } catch { /* ignore */ }
      }
    }
    // Flush every live session before exiting so the write-behind buffer is
    // durably on disk — same durability barrier as the restart path.
    const exitSoon = (): void => {
      try {
        const live = typeof ctx.sessions?.list === 'function' ? ctx.sessions.list() : []
        if (live.length === 0) {
          exitNow()
          return
        }
        Promise.allSettled(live.map((session: any) => ctx.sessions.flush(session)))
          .then(exitNow)
          .catch(exitNow)
      } catch {
        exitNow()
      }
    }
    if (res !== undefined && typeof res.once === 'function') {
      // HTTP path: exit on THIS response's 'finish' so the client sees the
      // ack before the connection drops. 500ms fallback if 'finish' never
      // fires (e.g. client aborted).
      res.once('finish', exitSoon)
      setTimeout(exitSoon, 500).unref()
    } else {
      // Command path: no response object; exit after a short beat so the
      // command result flushes.
      setTimeout(exitSoon, 300).unref()
    }
    return {
      ok: true,
      action: 'shutdown',
      note: isEnglishLocale(ctx)
        ? 'DeepSeek Harness is shutting down (start it again manually)'
        : 'DeepSeek Harness 正在关机（进程停止后需手动重新启动）',
    }
  } catch (e) {
    return { ok: false, action: 'shutdown', error: String(e) }
  }
}

/**
 * Trust fence for the destructive POST endpoints. These actions kill the DSH
 * process, so a malicious webpage must not trigger them cross-origin (a
 * `fetch(..., { mode: 'no-cors' })` still sends the request even though the
 * response is unreadable).
 *
 * Defense in depth — mirrors the official DSH browser-trust fence
 * (`isTrustedApiRequest` in dsh-client-connection) without importing the
 * client package:
 *   1. Loopback socket check — the request must arrive on 127.0.0.1/::1.
 *   2. Host-header fence (DNS-rebinding defense): Host must be loopback or a
 *      bare 127.0.0.1 authority — a rebound page carries the attacker's
 *      domain in Host even though the socket lands here.
 *   3. Cross-site fence: an explicit `sec-fetch-site: cross-site` is refused.
 *   4. Origin fence: when a browser attaches Origin it must equal Host
 *      (normalized); absent Origin is fine (curl/non-browser — Host already
 *      bound the request).
 *
 * NOTE: our `/api/dsh-power-button/*` prefix is LONGER than the official
 * `/api` route, so webServer's longest-prefix-wins matching means these
 * requests never pass through the official fence automatically — this guard
 * is the only line of defense for them.
 */
function isTrustedPowerRequest(req: any): boolean {
  const address = req.socket?.remoteAddress
  if (address !== '127.0.0.1' && address !== '::1' && address !== '::ffff:127.0.0.1') return false
  const { host, origin, 'sec-fetch-site': secFetchSite } = req.headers
  // Host fence: Host must be a loopback authority (we only serve loopback).
  if (typeof host !== 'string') return false
  let hostUrl: URL
  try {
    hostUrl = new URL(`http://${host}`)
  } catch {
    return false
  }
  const hn = hostUrl.hostname
  if (hn !== '127.0.0.1' && hn !== '::1' && hn !== '[::1]' && hn !== 'localhost') return false
  // Cross-site fence.
  if (typeof secFetchSite === 'string' && secFetchSite === 'cross-site') return false
  // Origin fence: present Origin must equal Host; "null" origin refused.
  if (origin === undefined) return true
  if (typeof origin !== 'string' || origin === 'null') return false
  try {
    return new URL(origin).host === hostUrl.host
  } catch {
    return false
  }
}

/**
 * At-most-once latch for destructive power transitions. Restart and shutdown
 * both end the current process; a second POST (duplicate tab, model tool +
 * UI race, client retry) must not spawn a second helper or double-exit.
 * Claimed on first POST, released only if the action fails synchronously
 * (the process is exiting on success, so the latch never needs clearing).
 */
let powerTransition: 'restart' | 'shutdown' | null = null

function claimPowerTransition(action: 'restart' | 'shutdown'): boolean {
  if (powerTransition !== null) return false
  powerTransition = action
  return true
}

function releasePowerTransition(): void {
  powerTransition = null
}

/** Whether the UI language is English (DSH settings `locale.preference`). */
function isEnglishLocale(ctx: any): boolean {
  try {
    const locale = ctx.settings?.get?.('locale') as { preference?: string } | undefined
    const pref = typeof locale?.preference === 'string' ? locale.preference.toLowerCase() : ''
    return pref.startsWith('en')
  } catch { /* settings unavailable */ }
  return false
}

// ---------------------------------------------------------------------------
// Restart-complete session notice
// ---------------------------------------------------------------------------
// When a restart is triggered from INSIDE a session (the restart_harness model
// tool or the /restart command), the marker records that session. The
// freshly-relaunched process then delivers a "restart complete" notice to it
// through the OFFICIAL agent APIs (ctx.agents.resume + followup/inject - the
// same path the goal-round driver and the web prompt endpoint use), never by
// writing session files directly: the interrupted turn is repaired by the
// session restore path (interruptedTurnClosers), and the notice itself is a
// durable inbox event, so it survives even if this process dies mid-delivery.

/** Structural type for the optional `agents` service (`@deepseek-ai/dsh-agent`).
 * Kept local so this plugin stays standalone (no hard dependency). */
interface AgentsServiceShape {
  get(id: string): AgentShape | undefined
  resume(options: {
    resumeSessionId: string
    agentOptions?: unknown
    setup?: (agentCtx: unknown) => Promise<void>
  }): Promise<{ agent: AgentShape, dispose(): Promise<void> }>
  currentInitiator?(): AgentShape | undefined
}

/** Structural type for a live Agent handle. */
interface AgentShape {
  id: string
  followup(message: unknown): void
  inject(message: unknown): void
  whenIdle(): Promise<void>
}

/** Render the notice text the session's model will see. */
export function renderRestartNoticeText(en: boolean, originSource?: string): string {
  const trigger = en
    ? { tool: 'the restart_harness tool', command: 'the /restart command', http: 'an HTTP request' }[originSource ?? 'http'] ?? 'a restart request'
    : { tool: 'restart_harness 工具', command: '/restart 命令', http: 'HTTP 请求' }[originSource ?? 'http'] ?? '重启请求'
  if (en) {
    return `[dsh-power-button] DeepSeek Harness restart complete (triggered by ${trigger}). `
      + `The new process is up (pid ${process.pid}); plugins and config that required a restart are now active. `
      + `This notice is automatic - no user message preceded it. If you were mid-task when the restart happened, continue that work now.`
  }
  return `[dsh-power-button] DeepSeek Harness 重启完成（由${trigger}触发）。`
    + `新进程已就绪（pid ${process.pid}），需要重启才能生效的插件与配置变更现已生效。`
    + `本通知为自动发送，并非用户消息。若重启发生时你还有未完成的任务，请继续。`
}

/** Resolve the agent-preset setup for a resumed session, mirroring how the
 * web host (dsh-host-apiproxy composeAgent) composes agents: resolve the
 * preset recorded on the session header and mount it on the fresh agent
 * context, so the notified model runs with its ORIGINAL toolset. Returns
 * undefined when no preset is recorded or the services are absent - the
 * host composition is the documented fallback then. */
async function composePresetSetup(
  ctx: any,
  sessionId: string,
): Promise<{ setup?: (agentCtx: unknown) => Promise<void>, retryable?: boolean }> {
  try {
    const persistence = ctx.get?.('sessionPersistence') as
      | { inspect?(id: string): Promise<{ meta?: { agentPreset?: string } }> }
      | undefined
    const presets = ctx.get?.('agentPresets') as
      | { resolve?(id: string): Promise<{ id: string }>, mount?(agentCtx: unknown, id: string): Promise<void> }
      | undefined
    if (persistence === undefined || persistence.inspect === undefined) return { retryable: true }
    if (presets === undefined || presets.resolve === undefined || presets.mount === undefined) {
      return { retryable: true }
    }
    // Bind to locals: the guards above do not narrow across the closure below.
    const inspect = persistence.inspect
    const resolve = presets.resolve
    const mount = presets.mount
    const inspected = await inspect(sessionId)
    const presetId = inspected?.meta?.agentPreset
    if (typeof presetId !== 'string' || presetId === '') return {} // no preset - host composition only
    const resolved = await resolve(presetId)
    return { setup: async (agentCtx: unknown) => { await mount(agentCtx, resolved.id) } }
  } catch (error) {
    // Early-boot service races (persistence / preset roster still loading)
    // look like inspect/resolve failures; log the reason so a silent
    // tool-less notification turn is diagnosable, and report retryable so
    // the caller retries instead of resuming a composition-less agent.
    try {
      appendLog(LOG_FILE, `${new Date().toISOString()} composePresetSetup failed for ${sessionId}: ${String(error)}\n`)
    } catch { /* ignore */ }
    return { retryable: true }
  }
}

/**
 * Deliver the restart-complete notice to the session that requested the
 * restart. Reuses the live agent when the web client already reconnected and
 * resumed the session; otherwise resumes it from persistence (with its
 * original agent preset mounted), delivers the notice, and disposes the
 * handle after the notification turn settles. Returns false (retryable) when
 * the agent services are not loaded yet; throws on permanent failures
 * (unknown session, corrupt persistence).
 */
export async function deliverRestartNotice(ctx: any, cfg: Config, info: RestartConfirmation): Promise<boolean> {
  const sessionId = info.originSessionId as string
  const agents = ctx.get?.('agents') as AgentsServiceShape | undefined
  if (agents === undefined || typeof agents.resume !== 'function' || typeof agents.get !== 'function') {
    return false // services still loading - caller retries
  }
  // Reuse the live agent when one exists (the web client may have resumed the
  // session already); apiproxy resolves opens the same way, so both paths
  // interoperate without ownership conflicts.
  let agent = agents.get(sessionId)
  let handle: { dispose(): Promise<void> } | null = null
  if (agent === undefined) {
    const compose = await composePresetSetup(ctx, sessionId)
    // Services/preset not ready yet (early boot): report retryable instead of
    // resuming a composition-less agent whose notification turn would have no
    // tools.
    if (compose.retryable === true) return false
    // Resume with the deployment's DEFAULT model route: the session's persona
    // assembles `{{model}}` from the agent's route (deployment:persona etc),
    // and a route-less resume fails prompt assembly (observed: notification
    // turn crashed with 'prompt variable "{{model}}" has no value'). The web
    // host passes the same selection (apiproxy agentOptions()).
    let agentOptions: { provider: string, model: string } | undefined
    try {
      const defaults = ctx.get?.('agentDefaultModel') as
        | { currentSelection?(): { provider?: string, model?: string } }
        | undefined
      const selection = defaults?.currentSelection?.()
      if (
        selection !== undefined
        && typeof selection.provider === 'string' && selection.provider !== ''
        && typeof selection.model === 'string' && selection.model !== ''
      ) {
        agentOptions = { provider: selection.provider, model: selection.model }
      }
    } catch { /* fall through: resume without options */ }
    const resumed = await agents.resume({
      resumeSessionId: sessionId,
      ...(agentOptions !== undefined ? { agentOptions } : {}),
      ...(compose.setup !== undefined ? { setup: compose.setup } : {}),
    })
    agent = resumed.agent
    handle = resumed
  }
  const message = createUserMessage({
    content: [{ type: 'text', text: renderRestartNoticeText(isEnglishLocale(ctx), info.originSource) }],
    source: { kind: 'plugin', plugin: 'dsh-power-button' },
  })
  if (cfg.notifyMode === 'inject') {
    // Durable no-wake context: visible on the session's next wake, zero cost.
    agent.inject(message)
    if (handle !== null) await handle.dispose().catch(() => { /* best-effort */ })
    return true
  }
  // followup: wake the driver for one notification turn so the model can
  // continue its interrupted work immediately.
  agent.followup(message)
  if (handle !== null) {
    // Let the notification turn settle before releasing the handle; bounded
    // (5min) so a stuck LLM call cannot pin this plugin's boot path forever.
    const settled = Promise.race([
      agent.whenIdle().catch(() => { /* driver failure still settles */ }),
      new Promise<void>((resolve) => { setTimeout(resolve, 300_000).unref?.() }),
    ])
    await settled
    await handle.dispose().catch(() => { /* best-effort */ })
  }
  return true
}

/** Schedule the restart-complete notice: one delivery after notifyDelayMs,
 * retried a bounded number of times (early boot races - the agent factory or
 * persistence may still be loading). Best-effort - failures are logged,
 * never thrown: a notice must not interfere with the freshly-booted process. */
function scheduleRestartNotice(ctx: any, cfg: Config, info: RestartConfirmation): void {
  const MAX_ATTEMPTS = 5
  let attempts = 0
  const retry = (): void => {
    const timer = setTimeout(attempt, 15_000)
    timer.unref?.()
  }
  const attempt = (): void => {
    attempts += 1
    deliverRestartNotice(ctx, cfg, info)
      .then((delivered) => {
        if (delivered) {
          appendLog(LOG_FILE, `${new Date().toISOString()} restart notice delivered to session=${info.originSessionId} mode=${cfg.notifyMode}\n`)
        } else if (attempts >= MAX_ATTEMPTS) {
          appendLog(LOG_FILE, `${new Date().toISOString()} restart notice skipped: agent services unavailable after ${attempts} attempts (session=${info.originSessionId})\n`)
        } else {
          retry()
        }
      })
      .catch((error) => {
        // Unknown session / corrupt persistence / rejected resume: retry a
        // bounded number of times (an early-boot service race can look like
        // this too), then give up. Never fatal.
        appendLog(LOG_FILE, `${new Date().toISOString()} restart notice failed (session=${info.originSessionId} attempt=${attempts}): ${String(error)}\n`)
        if (attempts < MAX_ATTEMPTS) retry()
      })
  }
  const first = setTimeout(attempt, Math.max(0, cfg.notifyDelayMs))
  first.unref?.()
}

export function apply(ctx: any, config: Config) {
  // Startup housekeeping: prune stale restart-helper logs from previous runs.
  pruneOldRestartLogs()
  // Resolve THIS instance's port first: markers are keyed by port so
  // concurrent instances never read each other's restart markers.
  CURRENT_PORT = resolvePort(ctx)
  // If the restart marker names a DIFFERENT previous instance, this process
  // is the freshly-relaunched one — record it for /health confirmation.
  restartConfirmation = consumeRestartConfirmation()
  if (restartConfirmation !== null) {
    try {
      appendLog(LOG_FILE, `${new Date().toISOString()} restart confirmed: fromInstanceId=${restartConfirmation.fromInstanceId} thisInstanceId=${INSTANCE_ID}\n`)
    } catch { /* ignore */ }
    // The confirmation is now UI-only: the client shows a "已重启" toast
    // when /health reports `restarted: true` (see src/client/RestartNotice.tsx).
    // Nothing is written into any session log, so a restart can never corrupt
    // a session file or trip the token-meter step-pairing invariant.
    //
    // Session notice (the ONLY session write, via the official agent APIs):
    // when the restart was triggered from inside a session, deliver a
    // "restart complete" followup/inject to it once this process is settled.
    if (
      config.notifySession
      && typeof restartConfirmation.originSessionId === 'string'
      && restartConfirmation.originSessionId !== ''
    ) {
      scheduleRestartNotice(ctx, config, restartConfirmation)
    }
  }

  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: BASE,
    handler: async (req: any, res: any) => {
      const url = new URL(req.url, 'http://x')
      const sub = url.pathname.slice(BASE.length).replace(/\/+$/, '') || '/'
      // Every mutation POST goes through the same-origin guard; health stays open.
      const needsGuard = (sub === '/restart' || sub === '/shutdown' || sub === '/notice-shown'
        || sub === '/confirm-pending' || sub === '/cancel-pending') && req.method === 'POST'
      if (needsGuard && !isTrustedPowerRequest(req)) {
        return json(res, 403, { ok: false, error: 'forbidden: cross-origin power request' })
      }
      try {
        if (sub === '/restart' && req.method === 'POST') {
          // Optional JSON body (`{ force: true }`) from the GUI's confirmed
          // busy-restart. Read it BEFORE claiming the transition so a busy
          // block can't leave the at-most-once latch held for a retry.
          const body = await readJsonBody(req)
          const force = wantsForce(body)
          // Busy guard: if another session is running and this call does NOT
          // carry an explicit force flag, refuse with 409 WITHOUT claiming the
          // latch (so a later retry — after the sessions finish, or a GUI
          // force — can still proceed). Only the GUI / an HTTP caller can
          // present { force: true }; the model tool never can.
          if (cfg.busyGuard && !force) {
            const busy = runningSessionIds(ctx)
            if (busy.length > 0) {
              return json(res, 409, {
                ok: false, action: 'restart', blocked: 'busy', busySessions: busy,
                error: renderBusyBlockedText(isEnglishLocale(ctx), busy),
              })
            }
          }
          if (!claimPowerTransition('restart')) {
            return json(res, 409, { ok: false, error: `power transition already in progress: ${powerTransition}` })
          }
          const result = restartDsh(ctx)
          if (!result.ok) releasePowerTransition()
          return json(res, result.ok ? 200 : 500, result)
        }
        // Pending-restart resolution endpoints: the GUI echo-confirms/cancels a
        // model-triggered suspended restart by token. These ONLY resolve the
        // signal bridge — the actual restart is still executed by the suspended
        // tool/command execution once it observes 'confirmed', so the
        // at-most-once latch and delayMs semantics stay at the single execution
        // point. An unknown/already-settled token is a 404 (the pending may
        // have timed out or another tab resolved it — the GUI closes its
        // dialog on that).
        if (sub === '/confirm-pending' && req.method === 'POST') {
          const body = await readJsonBody(req)
          const token = (body as { token?: unknown }).token
          const pending = typeof token === 'string'
            ? resolvePendingConfirm(token, 'confirmed')
            : null
          if (pending === null) {
            return json(res, 404, { ok: false, error: 'no pending restart for this token' })
          }
          return json(res, 200, { ok: true, token })
        }
        if (sub === '/cancel-pending' && req.method === 'POST') {
          const body = await readJsonBody(req)
          const token = (body as { token?: unknown }).token
          const pending = typeof token === 'string'
            ? resolvePendingConfirm(token, 'cancelled')
            : null
          if (pending === null) {
            return json(res, 404, { ok: false, error: 'no pending restart for this token' })
          }
          return json(res, 200, { ok: true, token })
        }
        if (sub === '/shutdown' && req.method === 'POST') {
          if (!claimPowerTransition('shutdown')) {
            return json(res, 409, { ok: false, error: `power transition already in progress: ${powerTransition}` })
          }
          const result = shutdownDsh(ctx, res)
          if (!result.ok) releasePowerTransition()
          return json(res, result.ok ? 200 : 500, result)
        }
        if (sub === '/health' && req.method === 'GET') {
          const body: Record<string, unknown> = {
            ok: true,
            instanceId: INSTANCE_ID,
            pluginVersion: PLUGIN_VERSION,
            lifecycle: powerTransition ?? (restartConfirmation !== null ? 'restarted' : 'ready'),
          }
          if (restartConfirmation !== null) {
            body.restarted = true
            body.fromInstanceId = restartConfirmation.fromInstanceId
          }
          // Surface an active model-triggered pending restart: the GUI watcher
          // (piggybacking on the existing health poll) pops the SAME busy
          // confirm dialog when this is present, and echoes the token back to
          // /confirm-pending or /cancel-pending. Omitted when nothing is
          // pending (a plain /health stays byte-identical otherwise).
          const pending = peekPendingConfirm()
          if (pending !== null) {
            body.pendingConfirm = {
              token: pending.token,
              source: pending.source,
              busySessions: pending.busySessions,
              expiresAt: pending.expiresAt,
            }
          }
          return json(res, 200, body)
        }
        if (sub === '/notice-shown' && req.method === 'POST') {
          // UI-only confirmation lifecycle: the client displays the "已重启"
          // toast once (from /health's `restarted` flag), then ACKs here so
          // a later page refresh does not re-show it. Idempotent: no marker
          // is persisted, only the in-memory confirmation is cleared.
          restartConfirmation = null
          return json(res, 200, { ok: true, action: 'notice-shown' })
        }
        json(res, 404, { ok: false, error: `no dsh-power-button endpoint ${sub}` })
      } catch (e) {
        releasePowerTransition()
        json(res, 500, { ok: false, error: String(e) })
      }
    },
  }), 'dsh-power-button: http routes')

  // Model tool: same name as anweat/dsh-restart's `restart_harness` so this
  // plugin stands in for it. On by default (config.enableModelTool); set
  // false to keep restart exclusively on the GUI button. Skip silently when
  // another plugin already owns the name (both installed) — the first
  // registrant wins.
  const cfg = config
  if (cfg.enableModelTool) {
    try {
      ctx.tools.register({
        name: 'restart_harness',
        description: isEnglishLocale(ctx)
          ? 'Restart the whole DeepSeek Harness process to reload plugins and config (profile cordis layers, settings, etc). '
            + 'Provided by dsh-power-button (standalone): normally spawns a detached helper that waits for the old process to exit and the port to free, '
            + 'then relaunches with the same command line and cwd, after which the old process exits. '
            + 'Under a process supervisor (systemd Restart=always etc) the helper is skipped and the supervisor relaunches the service. '
            + 'The current session connection drops briefly and the page auto-reconnects. Returns ok and a note.'
          : '重启整个 DeepSeek Harness 进程，用于重新加载插件与配置（profile 的 cordis 组合、settings 等）。'
            + '由 dsh-power-button 提供（独立实现）：通常派生一个 detach 的 helper，'
            + '在旧进程退出并释放端口后以原命令行在原目录重新拉起，然后旧进程退出；'
            + '在进程托管环境（systemd Restart=always 等）下跳过 helper，由托管方重新拉起。'
            + '触发后当前会话连接会短暂中断，网页随后自动重连到新进程。'
            + '返回 ok 与说明文本。',
        parameters: {
          type: 'object',
          properties: {
            delayMs: {
              type: 'number',
              description: isEnglishLocale(ctx)
                ? `ms to wait before the old process exits (gives the current result time to flush), default 2000, max ${cfg.maxDelayMs}.`
                : `旧进程退出前等待的毫秒数（给当前结果留出回传时间），默认 2000，上限 ${cfg.maxDelayMs}。`,
            },
          },
        },
        output: {
          // NOTE: `type: 'json'` is an author-only spec value — raw
          // `ctx.tools.register` feeds the schema straight to
          // assertSupportedJsonSchema, which only knows
          // object/array/string/number/integer/boolean/null and would throw.
          // An empty schema (annotation-only) accepts any JSON value.
          schema: {},
          render(_args: any, value: any) {
            return [{ type: 'text', text: JSON.stringify(value, null, 2) }]
          },
        },
        async execute(args: any) {
          const a = (args ?? {}) as { delayMs?: number }
          // Floor the model-visible delay: the restart tool must never be able
          // to kill the process before its own tool/result and turn boundary
          // settle. The delay is a process-control implementation detail; the
          // model only gets a bounded, floored knob.
          const clamped = clampModelDelayMs(Number(a.delayMs), cfg.maxDelayMs)
          // Capture the calling session BEFORE the restart: the new process
          // notifies it once it is up (config.notifySession).
          const origin = captureOrigin(ctx, 'tool')
          const en = isEnglishLocale(ctx)
          // Busy guard: the model can NOT self-authorize a forced restart, so
          // if another session is running, SUSPEND here — record the pending
          // request (surfaced to the GUI as the same confirm dialog via
          // /health) and WAIT for the user's explicit decision instead of
          // refusing outright. The wait resolves exactly once (confirm /
          // cancel / timeout); the caller's OWN session is excluded — whether
          // this session is running is irrelevant, the model is asking it.
          if (cfg.busyGuard) {
            const busy = runningSessionIds(ctx, origin.sessionId)
            if (busy.length > 0) {
              const pending = createPendingConfirm(origin, busy, cfg.busyConfirmTimeoutMs)
              if (pending === null) {
                // A concurrent pending request already exists (another tool /
                // command call is mid-wait, or a previous one is unsettled).
                // Only one suspension at a time — refuse the second outright.
                return {
                  ok: false, action: 'restart', blocked: 'busy', busySessions: busy,
                  error: en
                    ? 'a restart is already awaiting user confirmation'
                    : '已有待确认的重启请求',
                }
              }
              const outcome = await waitPendingConfirm(pending.token)
              if (outcome !== 'confirmed') {
                // cancelled (user declined in the GUI) or timeout (nobody
                // answered within busyConfirmTimeoutMs): the restart did NOT
                // happen. Report the readable bilingual result.
                return {
                  ok: false, action: 'restart', blocked: 'busy', busySessions: busy,
                  error: outcome === 'timeout'
                    ? renderPendingTimeoutText(en, busy)
                    : renderPendingCancelledText(en, busy),
                }
              }
              // confirmed: the user explicitly authorized the restart in the
              // GUI. Fall through to the regular flow — NO re-check of
              // runningSessionIds (busy state may have changed in the wait
              // window; the explicit confirmation IS the authorization).
            }
          }
          // Same at-most-once latch as the HTTP endpoints: the model tool and
          // a concurrent UI click must not spawn two helpers.
          if (!claimPowerTransition('restart')) {
            return { ok: false, error: `power transition already in progress: ${powerTransition}` }
          }
          const result = restartDsh(ctx, clamped, origin)
          if (!result.ok) releasePowerTransition()
          return result
        },
      })
    } catch (error) {
      // "already registered" — anweat/dsh-restart owns the name; our UI and
      // endpoints remain, the model uses theirs. Not an error.
      if (String(error).includes('already registered')) {
        try {
          appendLog(LOG_FILE, `${new Date().toISOString()} restart_harness already registered by another plugin; skipping our tool\n`)
        } catch { /* ignore */ }
      } else {
        throw error
      }
    }
  }

  // Command-bar entries, self-contained (no anweat/dsh-restart needed):
  // `/restart` and `/shutdown` share the same at-most-once latch as the UI
  // and the model tool, so a command cannot race a button click.
  // Each registration tolerates a name collision (another plugin may own
  // `restart`): a conflict logs and skips instead of crashing the boot.
  ctx.effect(() => {
    const en = isEnglishLocale(ctx)
    try {
      ctx.commands.register({
        name: 'restart',
        description: en
          ? 'Restart DeepSeek Harness (reload plugins & config)'
          : '重启 DeepSeek Harness（重载插件与配置）',
        recordInput: false,
        async handler() {
          // /restart typed by the model mid-turn runs inside its agent driver:
          // capture that session so the new process can notify it. A command
          // issued outside any driver (bare command bar) captures no session.
          const origin = captureOrigin(ctx, 'command')
          const en = isEnglishLocale(ctx)
          // Busy guard (same gate as the model tool): a command cannot force
          // itself past a running OTHER session — the model driving this
          // command cannot self-authorize a forced restart either. Instead of
          // refusing outright it SUSPENDS: the request is surfaced to the GUI
          // as the SAME busy confirm dialog (via /health pendingConfirm), and
          // the handler waits for the user's decision.
          if (cfg.busyGuard) {
            const busy = runningSessionIds(ctx, origin.sessionId)
            if (busy.length > 0) {
              const pending = createPendingConfirm(origin, busy, cfg.busyConfirmTimeoutMs)
              if (pending === null) {
                return {
                  kind: 'error',
                  text: en
                    ? 'a restart is already awaiting user confirmation'
                    : '已有待确认的重启请求',
                }
              }
              const outcome = await waitPendingConfirm(pending.token)
              if (outcome !== 'confirmed') {
                const text = outcome === 'timeout'
                  ? renderPendingTimeoutText(en, busy)
                  : renderPendingCancelledText(en, busy)
                return { kind: 'error', text }
              }
              // confirmed: fall through to the regular latch + restart.
            }
          }
          if (!claimPowerTransition('restart')) {
            return { kind: 'error', text: `power transition already in progress: ${powerTransition}` }
          }
          const result = restartDsh(ctx, 1500, origin)
          if (!result.ok) releasePowerTransition()
          return result.ok
            ? { kind: 'success', text: result.note }
            : { kind: 'error', text: result.error ?? (en ? 'restart failed' : '重启失败') }
        },
      })
    } catch (error) {
      if (String(error).includes('already registered')) {
        try {
          appendLog(LOG_FILE, `${new Date().toISOString()} command "restart" already registered by another plugin; skipping ours\n`)
        } catch { /* ignore */ }
      } else {
        throw error
      }
    }
    ctx.commands.register({
      name: 'shutdown',
      description: en
        ? 'Shut down DeepSeek Harness (stop process; restart manually). Opens a GUI confirm dialog.'
        : '关机 DeepSeek Harness（停止进程，需手动重新启动）。会弹出确认对话框。',
      // Declared input so `/shutdown <anything>` reaches the handler (the UI's
      // slash matchEnter treats argued lines as commands only when the command
      // declares an input descriptor). The confirm dialog is GUI-side: the
      // handler only signals SHUTDOWN_CONFIRM_PENDING, and the client pops the
      // same dialog as the power button, then POSTs /shutdown on confirm.
      input: { hint: en ? 'opens the shutdown confirm dialog' : '打开关机确认对话框' },
      recordInput: false,
      async handler() {
        // Signal the client to show the GUI confirm dialog (same one the power
        // button uses). The handler does NOT shut down here: shutdown is
        // irreversible, so the actual POST happens only after the user clicks
        // confirm in the dialog. If the client dialog is unavailable (e.g. a
        // non-UI caller), the command reports pending without any side effect.
        return {
          kind: 'error',
          text: 'SHUTDOWN_CONFIRM_PENDING',
        }
      },
    })
  }, 'dsh-power-button: commands')
}
