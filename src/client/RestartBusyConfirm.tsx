/**
 * Busy-restart confirm dialog — "restart while other sessions are running".
 *
 * The host busy guard (config.busyGuard) refuses a restart with
 * `blocked: 'busy'` while any OTHER session is running (agent status ===
 * 'running'). beginPower() then cancels its in-page flow and pops THIS dialog:
 * the body lists the running sessions, and the user must explicitly confirm a
 * FORCED restart (`beginPower('restart', { force: true })` — the only path
 * that bypasses the guard) or cancel.
 *
 * Interaction and styling replicate the ShutdownConfirm dialog exactly:
 * self-contained focus trap (Tab cycles the two buttons only), Esc cancels,
 * veil click cancels, default focus on CANCEL (a destructive action must
 * require a deliberate choice), danger-tinted primary action. The only
 * difference is the body: it renders the busy session ids as a list
 * (truncated to MAX_LINES rows + an "还有 N 个" tail row) instead of a static
 * sentence. ShutdownConfirm itself is left untouched — shutdown flows keep
 * their single-paragraph body.
 */
import { useEffect, useRef, useSyncExternalStore } from 'react'
import {
  cancelBusyRestartConfirm, confirmBusyRestart, getBusyRestartSessions,
  getBusyRestartSource, isBusyRestartConfirmVisible, onBusyRestartChange, tl,
} from './index.ts'

/** How many session ids are listed before the "+N more" tail row. */
const MAX_LINES = 6

/** Dialog rendered in shell.overlay while a restart is busy-blocked. */
export function RestartBusyConfirm(): JSX.Element | null {
  const visible = useSyncExternalStore(onBusyRestartChange, isBusyRestartConfirmVisible)
  const sessions = useSyncExternalStore(onBusyRestartChange, getBusyRestartSessions)
  const source = useSyncExternalStore(onBusyRestartChange, getBusyRestartSource)
  if (!visible) return null

  const shown = sessions.slice(0, MAX_LINES)
  const rest = sessions.length - shown.length
  return (
    <BusyDialog
      shown={shown}
      rest={rest}
      // The dialog body/title follow the trigger source: a GUI-clicked busy
      // restart asks to force-restart; a MODEL-triggered suspended restart
      // (surfaced via /health pendingConfirm) asks to ALLOW the model's
      // restart — same session list, same buttons, same risk framing.
      model={source === 'model'}
      onConfirm={confirmBusyRestart}
      onCancel={cancelBusyRestartConfirm}
    />
  )
}

/** The dialog itself — same self-contained modal as ShutdownConfirm, with a
 * session-list body. Kept local so the shared confirm stays untouched. */
