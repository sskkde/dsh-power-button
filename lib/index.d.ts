import z from "@deepseek-ai/schemastery";
//#region src/index.d.ts
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
declare function apply(ctx: any, config: Config): void;
//#endregion
export { Config, RestartOrigin, apply, clampModelDelayMs, consumeRestartConfirmation, inject, markerPath, name, pruneOldRestartLogs, redactCommandLine, renderRestartNoticeText, supervisorManaged, writeMarker };