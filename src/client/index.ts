/**
 * dsh-power-button browser half.
 *
 * Standalone plugin: adds a power button to the sidebar footer
 * (`sidebar.footer.action`) that opens an upward menu with two actions —
 * 重启 (restart) and 关机 (shutdown) — plus a full-screen
 * Windows-shutdown-style overlay (`shell.overlay`) with ring progress and
 * stage captions. Fully self-contained: the restart/shutdown ENGINE lives in
 * this plugin's host half (POST /api/dsh-power-button/{restart,shutdown}),
 * so it works standalone with no dependency on any other plugin.
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-commands/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import { RestartButton } from './RestartButton.tsx'
import { RestartNotice } from './RestartNotice.tsx'
import { RestartOverlay } from './RestartOverlay.tsx'
import { RestartPreparing } from './RestartPreparing.tsx'
import { ShutdownConfirmDialog } from './ShutdownConfirmDialog.tsx'
import { RestartBusyConfirm } from './RestartBusyConfirm.tsx'
import { en, zh } from './locales.ts'

/** Required services. */
export const inject = ['slots', 'locale']

/** Locale namespace for this plugin's UI strings. */
export const NS = 'power.button'

/** Register the plugin's dictionary keys with the typed locale map. */
declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    'power.button': keyof typeof zh
  }
  /**
   * Host-declared slot seats this plugin registers into. Official DSH client
   * packages (dsh-client-ui-sidebar / dsh-client-ui-layout) declare them; we
   * redeclare here so this standalone repo typechecks against the published
   * (empty-SlotMap) client packages — mirroring the sidebars' contracts.
   */
  interface SlotMap {
    'sidebar.footer.action': {
      kind: 'list'
      scope: 'root'
      owner: { wide: boolean }
    }
    'shell.overlay': {
      kind: 'list'
      scope: 'root'
    }
  }
}
/**
 * The 0.2.x client packages supply ctx.locale, ctx.slots, and the
 * command/executed event through their official Cordis type augmentations.
 */

/** What the power flow is doing: restarting or shutting down. */
export type PowerAction = 'restart' | 'shutdown'

/** Global power-flow state shared between the button, menu, and overlay. */
export type RestartPhase = 'idle' | 'preparing' | 'shutting' | 'waiting' | 'recovering' | 'off' | 'error'

let phase: RestartPhase = 'idle'
let action: PowerAction = 'restart'
let errorMsg: string | null = null
const listeners = new Set<() => void>()

/** Locale service captured at apply time; used to translate module-scope
 * (non-component) error strings according to the DSH UI language. */
let localeSvc: Pick<LocaleRuntime, 'getLocale'> | undefined

/** Translate a key in the current UI language (module scope; components use props.t). */
export function tl(key: keyof typeof zh): string {
  const dict = localeSvc?.getLocale().active.toLowerCase().startsWith('en') ? en : zh
  return dict[key]
}

function emit(): void {
  for (const fn of listeners) fn()
}

export function getRestartPhase(): RestartPhase { return phase }
export function getPowerAction(): PowerAction { return action }
export function getRestartError(): string | null { return errorMsg }

/** Surface an error, unless the flow has already moved past the point of no return. */
function fail(msg: string): void {
  if (phase === 'error' || phase === 'recovering') return
  phase = 'error'
  errorMsg = msg
  emit()
}

/** Monotonic operation id: each beginPower() bumps it; stale timers from a
 * previous operation check it and stop. Prevents an old health poll from
 * overwriting a newer flow's phase (e.g. error → waiting on retry). */
let operationId = 0

/** Kick a restart or shutdown. Opens the overlay and drives the flow.
 * Restart goes through a brief `preparing` stage first (a small corner hint,
 * no full-screen veil) so the user is not slammed by a modal in the first
 * hundreds of milliseconds — the POST is still in flight and the page is
 * alive; the full-screen overlay only appears once the connection is about to
 * actually drop. */
/** Shared recovery poll for a restart already in motion. Drives phase
 * waiting -> recovering -> window.location.reload(): each round probes
 * /health; success is authoritative when the instanceId changes from the
 * caller's baseline (old A -> new B), with seenDown-then-up as the fallback
 * only when NO baseline could be captured. Callers own the operation id
 * (`active`) and have already set the initial overlay phase. */
