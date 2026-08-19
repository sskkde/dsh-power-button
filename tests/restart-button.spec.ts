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
