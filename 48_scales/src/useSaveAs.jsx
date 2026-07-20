import { useEffect, useRef, useState } from 'react'

// Trigger the actual file download once a name is chosen. (In a browser the OS
// write still goes through the download mechanism; this just controls the name
// via our own UI instead of relying on the browser's auto-name / native prompt.)
function triggerDownload(content, filename, type) {
  const blob = new Blob([content], { type: type || 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

// Custom "Save as" dialog. Replaces the bare auto-download with an in-app modal
// that lets the user name the file before it's written.
function SaveAsModal({ defaultName, onSave, onCancel }) {
  const [name, setName] = useState(defaultName)
  const inputRef = useRef(null)
  useEffect(() => {
    const el = inputRef.current
    if (!el) return
    el.focus()
    // Preselect the base name (before the extension) for quick renaming.
    const dot = el.value.lastIndexOf('.')
    el.setSelectionRange(0, dot > 0 ? dot : el.value.length)
  }, [])
  const finalName = () => {
    const t = name.trim()
    if (!t) return ''
    return /\.[a-z0-9]+$/i.test(t) ? t : `${t}.json`
  }
  const commit = () => {
    const n = finalName()
    if (n) onSave(n)
  }
  return (
    <div className="modal-backdrop" onMouseDown={onCancel}>
      <div className="modal" onMouseDown={(e) => e.stopPropagation()}>
        <h3>Save as</h3>
        <label className="modal-sub">
          File name
          <input
            ref={inputRef}
            value={name}
            spellCheck={false}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commit()
              else if (e.key === 'Escape') onCancel()
            }}
          />
        </label>
        <div className="modal-actions">
          <button type="button" onClick={onCancel}>
            Cancel
          </button>
          <button
            type="button"
            className="primary"
            onClick={commit}
            disabled={!name.trim()}
          >
            Save
          </button>
        </div>
      </div>
    </div>
  )
}

// Hook: `requestSave(content, defaultName, type?)` opens the dialog; render the
// returned `saveAsModal` node somewhere in the component's JSX.
export function useSaveAs() {
  const [pending, setPending] = useState(null) // { content, defaultName, type }
  const requestSave = (content, defaultName, type) =>
    setPending({ content, defaultName: defaultName || 'export.json', type })
  const saveAsModal = pending ? (
    <SaveAsModal
      defaultName={pending.defaultName}
      onSave={(name) => {
        triggerDownload(pending.content, name, pending.type)
        setPending(null)
      }}
      onCancel={() => setPending(null)}
    />
  ) : null
  return { requestSave, saveAsModal }
}