function pollRestartRecovery(baseline: string | null, active: () => boolean): void {
  // Serial (single-flight) polling: each round awaits the fetch before the
  // next timer is scheduled, so overlapping polls cannot race the state.
  let seenDown = false
  let upTicks = 0
  let attempts = 0
  const POLL_MS = 1000
  const MAX_ATTEMPTS = 90

  const poll = async (): Promise<void> => {
    if (!active()) return
    attempts += 1
    if (attempts > MAX_ATTEMPTS) {
      phase = 'error'
      errorMsg = tl('restartTimeout')
      emit()
      return
    }
    let up = false
    let instanceChanged = false
    try {
      const r = await fetch('/api/dsh-power-button/health', { cache: 'no-store' })
      up = r.ok
      if (r.ok) {
        const j = await r.json().catch(() => ({})) as { instanceId?: string }
        instanceChanged = baseline !== null
          && typeof j.instanceId === 'string'
          && j.instanceId !== baseline
      }
    } catch { up = false }
    if (!active()) return

    if (!up) {
      seenDown = true
      upTicks = 0
      if (phase !== 'waiting') {
        phase = 'waiting'
        emit()
      }
    } else {
      const confirmed = baseline !== null
        ? instanceChanged // authoritative: a different process answered
        : (seenDown && up) // fallback: real down followed by an up
      if (confirmed) {
        phase = 'recovering'
        emit()
        // Let the ring transition to 100% (1.1s) before reloading.
        setTimeout(() => { if (active()) window.location.reload() }, 1300)
        return
      }
      // Up without confirmation: allow ~20s for a POST to be delivered
      // (it can queue behind the app's streams) before declaring failure.
      upTicks += 1
      if (upTicks >= 20) {
        phase = 'error'
        errorMsg = tl('restartNoEffect')
        emit()
        return
      }
    }
    setTimeout(poll, POLL_MS)
  }
  void poll()
}

