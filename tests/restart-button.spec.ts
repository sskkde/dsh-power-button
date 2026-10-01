import { existsSync, writeFileSync, utimesSync } from 'node:fs'
import { join } from 'node:path'

// DSH_HOME is set by tests/setup.ts BEFORE this module is imported, so
// RUNTIME_DIR (captured at module load) points at an isolated temp dir.
const testHome = process.env.DSH_HOME as string

import { describe, expect, it } from 'vitest'
import {
  consumeRestartConfirmation, writeMarker, markerPath,
  redactCommandLine, clampModelDelayMs, pruneOldRestartLogs,
  renderRestartNoticeText, deliverRestartNotice,
  runningSessionIds, renderBusyBlockedText, readJsonBody, wantsForce,
  createPendingConfirm, resolvePendingConfirm, peekPendingConfirm,
  waitPendingConfirm, renderPendingTimeoutText, renderPendingCancelledText,
  type PendingConfirm,
} from '../src/index.ts'

describe('restart marker lifecycle', () => {
  it('consumeRestartConfirmation returns the old instance for a helper-confirmed relaunch', () => {
    // A REAL helper relaunch writes relaunchedAt + newPid === the new process.
    writeMarker({
      fromInstanceId: 'instance-A',
      requestedAt: new Date().toISOString(),
      newPid: process.pid,
      relaunchedAt: new Date().toISOString(),
    })
    expect(existsSync(markerPath())).toBe(true)
    const result = consumeRestartConfirmation()
    // requestedAt now passes through too (the notice reports the restart
    // timeline), so match on the identity-bearing fields instead of the
    // exact object.
    expect(result?.fromInstanceId).toBe('instance-A')
    expect(result?.originSessionId).toBeUndefined()
    // Consumed: the file is gone, so a LATER ordinary boot cannot misreport.
    expect(existsSync(markerPath())).toBe(false)
  })

  it('passes the origin session through the marker for the restart notice', () => {
    // restartDsh records which session asked for the restart; the helper
    // rewrites the marker on relaunch success preserving those fields; the
    // new process must read them back to deliver the notice.
    writeMarker({
      fromInstanceId: 'instance-A',
      requestedAt: '2026-01-01T00:00:00.000Z',
      originSessionId: 'session-42',
      originSource: 'tool',
      newPid: process.pid,
      relaunchedAt: new Date().toISOString(),
    })
    const result = consumeRestartConfirmation()
    expect(result).toEqual({
      fromInstanceId: 'instance-A',
      originSessionId: 'session-42',
      originSource: 'tool',
      requestedAt: '2026-01-01T00:00:00.000Z',
    })
    expect(existsSync(markerPath())).toBe(false)
  })

  it('accepts a FRESH supervisor intent marker (systemd relaunched us)', () => {
    // Supervisor-managed restart (INVOCATION_ID env): no helper runs, so the
    // marker never gains relaunchedAt/newPid. The new process claims the
    // restart from the fresh intent marker within the acceptance window.
    writeMarker({
      fromInstanceId: 'instance-A',
      requestedAt: new Date().toISOString(),
      originSessionId: 'session-42',
      originSource: 'command',
      supervisor: true,
    })
    const result = consumeRestartConfirmation()
    expect(result?.fromInstanceId).toBe('instance-A')
    expect(result?.originSessionId).toBe('session-42')
    expect(result?.originSource).toBe('command')
    expect(existsSync(markerPath())).toBe(false)
  })

  it('rejects a STALE supervisor intent marker as a manual boot', () => {
    // A supervisor marker older than the acceptance window must not let a
    // much-later MANUAL boot misreport "restarted".
    const stale = new Date(Date.now() - 30 * 60 * 1000).toISOString()
    writeMarker({
      fromInstanceId: 'instance-A',
      requestedAt: stale,
      supervisor: true,
    })
    const result = consumeRestartConfirmation()
    expect(result).toBeNull()
    expect(existsSync(markerPath())).toBe(false)
  })

  it('rejects an intent-only marker (helper died before spawning) as a manual boot', () => {
    // restartDsh writes {fromInstanceId, requestedAt} BEFORE the helper spawns.
    // If the helper dies before confirming a relaunch (no newPid/relaunchedAt),
    // a subsequent MANUAL boot must NOT report "restarted".
    writeMarker({ fromInstanceId: 'instance-A', requestedAt: new Date().toISOString() })
    const result = consumeRestartConfirmation()
    expect(result).toBeNull()
    expect(existsSync(markerPath())).toBe(false)
  })

  it('rejects a marker whose newPid does not match this process', () => {
    // The helper recorded relaunching a DIFFERENT pid (e.g. its first spawn
    // failed and it retried, or the marker is from another instance): only the
    // exact process the helper spawned may claim the restart.
    writeMarker({
      fromInstanceId: 'instance-A',
      requestedAt: new Date().toISOString(),
      newPid: process.pid + 1,
      relaunchedAt: new Date().toISOString(),
    })
    const result = consumeRestartConfirmation()
    expect(result).toBeNull()
    expect(existsSync(markerPath())).toBe(false)
  })

  it('a later ordinary boot with no marker does not report restarted', () => {
    // The previous tests consumed the marker. A fresh process (different
    // instance id) starting with no marker must NOT claim a restart.
    const result = consumeRestartConfirmation()
    expect(result).toBeNull()
    expect(existsSync(markerPath())).toBe(false)
  })
})

