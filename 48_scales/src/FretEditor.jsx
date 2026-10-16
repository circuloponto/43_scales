import { useEffect, useRef, useState } from 'react'
import FretDiagram from './FretDiagram'
import { WINDOW, emptyShape, formatFrets, nameChord, pitchesOf, startRange, windowStart } from './fretShape'
import { pcName } from './chordVocab'

// The "draw a chord" popover: click the frets to place the notes, see the note
// names and fret numbers as you go, then insert (or save) the diagram. What it
// produces is  [[frets x 3 2 0 1 0 | optional title]].
export default function FretEditor({ x, y, initial, useFlats, onSave, onClose }) {
  const ref = useRef(null)
  const [frets, setFrets] = useState(() => initial?.frets ?? emptyShape())
  const [label, setLabel] = useState(initial?.label ?? '')
  // null = fit the window to the shape automatically; a number = the user moved it
  const [manualStart, setManualStart] = useState(null)

  useEffect(() => {
    const down = (e) => {
      if (ref.current && !ref.current.contains(e.target)) onClose()
    }
    const key = (e) => e.key === 'Escape' && onClose()
    window.addEventListener('pointerdown', down, true)
    window.addEventListener('keydown', key)
    return () => {
      window.removeEventListener('pointerdown', down, true)
      window.removeEventListener('keydown', key)
    }
  }, [onClose])

  // The window may never hide a dot, so it is clamped to what the shape allows.
  const range = startRange(frets, WINDOW)
  const start = manualStart == null ? windowStart(frets) : Math.max(range.min, Math.min(range.max, manualStart))
  const played = pitchesOf(frets)
  const guesses = nameChord(frets)
  const guess = guesses[0]
  const guessText = guess ? `${pcName(guess.rootPc, useFlats)} ${guess.quality}` : ''
  const shift = (d) => setManualStart(Math.max(range.min, Math.min(range.max, start + d)))
  // a title can never break the [[ ]] it is written in
  const cleanLabel = label.replace(/[[\]\n|]/g, '').trim()

  const save = () => onSave(`frets ${formatFrets(frets)}${cleanLabel ? ` | ${cleanLabel}` : ''}`)

  return (
    <div
      className="note-popover fret-editor"
      ref={ref}
      style={{ left: Math.max(8, Math.min(x, window.innerWidth - 360)), top: Math.max(8, Math.min(y, window.innerHeight - 560)) }}
    >
      <div className="scale-picker-title">{initial ? 'Edit chord diagram' : 'Draw a chord'}</div>
      <p className="fret-editor-help">
        Click a fret to place a note on that string (click it again to mute the string). Click above the nut to
        switch a string open ○ or muted ✕.
      </p>
      <div className="fret-editor-board">
        <FretDiagram frets={frets} onChange={setFrets} start={start} useFlats={useFlats} size="lg" />
      </div>
      <div className="fret-editor-window">
        <button type="button" onClick={() => shift(-1)} disabled={start <= range.min} aria-label="show lower frets">
          ▲ lower
        </button>
        <span>
          frets {start}–{start + WINDOW - 1}
        </span>
        <button type="button" onClick={() => shift(1)} disabled={start >= range.max} aria-label="show higher frets">
          higher ▼
        </button>
      </div>
      <div className="fret-editor-info">
        <div>
          <span className="fret-editor-k">Notes</span>{' '}
          {played.length ? played.map((p) => pcName(p.pc, useFlats)).join(' ') : 'none yet'}
        </div>
        {guess && (
          <div>
            <span className="fret-editor-k">Looks like</span> {guessText}{' '}
            <button type="button" className="fret-editor-use" onClick={() => setLabel(guessText)}>
              use as title
            </button>
          </div>
        )}
      </div>
      <input
        className="scale-picker-search"
        value={label}
        placeholder="Title (optional), e.g. Cmaj7 shape"
        aria-label="Diagram title"
        onChange={(e) => setLabel(e.target.value)}
      />
      <div className="fret-editor-actions">
        <button
          type="button"
          onClick={() => {
            setFrets(emptyShape())
            setManualStart(null)
          }}
        >
          Clear
        </button>
        <button type="button" className="scale-picker-confirm" disabled={!played.length} onClick={save}>
          {initial ? 'Save changes' : 'Insert diagram'}
        </button>
      </div>
    </div>
  )
}