export function beginPower(next: PowerAction, opts?: { force?: boolean }): void {
  const myOperation = ++operationId
  const active = (): boolean => myOperation === operationId
  const force = opts?.force === true
  action = next
  errorMsg = null

  const endpoint = next === 'shutdown' ? '/api/dsh-power-button/shutdown' : '/api/dsh-power-button/restart'

  if (next === 'restart') {
    // Stage 1: corner hint, page stays fully usable.
    phase = 'preparing'
    emit()
    // Stage 2: after a short beat (POST delivered, flush underway) switch to
    // the full-screen lifecycle overlay. Bound: never skip to the overlay if
    // a newer operation superseded this one.
    setTimeout(() => {
      if (!active() || phase !== 'preparing') return
      phase = 'shutting'
      emit()
    }, 800)
  } else {
    // Shutdown already has its own confirm dialog; go straight to the veil.
    phase = 'shutting'
    emit()
  }

  // Shutdown: fire-and-forget the POST (keepalive survives the page/process
  // lifecycle), then poll health. The process exits and never comes back —
  // once we observe repeated DOWNs, settle on the final "已关机" screen. No
  // reload: the page must not bounce back to a dead server.
  if (next === 'shutdown') {
    void fetch(endpoint, { method: 'POST', keepalive: true })
      .then(async (r) => {
        const j = await r.json().catch(() => ({}))
        if (!active()) return
        if (!r.ok || (j as { ok?: boolean })?.ok === false) {
          fail((j as { error?: string })?.error ?? tl('opFailedHttp').replace('{0}', String(r.status)))
        }
      })
      .catch(() => { /* polls observe the outage */ })
    const SHUTDOWN_POLL_MS = 500
    const SHUTDOWN_TIMEOUT_MS = 40_000
    const MAX_ATTEMPTS = SHUTDOWN_TIMEOUT_MS / SHUTDOWN_POLL_MS
    let attempts = 0
    let downStreak = 0
    const timer = setInterval(async () => {
      if (!active()) { clearInterval(timer); return }
      attempts += 1
      // Timeout: never claim success without observing the process actually
      // go down — that would be a false "已关机".
      if (attempts >= MAX_ATTEMPTS) {
        clearInterval(timer)
        phase = 'error'
        errorMsg = tl('shutdownNoEffect')
        emit()
        return
      }
      let up = false
      try {
        const r = await fetch('/api/dsh-power-button/health', { cache: 'no-store' })
        up = r.ok
      } catch { up = false }
      if (!up) {
        // Require a short streak of DOWNs (a single transient blip must not
        // declare "已关机").
        downStreak += 1
        if (downStreak >= 3) {
          clearInterval(timer)
          phase = 'off'
          emit()
        }
      } else {
        downStreak = 0
      }
    }, SHUTDOWN_POLL_MS)
    return
  }

  // Brief beat on the closing caption, then move to waiting.
  setTimeout(() => {
    if (!active()) return
    if (phase === 'shutting') {
      phase = 'waiting'
      emit()
    }
  }, 600)

  // Restart: capture THIS operation's baseline instanceId FIRST (not the
  // page-load one — the server may have been restarted manually since, which
  // would make the old baseline a false "already changed"), then POST, then
  // poll. Success is authoritative when the instanceId changes from the
  // operation baseline (old A → new B). A captured baseline makes seenDown
  // alone insufficient (a transient network blip on the still-old instance
  // must not fake success); seenDown is only the fallback when NO baseline
  // could be captured at all.
  void (async () => {
    let baseline: string | null = null
    try {
      const r = await fetch('/api/dsh-power-button/health', { cache: 'no-store' })
      if (r.ok) {
        const j = await r.json().catch(() => ({})) as { instanceId?: string }
        if (typeof j.instanceId === 'string') baseline = j.instanceId
      }
    } catch { /* baseline stays null → seenDown fallback */ }

    if (!active()) return

    // Fire the restart POST now that the baseline is captured, and AWAIT its
    // response. The pre-busy-guard flow fired-and-forgot and started the
    // recovery poll immediately; the busy guard changes that: a
    // `blocked: 'busy'` 409 must cancel THIS flow and ask the user for a
    // forced restart BEFORE any recovery poll starts — a poll after a blocked
    // restart would watch a live server for ~20s and misreport restartNoEffect
    // for a restart that never happened. Only the FORCE call carries a body:
    // the plain call stays a bare keepalive POST, exactly as before.
    let busyBlocked = false
    let busySessions: string[] = []
    try {
      const r = await fetch(endpoint, {
        method: 'POST',
        keepalive: true,
        ...(force
          ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify({ force: true }) }
          : {}),
      })
      const j = await r.json().catch(() => ({})) as { ok?: boolean; blocked?: string; busySessions?: unknown }
      if (!active()) return
      if (j.blocked === 'busy' && !force) {
        // Host busy guard fired: another session is running. Cancel the whole
        // in-page flow (operation bump invalidates every stale timer), then
        // surface the GUI confirm dialog — the ONLY way to bypass the guard.
        busyBlocked = true
        busySessions = Array.isArray(j.busySessions)
          ? j.busySessions.filter((s): s is string => typeof s === 'string')
          : []
      } else if (!r.ok || j.ok === false) {
        // A DEFINITE server-side refusal (latch 409, internal 500, ...): the
        // restart did not happen. Show the server's error and stop here — a
        // recovery poll would watch a LIVE server for ~20s and then overwrite
        // this message with a misleading restartNoEffect. (Only a transport
        // failure below keeps polling: the restart may actually have been
        // delivered even though the response was lost.)
        fail((j as { error?: string })?.error ?? tl('opFailedHttp').replace('{0}', String(r.status)))
        return
      }
    } catch { /* POST transport error — polls observe the outage */ }

    if (!active()) return
    if (busyBlocked) {
      operationId += 1 // invalidate any stale timers from this flow
      phase = 'idle'
      errorMsg = null
      emit()
      requestBusyRestartConfirm(busySessions)
      return
    }

    // Recovery poll (waiting -> recovering -> reload) is shared with the
    // external-restart watcher: same health probe, same confirmation rule.
    // Started only AFTER the POST response was processed, so a busy-blocked
    // restart never reaches it.
    pollRestartRecovery(baseline, active)
  })()
}

/** Dismiss the error overlay without reloading: cancels any in-flight flow
 * and returns to idle. The restart may have killed the old process without
 * a new one up — reloading here would bounce to a dead page, so just close
 * the dialog and let the user act (refresh manually if they wish). */
export function dismissPower(): void {
  operationId += 1 // invalidate any stale timers
  phase = 'idle'
  errorMsg = null
  emit()
}

/** Subscribe to power-flow changes; returns an unsubscribe. */
export function onRestartChange(fn: () => void): () => void {
  listeners.add(fn)
  return () => { listeners.delete(fn) }
}