describe('clampModelDelayMs', () => {
  it('floors sub-second delays so the tool cannot kill its own turn', () => {
    expect(clampModelDelayMs(1, 5000)).toBe(1000)
    expect(clampModelDelayMs(0, 5000)).toBe(2000)
    expect(clampModelDelayMs(Number.NaN, 5000)).toBe(2000)
  })
  it('clamps to the configured max and keeps valid mid-range values', () => {
    expect(clampModelDelayMs(3000, 5000)).toBe(3000)
    expect(clampModelDelayMs(6000, 5000)).toBe(5000)
    expect(clampModelDelayMs(2000, 5000)).toBe(2000)
  })
  it('stays within [floor, max] for every input', () => {
    // Regression: previously clamp(NaN, 500) returned 2000 (escaped the
    // ceiling) and a config maxDelayMs below the floor would have defeated
    // the 1000ms floor. The clamp now never leaves [1000, maxDelayMs]; the
    // schema separately rejects maxDelayMs < 1000 at config time.
    expect(clampModelDelayMs(1, 200)).toBe(200) // ceiling wins over floor
    expect(clampModelDelayMs(6000, 200)).toBe(200)
    expect(clampModelDelayMs(3000, 5000)).toBe(3000)
    expect(clampModelDelayMs(1, 5000)).toBe(1000) // floor applies within valid range
  })
  it('caps the non-numeric fallback at the configured max', () => {
    // Regression: NaN/0 previously escaped the ceiling and returned 2000 even
    // when maxDelayMs was smaller; now every outcome respects the ceiling.
    expect(clampModelDelayMs(Number.NaN, 500)).toBe(500)
    expect(clampModelDelayMs(0, 500)).toBe(500)
    expect(clampModelDelayMs(Number.NaN, 1000)).toBe(1000)
  })
})

describe('redactCommandLine', () => {
  it('redacts inline key=value secrets', () => {
    const out = redactCommandLine(['dsh', '--api-key=sk-abc12345'])
    expect(out).not.toContain('sk-abc12345')
    expect(out).toContain('***')
  })
  it('redacts a value following a credential key token', () => {
    const out = redactCommandLine(['dsh', '--api-key', 'sk-abc12345'])
    expect(out).not.toContain('sk-abc12345')
  })
  it('keeps ordinary arguments intact', () => {
    const out = redactCommandLine(['node', 'bin.ts', '--profile', 'web', '--port', '3080'])
    expect(out).toBe('node bin.ts --profile web --port 3080')
  })
  it('redacts bare secret-shaped tokens (no key prefix)', () => {
    const out = redactCommandLine(['dsh', 'sk-proj-1234567890abcdef'])
    expect(out).not.toContain('sk-proj-1234567890abcdef')
  })
})

describe('renderRestartNoticeText', () => {
  it('names the trigger source and the new pid in both languages', () => {
    const en = renderRestartNoticeText(true, 'tool')
    expect(en).toContain('restart_harness')
    expect(en).toContain(`pid ${process.pid}`)
    const zh = renderRestartNoticeText(false, 'command')
    expect(zh).toContain('/restart')
    expect(zh).toContain(`pid ${process.pid}`)
  })
})

