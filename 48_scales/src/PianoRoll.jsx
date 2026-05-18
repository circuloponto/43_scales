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
  const [playheadBeat, setPlayheadBeat] = useState(null)
  const audioCtxRef = useRef(null)
  const playStateRef = useRef(null)
  const rafRef = useRef(null)
  const scrollRef = useRef(null)

  useEffect(() => {
    setNotes(buildInitialPattern(scale, root))
  }, [scale?.id, root])

  useEffect(() => {
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current)
      playStateRef.current = null
    }
  }, [])

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

  const pitches = useMemo(() => {
    const list = []
    for (let m = MIDI_HIGH; m >= MIDI_LOW; m--) list.push(m)
    return list
  }, [])

  if (!scale) return null

  const inScale = (pc) =>
    scale.notes.some((n) => (n + root) % 12 === pc)

  const toggleNote = (beat, midi) => {
    const key = `${beat}-${midi}`
    const adding = !notes.has(key)
    setNotes((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
    if (adding) playOneNote(midi, undefined, 0.3)
  }

  const stopPlayback = () => {
    if (rafRef.current) {
      cancelAnimationFrame(rafRef.current)
      rafRef.current = null
    }
    playStateRef.current = null
    setPlayheadBeat(null)
  }

  const playRoll = () => {
    if (notes.size === 0) return
    stopPlayback()
    const ctx = getAudioContext()
    const beatDur = 0.22
    const startBase = ctx.currentTime + 0.05
    let lastBeat = 0
    for (const key of notes) {
      const [beatStr, midiStr] = key.split('-')
      const beat = Number(beatStr)
      const midi = Number(midiStr)
      if (beat > lastBeat) lastBeat = beat
      playOneNote(midi, startBase + beat * beatDur, beatDur)
    }

    playStateRef.current = {
      startTime: startBase,
      beatDur,
      endBeat: lastBeat + 1,
    }
    setPlayheadBeat(0)

    const tick = () => {
      const state = playStateRef.current
      const ctx2 = audioCtxRef.current
      if (!state || !ctx2) return
      const elapsed = ctx2.currentTime - state.startTime
      const beat = elapsed / state.beatDur
      if (beat >= state.endBeat) {
        stopPlayback()
        return
      }
      const current = Math.max(0, beat)
      setPlayheadBeat(current)
      // auto-scroll so the playhead stays visible
      const sc = scrollRef.current
      if (sc) {
        const playheadX = current * BEAT_WIDTH + 86 // + keyboard column width
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
        <label className="beats-control">
          <span className="beats-label">Beats</span>
          <input
            type="number"
            className="beats-input"
            min={MIN_BEATS}
            max={MAX_BEATS}
            step={4}
            value={totalBeats}
            onChange={(e) => {
              const v = Number(e.target.value)
              if (Number.isFinite(v))
                setTotalBeats(
                  Math.max(MIN_BEATS, Math.min(MAX_BEATS, Math.round(v)))
                )
            }}
          />
        </label>
        <button
          className="play roll-play"
          onClick={playRoll}
          aria-label="play roll"
        >
          <PlayIcon />
        </button>
      </header>

      <div className="roll-body">
        <VariationPanel />
        <div className="roll-stage">
          <div className="roll-scroll" ref={scrollRef}>
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
                  return (
                    <div
                      key={midi}
                      className={`grid-row ${isWhite ? 'white' : 'black'} ${
                        isOctave ? 'octave' : ''
                      } ${isIn ? 'in' : ''} ${isRoot ? 'is-root' : ''}`}
                    >
                      {Array.from({ length: totalBeats }, (_, b) => {
                        const here = notes.has(`${b}-${midi}`)
                        return (
                          <button
                            key={b}
                            type="button"
                            className={`beat-cell ${
                              b % 4 === 0 ? 'measure' : ''
                            } ${here ? 'has-note' : ''}`}
                            onClick={() => toggleNote(b, midi)}
                          >
                            {here && <div className="roll-note" />}
                          </button>
                        )
                      })}
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
