import { useEffect, useMemo, useRef, useState } from 'react'

const NOTE_DISPLAY = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B']
const WHITE_PCS = new Set([0, 2, 4, 5, 7, 9, 11])

// PC → "white index from top of octave" (0 = B, 1 = A, ..., 6 = C)
const PC_TO_WHITE_IDX = { 11: 0, 9: 1, 7: 2, 5: 3, 4: 4, 2: 5, 0: 6 }
// PC of a black key → the white-index ABOVE it (where its boundary lives)
const BLACK_PC_TO_ABOVE_WHITE_IDX = { 10: 0, 8: 1, 6: 2, 3: 4, 1: 5 }

// Geometry. Whites are 36 px tall, blacks 24 px, centered on the boundary
// between two whites. Octave height = 7 × 36 = 12 × 21 = 252 px,
// so the keyboard column and the 21 px grid rows share total height.
const ROW_HEIGHT = 21
const WHITE_HEIGHT = 36
const BLACK_HEIGHT = 24
const OCTAVE_KBD_HEIGHT = WHITE_HEIGHT * 7
const BEAT_WIDTH = 28

// MIDI range
const MIDI_LOW = 36 // C2
const MIDI_HIGH = 83 // B5
const TOP_OCTAVE = Math.floor(MIDI_HIGH / 12) - 1 // 5

const DEFAULT_BEATS = 64
const MIN_BEATS = 8
const MAX_BEATS = 512
const DEFAULT_BPM = 120
const MIN_BPM = 40
const MAX_BPM = 300
const DEFAULT_SWING = 50
const MIN_SWING = 50
const MAX_SWING = 75

// Map a musical beat (cells on the linear grid) to swung playback time
// expressed in cells. Pairs of cells form a swing pair: the first cell
// stretches to swing/100 of the pair, the second compresses to the rest.
// swingPct = 50 → identity (straight). swingPct = 67 → triplet feel.
function applySwingBeat(beat, swingPct) {
  if (swingPct === 50) return beat
  const swing = swingPct / 100
  const pairIdx = Math.floor(beat / 2)
  const localB = beat - pairIdx * 2
  let timeInPair
  if (localB < 1) {
    timeInPair = localB * (2 * swing)
  } else {
    timeInPair = 2 * swing + (localB - 1) * 2 * (1 - swing)
  }
  return pairIdx * 2 + timeInPair
}

// Inverse: given swung playback time in cells, recover the musical beat
// (where the playhead should sit on the linear grid).
function unswingTimeBeat(t, swingPct) {
  if (swingPct === 50) return t
  const swing = swingPct / 100
  const pairIdx = Math.floor(t / 2)
  const localT = t - pairIdx * 2
  let localMusic
  if (localT < 2 * swing) {
    localMusic = localT / (2 * swing)
  } else {
    localMusic = 1 + (localT - 2 * swing) / (2 * (1 - swing))
  }
  return pairIdx * 2 + localMusic
}

function padId(id) {
  return String(id).padStart(2, '0')
}

function midiToOctave(midi) {
  return Math.floor(midi / 12) - 1
}

function kbdPosition(midi) {
  const pc = midi % 12
  const octaveOffset = (TOP_OCTAVE - midiToOctave(midi)) * OCTAVE_KBD_HEIGHT
  if (WHITE_PCS.has(pc)) {
    return {
      white: true,
      top: octaveOffset + PC_TO_WHITE_IDX[pc] * WHITE_HEIGHT,
      height: WHITE_HEIGHT,
    }
  }
  const aboveIdx = BLACK_PC_TO_ABOVE_WHITE_IDX[pc]
  const boundary = octaveOffset + (aboveIdx + 1) * WHITE_HEIGHT
  return {
    white: false,
    top: boundary - BLACK_HEIGHT / 2,
    height: BLACK_HEIGHT,
  }
}

