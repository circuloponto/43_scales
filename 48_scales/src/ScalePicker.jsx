import { useEffect, useMemo, useRef, useState } from 'react'

// Popover for choosing a zone's scale, root and (optionally) mode. Applies each
// change straight away, like the other pickers in the app; click outside or
// press Escape to close. Notes are never touched by picking a scale.
const SCALE_COLUMNS = 12

function MiniScale({ notes }) {
  const on = new Set(notes)
  return (
    <span className="scale-picker-mini" aria-hidden="true">
      {Array.from({ length: SCALE_COLUMNS }, (_, pc) => (
        <i key={pc} className={on.has(pc) ? 'on' : ''} />
      ))}
    </span>
  )
}

export default function ScalePicker({
  x,
  y,
  zone,
  builtIn,
  custom,
  nameOf,
  noteNames,
  onChange,
  onClose,
  confirmLabel,
  onConfirm,
}) {
  const [query, setQuery] = useState('')
  const wrapRef = useRef(null)

  useEffect(() => {
    const down = (e) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target)) onClose()
    }
    const key = (e) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('pointerdown', down, true)
    window.addEventListener('keydown', key)
    return () => {
      window.removeEventListener('pointerdown', down, true)
      window.removeEventListener('keydown', key)
    }
  }, [onClose])

  const current =
    builtIn.find((s) => s.id === zone.scaleId) ||
    custom.find((s) => s.id === zone.scaleId) ||
    null

  const q = query.trim().toLowerCase()
  const matches = (s) => {
    if (!q) return true
    const label = `${s.kind === 'custom' ? s.name : nameOf(s.id)} ${s.id}`.toLowerCase()
    return label.includes(q)
  }
  const builtInShown = useMemo(() => builtIn.filter(matches), [builtIn, q]) // eslint-disable-line react-hooks/exhaustive-deps
  const customShown = useMemo(() => custom.filter(matches), [custom, q]) // eslint-disable-line react-hooks/exhaustive-deps

  // Keep the popover on screen.
  const left = Math.max(8, Math.min(x, window.innerWidth - 320))
  const top = Math.max(8, Math.min(y, window.innerHeight - 440))

  const row = (s) => (
    <button
      key={s.id}
      type="button"
      className={`scale-picker-row ${s.id === zone.scaleId ? 'on' : ''}`}
      onClick={() => onChange({ scaleId: s.id, modeStep: null })}
    >
      <span className="scale-picker-id">
        {s.kind === 'custom' ? '★' : String(s.id).padStart(2, '0')}
      </span>
      <span className="scale-picker-name">
        {s.kind === 'custom' ? s.name : nameOf(s.id)}
      </span>
      <MiniScale notes={s.notes} />
    </button>
  )

  return (
    <div
      className="scale-picker"
      ref={wrapRef}
      style={{ left, top }}
      onContextMenu={(e) => e.preventDefault()}
    >
      <div className="scale-picker-title">Scale for this zone</div>
      <div className="scale-picker-roots" role="radiogroup" aria-label="Root">
        {noteNames.map((n, pc) => (
          <button
            key={pc}
            type="button"
            role="radio"
            aria-checked={zone.root === pc}
            className={zone.root === pc ? 'on' : ''}
            onClick={() => onChange({ root: pc })}
          >
            {n}
          </button>
        ))}
      </div>
      {current && (
        <label className="scale-picker-mode">
          <span>Root degree</span>
          <select
            value={zone.modeStep ?? ''}
            onChange={(e) =>
              onChange({ modeStep: e.target.value ? Number(e.target.value) : null })
            }
          >
            <option value="">scale default</option>
            {current.notes.map((_, i) => (
              <option key={i} value={i + 1}>
                degree {i + 1}
              </option>
            ))}
          </select>
        </label>
      )}
      <input
        className="scale-picker-search"
        value={query}
        placeholder="Search scales…"
        autoFocus
        onChange={(e) => setQuery(e.target.value)}
      />
      <div className="scale-picker-list">
        {customShown.length > 0 && (
          <>
            <div className="scale-picker-group">Custom</div>
            {customShown.map(row)}
          </>
        )}
        {builtInShown.length > 0 && (
          <>
            <div className="scale-picker-group">8-note scales</div>
            {builtInShown.map(row)}
          </>
        )}
        {customShown.length === 0 && builtInShown.length === 0 && (
          <div className="scale-picker-empty">No scale matches</div>
        )}
      </div>
      {onConfirm && (
        <button type="button" className="scale-picker-confirm" onClick={onConfirm}>
          {confirmLabel ?? 'Use this scale'}
        </button>
      )}
    </div>
  )
}