// ---------------------------------------------------------------------------
// External-restart watcher (model tool / /restart command / other tab)
// ---------------------------------------------------------------------------
// beginPower() only runs for THIS page's power button: a restart triggered by
// the model tool, a /restart command, another tab, or an external POST is
// invisible to the page (the official connection layer auto-reconnects the
// websocket but never reloads the document, so a stale client bundle keeps
// running after a restart that was done precisely to update it). This
// low-frequency watcher gives the page the same recovery the button flow has:
// it probes /health every few seconds, and on evidence of an external
// restart it drives the SAME waiting -> recovering -> reload overlay.

/** Watch poll interval. A local loopback GET every 3.5s is negligible, and
 * bounds the reaction latency to a model-triggered restart. */
const WATCH_POLL_MS = 3500

/**
 * Watch for restarts triggered outside this page. Returns the interval
 * handle (callers clear it on plugin teardown / hot reload).
 *
 * Decision rules, deliberately conservative (a false reload is far worse
 * than a late one):
 *  - `/health` unreachable: no decision - transient blip or mid-restart
 *    window; the next successful probe decides.
 *  - `lifecycle === 'restart'` (the old process is draining; its in-memory
 *    powerTransition latch reports this): enter the waiting overlay once and
 *    hand over to the shared recovery poll.
 *  - instanceId differs from the established baseline: the new process is
 *    already answering - go straight to recovering + reload. The baseline is
 *    (re)established lazily on every probe until first seen, so a fresh page
 *    load adopts whatever process answers without ever reloading for it.
 * No action while any in-page power flow is active (phase !== 'idle').
 */
function watchExternalRestarts(): ReturnType<typeof setInterval> {
  let baseline: string | null = null
  let engaged = false
  const probe = async (): Promise<void> => {
    let j: { instanceId?: string, lifecycle?: string, pendingConfirm?: { token?: unknown, busySessions?: unknown, source?: unknown, expiresAt?: unknown } } | null = null
    try {
      const r = await fetch('/api/dsh-power-button/health', { cache: 'no-store' })
      if (r.ok) j = await r.json().catch(() => null)
    } catch { j = null }
    if (j === null) return // unreachable: no decision (see rules above)
    // Establish/refresh the baseline FIRST, before the pending branch: a tab
    // whose every probe arrives during a pending confirm must still catch the
    // post-restart instanceId change (the reload fallback once the decision
    // resolved elsewhere). First sighting is the baseline, never a change.
    if (baseline === null && typeof j.instanceId === 'string') {
      baseline = j.instanceId
    }
    if (typeof j.instanceId !== 'string') return
    // Pending-confirm surface channel: the host recorded a SUSPENDED
    // model-triggered restart (another session is running; the tool/command is
    // waiting). Pop the SAME busy confirm dialog, but in 'model' mode — the
    // restart will be executed by the HOST once confirmed/cancelled, so no
    // in-page recovery flow starts here. Ignores any active in-page flow
    // (phase idle check mirrors the reload branches below).
    const pc = j.pendingConfirm
    if (pc && typeof pc.token === 'string') {
      // Never re-open a pending the user just cancelled: the POST that resolves
      // it may still be in flight, so /health can report it for another tick.
      if (pc.token !== cancelledModelToken && !isBusyRestartConfirmVisible() && phase === 'idle') {
        requestModelRestartConfirm({
          token: pc.token,
          busySessions: Array.isArray(pc.busySessions)
            ? pc.busySessions.filter((s): s is string => typeof s === 'string')
            : [],
        })
      }
      // While a pending confirm exists, the restart canonical decision is the
      // confirm/cancel choice; the reload branches below must NOT also fire
      // (a stale instance change must not double-act). Return after the
      // pending-confirm branch so non-pending probes behave exactly as before.
      return
    }
    // No pending request: a suppressed cancel token (if any) is now fully
    // settled on the host, so forget it.
    cancelledModelToken = null
    // The pendingConfirm disappeared (another tab confirmed/cancelled, or the
    // host timed it out): close a MODEL-mode dialog we opened. Pure close —
    // the token is stale on the host, so no /cancel-pending POST (the real
    // decision already happened elsewhere).
    if (isBusyRestartConfirmVisible() && getBusyRestartSource() === 'model') {
      dismissBusyRestartConfirm()
    }
    // (a) an external restart completed: a DIFFERENT process answered.
    if (j.instanceId !== baseline) {
      baseline = j.instanceId // adopt the new instance
      if (phase !== 'idle') return // an in-page flow already owns the UI
      action = 'restart'
      errorMsg = null
      const myOperation = ++operationId
      phase = 'recovering'
      emit()
      setTimeout(() => { if (myOperation === operationId) window.location.reload() }, 1300)
      return
    }
    // (b) an external restart is in progress (old process draining).
    if (j.lifecycle === 'restart' && phase === 'idle' && !engaged) {
      engaged = true // one overlay per page lifetime: no re-engage nagging
      action = 'restart'
      errorMsg = null
      const myOperation = ++operationId
      phase = 'waiting'
      emit()
      pollRestartRecovery(baseline, () => myOperation === operationId)
    }
  }
  return setInterval(() => { void probe() }, WATCH_POLL_MS)
}