function NumberField({
  label,
  value,
  min,
  max,
  step = 1,
  sensitivity = 1,
  onCommit,
}) {
  const [draft, setDraft] = useState(String(value))
  const focusedRef = useRef(false)

  useEffect(() => {
    if (!focusedRef.current) setDraft(String(value))
  }, [value])

  const commit = () => {
    const v = Number(draft)
    if (Number.isFinite(v)) {
      const clamped = Math.max(min, Math.min(max, Math.round(v)))
      onCommit(clamped)
      setDraft(String(clamped))
    } else {
      setDraft(String(value))
    }
  }

  const handleLabelDown = (e) => {
    e.preventDefault()
    const startX = e.clientX
    const startValue = value
    let moved = false
    const move = (mv) => {
      const dx = mv.clientX - startX
      if (!moved && Math.abs(dx) < 2) return
      moved = true
      const next = Math.max(
        min,
        Math.min(max, Math.round(startValue + dx * sensitivity))
      )
      if (next !== value) onCommit(next)
    }
    const up = () => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
      document.body.style.cursor = ''
    }
    document.body.style.cursor = 'ew-resize'
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
  }

  return (
    <label className="beats-control">
      <span
        className="beats-label draggable"
        onMouseDown={handleLabelDown}
        title="Drag horizontally to change"
      >
        {label}
      </span>
      <input
        type="number"
        className="beats-input"
        min={min}
        max={max}
        step={step}
        value={draft}
        onFocus={() => {
          focusedRef.current = true
        }}
        onBlur={() => {
          focusedRef.current = false
          commit()
        }}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.target.blur()
          } else if (e.key === 'Escape') {
            setDraft(String(value))
            e.target.blur()
          }
        }}
      />
    </label>
  )
}

function PlayIcon() {
  return (
    <svg width="12" height="14" viewBox="0 0 12 14" aria-hidden="true">
      <path d="M2 1 L11 7 L2 13 Z" fill="currentColor" />
    </svg>
  )
}

function BackIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
      <path
        d="M7 2 L3 6 L7 10"
        stroke="currentColor"
        strokeWidth="1.6"
        fill="none"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

function buildInitialPattern(scale, root) {
  const notes = new Set()
  if (!scale || scale.notes.length === 0) return notes
  const sorted = [...scale.notes].sort((a, b) => a - b)
  const baseRoot = 60 + root // C4 + root
  const n = sorted.length
  for (let b = 0; b < 16; b++) {
    const idx = b < n ? b : 2 * n - 2 - b
    if (idx < 0 || idx >= n) continue
    const midi = baseRoot + sorted[idx]
    notes.add(`${b}-${midi}`)
  }
  return notes
}

const VARIATION_FIELDS = [
  { key: 'tabby', label: 'Tabby order' },
  { key: 'direction', label: 'Direction' },
  { key: 'contour', label: 'Contour' },
  { key: 'sequence', label: 'Sequence' },
  { key: 'anchor', label: 'Anchor' },
]

function VariationPanel() {
  return (
    <aside className="variation-panel">
      <div className="label">Variation</div>
      <ul className="variation-list">
        {VARIATION_FIELDS.map((f) => (
          <li key={f.key} className="variation-row">
            <span className="variation-label">{f.label}</span>
            <span className="variation-control">—</span>
          </li>
        ))}
      </ul>
    </aside>
  )
}

