import { useEffect, useMemo, useRef, useState } from 'react'

// Template builder / editor. This reuses the REAL piano-roll timeline markup
// and CSS (.roll-content / .kbd-column / .piano-key / .grid-area / .grid-row /
// .beats-track / .row-note) so it looks and reads exactly like the roll. Notes
// are stored scale-relative — { beat, degree, octave, semis, length } — so a
// template replays on any scale; `semis` is the chromatic offset above the
// scale degree (0 for in-scale notes).
const ROW_H = 21
const BEAT_W = 28 // width of one 16th-cell, matching the roll base
const MIDI_LOW = 21
const MIDI_HIGH = 108
const CELLS_PER_BEAT = 4 // 4 sixteenths per beat (4/4)
const WHITE_PCS = new Set([0, 2, 4, 5, 7, 9, 11])
const octaveOf = (midi) => Math.floor(midi / 12) - 1

export default function TemplateEditorModal({
  scale,
  root,
  NOTE_DISPLAY,
  inScale,
  chordClassFor,
  onAudition,
  onSave,
  onClose,
  initialName = '',
  initialNotes = null,
}) {
  const baseRoot = 60 + root
  const midiOf = (it) =>
    baseRoot + scale.notes[it.degree] + it.octave * 12 + (it.semis || 0)

  const [name, setName] = useState(initialName)
  // Map "midi:beat" -> length (cells).
  const [notes, setNotes] = useState(() => {
    const m = new Map()
    if (initialNotes)
      for (const it of initialNotes) m.set(`${midiOf(it)}:${it.beat}`, it.length || 1)
    return m
  })
  const resizeRef = useRef(false)
  const scrollRef = useRef(null)

  const pitches = useMemo(() => {
    const out = []
    for (let m = MIDI_HIGH; m >= MIDI_LOW; m--) out.push(m)
    return out
  }, [])

  const COLS = useMemo(() => {
    let c = 32
    if (initialNotes)
      for (const it of initialNotes) c = Math.max(c, it.beat + (it.length || 1))
    return Math.max(32, Math.ceil((c + 1) / 16) * 16)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Center the view on the root octave when it opens.
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    el.scrollTop = Math.max(0, (MIDI_HIGH - (baseRoot + 6)) * ROW_H - 120)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const notesByMidi = useMemo(() => {
    const m = new Map()
    for (const [k, length] of notes) {
      const [midi, beat] = k.split(':').map(Number)
      if (!m.has(midi)) m.set(midi, [])
      m.get(midi).push({ key: k, beat, length })
    }
    return m
  }, [notes])

  const covers = (midi, beat) => {
    const row = notesByMidi.get(midi) || []
    return row.some((n) => beat >= n.beat && beat < n.beat + n.length)
  }
  const addAt = (e, midi) => {
    if (e.button !== 0) return
    const rect = e.currentTarget.getBoundingClientRect()
    const beat = Math.max(
      0,
      Math.min(COLS - 1, Math.floor((e.clientX - rect.left) / BEAT_W))
    )
    if (covers(midi, beat)) return
    setNotes((prev) => new Map(prev).set(`${midi}:${beat}`, 1))
    onAudition?.(midi)
  }
  const removeNote = (key) => {
    setNotes((prev) => {
      const next = new Map(prev)
      next.delete(key)
      return next
    })
  }
  const startResize = (e, midi, beat, startLen) => {
    e.preventDefault()
    e.stopPropagation()
    resizeRef.current = true
    const startX = e.clientX
    const move = (mv) => {
      const dx = mv.clientX - startX
      const len = Math.max(
        1,
        Math.min(COLS - beat, startLen + Math.round(dx / BEAT_W))
      )
      setNotes((prev) => new Map(prev).set(`${midi}:${beat}`, len))
    }
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      setTimeout(() => (resizeRef.current = false), 0)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  const save = () => {
    const items = []
    for (const [k, length] of notes) {
      const [midi, beat] = k.split(':').map(Number)
      const rel = midi - baseRoot
      const octave = Math.floor(rel / 12)
      const within = ((rel % 12) + 12) % 12
      let degree = 0
      for (let d = 0; d < scale.notes.length; d++) {
        if (scale.notes[d] <= within) degree = d
        else break
      }
      const semis = within - scale.notes[degree]
      items.push({ beat, degree, octave, semis, length })
    }
    onSave(name.trim(), items)
  }

  const kbdHeight = (MIDI_HIGH - MIDI_LOW + 1) * ROW_H

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal template-editor-modal"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === 'Escape') onClose()
        }}
      >
        <div className="settings-modal-header">
          <input
            className="template-editor-name"
            value={name}
            placeholder="Template name"
            autoFocus
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') save()
            }}
          />
          <button
            type="button"
            className="finder-modal-close"
            onClick={onClose}
            aria-label="close editor"
          >
            ×
          </button>
        </div>
        <p className="modal-sub">
          Click to add a note, click a note to remove it, drag its right edge to
          lengthen. In-scale rows are tinted like the roll; stored by scale
          relationship so it replays on any scale.
        </p>

        <div className="template-editor-roll" ref={scrollRef}>
          <div className="roll-content">
            <div className="kbd-column" style={{ height: kbdHeight }}>
              {pitches.map((midi) => {
                const pc = ((midi % 12) + 12) % 12
                const white = WHITE_PCS.has(pc)
                const isRoot = pc === root
                const isIn = inScale ? inScale(pc) : true
                return (
                  <div
                    key={midi}
                    className={`piano-key ${white ? 'white' : 'black'} ${
                      isIn ? 'in' : ''
                    } ${isRoot ? 'is-root' : ''} ${
                      chordClassFor ? chordClassFor(pc) : ''
                    }`}
                    style={{ top: (MIDI_HIGH - midi) * ROW_H, height: ROW_H }}
                  >
                    <span className="key-label">
                      {pc === 0 ? `C${octaveOf(midi)}` : NOTE_DISPLAY[pc]}
                    </span>
                  </div>
                )
              })}
            </div>
            <div className="grid-area">
              {pitches.map((midi) => {
                const pc = ((midi % 12) + 12) % 12
                const white = WHITE_PCS.has(pc)
                const isRoot = pc === root
                const isIn = inScale ? inScale(pc) : true
                const cc = chordClassFor ? chordClassFor(pc) : ''
                const rowNotes = notesByMidi.get(midi) || []
                return (
                  <div
                    key={midi}
                    className={`grid-row ${white ? 'white' : 'black'} ${
                      pc === 0 ? 'octave' : ''
                    } ${isIn ? 'in' : ''} ${isRoot ? 'is-root' : ''} ${cc}`}
                  >
                    <div
                      className="beats-track"
                      style={{
                        width: COLS * BEAT_W,
                        backgroundSize: `${BEAT_W}px 100%, ${
                          BEAT_W * CELLS_PER_BEAT
                        }px 100%`,
                      }}
                      onPointerDown={(e) => addAt(e, midi)}
                    >
                      {rowNotes.map(({ key, beat, length }) => (
                        <div
                          key={key}
                          className={`row-note ${cc}`}
                          style={{
                            left: beat * BEAT_W,
                            width: length * BEAT_W,
                          }}
                          onPointerDown={(e) => {
                            e.stopPropagation()
                            if (resizeRef.current) return
                            removeNote(key)
                          }}
                          title="Click to remove · drag right edge to resize"
                        >
                          <span
                            className="row-note-handle"
                            onPointerDown={(e) =>
                              startResize(e, midi, beat, length)
                            }
                          />
                        </div>
                      ))}
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
        </div>

        <div className="modal-actions">
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="primary"
            onClick={save}
            disabled={notes.size === 0}
          >
            {initialNotes ? 'Save changes' : 'Save template'}
          </button>
        </div>
      </div>
    </div>
  )
}
