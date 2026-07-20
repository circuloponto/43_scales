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
  bpm = 120,
  NOTE_DISPLAY,
  inScale,
  chordClassFor,
  onAudition,
  getAudioContext,
  playNote,
  stopAudio,
  rhythm,
  findDuplicate,
  onSave,
  onClose,
  initialName = '',
  initialNotes = null,
  initialTags = [],
}) {
  const baseRoot = 60 + root
  const midiOf = (it) =>
    baseRoot + scale.notes[it.degree] + it.octave * 12 + (it.semis || 0)

  const [name, setName] = useState(initialName)
  // Tags for this template (free-text chips).
  const [tags, setTags] = useState(() =>
    Array.isArray(initialTags) ? initialTags : []
  )
  const [tagInput, setTagInput] = useState('')
  const addTag = (raw) => {
    // A comma-separated list adds one tag per name.
    const parts = (raw || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
    if (!parts.length) return
    setTags((prev) => {
      const out = [...prev]
      for (const p of parts)
        if (!out.some((x) => x.toLowerCase() === p.toLowerCase())) out.push(p)
      return out
    })
    setTagInput('')
  }
  const removeTag = (t) => setTags((prev) => prev.filter((x) => x !== t))
  // Map "midi:beat" -> length (cells).
  const [notes, setNotes] = useState(() => {
    const m = new Map()
    if (initialNotes)
      for (const it of initialNotes) m.set(`${midiOf(it)}:${it.beat}`, it.length || 1)
    return m
  })
  const resizeRef = useRef(false)
  const scrollRef = useRef(null)
  // Duplicate-on-save warning: `dupName` is the matching template's name;
  // `dupAck` means the user has seen the warning and may now save anyway.
  const [dupName, setDupName] = useState(null)
  const [dupAck, setDupAck] = useState(false)
  // Editing the notes invalidates a prior warning — re-check on next save.
  useEffect(() => {
    setDupName(null)
    setDupAck(false)
  }, [notes])

  // ── Transport (play / pause / stop / return-to-start) ─────────────────
  const [playing, setPlaying] = useState(false)
  const [playhead, setPlayhead] = useState(null) // cell position, null = at 0/idle
  const rafRef = useRef(null)
  const playRef = useRef(null) // { audioStart, startBeat }
  const notesRef = useRef(notes)
  notesRef.current = notes
  const cellDur = 60 / bpm / 4 // seconds per 16th-cell

  const contentEnd = () => {
    let end = 0
    for (const [k, len] of notesRef.current) {
      const beat = Number(k.split(':')[1])
      if (beat + len > end) end = beat + len
    }
    return end
  }
  const stopTransport = (resetTo = null) => {
    if (rafRef.current) cancelAnimationFrame(rafRef.current)
    rafRef.current = null
    playRef.current = null
    stopAudio?.()
    setPlaying(false)
    if (resetTo !== null) setPlayhead(resetTo)
  }
  const startPlayback = (fromBeat) => {
    const end = contentEnd()
    if (end <= 0) return
    const start = Math.max(0, Math.min(fromBeat ?? 0, end - 0.0001))
    const ctx = getAudioContext()
    const audioStart = ctx.currentTime + 0.06
    for (const [k, len] of notesRef.current) {
      const [midi, beat] = k.split(':').map(Number)
      if (beat + len <= start) continue
      const at = audioStart + (beat - start) * cellDur
      playNote?.(midi, at, len * cellDur)
    }
    playRef.current = { audioStart, startBeat: start }
    setPlaying(true)
    const tick = () => {
      const pr = playRef.current
      if (!pr) return
      const pos = pr.startBeat + (ctx.currentTime - pr.audioStart) / cellDur
      if (pos >= end) {
        stopTransport(0)
        return
      }
      setPlayhead(pos)
      rafRef.current = requestAnimationFrame(tick)
    }
    rafRef.current = requestAnimationFrame(tick)
  }
  const togglePlay = () => {
    if (playing) stopTransport() // pause, keep playhead
    else startPlayback(playhead ?? 0)
  }
  const toBeginning = () => stopTransport(0)

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

  // Transport keys — Space play/pause, Enter return-to-start, Esc close. The
  // roll's own shortcuts are suppressed while this modal is open.
  useEffect(() => {
    const onKey = (e) => {
      const tag = e.target.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA') {
        if (e.key === 'Escape') onClose()
        return
      }
      if (e.code === 'Space') {
        e.preventDefault()
        togglePlay()
      } else if (e.code === 'Enter') {
        e.preventDefault()
        toBeginning()
      } else if (e.key === 'Escape') {
        e.preventDefault()
        onClose()
      } else if (rhythm && /^Digit[0-9]$/.test(e.code)) {
        // Type a number → set the rhythm divisor (or multiplier after X).
        if (e.repeat) return
        e.preventDefault()
        rhythm.feedDigit(Number(e.code.slice(5)))
      } else if (rhythm && (e.code === 'KeyX' || e.key === 'x')) {
        e.preventDefault()
        rhythm.primeMultiplier()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing, playhead])

  // Stop audio + RAF if the modal unmounts mid-playback.
  useEffect(
    () => () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current)
      stopAudio?.()
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    []
  )

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
    const raw = (e.clientX - rect.left) / BEAT_W
    // Snap to the rhythm's subdivision (so triplets etc. land evenly), and use
    // its length for the new note — same idea as the roll.
    const sub = rhythm && rhythm.subdivision > 0 ? rhythm.subdivision : 1
    const len = rhythm && rhythm.length > 0 ? rhythm.length : 1
    const beat = Math.max(0, Math.min(COLS - len, Math.round(raw / sub) * sub))
    if (covers(midi, beat)) return
    setNotes((prev) => new Map(prev).set(`${midi}:${beat}`, len))
    onAudition?.(midi)
  }
  const removeNote = (key) => {
    setNotes((prev) => {
      const next = new Map(prev)
      next.delete(key)
      return next
    })
  }
  // Left-drag a note to move it across time and pitch (snaps to the rhythm
  // subdivision). A plain click leaves it put; right-click deletes.
  const startMove = (e, midi, beat, len) => {
    if (e.button !== 0) return
    e.preventDefault()
    e.stopPropagation()
    const startX = e.clientX
    const startY = e.clientY
    const sub = rhythm && rhythm.subdivision > 0 ? rhythm.subdivision : 1
    let curMidi = midi
    let curBeat = beat
    const move = (mv) => {
      let nb = beat + (mv.clientX - startX) / BEAT_W
      nb = Math.max(0, Math.min(COLS - len, Math.round(nb / sub) * sub))
      const dRows = Math.round((mv.clientY - startY) / ROW_H)
      const nm = Math.max(MIDI_LOW, Math.min(MIDI_HIGH, midi - dRows))
      if (nm === curMidi && nb === curBeat) return
      // Capture the keys NOW — the setNotes updater runs async, and curMidi/
      // curBeat are reassigned below before it fires, so referencing them
      // inside the updater would delete the wrong (new) key and leave a trail.
      const oldKey = `${curMidi}:${curBeat}`
      const newKey = `${nm}:${nb}`
      const pitchChanged = nm !== curMidi
      curMidi = nm
      curBeat = nb
      setNotes((prev) => {
        const next = new Map(prev)
        next.delete(oldKey)
        next.set(newKey, len)
        return next
      })
      if (pitchChanged) onAudition?.(nm)
    }
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
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

  const buildItems = () => {
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
    return items
  }
  const save = () => {
    const items = buildItems()
    // Warn once if this template duplicates an existing one (same scalar
    // contour + same relative rhythm). A second click saves it anyway.
    if (findDuplicate && !dupAck) {
      const dup = findDuplicate(items)
      if (dup) {
        setDupName(dup.name)
        setDupAck(true)
        return
      }
    }
    onSave(name.trim(), items, tags)
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
        <div className="template-editor-tags">
          <span className="template-editor-tags-label">Tags</span>
          {tags.map((t) => (
            <span key={t} className="tag-chip">
              {t}
              <button
                type="button"
                className="tag-chip-x"
                onClick={() => removeTag(t)}
                aria-label={`Remove tag ${t}`}
              >
                ×
              </button>
            </span>
          ))}
          <input
            className="template-editor-tag-input"
            value={tagInput}
            placeholder={tags.length ? 'Add tag…' : 'Add tags…'}
            onChange={(e) => setTagInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ',') {
                e.preventDefault()
                addTag(tagInput)
              } else if (e.key === 'Backspace' && !tagInput && tags.length) {
                removeTag(tags[tags.length - 1])
              }
            }}
          />
        </div>
        <p className="modal-sub">
          Click empty space to add · drag a note to move it · drag its right
          edge to lengthen · right-click to delete. Stored by scale relationship
          so it replays on any scale.
        </p>

        <div className="template-editor-transport">
          <button
            type="button"
            className={`te-transport-btn ${playing ? 'on' : ''}`}
            onClick={togglePlay}
            title={playing ? 'Pause (Space)' : 'Play (Space)'}
            aria-label={playing ? 'pause' : 'play'}
          >
            {playing ? '❚❚' : '▶'}
          </button>
          <button
            type="button"
            className="te-transport-btn"
            onClick={() => stopTransport(0)}
            title="Stop / return to start"
            aria-label="stop"
          >
            ■
          </button>
          {rhythm && (
            <div
              className="rhythm-cluster"
              title="Rhythm — pick beat/bar, then type a number to divide it (÷2 half, ÷3 triplet…). Press X then a number for a multiplier."
            >
              <button
                type="button"
                className="rhythm-unit-box"
                onClick={rhythm.toggleUnit}
                title="Toggle whether the division refers to a beat or a bar"
              >
                {rhythm.unit === 'bar' ? 'BAR' : 'BEAT'}
              </button>
              <div className="rhythm-box">
                <span className="rhythm-box-div">÷{rhythm.denominator}</span>
                <span className="rhythm-box-name">{rhythm.noteName}</span>
              </div>
              <div className="rhythm-note-icon">
                <rhythm.NoteGlyph value={rhythm.glyphValue} size={18} />
                {rhythm.tuplet && (
                  <span className="rhythm-note-tuplet">{rhythm.tuplet}</span>
                )}
              </div>
              <div
                className={`rhythm-mult-box ${rhythm.awaiting ? 'awaiting' : ''}`}
              >
                ×{rhythm.awaiting ? '?' : rhythm.mult}
              </div>
            </div>
          )}
          <span className="te-transport-hint">
            Space play · Enter start · digits = rhythm
          </span>
        </div>

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
              {playhead !== null && (
                <div
                  className="playhead"
                  style={{ transform: `translateX(${playhead * BEAT_W}px)` }}
                />
              )}
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
                          onPointerDown={(e) => startMove(e, midi, beat, length)}
                          onContextMenu={(e) => {
                            e.preventDefault()
                            e.stopPropagation()
                            removeNote(key)
                          }}
                          title="Drag to move · drag right edge to resize · right-click to delete"
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

        {dupName && (
          <div className="template-dup-warning">
            ⚠ This has the same shape &amp; rhythm as{' '}
            <strong>{dupName}</strong>. Click Save again to keep it anyway.
          </div>
        )}

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
            {dupName
              ? 'Save anyway'
              : initialNotes
              ? 'Save changes'
              : 'Save template'}
          </button>
        </div>
      </div>
    </div>
  )
}