function BusyDialog({ shown, rest, model, onConfirm, onCancel }: {
  shown: string[]
  rest: number
  model: boolean
  onConfirm: () => void
  onCancel: () => void
}): JSX.Element {
  const cancelRef = useRef<HTMLButtonElement | null>(null)
  const confirmRef = useRef<HTMLButtonElement | null>(null)
  const title = tl(model ? 'busyConfirmModelTitle' : 'busyConfirmTitle')
  const onKey = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') {
      onCancel()
      return
    }
    // Modal focus trap: Tab/Shift+Tab cycle ONLY between the two dialog
    // buttons, so focus can never escape behind the modal.
    if (e.key !== 'Tab') return
    const focusables = [cancelRef.current, confirmRef.current].filter((el): el is HTMLButtonElement => el !== null)
    if (focusables.length === 0) return
    const active = document.activeElement as HTMLElement | null
    const idx = focusables.indexOf(active as HTMLButtonElement)
    if (e.shiftKey) {
      // Shift+Tab from the first button wraps to the last.
      if (idx <= 0) {
        e.preventDefault()
        focusables[focusables.length - 1]?.focus()
      }
    } else {
      // Tab from the last button wraps to the first.
      if (idx >= focusables.length - 1 || idx === -1) {
        e.preventDefault()
        focusables[0]?.focus()
      }
    }
  }
  useEffect(() => {
    // Default focus goes to CANCEL, not confirm: for a destructive action the
    // user must make a deliberate choice to proceed — a stray Enter (or the
    // focus landing on the dangerous button) must never restart the harness.
    cancelRef.current?.focus()
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={title}
      onMouseDown={(e) => {
        // Click on the veil (outside the card) cancels.
        if (e.target === e.currentTarget) onCancel()
      }}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 1600,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'var(--dsw-alias-bg-mask-2, rgba(0,0,0,0.4))',
        backdropFilter: 'blur(2px)',
        WebkitBackdropFilter: 'blur(2px)',
        fontFamily: 'var(--dsw-font-family, ui-sans-serif, system-ui, sans-serif)',
      }}
    >
      <div
        style={{
          // Responsive: full-width with a small gutter on narrow viewports.
          width: 'min(360px, calc(100vw - 32px))',
          boxSizing: 'border-box',
          padding: '20px 22px 18px',
          borderRadius: 14,
          background: 'var(--dsw-alias-bg-layer-2, rgba(24,28,38,0.98))',
          border: '1px solid var(--dsw-alias-border-l3, rgba(196,211,232,0.31))',
          boxShadow: '0 16px 48px rgba(0,0,0,0.45)',
          color: 'var(--dsw-alias-label-primary, #f2f6fc)',
        }}
      >
        <div style={{ fontSize: 15, fontWeight: 650, lineHeight: 1.4, marginBottom: 8 }}>
          {title}
        </div>
        <div style={{ fontSize: 13, lineHeight: 1.6, color: 'var(--dsw-alias-label-secondary, rgba(242,246,252,0.7))', marginBottom: 18 }}>
          <div style={{ marginBottom: rest > 0 || shown.length > 0 ? 6 : 0 }}>{tl(model ? 'busyConfirmModelBody' : 'busyConfirmBody')}</div>
          {shown.length > 0 ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 2, maxHeight: '38vh', overflowY: 'auto' }}>
              {shown.map((id) => (
                // One line per running session; ids can be long, so they wrap
                // inside the card rather than overflowing.
                <div key={id} style={{
                  display: 'flex', gap: 6,
                  // Session ids are opaque tokens; monospace keeps them
                  // visually distinct from prose. word-break prevents a very
                  // long id from blowing the modal's width.
                  fontFamily: 'var(--dsw-font-mono, ui-monospace, SFMono-Regular, Menlo, monospace)',
                  fontSize: 12, wordBreak: 'break-all',
                }}>
                  <span aria-hidden="true" style={{ flex: 'none', color: 'var(--dsw-alias-state-error-primary, #ff8592)', opacity: 0.8 }}>•</span>
                  <span>{id}</span>
                </div>
              ))}
              {rest > 0 ? (
                <div style={{
                  marginTop: 4,
                  fontSize: 12,
                  color: 'var(--dsw-alias-label-caption, rgba(242,246,252,0.5))',
                }}>
                  {tl('busyMore').replace('{0}', String(rest))}
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10 }}>
          <button
            ref={cancelRef}
            type="button"
            onClick={onCancel}
            style={{
              padding: '7px 16px',
              borderRadius: 8,
              border: '1px solid var(--dsw-alias-border-l3, rgba(196,211,232,0.31))',
              background: 'transparent',
              color: 'var(--dsw-alias-label-primary, #f2f6fc)',
              font: 'inherit',
              fontSize: 13,
              cursor: 'pointer',
            }}
          >
            {tl('cancel')}
          </button>
          <button
            ref={confirmRef}
            type="button"
            onClick={onConfirm}
            style={{
              padding: '7px 16px',
              borderRadius: 8,
              border: '1px solid color-mix(in srgb, var(--dsw-alias-state-error-primary) 55%, transparent)',
              // Danger button fill: mix the error primary at a low ratio into
              // the surface (official DSH pattern) — same rationale as the
              // shutdown confirm's primary button.
              background: 'color-mix(in srgb, var(--dsw-alias-state-error-primary) 16%, var(--dsw-alias-bg-layer-2, rgba(24,28,38,0.98)))',
              color: 'var(--dsw-alias-state-error-primary, #ff8592)',
              font: 'inherit',
              fontSize: 13,
              fontWeight: 600,
              cursor: 'pointer',
            }}
          >
            {tl('restartAnyway')}
          </button>
        </div>
      </div>
    </div>
  )
}