describe('deliverRestartNotice', () => {
  it('resumes the session with the deployment default model route', async () => {
    // Regression: a route-less resume crashed the notification turn with
    // `prompt variable "{{model}}" has no value for this assembly` — the
    // session persona assembles {{model}} from the agent route, so resume
    // must pass the same default selection the web host uses.
    const resumedArgs: Array<Record<string, unknown>> = []
    const fakeAgents = {
      get: () => undefined,
      resume: async (opts: Record<string, unknown>) => {
        resumedArgs.push(opts)
        return {
          agent: { id: 'x', followup() {}, inject() {}, whenIdle: async () => {} },
          dispose: async () => {},
        }
      },
    }
    const ctx = {
      get: (key: string) => {
        if (key === 'agents') return fakeAgents
        if (key === 'agentDefaultModel') {
          return { currentSelection: () => ({ provider: 'volces', model: 'glm-5.3' }) }
        }
        if (key === 'sessionPersistence') {
          return { inspect: async () => ({ meta: { agentPreset: 'cordis' } }) }
        }
        if (key === 'agentPresets') {
          return { resolve: async () => ({ id: 'cordis' }), mount: async () => {} }
        }
        return undefined
      },
      settings: { get: () => ({ preference: 'en' }) },
    }
    const cfg = { notifySession: true, notifyMode: 'followup', enableModelTool: true, maxDelayMs: 5000, notifyDelayMs: 100 }
    const info = { fromInstanceId: 'A', originSessionId: 'session-1', originSource: 'tool', requestedAt: new Date().toISOString() }
    const ok = await deliverRestartNotice(ctx as never, cfg as never, info as never)
    expect(ok).toBe(true)
    expect(resumedArgs.length).toBe(1)
    expect(resumedArgs[0].agentOptions).toEqual({ provider: 'volces', model: 'glm-5.3' })
  })

  it('does not resume without the preset services (retryable instead)', async () => {
    // Regression: composePresetSetup returning undefined used to resume a
    // composition-less agent whose notification turn had no tools; it must
    // now report retryable so the caller retries later.
    const resumedArgs: Array<Record<string, unknown>> = []
    const fakeAgents = {
      get: () => undefined,
      resume: async (opts: Record<string, unknown>) => {
        resumedArgs.push(opts)
        return { agent: { id: 'x', followup() {}, inject() {}, whenIdle: async () => {} }, dispose: async () => {} }
      },
    }
    const ctx = {
      get: (key: string) => {
        if (key === 'agents') return fakeAgents
        if (key === 'agentDefaultModel') {
          return { currentSelection: () => ({ provider: 'volces', model: 'glm-5.3' }) }
        }
        return undefined // sessionPersistence / agentPresets absent -> retryable
      },
      settings: { get: () => ({ preference: 'en' }) },
    }
    const cfg = { notifySession: true, notifyMode: 'followup', enableModelTool: true, maxDelayMs: 5000, notifyDelayMs: 100 }
    const info = { fromInstanceId: 'A', originSessionId: 'session-1', originSource: 'tool', requestedAt: new Date().toISOString() }
    const ok = await deliverRestartNotice(ctx as never, cfg as never, info as never)
    expect(ok).toBe(false)
    expect(resumedArgs.length).toBe(0)
  })
})

describe('pruneOldRestartLogs', () => {
  it('removes stale restart-helper logs and keeps recent ones', () => {
    const oldLog = join(testHome, 'restart-helper-1111.log')
    const freshLog = join(testHome, 'restart-helper-2222.log')
    writeFileSync(oldLog, 'old', 'utf8')
    writeFileSync(freshLog, 'fresh', 'utf8')
    const past = new Date(Date.now() - 10 * 24 * 3600 * 1000)
    utimesSync(oldLog, past, past)

    pruneOldRestartLogs(7)

    expect(existsSync(oldLog)).toBe(false)
    expect(existsSync(freshLog)).toBe(true)
  })
})

