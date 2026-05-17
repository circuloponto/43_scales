import { useEffect, useMemo, useState } from 'react'

const NOTE_DISPLAY = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B']
const BLACK_PC = new Set([1, 3, 6, 8, 10])

// MIDI range shown in the roll. C2 = 36, B5 = 83. 4 octaves of pitches.
const MIDI_LOW = 36
const MIDI_HIGH = 83
const TOTAL_BEATS = 32

function padId(id) {
  return String(id).padStart(2, '0')
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

  // Reset notes when the scale or root changes.
  useEffect(() => {
    setNotes(buildInitialPattern(scale, root))
  }, [scale?.id, root])

  const pitches = useMemo(() => {
    const list = []
    for (let m = MIDI_HIGH; m >= MIDI_LOW; m--) list.push(m)
    return list
  }, [])

  if (!scale) return null

  const inScale = (pc) =>
    scale.notes.some((n) => (n + root) % 12 === pc)

  const toggleNote = (beat, midi) => {
    setNotes((prev) => {
      const key = `${beat}-${midi}`
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  const playRoll = () => {
    if (notes.size === 0) return
    const Ctx = window.AudioContext || window.webkitAudioContext
    const ctx = new Ctx()
    const beatDur = 0.2
    for (const key of notes) {
      const [beatStr, midiStr] = key.split('-')
      const beat = Number(beatStr)
      const midi = Number(midiStr)
      const freq = 440 * Math.pow(2, (midi - 69) / 12)
      const osc = ctx.createOscillator()
      const gain = ctx.createGain()
      osc.type = 'triangle'
      osc.frequency.value = freq
      osc.connect(gain)
      gain.connect(ctx.destination)
      const start = ctx.currentTime + beat * beatDur
      const end = start + beatDur
      gain.gain.setValueAtTime(0, start)
      gain.gain.linearRampToValueAtTime(0.2, start + 0.015)
      gain.gain.exponentialRampToValueAtTime(0.001, end)
      osc.start(start)
      osc.stop(end + 0.02)
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
          <div className="roll-scroll">
            {pitches.map((midi) => {
              const pc = midi % 12
              const octave = Math.floor(midi / 12) - 1
              const isBlack = BLACK_PC.has(pc)
              const isRoot = pc === root
              const isIn = inScale(pc)
              const isOctaveBoundary = pc === 0
              return (
                <div
                  key={midi}
                  className={`pitch-row ${isBlack ? 'black' : 'white'} ${
                    isIn ? 'in' : ''
                  } ${isRoot ? 'is-root' : ''} ${
                    isOctaveBoundary ? 'octave' : ''
                  }`}
                >
                  <div className="kbd-key">
                    <span className="key-label">
                      {pc === 0 ? `C${octave}` : NOTE_DISPLAY[pc]}
                    </span>
                  </div>
                  <div className="beats-row">
                    {Array.from({ length: TOTAL_BEATS }, (_, b) => {
                      const here = notes.has(`${b}-${midi}`)
                      return (
                        <button
                          key={b}
                          type="button"
                          className={`beat-cell ${
                            b % 4 === 0 ? 'measure' : ''
                          } ${here ? 'has-note' : ''}`}
                          onClick={() => toggleNote(b, midi)}
                          aria-label={`beat ${b + 1}, ${NOTE_DISPLAY[pc]}${octave}`}
                        >
                          {here && <div className="roll-note" />}
                        </button>
                      )
                    })}
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      </div>
    </div>
  )
}
