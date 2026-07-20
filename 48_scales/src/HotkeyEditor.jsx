import { useEffect, useState } from 'react'
import {
  HOTKEY_ACTIONS,
  RESERVED_SIGS,
  useHotkeys,
  setBinding,
  resetBindings,
  eventToSig,
  sigToLabel,
} from './hotkeys'

// Interactive rebinder for the core action shortcuts. Click a binding, press the
// new keys; conflicts with another action or a reserved gesture are refused.
export default function HotkeyEditor() {
  const bindings = useHotkeys()
  const [capturing, setCapturing] = useState(null) // action id being rebound
  const [warning, setWarning] = useState('')

  useEffect(() => {
    if (!capturing) return
    // Capture phase + stopPropagation so the app's own key handlers (bubble
    // phase) don't act on the keys we're grabbing for a rebind.
    const onKey = (e) => {
      e.preventDefault()
      e.stopPropagation()
      if (e.code === 'Escape') {
        setCapturing(null)
        setWarning('')
        return
      }
      const sig = eventToSig(e)
      if (!sig) return // lone modifier — wait for the real key
      if (RESERVED_SIGS.has(sig)) {
        setWarning(`${sigToLabel(sig)} is reserved by a fixed control.`)
        return
      }
      const clash = HOTKEY_ACTIONS.find(
        (a) => a.id !== capturing && bindings[a.id] === sig
      )
      if (clash) {
        setWarning(`${sigToLabel(sig)} is already used by “${clash.label}”.`)
        return
      }
      setBinding(capturing, sig)
      setCapturing(null)
      setWarning('')
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [capturing, bindings])

  const sections = [...new Set(HOTKEY_ACTIONS.map((a) => a.section))]

  return (
    <div className="hotkey-editor">
      {sections.map((section) => (
        <div key={section} className="shortcuts-section">
          <div className="shortcuts-section-title">{section}</div>
          <ul className="shortcuts-list">
            {HOTKEY_ACTIONS.filter((a) => a.section === section).map((a) => (
              <li key={a.id} className="hotkey-row">
                <span className="shortcuts-desc">{a.label}</span>
                <button
                  type="button"
                  className={`hotkey-binding ${
                    capturing === a.id ? 'capturing' : ''
                  }`}
                  onClick={() => {
                    setWarning('')
                    setCapturing((c) => (c === a.id ? null : a.id))
                  }}
                  title="Click, then press the new keys (Esc to cancel)"
                >
                  {capturing === a.id ? 'Press keys…' : sigToLabel(bindings[a.id])}
                </button>
              </li>
            ))}
          </ul>
        </div>
      ))}
      {warning && <div className="hotkey-warning">{warning}</div>}
      <div className="hotkey-editor-actions">
        <button
          type="button"
          onClick={() => {
            resetBindings()
            setCapturing(null)
            setWarning('')
          }}
        >
          Reset to defaults
        </button>
      </div>
    </div>
  )
}