describe('runningSessionIds (busy-guard truth source)', () => {
  it('returns [] when the agents service is absent', () => {
    // ctx without ctx.get('agents'): the guard must treat the harness as not
    // busy rather than throw.
    expect(runningSessionIds({ get: () => undefined })).toEqual([])
    expect(runningSessionIds({})).toEqual([])
  })

  it('only counts agents whose status is literally "running"', () => {
    const agents = {
      list: () => [
        { id: 'a', status: 'running' },
        { id: 'b', status: 'idle' },
        // status is a getter on the live handle; a non-boolean shape must not
        // be coerced into "running".
        { id: 'c', status: 'paused' },
      ],
    }
    expect(runningSessionIds({ get: () => agents })).toEqual(['a'])
  })

  it('excludes the caller\'s own session (exceptId)', () => {
    const agents = {
      list: () => [
        { id: 'me', status: 'running' },
        { id: 'other', status: 'running' },
      ],
    }
    // The model tool / /restart command runs INSIDE 'me' — restarting one's
    // own session is not "another session running".
    expect(runningSessionIds({ get: () => agents }, 'me')).toEqual(['other'])
  })

  it('tolerates malformed agent entries and a throwing service', () => {
    // A live registry may be mid-mutation or expose non-conforming entries;
    // the guard must never throw for any shape.
    const agents = {
      list: () => [
        null,
        { id: '', status: 'running' }, // blank id: not attributable, skip
        { id: 42, status: 'running' }, // non-string id: skip
        { id: 'ok', status: 'running' },
      ] as unknown[],
    }
    expect(runningSessionIds({ get: () => agents })).toEqual(['ok'])
    expect(runningSessionIds({ get: () => { throw new Error('boom') } })).toEqual([])
  })

  it('keeps the service receiver when list() reads this.store', () => {
    // Regression: the REAL AgentRegistry.list() is a method that iterates
    // `this.store` (dsh-agent Service). An earlier implementation did
    // `const list = agents?.list; list()` — losing `this`, throwing inside
    // the try, and returning [] from the catch: the busy guard silently never
    // fired. Arrow-function fakes cannot catch this; the method must be
    // invoked WITH the service as its receiver.
    const agents = {
      store: new Map<string, { id: string; status: string }>([
        ['me', { id: 'me', status: 'running' }],
        ['other', { id: 'other', status: 'running' }],
        ['idle-one', { id: 'idle-one', status: 'idle' }],
      ]),
      list() { return [...this.store.values()] },
    }
    expect(runningSessionIds({ get: () => agents })).toEqual(['me', 'other'])
    expect(runningSessionIds({ get: () => agents }, 'me')).toEqual(['other'])
  })
})

describe('renderBusyBlockedText', () => {
  it('names the running sessions in both languages', () => {
    const en = renderBusyBlockedText(true, ['sess-1', 'sess-2'])
    expect(en).toContain('sess-1')
    expect(en).toContain('sess-2')
    expect(en).toMatch(/running/i)
    const zh = renderBusyBlockedText(false, ['sess-1', 'sess-2'])
    expect(zh).toContain('sess-1')
    expect(zh).toContain('sess-2')
    // Both direct the caller to the GUI confirm path (the only force route).
    expect(en).toMatch(/GUI/i)
    expect(zh).toMatch(/GUI|电源/i)
  })
})

