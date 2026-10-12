import { useEffect, useMemo, useRef, useState } from 'react'
import { ChevronLeft, ChevronRight } from 'lucide-react'

// Line-generator variations, previewed in a modal (same idea and markup as the
// template editor). The arrows and counter sit in a fixed header, and the
// preview's pitch and beat range are computed once from the original line plus
// ALL variations, so stepping never moves or rescrolls anything. Nothing on the
// real roll changes until Accept.
//
// Position 0 is the original line; 1..variants.length are the variations.
// `original` / `fixed` items are { beat, midi, len } (beat and len in 16th-cells);
// `variants` is an array of midi arrays aligned to `original`. `fixed` are
// anchored notes from the selection: shown dimmed, never changed.
const ROW_H = 21 // matches the roll / template editor row height
const MIDI_LOW = 21
const MIDI_HIGH = 108
const PAD_ROWS = 3 // empty rows above / below the line
const MIN_ROWS = 14
const FIT_WIDTH = 640 // px the line aims to fit in before scrolling sideways
const WHITE_PCS = new Set([0, 2, 4, 5, 7, 9, 11])
const octaveOf = (midi) => Math.floor(midi / 12) - 1

export default function VariationModal({
  root,
  bpm = 120,
  NOTE_DISPLAY,
  inScale,
  chordClassFor,
  getAudioContext,
  playNote,
  stopAudio,
  original,
  fixed = [],
  variants,
  modeLabel,
  onAccept,
  onCancel,
  onRegenerate,
}) {
  const count = variants.length
  const [index, setIndex] = useState(count > 0 ? 1 : 0)
  const [message, setMessage] = useState('')
  const [playing, setPlaying] = useState(false)
  const [playhead, setPlayhead] = useState(null) // cells from the left edge
  const rafRef = useRef(null)
  const rootRef = useRef(null)

  // Fixed viewport: rows and columns that fit every version of the line.
  const view = useMemo(() => {
    const midis = [
      ...original.map((n) => n.midi),
      ...fixed.map((n) => n.midi),
      ...variants.flat(),
    ]
    let hi = Math.min(MIDI_HIGH, Math.max(...midis) + PAD_ROWS)
    let lo = Math.max(MIDI_LOW, Math.min(...midis) - PAD_ROWS)
    while (hi - lo + 1 < MIN_ROWS) {
      if (hi < MIDI_HIGH) hi++
      if (hi - lo + 1 < MIN_ROWS && lo > MIDI_LOW) lo--
    }
    const all = [...original, ...fixed]
    const minBeat = Math.min(...all.map((n) => n.beat))
    const endBeat = Math.max(...all.map((n) => n.beat + n.len))
    const cols = Math.max(4, Math.ceil(endBeat - minBeat) + 1)
    const beatW = Math.max(14, Math.min(40, Math.floor(FIT_WIDTH / cols)))
    const pitches = []
    for (let m = hi; m >= lo; m--) pitches.push(m)
    return { pitches, minBeat, cols, beatW, endBeat }
  }, [original, fixed, variants])

  // New variations (Regenerate): start on the first one again. Done during
  // render, React's recommended way to reset state when a prop changes.
  const [shownVariants, setShownVariants] = useState(variants)
  if (shownVariants !== variants) {
    setShownVariants(variants)
    setIndex(variants.length > 0 ? 1 : 0)
  }

  useEffect(() => {
    rootRef.current?.focus()
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current)
      stopAudio?.()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const midisAt = (i) => (i === 0 ? original.map((n) => n.midi) : variants[i - 1])
  const current = midisAt(index)

  const stopTransport = () => {
    if (rafRef.current) cancelAnimationFrame(rafRef.current)
    rafRef.current = null
    stopAudio?.()
    setPlaying(false)
    setPlayhead(null)
  }
  const play = () => {
    const ctx = getAudioContext()
    const cellDur = 60 / bpm / 4
    const t0 = ctx.currentTime + 0.06
    const notes = [
      ...original.map((n, i) => ({ ...n, midi: current[i] })),
      ...fixed,
    ]
    for (const n of notes) {
      playNote?.(n.midi, t0 + (n.beat - view.minBeat) * cellDur, n.len * cellDur)
    }
    const span = view.endBeat - view.minBeat
    setPlaying(true)
    const tick = () => {
      const pos = (ctx.currentTime - t0) / cellDur
      if (pos >= span) {
        stopTransport()
        return
      }
      setPlayhead(Math.max(0, pos))
      rafRef.current = requestAnimationFrame(tick)
    }
    rafRef.current = requestAnimationFrame(tick)
  }
  const togglePlay = () => (playing ? stopTransport() : play())

  const step = (dir) => {
    if (count === 0) return
    stopTransport()
    setIndex((i) => (i + dir + count + 1) % (count + 1))
  }

  const regenerate = () => {
    stopTransport()
    setMessage(onRegenerate() || '')
  }

  // Notes grouped by pitch row: the original as a ghost, the current version
  // on top, anchored notes dimmed.
  const rows = useMemo(() => {
    const map = new Map()
    const add = (midi, entry) => {
      if (!map.has(midi)) map.set(midi, [])
      map.get(midi).push(entry)
    }
    if (index !== 0) {
      original.forEach((n) => add(n.midi, { ...n, kind: 'ghost' }))
    }
    original.forEach((n, i) => add(current[i], { ...n, midi: current[i], kind: 'now' }))
    fixed.forEach((n) => add(n.midi, { ...n, kind: 'fixed' }))
    return map
  }, [original, fixed, current, index])

  const onKeyDown = (e) => {
    const onButton = e.target.tagName === 'BUTTON'
    if (e.key === 'Escape') {
      e.preventDefault()
      onCancel()
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault()
      step(-1)
    } else if (e.key === 'ArrowRight') {
      e.preventDefault()
      step(1)
    } else if (e.key === 'Enter' && !onButton) {
      e.preventDefault()
      onAccept(index)
    } else if (e.key === ' ' && !onButton) {
      e.preventDefault()
      togglePlay()
    }
  }
  // Keep focus on the modal so the keys above keep working after a click.
  const keepFocus = (e) => e.preventDefault()

  const { pitches, minBeat, cols, beatW } = view
  const kbdHeight = pitches.length * ROW_H
  const top = pitches[0]

  return (
    <div className="modal-backdrop" onClick={onCancel}>
      <div
        className="modal variation-modal"
        ref={rootRef}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={onKeyDown}
      >
        <div className="settings-modal-header">
          <h3>Line variations{modeLabel ? ` · ${modeLabel}` : ''}</h3>
          <button
            type="button"
            className="finder-modal-close"
            onClick={onCancel}
            aria-label="close"
          >
            ×
          </button>
        </div>

        <div className="variation-modal-nav">
          <button
            type="button"
            className="variation-modal-arrow"
            onMouseDown={keepFocus}
            onClick={() => step(-1)}
            disabled={count === 0}
            title="Previous (←)"
            aria-label="Previous variation"
          >
            <ChevronLeft size={20} />
          </button>
          <div className="variation-modal-count" aria-live="polite">
            {index}
            <small> / {count}</small>
            <span className="variation-modal-tag">
              {index === 0 ? 'original' : 'variation'}
            </span>
          </div>
          <button
            type="button"
            className="variation-modal-arrow"
            onMouseDown={keepFocus}
            onClick={() => step(1)}
            disabled={count === 0}
            title="Next (→)"
            aria-label="Next variation"
          >
            <ChevronRight size={20} />
          </button>
          <button
            type="button"
            className={`te-transport-btn ${playing ? 'on' : ''}`}
            onMouseDown={keepFocus}
            onClick={togglePlay}
            title={playing ? 'Stop (Space)' : 'Play (Space)'}
            aria-label={playing ? 'stop' : 'play'}
          >
            {playing ? '■' : '▶'}
          </button>
        </div>

        <div className="template-editor-roll">
          <div className="roll-content">
            <div className="kbd-column" style={{ height: kbdHeight }}>
              {pitches.map((midi) => {
                const pc = ((midi % 12) + 12) % 12
                return (
                  <div
                    key={midi}
                    className={`piano-key ${WHITE_PCS.has(pc) ? 'white' : 'black'} ${
                      inScale(pc) ? 'in' : ''
                    } ${pc === root ? 'is-root' : ''} ${chordClassFor(pc)}`}
                    style={{ top: (top - midi) * ROW_H, height: ROW_H }}
                  >
                    <span className="key-label">
                      {pc === 0 ? `C${octaveOf(midi)}` : NOTE_DISPLAY[pc]}
                    </span>
                  </div>
                )
              })}
            </div>
            <div className="grid-area">
              {playhead !== null && (
                <div
                  className="playhead"
                  style={{ transform: `translateX(${playhead * beatW}px)` }}
                />
              )}
              {pitches.map((midi) => {
                const pc = ((midi % 12) + 12) % 12
                const cc = chordClassFor(pc)
                return (
                  <div
                    key={midi}
                    className={`grid-row ${WHITE_PCS.has(pc) ? 'white' : 'black'} ${
                      pc === 0 ? 'octave' : ''
                    } ${inScale(pc) ? 'in' : ''} ${pc === root ? 'is-root' : ''} ${cc}`}
                  >
                    <div
                      className="beats-track"
                      style={{
                        width: cols * beatW,
                        cursor: 'default',
                        backgroundSize: `${beatW}px 100%, ${beatW * 4}px 100%`,
                      }}
                    >
                      {(rows.get(midi) || []).map((n, i) => (
                        <div
                          key={`${n.kind}-${n.beat}-${i}`}
                          className={`row-note ${n.kind} ${cc}`}
                          style={{
                            left: (n.beat - minBeat) * beatW,
                            width: n.len * beatW,
                          }}
                        />
                      ))}
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
        </div>

        <p className="modal-sub">
          ← → step through the variations · Space play · Enter accept · Esc cancel.
          The dashed outline is your original line
          {fixed.length > 0 ? '; dimmed notes are anchored and stay as they are' : ''}.
          Nothing changes on the roll until you accept.
        </p>
        {message && <div className="line-gen-message">{message}</div>}

        <div className="modal-actions">
          <button type="button" onMouseDown={keepFocus} onClick={onCancel}>
            Cancel
          </button>
          <button type="button" onMouseDown={keepFocus} onClick={regenerate}>
            Regenerate
          </button>
          <button
            type="button"
            className="primary"
            onMouseDown={keepFocus}
            onClick={() => onAccept(index)}
          >
            {index === 0 ? 'Keep original' : 'Accept'}
          </button>
        </div>
      </div>
    </div>
  )
}
