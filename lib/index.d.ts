import z from "@deepseek-ai/schemastery";
//#region src/index.d.ts
/**
 * Producer-declared message source kind (session format v4).
 * In v4 the generic `kind: 'plugin'` is rejected by the session-format
 * admission check; every producer declares its own kind, conventionally
 * `plugin:<name>` for third-party plugins (same shape the v3→v4 migration
 * synthesizes for unknown plugin names).
 */
declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'plugin:dsh-power-button': {
      kind: 'plugin:dsh-power-button';
      plugin: string;
    };
  }
}
declare const name = "dsh-power-button";
declare const inject: string[];
/** Plugin configuration (editable via the profile's cordis config / settings). */
interface Config {
  /** Register the `restart_harness` model tool. On by default: the owner uses
   * this plugin with the agent, and the restart is a graceful `ctx.appExit`
   * (tree dispose), not a hard kill. Set false to disable the model tool and
   * keep restart exclusively on the GUI power button. */
  enableModelTool: boolean;
  /** Upper bound (ms) for the model tool's delayMs argument. */
  maxDelayMs: number;
  /** After a restart that was triggered from inside a session (model tool or
   * /restart command), notify that session on the new process. */
  notifySession: boolean;
  /** How the restart-complete notice reaches the session:
   * - 'followup': queue a follow-up turn and wake the driver - the model sees
   *   the notice immediately and can continue its interrupted work (costs one
   *   model round).
   * - 'inject': queue model-facing context WITHOUT waking the driver - the
   *   notice is durable in the session inbox and is seen on the next wake
   *   (zero model cost). */
  notifyMode: 'followup' | 'inject';
  /** Delay (ms) after boot before the restart-complete notice is delivered -
   * gives the freshly-relaunched process time to finish loading services. */
  notifyDelayMs: number;
  /** Busy guard: before a restart, check whether any OTHER session is running
   * (agent status === 'running'). If so, the restart is blocked on the HTTP
   * and tool/command paths until the user explicitly confirms it (force) — a
   * restart would cut a running task's turn mid-flight, so at-restart (=after
   * boot) behavior never depends on this flag: it gates the RESTART trigger. */
  busyGuard: boolean;
  /** How long (ms) a MODEL-triggered restart waits for the user to confirm it
   * in the GUI before the pending request times out. The busy guard turns the
   * model tool / /restart command into a SUSPENDED wait ("pending restart"),
   * surfaced to the GUI as a confirm dialog via /health; if the user neither
   * confirms nor cancels within this window, the wait resolves to 'timeout'
   * and the tool/command returns a timeout result. Floor of 30s so a misconfig
   * cannot silently make model restarts hang for only a few seconds. */
  busyConfirmTimeoutMs: number;
}
/** Schemastery schema; cordis validates and provides it as apply(ctx, config). */
declare const Config: z<Config>;
/** Per-port marker path. Exported for tests (isolated via DSH_HOME). */
declare function markerPath(): string;
/** Set at apply time when this process is the freshly-restarted instance:
 * health reports `restarted: true, fromInstanceId: <old>` so a /restart
 * command, the model tool, or a UI click can be confirmed after the fact.
 * `originSessionId`/`originSource` (when the restart was triggered from
 * inside a session) drive the restart-complete notice. */
interface RestartConfirmation {
  fromInstanceId: string;
  originSessionId?: string;
  originSource?: string;
  requestedAt?: string;
}
/** Where a restart request came from, captured at the trigger site so the
 * new process can notify the originating session. */