describe('readJsonBody / wantsForce (busy-guard force channel)', () => {
  /** Minimal IncomingMessage-like emitter with settable headers. */
  function fakeReq(headers: Record<string, string>, body: string | null): NodeJS.ReadableStream {
    const { Readable } = require('node:stream') as typeof import('node:stream')
    const r = new Readable({ read() {} }) as NodeJS.ReadableStream & { headers: Record<string, string> }
    ;(r as { headers: Record<string, string> }).headers = headers
    if (body !== null) r.push(body)
    r.push(null)
    return r
  }

  it('returns {} for a bodyless POST (historical bare restart)', async () => {
    expect(await readJsonBody(fakeReq({}, null))).toEqual({})
    expect(await readJsonBody(fakeReq({ 'content-length': '0' }, null))).toEqual({})
  })

  it('parses a small JSON body and preserves only a truthy force flag', async () => {
    const req = fakeReq({ 'content-length': '13' }, JSON.stringify({ force: true }))
    expect(await readJsonBody(req)).toEqual({ force: true })
    expect(wantsForce({ force: true })).toBe(true)
    expect(wantsForce({ force: 'yes' })).toBe(false)
    expect(wantsForce({})).toBe(false)
    expect(wantsForce(JSON.parse('null'))).toBe(false)
  })

  it('never grants force from malformed, oversized, or non-object bodies', async () => {
    // Malformed JSON.
    expect(await readJsonBody(fakeReq({ 'content-length': '3' }, 'nope'))).toEqual({})
    // Over the 16KB cap: a valid JSON object beyond the limit is discarded.
    const big = JSON.stringify({ force: true, pad: 'x'.repeat(20 * 1024) })
    expect(await readJsonBody(fakeReq({ 'content-length': String(big.length) }, big))).toEqual({})
    // JSON arrays / scalars are not candidate objects.
    const arr = fakeReq({ 'content-length': '12' }, JSON.stringify([{ force: true }]))
    expect(await readJsonBody(arr)).toEqual({})
    expect(wantsForce([])).toBe(false)
  })

  it('treats an aborted/erroring stream as unforced', async () => {
    const { Readable } = require('node:stream') as typeof import('node:stream')
    const r = new Readable({ read() {} }) as NodeJS.ReadableStream & { headers: Record<string, string> }
    ;(r as { headers: Record<string, string> }).headers = { 'content-length': '5' }
    r.push('{"for')
    r.destroy(new Error('client hung up'))
    expect(await readJsonBody(r)).toEqual({})
  })
})

const ORIGIN_TOOL = { source: 'tool' as const, sessionId: 'me' }

describe('createPendingConfirm (suspended model restart)', () => {
  it('creates a pending request with token/source/sessions/timeout window', () => {
    const p = createPendingConfirm(ORIGIN_TOOL, ['other-1'], 60_000)
    expect(p).not.toBeNull()
    // token is a fresh uuid; source projects the origin trigger.
    expect(typeof p?.token).toBe('string')
    expect((p as NonNullable<PendingConfirm>).token.length).toBeGreaterThan(20)
    expect(p?.source).toBe('tool')
    expect(p?.busySessions).toEqual(['other-1'])
    expect(p?.origin.sessionId).toBe('me')
    // expiresAt = createdAt + timeoutMs.
    const created = Date.parse((p as NonNullable<PendingConfirm>).createdAt)
    const expires = Date.parse((p as NonNullable<PendingConfirm>).expiresAt)
    expect(expires - created).toBe(60_000)
    expect(peekPendingConfirm()?.token).toBe((p as NonNullable<PendingConfirm>).token)
    // Clean up so later tests start from a clear global slot.
    resolvePendingConfirm((p as NonNullable<PendingConfirm>).token, 'confirmed')
    expect(peekPendingConfirm()).toBeNull()
  })

  it('refuses a SECOND concurrent pending request (returns null)', () => {
    const p1 = createPendingConfirm(ORIGIN_TOOL, ['a'], 60_000)
    expect(p1).not.toBeNull()
    // A concurrent suspension (another tool/command already mid-wait) is the
    // atomicity point: only one caller may own the pending/confirm slot.
    expect(createPendingConfirm({ source: 'command' }, ['b'], 60_000)).toBeNull()
    resolvePendingConfirm((p1 as NonNullable<PendingConfirm>).token, 'cancelled')
    expect(peekPendingConfirm()).toBeNull()
  })
})