// ---------------------------------------------------------------------------
// /shutdown command → GUI confirm dialog
// ---------------------------------------------------------------------------
// The host `/shutdown` handler never shuts down directly: it signals
// `SHUTDOWN_CONFIRM_PENDING` (a command/executed error text), and this client
// shows the SAME confirm dialog as the power button. Confirm → beginPower
// ('shutdown') POSTs the real shutdown; cancel just dismisses.
const confirmListeners = new Set<() => void>()
let confirmVisible = false

function emitConfirm(): void {
  for (const fn of confirmListeners) fn()
}

/** Show the shutdown confirm dialog (from the /shutdown command path). */
export function requestShutdownConfirm(): void {
  confirmVisible = true
  emitConfirm()
}

/** Dismiss the dialog without acting. */
export function cancelShutdownConfirm(): void {
  confirmVisible = false
  emitConfirm()
}

/** Whether the /shutdown confirm dialog is currently shown. */
export function isShutdownConfirmVisible(): boolean {
  return confirmVisible
}

/** Subscribe to dialog visibility changes. */
export function onShutdownConfirmChange(fn: () => void): () => void {
  confirmListeners.add(fn)
  return () => { confirmListeners.delete(fn) }
}

/** Sentinel the host `/shutdown` handler returns to request the GUI dialog. */
const SHUTDOWN_CONFIRM_PENDING = 'SHUTDOWN_CONFIRM_PENDING'

// ---------------------------------------------------------------------------
// Busy-restart confirm dialog (restart while other sessions are running)
// ---------------------------------------------------------------------------
// The host busy guard (config.busyGuard) refuses a restart with
// `blocked: 'busy'` while another session is running. This page then cancels
// its in-page flow and pops THIS dialog: the user explicitly confirms a
// FORCED restart (beginPower('restart', { force: true })) or cancels. Only the
// GUI can pass force — the model tool and /restart command never can. Same
// store shape as the shutdown-confirm dialog above.
//
// The SAME dialog also serves MODEL-triggered restarts: the host does not
// refuse those directly anymore — it records a pending confirmation and
// suspends the tool/command execution until the user decides. The external-
// restart watcher (watchExternalRestarts) observes the pending state on
// /health (pendingConfirm field) and opens this dialog with the token; confirm
// POSTs /confirm-pending, cancel POSTs /cancel-pending (best-effort), and the
// host resolves the suspended wait accordingly. The restart itself still runs
// on the host side (the suspended execution point), so `confirm` here never
// calls beginPower for the model path.
const busyConfirmListeners = new Set<() => void>()
let busyConfirmVisible = false
let busySessionIds: string[] = []
/** Who opened the busy dialog: 'gui' (this page's power button hit the guard)
 * or 'model' (the host suspended a model tool / /restart command, surfaced via
 * /health pendingConfirm). Drives confirm/cancel behavior AND the dialog
 * title/body. */
let busyConfirmSource: 'gui' | 'model' = 'gui'
/** Present only for source === 'model': the host pending token echoed back on
 * confirm/cancel so the host can resolve the right suspended wait. */
let busyConfirmToken: string | null = null
/** Token the user explicitly CANCELLED: suppress re-opening that same pending
 * while the cancel POST is in flight (the /health probe may still report it for
 * one more tick). Cleared as soon as /health stops reporting a pending. */
let cancelledModelToken: string | null = null

function emitBusyConfirm(): void {
  for (const fn of busyConfirmListeners) fn()
}

/** Show the busy-restart confirm dialog with the offending session ids.
 * GUI semantics: opened by THIS page after its own POST got a blocked:'busy'
 * 409; confirm re-runs the force flow (beginPower force). */