interface RestartOrigin {
  /** The session that asked for the restart (the agent driving the model
   * tool or /restart command), when triggered from inside a session. */
  sessionId?: string;
  /** Trigger site: 'tool' (restart_harness), 'command' (/restart),
   * 'http' (power button / external POST). */
  source: 'tool' | 'command' | 'http';
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
declare function runningSessionIds(ctx: any, exceptId?: string): string[];
/** Render the bilingual blocked-by-busy notice (mirrors renderRestartNoticeText).
 * Tells the model / command caller which sessions are running and that the
 * restart would interrupt their in-flight task, and how to proceed: either
 * wait for them to finish and retry, or force the restart from the GUI power
 * button — the trust model is: the model tool and commands can NEVER pass
 * force; any trusted loopback HTTP caller (normally the GUI) can. */
declare function renderBusyBlockedText(en: boolean, ids: string[]): string;
/** The outcome of a pending (suspended) restart request, resolved by the GUI
 * (or by the timeout timer). */
type PendingOutcome = 'confirmed' | 'cancelled' | 'timeout';
/** Render the bilingual result the MODEL sees after its suspended restart wait
 * resolves to a timeout (the user never confirmed/cancelled within the window).
 * Mirrors renderBusyBlockedText's voice; distinct so the model can tell a plain
 * busy-block apart from a confirmation that lapsed. */
declare function renderPendingTimeoutText(en: boolean, ids: string[]): string;
/** Render the bilingual result the model sees when the user explicitly CANCELS
 * the pending restart in the GUI. */
declare function renderPendingCancelledText(en: boolean, ids: string[]): string;
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
interface PendingConfirm {
  /** Opaque one-time token; the GUI echoes it back to confirm/cancel. */
  token: string;
  /** Which trigger created the pending request ('tool' | 'command'). */
  origin: RestartOrigin;
  /** The sessions that were busy when the pending request was created. */
  busySessions: string[];
  /** Whether the trigger was a model tool or a /restart command. */
  source: 'tool' | 'command';
  /** Creation timestamp (ISO). */
  createdAt: string;
  /** Absolute ISO time at which the wait self-resolves to 'timeout'. */
  expiresAt: string;
  /** The suspended wait promise + resolver (bound at create, fired once by a
   * successful resolve). `waitPendingConfirm` awaits this promise. */
  resolve?: {
    promise: Promise<PendingOutcome>;
    resolve: (o: PendingOutcome) => void;
  };
  /** One-shot settle marker: prevents confirm/cancel/timeout racing double-fire. */
  settled?: boolean;
}
/** Create a PendingConfirm for a busy-bound model restart. Refuses (returns
 * null) if one is already pending — a second concurrent suspension must not
 * exist (each caller would otherwise race for the single restart latch).
 * The timeout timer is stored (module-level, unref'd) so a resolve can clear it
 * instead of leaving a stray ticker. */
declare function createPendingConfirm(origin: RestartOrigin, busySessions: string[], timeoutMs: number): PendingConfirm | null;
/** Peek at the current pending confirmation, if any. /health uses this to
 * surface the pending state to the GUI watcher. */
declare function peekPendingConfirm(): PendingConfirm | null;
/** Resolve (settle) the pending confirmation, exactly once. Returns the
 * resolved PendingConfirm, or null when the token does not match an active
 * pending request (already settled, or never created). `settled` guards the
 * confirm/cancel and timeout paths racing: only the FIRST settle wins; every
 * later resolve returns null and leaves the global slot untouched. */
declare function resolvePendingConfirm(token: string, outcome: PendingOutcome): PendingConfirm | null;
/** Wait (suspend) for the pending confirmation to be resolved. The tool /
 * command execution calls this right after createPendingConfirm and does not
 * return until the user confirms/cancels or the timeout fires. Resolves once:
 * subsequent calls (and the resolve happen-before) resolve to the SAME outcome,
 * but only if the token is still the active pending request. */
declare function waitPendingConfirm(token: string): Promise<PendingOutcome>;
/** Record restart intent. Exported for tests (isolated via DSH_HOME). */
declare function writeMarker(data: Record<string, unknown>): void;
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
declare function supervisorManaged(): boolean;
/** Whether THIS process is the freshly-restarted instance. Exported for tests. */
declare function consumeRestartConfirmation(): RestartConfirmation | null;
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
declare function readJsonBody(req: any): object;
/** Whether a candidate object carries a truthy `force` flag (busy-guard bypass).
 * Exported for tests (module-level symbol, never part of the public API). */
declare function wantsForce(body: object): boolean;
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
declare function redactCommandLine(parts: readonly string[]): string;
/** Floor/clamp the model-visible restart delay: the model must never be able
 * to kill the process before its own tool/result and turn boundary settle.
 * The floor applies whenever a numeric positive delay is given; the ceiling
 * (config.maxDelayMs, schema-validated >= 1000) caps every outcome INCLUDING
 * the non-numeric fallback, so clamp(anything, maxDelayMs) ∈ [1000, maxDelayMs]. */
declare function clampModelDelayMs(raw: number, maxDelayMs: number): number;
/** Startup housekeeping: prune old restart-helper logs and helper scripts so
 * ~/.dsh does not accumulate one file per restart forever. Only files older
 * than the cutoff are removed, so a JUST-spawned helper (current restart in
 * flight) is never touched. Best-effort, never throws. */
declare function pruneOldRestartLogs(maxAgeDays?: number): void;
/** Render the notice text the session's model will see. */
declare function renderRestartNoticeText(en: boolean, originSource?: string): string;
/**
 * Deliver the restart-complete notice to the session that requested the
 * restart. Reuses the live agent when the web client already reconnected and
 * resumed the session; otherwise resumes it from persistence (with its
 * original agent preset mounted), delivers the notice, and disposes the
 * handle after the notification turn settles. Returns false (retryable) when
 * the agent services are not loaded yet; throws on permanent failures
 * (unknown session, corrupt persistence).
 */
declare function deliverRestartNotice(ctx: any, cfg: Config, info: RestartConfirmation): Promise<boolean>;
declare function apply(ctx: any, config: Config): void;
//#endregion
export { Config, PendingConfirm, PendingOutcome, RestartOrigin, apply, clampModelDelayMs, consumeRestartConfirmation, createPendingConfirm, deliverRestartNotice, inject, markerPath, name, peekPendingConfirm, pruneOldRestartLogs, readJsonBody, redactCommandLine, renderBusyBlockedText, renderPendingCancelledText, renderPendingTimeoutText, renderRestartNoticeText, resolvePendingConfirm, runningSessionIds, supervisorManaged, waitPendingConfirm, wantsForce, writeMarker };