describe('resolvePendingConfirm (one-shot settle)', () => {
  it('resolves confirmed and clears the global pending slot', () => {
    const p = createPendingConfirm(ORIGIN_TOOL, ['x'], 60_000) as PendingConfirm
    const resolved = resolvePendingConfirm(p.token, 'confirmed')
    expect(resolved?.token).toBe(p.token)
    // The wait's outcome is observable through peek AFTER settle: the slot is
    // cleared, so peek confirms the invariant.
    expect(peekPendingConfirm()).toBeNull()
  })

  it('resolves cancelled and returns the resolved request', () => {
    const p = createPendingConfirm(ORIGIN_TOOL, ['x'], 60_000) as PendingConfirm
    const before = peekPendingConfirm()
    expect(before?.token).toBe(p.token)
    const resolved = resolvePendingConfirm(p.token, 'cancelled')
    expect(resolved?.token).toBe(p.token)
    expect(peekPendingConfirm()).toBeNull()
  })

  it('resolves timeout via the timer (short real timeout)', async () => {
    // Real 20ms timeout + await: no fake timers to entangle with the async
    // wait resolution. After the window the auto-resolve fires 'timeout' and
    // the pending slot is cleared.
    const p = createPendingConfirm(ORIGIN_TOOL, ['slow'], 20) as PendingConfirm
    const outcome = await waitPendingConfirm(p.token)
    expect(outcome).toBe('timeout')
    expect(peekPendingConfirm()).toBeNull()
  })

  it('returns null for an unknown / wrong token', () => {
    const p = createPendingConfirm(ORIGIN_TOOL, ['x'], 60_000) as PendingConfirm
    expect(resolvePendingConfirm('no-such-token', 'confirmed')).toBeNull()
    expect(resolvePendingConfirm('', 'confirmed')).toBeNull()
    expect(peekPendingConfirm()?.token).toBe(p.token)
    resolvePendingConfirm(p.token, 'cancelled')
  })

  it('rejects a SECOND resolve after settle (confirm/timeout race guard)', () => {
    const p = createPendingConfirm(ORIGIN_TOOL, ['x'], 60_000) as PendingConfirm
    expect(resolvePendingConfirm(p.token, 'confirmed')?.token).toBe(p.token)
    // A racing second outcome (e.g. the timeout timer firing after the confirm
    // won) must be a no-op: settled blocks the double-fire.
    expect(resolvePendingConfirm(p.token, 'timeout')).toBeNull()
    expect(peekPendingConfirm()).toBeNull()
  })
})

describe('waitPendingConfirm ↔ resolvePendingConfirm linkage', () => {
  it('confirm: the awaited promise resolves to "confirmed"', async () => {
    const p = createPendingConfirm(ORIGIN_TOOL, ['busy'], 60_000) as PendingConfirm
    const waiter = waitPendingConfirm(p.token)
    // The waiter is still pending (suspended).
    const settled = await Promise.race([waiter.then(() => true), Promise.resolve(false)])
    expect(settled).toBe(false)
    resolvePendingConfirm(p.token, 'confirmed')
    expect(await waiter).toBe('confirmed')
    expect(peekPendingConfirm()).toBeNull()
  })

  it('cancel: the awaited promise resolves to "cancelled"', async () => {
    const p = createPendingConfirm(ORIGIN_TOOL, ['busy'], 60_000) as PendingConfirm
    const waiter = waitPendingConfirm(p.token)
    resolvePendingConfirm(p.token, 'cancelled')
    expect(await waiter).toBe('cancelled')
    expect(peekPendingConfirm()).toBeNull()
  })

  it('a wait for an already-settled token does not hang (settled cancelled)', async () => {
    // After settle the pending slot is cleared, so waitPendingConfirm cannot
    // bind to the (now-stale) token — it must return a settled result instead
    // of hanging forever.
    const p = createPendingConfirm(ORIGIN_TOOL, ['busy'], 60_000) as PendingConfirm
    resolvePendingConfirm(p.token, 'confirmed')
    const outcome = await waitPendingConfirm(p.token)
    expect(['cancelled', 'timeout', 'confirmed']).toContain(outcome)
  })
})

describe('renderPending*Text', () => {
  it('renderPendingTimeoutText names the sessions in both languages', () => {
    const en = renderPendingTimeoutText(true, ['s1', 's2'])
    expect(en).toContain('s1')
    expect(en).toContain('s2')
    expect(en).toMatch(/timed out/i)
    const zh = renderPendingTimeoutText(false, ['s1', 's2'])
    expect(zh).toContain('s1')
    expect(zh).toContain('s2')
    expect(zh).toMatch(/超时/)
  })
  it('renderPendingCancelledText names the sessions in both languages', () => {
    const en = renderPendingCancelledText(true, ['s1'])
    expect(en).toContain('s1')
    expect(en).toMatch(/cancel/i)
    const zh = renderPendingCancelledText(false, ['s1'])
    expect(zh).toContain('s1')
    expect(zh).toMatch(/取消/)
  })
})