export default function PianoRoll({ scale, root, onBack }) {
  const [notes, setNotes] = useState(() => buildInitialPattern(scale, root))
  const [totalBeats, setTotalBeats] = useState(DEFAULT_BEATS)
  const [bpm, setBpm] = useState(DEFAULT_BPM)
  const [swingPct, setSwingPct] = useState(DEFAULT_SWING)
  const [playheadBeat, setPlayheadBeat] = useState(null)
  const [freeMode, setFreeMode] = useState(false)
  const [metronome, setMetronome] = useState(false)
  const audioCtxRef = useRef(null)
  const playStateRef = useRef(null)
  const rafRef = useRef(null)
  const scrollRef = useRef(null)
  const dragRef = useRef(null)

  useEffect(() => {
    setNotes(buildInitialPattern(scale, root))
  }, [scale?.id, root])

  useEffect(() => {
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current)
      playStateRef.current = null
    }
  }, [])

  useEffect(() => {
    const handler = (e) => {
      const tag = e.target.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || e.target.isContentEditable) return
      if (e.code === 'Space') {
        e.preventDefault()
        togglePlay()
      } else if (e.code === 'Enter') {
        e.preventDefault()
        playFromStart()
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  })

  const getAudioContext = () => {
    if (!audioCtxRef.current) {
      const Ctx = window.AudioContext || window.webkitAudioContext
      audioCtxRef.current = new Ctx()
    }
    const ctx = audioCtxRef.current
    if (ctx.state === 'suspended') ctx.resume()
    return ctx
  }

  const playOneNote = (midi, startAt, duration = 0.22) => {
    const ctx = getAudioContext()
    const t = startAt ?? ctx.currentTime
    const freq = 440 * Math.pow(2, (midi - 69) / 12)
    const osc = ctx.createOscillator()
    const gain = ctx.createGain()
    osc.type = 'triangle'
    osc.frequency.value = freq
    osc.connect(gain)
    gain.connect(ctx.destination)
    gain.gain.setValueAtTime(0, t)
    gain.gain.linearRampToValueAtTime(0.22, t + 0.015)
    gain.gain.exponentialRampToValueAtTime(0.001, t + duration)
    osc.start(t)
    osc.stop(t + duration + 0.02)
  }

  const playClick = (startAt, accent = false) => {
    const ctx = getAudioContext()
    const t = startAt
    const osc = ctx.createOscillator()
    const gain = ctx.createGain()
    osc.type = 'sine'
    osc.frequency.value = accent ? 1800 : 1100
    osc.connect(gain)
    gain.connect(ctx.destination)
    gain.gain.setValueAtTime(0, t)
    gain.gain.linearRampToValueAtTime(accent ? 0.16 : 0.1, t + 0.002)
    gain.gain.exponentialRampToValueAtTime(0.001, t + 0.05)
    osc.start(t)
    osc.stop(t + 0.07)
  }

  const pitches = useMemo(() => {
    const list = []
    for (let m = MIDI_HIGH; m >= MIDI_LOW; m--) list.push(m)
    return list
  }, [])

  if (!scale) return null

  const inScale = (pc) =>
    scale.notes.some((n) => (n + root) % 12 === pc)

  const removeNote = (key) => {
    setNotes((prev) => {
      if (!prev.has(key)) return prev
      const next = new Set(prev)
      next.delete(key)
      return next
    })
  }

  const handleRowMouseDown = (e, midi) => {
    // Ignore mousedown on a child note — it has its own drag handler.
    if (e.target !== e.currentTarget) return
    const rect = e.currentTarget.getBoundingClientRect()
    const x = e.clientX - rect.left
    let beat = x / BEAT_WIDTH
    if (!freeMode) beat = Math.floor(beat)
    beat = Math.max(0, Math.min(totalBeats - 0.001, beat))
    const key = `${beat}-${midi}`
    setNotes((prev) => {
      const next = new Set(prev)
      next.add(key)
      return next
    })
    playOneNote(midi, undefined, 0.3)
  }

  const handleNoteMouseDown = (e, key, beat, midi) => {
    e.stopPropagation()
    e.preventDefault()
    const drag = {
      originalBeat: beat,
      originalMidi: midi,
      currentKey: key,
      lastMidi: midi,
      startX: e.clientX,
      startY: e.clientY,
      hasMoved: false,
    }
    dragRef.current = drag

    const move = (mv) => {
      if (!dragRef.current) return
      const dx = mv.clientX - drag.startX
      const dy = mv.clientY - drag.startY
      if (!drag.hasMoved && Math.abs(dx) < 3 && Math.abs(dy) < 3) return
      drag.hasMoved = true

      let newBeat = drag.originalBeat + dx / BEAT_WIDTH
      if (!freeMode) newBeat = Math.round(newBeat)
      newBeat = Math.max(0, Math.min(totalBeats - 0.001, newBeat))

      const midiDelta = -Math.round(dy / ROW_HEIGHT)
      let newMidi = drag.originalMidi + midiDelta
      newMidi = Math.max(MIDI_LOW, Math.min(MIDI_HIGH, newMidi))

      const newKey = `${newBeat}-${newMidi}`
      if (newKey === drag.currentKey) return

      // Capture the previous key locally before mutating the ref — the
      // setNotes updater may run after the mutation otherwise, which would
      // make us "delete" the new key (no-op) and leave the old one behind,
      // producing duplicates.
      const previousKey = drag.currentKey
      drag.currentKey = newKey
      setNotes((prev) => {
        const next = new Set(prev)
        next.delete(previousKey)
        next.add(newKey)
        return next
      })
      if (newMidi !== drag.lastMidi) {
        playOneNote(newMidi, undefined, 0.2)
        drag.lastMidi = newMidi
      }
    }

    const up = () => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
      document.body.style.cursor = ''
      if (!drag.hasMoved) removeNote(drag.currentKey)
      dragRef.current = null
    }

    document.body.style.cursor = 'grabbing'
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
  }

  const notesByMidi = useMemo(() => {
    const map = new Map()
    for (const key of notes) {
      const [beatStr, midiStr] = key.split('-')
      const midi = Number(midiStr)
      const beat = Number(beatStr)
      const arr = map.get(midi) ?? []
      arr.push({ key, beat })
      map.set(midi, arr)
    }
    return map
  }, [notes])

  const stopPlayback = (clearPlayhead = true) => {
    if (rafRef.current) {
      cancelAnimationFrame(rafRef.current)
      rafRef.current = null
    }
    playStateRef.current = null
    if (clearPlayhead) setPlayheadBeat(null)
  }

  // Each beat-cell is a 16th note. BPM is quarter-note tempo.
  const beatDurForBpm = (b) => 60 / b / 4

  const playFromBeat = (startBeat = 0) => {
    if (notes.size === 0 && !metronome) return
    stopPlayback(false)
    const ctx = getAudioContext()
    const cellDur = beatDurForBpm(bpm)
    const startBase = ctx.currentTime + 0.05
    const swing = swingPct
    const swungStart = applySwingBeat(startBeat, swing)
    let lastBeat = 0
    for (const key of notes) {
      const [beatStr, midiStr] = key.split('-')
      const beat = Number(beatStr)
      const midi = Number(midiStr)
      if (beat > lastBeat) lastBeat = beat
      if (beat >= startBeat) {
        const swungNoteStart = applySwingBeat(beat, swing)
        const swungNoteEnd = applySwingBeat(beat + 1, swing)
        const noteTime = startBase + (swungNoteStart - swungStart) * cellDur
        const noteDur = Math.max(0.06, (swungNoteEnd - swungNoteStart) * cellDur)
        playOneNote(midi, noteTime, noteDur)
      }
    }

    const endBeat = notes.size > 0 ? lastBeat + 1 : totalBeats

    // Metronome stays straight (no swing). Quarter notes = every 4 cells,
    // measure downbeats = every 16 cells get the accented click.
    if (metronome) {
      const CELLS_PER_BEAT = 4
      const CELLS_PER_MEASURE = 16
      const first = Math.ceil(startBeat / CELLS_PER_BEAT) * CELLS_PER_BEAT
      for (let b = first; b < endBeat; b += CELLS_PER_BEAT) {
        const clickTime = startBase + (b - startBeat) * cellDur
        playClick(clickTime, b % CELLS_PER_MEASURE === 0)
      }
    }

    playStateRef.current = {
      startTime: startBase,
      cellDur,
      swungStart,
      swungEnd: applySwingBeat(endBeat, swing),
      swingPct: swing,
      endBeat,
      offsetBeat: startBeat,
    }
    setPlayheadBeat(startBeat)

    const tick = () => {
      const state = playStateRef.current
      const ctx2 = audioCtxRef.current
      if (!state || !ctx2) return
      const elapsedTime = ctx2.currentTime - state.startTime
      const currentSwungBeat = state.swungStart + elapsedTime / state.cellDur
      if (currentSwungBeat >= state.swungEnd) {
        stopPlayback(true)
        return
      }
      const musicalBeat = unswingTimeBeat(currentSwungBeat, state.swingPct)
      const current = Math.max(0, musicalBeat)
      setPlayheadBeat(current)
      const sc = scrollRef.current
      if (sc) {
        const playheadX = current * BEAT_WIDTH + 86
        const margin = 80
        if (playheadX > sc.scrollLeft + sc.clientWidth - margin) {
          sc.scrollLeft = playheadX - sc.clientWidth + margin * 2
        } else if (playheadX < sc.scrollLeft + 86 + 4) {
          sc.scrollLeft = Math.max(0, playheadX - 86 - 4)
        }
      }
      rafRef.current = requestAnimationFrame(tick)
    }
    rafRef.current = requestAnimationFrame(tick)
  }

  const togglePlay = () => {
    if (playStateRef.current) {
      // playing → pause, keep playhead visible at current position
      stopPlayback(false)
    } else {
      // stopped → resume from playhead position, or from start if none
      playFromBeat(playheadBeat ?? 0)
    }
  }

  const playFromStart = () => {
    playFromBeat(0)
  }

  const seekFromTimelineEvent = (e) => {
    const rect = e.currentTarget.getBoundingClientRect()
    const x = e.clientX - rect.left
    const beat = Math.max(0, Math.min(totalBeats, x / BEAT_WIDTH))
    if (playStateRef.current) {
      // already playing → seek and continue playing from new position
      playFromBeat(beat)
    } else {
      setPlayheadBeat(beat)
    }
  }

  return (
    <div className="roll-view">
      <header className="roll-header">
        <button className="back-btn" onClick={onBack} aria-label="back to matrix">
          <BackIcon />
          <span>back</span>
        </button>
        <div className="roll-title">
          <span className="roll-number">{padId(scale.id)}</span>
          <span className="roll-divider">·</span>
          <span className="roll-name">rooted in {NOTE_DISPLAY[root]}</span>
        </div>
        <NumberField
          label="Tempo"
          value={bpm}
          min={MIN_BPM}
          max={MAX_BPM}
          sensitivity={0.5}
          onCommit={setBpm}
        />
        <NumberField
          label="Swing"
          value={swingPct}
          min={MIN_SWING}
          max={MAX_SWING}
          sensitivity={0.25}
          onCommit={setSwingPct}
        />
        <NumberField
          label="Beats"
          value={totalBeats}
          min={MIN_BEATS}
          max={MAX_BEATS}
          step={4}
          sensitivity={2}
          onCommit={setTotalBeats}
        />
        <button
          type="button"
          className={`mode-toggle ${metronome ? 'on' : ''}`}
          onClick={() => setMetronome((v) => !v)}
          aria-pressed={metronome}
          title="Metronome click on every quarter note (straight, ignores swing)"
        >
          Click
        </button>
        <button
          type="button"
          className={`mode-toggle ${freeMode ? 'on' : ''}`}
          onClick={() => setFreeMode((v) => !v)}
          aria-pressed={freeMode}
          title="Disable grid snapping — drop notes at any beat position"
        >
          Free
        </button>
        <button
          className="play roll-play"
          onClick={togglePlay}
          aria-label="play roll"
          title="Space: play/pause · Enter: play from start"
        >
          <PlayIcon />
        </button>
      </header>

      <div className="roll-body">
        <VariationPanel />
        <div className="roll-stage">
          <div className="roll-scroll" ref={scrollRef}>
            <div className="timeline">
              <div className="timeline-corner" />
              <div
                className="timeline-bar"
                style={{ width: totalBeats * BEAT_WIDTH }}
                onMouseDown={seekFromTimelineEvent}
                onMouseMove={(e) => {
                  if (e.buttons & 1) seekFromTimelineEvent(e)
                }}
              >
                {Array.from({ length: totalBeats }, (_, b) => {
                  if (b % 4 !== 0) return null
                  const isMeasure = b % 16 === 0
                  return (
                    <div
                      key={b}
                      className={`timeline-tick ${
                        isMeasure ? 'measure' : 'beat'
                      }`}
                      style={{ left: `${b * BEAT_WIDTH}px` }}
                    >
                      {isMeasure ? Math.floor(b / 16) + 1 : ''}
                    </div>
                  )
                })}
              </div>
            </div>
            <div className="roll-content">
              <div className="kbd-column">
                {pitches.map((midi) => {
                  const pc = midi % 12
                  const octave = midiToOctave(midi)
                  const pos = kbdPosition(midi)
                  const isRoot = pc === root
                  const isIn = inScale(pc)
                  const showOctaveLabel = pc === 0
                  return (
                    <div
                      key={midi}
                      className={`piano-key ${pos.white ? 'white' : 'black'} ${
                        isIn ? 'in' : ''
                      } ${isRoot ? 'is-root' : ''}`}
                      style={{ top: `${pos.top}px`, height: `${pos.height}px` }}
                    >
                      {pos.white && (
                        <span className="key-label">
                          {showOctaveLabel
                            ? `C${octave}`
                            : NOTE_DISPLAY[pc]}
                        </span>
                      )}
                    </div>
                  )
                })}
              </div>
              <div className="grid-area">
                {playheadBeat !== null && (
                  <div
                    className="playhead"
                    style={{
                      transform: `translateX(${playheadBeat * BEAT_WIDTH}px)`,
                    }}
                  />
                )}
                {pitches.map((midi) => {
                  const pc = midi % 12
                  const isWhite = WHITE_PCS.has(pc)
                  const isOctave = pc === 0
                  const isIn = inScale(pc)
                  const isRoot = pc === root
                  const rowNotes = notesByMidi.get(midi) ?? []
                  return (
                    <div
                      key={midi}
                      className={`grid-row ${isWhite ? 'white' : 'black'} ${
                        isOctave ? 'octave' : ''
                      } ${isIn ? 'in' : ''} ${isRoot ? 'is-root' : ''}`}
                    >
                      <div
                        className={`beats-track ${freeMode ? 'free' : ''}`}
                        style={{ width: totalBeats * BEAT_WIDTH }}
                        onMouseDown={(e) => handleRowMouseDown(e, midi)}
                      >
                        {rowNotes.map(({ key, beat }) => (
                          <div
                            key={key}
                            className="row-note"
                            style={{
                              left: `${beat * BEAT_WIDTH}px`,
                              width: `${BEAT_WIDTH}px`,
                            }}
                            onMouseDown={(e) =>
                              handleNoteMouseDown(e, key, beat, midi)
                            }
                          />
                        ))}
                      </div>
                    </div>
                  )
                })}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
