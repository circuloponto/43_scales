import { useState } from 'react'

// Modal builder for a custom scale: pick pitch classes on a 12-cell chromatic
// strip, designate one selected note as the root, name it. `rootStep` (1-indexed
// position of the root within the ascending notes) is the analogue of scales.js
// rootSteps. `initial` prefills the form for editing; null = create.
export default function CustomScaleModal({ initial, NOTE_DISPLAY, onSave, onClose }) {
  const [selected, setSelected] = useState(() => new Set(initial?.notes ?? []))
  const [rootPc, setRootPc] = useState(
    initial ? initial.notes[initial.rootStep - 1] ?? null : null
  )
  const [name, setName] = useState(initial?.name ?? '')

  const notesSorted = [...selected].sort((a, b) => a - b)
  const effRoot =
    rootPc != null && selected.has(rootPc) ? rootPc : notesSorted[0] ?? null
  const canSave = notesSorted.length >= 2 && name.trim().length > 0

  const toggle = (pc) => {
    const wasSelected = selected.has(pc)
    setSelected((prev) => {
      const next = new Set(prev)
      wasSelected ? next.delete(pc) : next.add(pc)
      return next
    })
    // The FIRST note added becomes the root; removing the root clears it (the
    // root then falls back to the lowest note until re-picked).
    setRootPc((cur) => {
      if (wasSelected) return cur === pc ? null : cur
      return cur == null ? pc : cur
    })
  }

  const save = () => {
    if (!canSave) return
    const notes = notesSorted
    const rootStep = notes.indexOf(effRoot) + 1 || 1
    onSave({ id: initial?.id, name: name.trim(), notes, rootStep })
  }

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="modal custom-modal" onMouseDown={(e) => e.stopPropagation()}>
        <div className="settings-modal-header">
          <h3 className="custom-modal-title">
            {initial ? 'Edit custom scale' : 'New custom scale'}
          </h3>
          <button
            type="button"
            className="finder-modal-close"
            onClick={onClose}
            aria-label="close"
          >
            ×
          </button>
        </div>

        <input
          className="custom-name"
          placeholder="Scale name"
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && canSave) save()
            else if (e.key === 'Escape') onClose()
          }}
        />

        <div className="custom-label">Notes — click to add / remove</div>
        <div className="custom-cells">
          {Array.from({ length: 12 }, (_, pc) => {
            const on = selected.has(pc)
            return (
              <button
                key={pc}
                type="button"
                className={`custom-cell ${on ? 'on' : 'off'} ${
                  on && effRoot === pc ? 'root' : ''
                }`}
                onClick={() => toggle(pc)}
                title={NOTE_DISPLAY[pc]}
              >
                {NOTE_DISPLAY[pc]}
              </button>
            )
          })}
        </div>

        <div className="custom-label">Root</div>
        <div className="custom-roots">
          {notesSorted.length === 0 ? (
            <span className="custom-hint">Select notes first.</span>
          ) : (
            notesSorted.map((pc) => (
              <button
                key={pc}
                type="button"
                className={`custom-root-chip ${effRoot === pc ? 'active' : ''}`}
                onClick={() => setRootPc(pc)}
              >
                {NOTE_DISPLAY[pc]}
              </button>
            ))
          )}
        </div>

        <div className="custom-builder-actions">
          <button type="button" className="custom-cancel" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="custom-save"
            disabled={!canSave}
            onClick={save}
          >
            {initial ? 'Update' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  )
}