export function requestBusyRestartConfirm(sessions: string[]): void {
  busySessionIds = sessions
  busyConfirmSource = 'gui'
  busyConfirmToken = null
  busyConfirmVisible = true
  emitBusyConfirm()
}

/** Open the busy dialog for a MODEL-triggered suspended restart (surfaced via
 * /health pendingConfirm by watchExternalRestarts). The dialog is identical;
 * only confirm/cancel act differently (POST to the host's pending-resolution
 * endpoints instead of beginPower force—the host executes the restart). */
export function requestModelRestartConfirm(info: { token: string; busySessions: string[] }): void {
  busySessionIds = info.busySessions
  busyConfirmSource = 'model'
  busyConfirmToken = info.token
  busyConfirmVisible = true
  emitBusyConfirm()
}

/** Hide the dialog without talking to the host. Used when the pending request
 * already resolved elsewhere (the /health watcher saw it disappear, or this tab
 * just confirmed it): the token is stale on the host, so POSTing would only 404. */
function dismissBusyRestartConfirm(): void {
  busyConfirmVisible = false
  busyConfirmSource = 'gui'
  busyConfirmToken = null
  emitBusyConfirm()
}

/** User cancelled the dialog (button / Esc / veil click).
 * - GUI path: pure close — the restart never started.
 * - Model path: actively resolve the host's pending request as 'cancelled'
 *   (best-effort POST), so the suspended tool/command stops immediately and the
 *   model receives the "restart declined" result instead of waiting for the
 *   timeout and then reporting a timeout. The token is suppressed so the
 *   /health watcher cannot re-open the same dialog while the POST is in flight. */
export function cancelBusyRestartConfirm(): void {
  const token = busyConfirmToken
  const source = busyConfirmSource
  dismissBusyRestartConfirm()
  if (source === 'model' && token !== null) {
    cancelledModelToken = token
    cancelPendingRestart(token)
  }
}

/** Best-effort POST to /cancel-pending for a MODEL-triggered pending restart.
 * Fire-and-forget: the host resolves the user's decision and the suspended
 * tool/command gets the 'cancelled' outcome; a network failure is swallowed
 * (the host timeout will release the wait anyway). */
function cancelPendingRestart(token: string): void {
  void fetch('/api/dsh-power-button/cancel-pending', {
    method: 'POST',
    keepalive: true,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token }),
  }).catch(() => { /* best-effort: host timeout releases the wait */ })
}

/** Whether the busy-restart confirm dialog is currently shown. */
export function isBusyRestartConfirmVisible(): boolean {
  return busyConfirmVisible
}

/** The session ids the busy dialog was opened with. */
export function getBusyRestartSessions(): string[] {
  return busySessionIds
}

/** The source that opened the busy dialog ('gui' | 'model'). */
export function getBusyRestartSource(): 'gui' | 'model' {
  return busyConfirmSource
}

/** Subscribe to busy-dialog visibility changes. */
export function onBusyRestartChange(fn: () => void): () => void {
  busyConfirmListeners.add(fn)
  return () => { busyConfirmListeners.delete(fn) }
}

/** User confirmed the restart in the busy dialog.
 * - GUI path: re-enter the full restart flow with force — the POST carries
 *   `{ force: true }`, the ONLY way past the host busy guard.
 * - Model path: tell the host the user confirmed; the host's suspended
 *   tool/command execution then runs the actual restart (at its single
 *   execution point — the at-most-once latch and delayMs stay host-side).
 *   No beginPower here: the restart happens on the host and the existing
 *   external-restart watcher recovers the page (instanceId change → reload). */
export function confirmBusyRestart(): void {
  const token = busyConfirmToken
  const source = busyConfirmSource
  dismissBusyRestartConfirm()
  if (source === 'model' && token !== null) {
    void fetch('/api/dsh-power-button/confirm-pending', {
      method: 'POST',
      keepalive: true,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token }),
    })
      .then(async (r) => {
        const j = await r.json().catch(() => ({})) as { ok?: boolean }
        // Restart proceeds host-side; nothing more to do on success. A 404
        // means the pending expired / another tab settled it — the host's
        // suspended wait already resolved, so silently close.
        if (r.ok && j.ok === true) return
      })
      .catch(() => { /* best-effort */ })
    return
  }
  // GUI path (no model token): force-restart from this page.
  beginPower('restart', { force: true })
}

export function apply(ctx: ClientContext): void {
  // Register UI strings so the button/overlay follow the DSH interface language.
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-power-button: dictionaries')

  // Background watcher: reload the page after a restart triggered OUTSIDE it
  // (model tool / /restart command / another tab / external POST). Effect-
  // scoped so a plugin hot reload or teardown clears the interval.
  ctx.effect(() => {
    const timer = watchExternalRestarts()
    return () => clearInterval(timer)
  }, 'dsh-power-button: external restart watcher')

  // Capture the locale service for module-scope (non-component) error strings.
  localeSvc = ctx.locale

  // Self-contained layout fix: this plugin's footer button is full-width
  // (width: calc(100% + 8px)), so it needs the sidebar's footer-actions
  // container to wrap — one full-width occupant per row. The stock DSH css
  // uses `display: flex` without `flex-wrap`, which squeezes a second
  // full-width button (e.g. the suite-panel button) beside the first. Inject
  // the wrap here so the plugin works on unmodified official DSH builds too.
  // Scope the host-container workaround to the footerActions instance that
  // contains this plugin. Sibling actions in that SAME container will also
  // participate in wrapping; other footer containers are untouched. An id
  // prevents duplicate <style> on hot reload.
  const STYLE_ID = 'dsh-power-button-style'
  let styleEl = document.getElementById(STYLE_ID) as HTMLStyleElement | null
  if (styleEl === null) {
    styleEl = document.createElement('style')
    styleEl.id = STYLE_ID
    styleEl.textContent = '[class$="_footerActions"]:has(.dsh-power-button) { flex-wrap: wrap; }'
    document.head.appendChild(styleEl)
  }

  ctx.slots.inject('sidebar.footer.action', () =>
    ctx.slots.register({
      name: 'sidebar.footer.action',
      id: 'dsh-power-button',
      order: -20,
      locale: NS,
      label: () => (localeSvc?.getLocale().active.toLowerCase().startsWith('en') ? en.power : zh.power),
    }, RestartButton))

  // Full-screen restart/shutdown overlay (additive list slot; coexists with others).
  ctx.slots.inject('shell.overlay', () =>
    ctx.slots.register({
      name: 'shell.overlay',
      id: 'dsh-restart-overlay',
      locale: NS,
    }, RestartOverlay))

  // Corner "preparing to restart" hint — shown during the brief pre-veil
  // window so the full-screen overlay does not slam in the moment the user
  // clicks Restart.
  ctx.slots.inject('shell.overlay', () =>
    ctx.slots.register({
      name: 'shell.overlay',
      id: 'dsh-restart-preparing',
      locale: NS,
    }, RestartPreparing))

  // UI-only "已重启" toast: shown once after a restart via /health's
  // `restarted` flag. Lives in the same additive overlay slot; unlike the
  // old session-injected assistant message it never touches a session file.
  ctx.slots.inject('shell.overlay', () =>
    ctx.slots.register({
      name: 'shell.overlay',
      id: 'dsh-restart-notice',
      locale: NS,
    }, RestartNotice))

  // /shutdown confirm dialog: the command UI emits command/executed to the
  // submitting browser after the host returns SHUTDOWN_CONFIRM_PENDING; this
  // listener pops the same dialog as the power button, and only a confirmed
  // click actually shuts down.
  ctx.effect(() => ctx.on('command/executed', (_sessionId, name, result) => {
    if (name !== 'shutdown') return
    const text = typeof (result as { text?: unknown } | undefined)?.text === 'string'
      ? (result as { text: string }).text
      : ''
    if (text === SHUTDOWN_CONFIRM_PENDING) requestShutdownConfirm()
  }), 'dsh-power-button: shutdown command confirm')

  ctx.slots.inject('shell.overlay', () =>
    ctx.slots.register({
      name: 'shell.overlay',
      id: 'dsh-restart-shutdown-confirm',
      locale: NS,
    }, ShutdownConfirmDialog))

  // Busy-restart confirm dialog: appears when the host busy guard refused a
  // restart (blocked: 'busy') because another session is running. Confirm →
  // beginPower('restart', { force: true }) re-runs the whole flow with the
  // force bypass — the only path that can restart while sessions are busy.
  ctx.slots.inject('shell.overlay', () =>
    ctx.slots.register({
      name: 'shell.overlay',
      id: 'dsh-restart-busy-confirm',
      locale: NS,
    }, RestartBusyConfirm))
}
