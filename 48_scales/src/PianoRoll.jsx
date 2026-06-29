import { useEffect, useMemo, useRef, useState } from 'react'
import { Magnet, Camera, Repeat, Metronome } from 'lucide-react'
import { rootSteps } from './scales'
import { chordPairs } from './chordPairs'
import { resolveChordPair, pcName } from './chordVocab'

const NOTE_NAMES_SHARP = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B']
const NOTE_NAMES_FLAT  = ['C', 'D♭', 'D', 'E♭', 'E', 'F', 'G♭', 'G', 'A♭', 'A', 'B♭', 'B']
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

// MIDI range — full 88-key piano: A0 to C8.
const MIDI_LOW = 21 // A0
const MIDI_HIGH = 108 // C8
const TOP_OCTAVE = Math.floor(MIDI_HIGH / 12) - 1 // 8

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

// Each MIDI row in the keyboard column occupies exactly one ROW_HEIGHT, so
// the keyboard and the grid are pixel-perfectly aligned at every semitone.
// White keys fill the column's full width; black keys are narrower and
// right-aligned, so the layout still reads as a piano without the visual
// overlap drift that came from mixing white-key spacing with semitone rows.
const KBD_COLUMN_HEIGHT = (MIDI_HIGH - MIDI_LOW + 1) * ROW_HEIGHT

function kbdPosition(midi) {
  const pc = midi % 12
  return {
    white: WHITE_PCS.has(pc),
    top: (MIDI_HIGH - midi) * ROW_HEIGHT,
    height: ROW_HEIGHT,
  }
}

// Pretty pitch label factory: returns a function that prints "C4", "F♯7",
// etc. using scientific octave numbering. Sharps vs. flats picked from the
// useFlats flag so the popup follows the global setting.
function makeMidiPitchLabel(useFlats) {
  const names = useFlats ? NOTE_NAMES_FLAT : NOTE_NAMES_SHARP
  return (midi) => {
    const pc = ((midi % 12) + 12) % 12
    const octave = Math.floor(midi / 12) - 1
    return names[pc] + octave
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
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', up)
      document.body.style.cursor = ''
    }
    document.body.style.cursor = 'ew-resize'
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', up)
  }

  return (
    // Use a div, not a <label>, so a mousedown on the draggable span doesn't
    // implicitly focus the input — which otherwise interrupts the horizontal
    // scrub gesture as soon as the cursor crosses the input element.
    <div className="beats-control">
      <span
        className="beats-label draggable"
        onPointerDown={handleLabelDown}
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
        aria-label={label}
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
    </div>
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

// notes is a Map<string, number>:
//   key   = `${beat}-${midi}`  (unique position)
//   value = length in cells (default 1)
function buildInitialPattern(scale, root) {
  const notes = new Map()
  if (!scale || scale.notes.length === 0) return notes
  const sorted = [...scale.notes].sort((a, b) => a - b)
  const baseRoot = 72 + root // C5 + root — leaves the C3-C4 range free for chord drops
  const sequence = [...sorted, sorted[0] + 12]
  sequence.forEach((offset, b) => {
    notes.set(`${b}-${baseRoot + offset}`, 1)
  })
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

export default function PianoRoll({
  scale: rawScale,
  root,
  onBack,
  templates = [],
  setTemplates,
  modeStep = null,
  settings = {},
}) {
  const allowOutOfScale = !!settings.allowOutOfScale
  const useFlats = !!settings.useFlats
  // Note-label arrays follow the global accidental setting so every label
  // (keyboard column, pattern row, hover tooltip, chord card, etc.) flips
  // between sharps and flats together.
  const NOTE_DISPLAY = useFlats ? NOTE_NAMES_FLAT : NOTE_NAMES_SHARP
  const midiPitchLabel = makeMidiPitchLabel(useFlats)
  const noteName = (pc) => pcName(pc, useFlats)
  // Rotate the scale by its rootStep so the displayed scale here matches the
  // right-panel view in the matrix screen: the intrinsic-root degree sits at
  // pc 0 of `scale.notes`. Every downstream piece — inScale, nearestScaleMidi,
  // buildInitialPattern, the chord catalog generator, template apply, the
  // scale-bar pattern — uses `scale` (this rotated version), so chord-pair
  // colors align cleanly with the on-cells.
  const _rsRoll = rawScale ? modeStep ?? rootSteps[rawScale.id - 1] : null
  const _intrinsicPcRoll =
    rawScale && _rsRoll ? rawScale.notes[_rsRoll - 1] : 0
  // Sort the rotated notes ascending so scale.notes[i] is the i-th scale
  // degree in pitch order. midiToScaleStep relies on this ordering to give
  // monotone step indices (otherwise stepping across the rotation seam
  // jumps a full octave).
  const scale = rawScale
    ? {
        ...rawScale,
        notes: rawScale.notes
          .map((n) => (n - _intrinsicPcRoll + 12) % 12)
          .sort((a, b) => a - b),
      }
    : null
  const [notes, setNotes] = useState(() => buildInitialPattern(scale, root))
  const [totalBeats, setTotalBeats] = useState(DEFAULT_BEATS)
  const [bpm, setBpm] = useState(DEFAULT_BPM)
  const [swingPct, setSwingPct] = useState(DEFAULT_SWING)
  const [playheadBeat, setPlayheadBeat] = useState(null)
  const [freeMode, setFreeMode] = useState(false)
  const [metronome, setMetronome] = useState(false)
  const [selectedKeys, setSelectedKeys] = useState(() => new Set())
  const [marquee, setMarquee] = useState(null)
  const [loop, setLoop] = useState(null)
  const [captureOpen, setCaptureOpen] = useState(false)
  const [captureName, setCaptureName] = useState('')
  const [exportFeedback, setExportFeedback] = useState('')
  const [chordModalOpen, setChordModalOpen] = useState(false)
  // Floating pitch label that follows the cursor while hovering a row-note.
  const [notePitchTip, setNotePitchTip] = useState(null)
  // Mobile-only UI state. Desktop ignores these via CSS.
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false)
  const [mobileDrawerOpen, setMobileDrawerOpen] = useState(false)
  // Visible badge that lights up while T is held so the user can see that
  // ArrowUp/Down do a pitch rotation instead of the regular step nudge.
  const [tHeld, setTHeld] = useState(false)
  const audioCtxRef = useRef(null)
  const playStateRef = useRef(null)
  const rafRef = useRef(null)
  const scheduledVoicesRef = useRef([])
  const scrollRef = useRef(null)
  const dragRef = useRef(null)
  const marqueeRef = useRef(null)
  const historyRef = useRef([])
  const futureRef = useRef([])
  const clipboardRef = useRef(null)
  const notesRef = useRef(notes)
  notesRef.current = notes
  // Live refs for state read by the loop scheduler so edits during playback
  // (note add/remove/move, metronome toggle, swing change) propagate to the
  // next iteration without restarting playback.
  const metronomeRef = useRef(metronome)
  metronomeRef.current = metronome
  const swingPctRef = useRef(swingPct)
  swingPctRef.current = swingPct
  const loopRef = useRef(loop)
  loopRef.current = loop
  // Last non-null loop the user had. Stashed every time `loop` is set to
  // a valid region, so the toolbar Loop button can re-toggle it back on
  // after the user clears it.
  const lastLoopRef = useRef(null)
  useEffect(() => {
    if (loop) lastLoopRef.current = loop
  }, [loop])
  const gridAreaRef = useRef(null)
  // Last length the user set on a note (via resize). Newly-placed notes
  // inherit it so the user can pick a duration once and keep adding notes
  // at that length without re-resizing each one.
  const defaultNoteLengthRef = useRef(1)
  // `T` is a held modifier: while it's down, ArrowUp/Down rotate the
  // selection's pitches instead of nudging them by a scale step.
  const tHeldRef = useRef(false)

  useEffect(() => {
    const initial = buildInitialPattern(scale, root)
    setNotes(initial)
    historyRef.current = []
    futureRef.current = []
    setSelectedKeys(new Set())
    // Scroll the roll vertically so the initial notes sit roughly in the
    // middle of the viewport. With the 88-key range this avoids dropping
    // the user at the top of an empty C8 area.
    requestAnimationFrame(() => {
      const sc = scrollRef.current
      if (!sc) return
      let avgMidi = 60 + root
      if (initial.size > 0) {
        let sum = 0
        for (const [k] of initial) sum += Number(k.split('-')[1])
        avgMidi = sum / initial.size
      }
      const targetTop = (MIDI_HIGH - avgMidi) * ROW_HEIGHT
      sc.scrollTop = Math.max(0, targetTop - sc.clientHeight / 2 + ROW_HEIGHT / 2)
    })
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
      const meta = e.ctrlKey || e.metaKey
      const k = (e.key || '').toLowerCase()
      // Ctrl/Cmd + Shift + Z → redo. Plain Ctrl/Cmd + Z → undo.
      if (meta && (e.code === 'KeyZ' || k === 'z')) {
        e.preventDefault()
        if (e.shiftKey) redo()
        else undo()
      } else if (
        meta &&
        (e.code === 'KeyY' || e.code === 'KeyX' || k === 'y' || k === 'x')
      ) {
        e.preventDefault()
        redo()
      } else if (meta && e.code === 'KeyC') {
        e.preventDefault()
        copyNotes()
      } else if (meta && !e.shiftKey && e.code === 'KeyV') {
        // Ctrl/Cmd+V → paste. With Shift held this branch is skipped so the
        // gesture can fall through to the flipVertical handler below.
        e.preventDefault()
        pasteNotes()
      } else if (meta && (e.code === 'KeyA' || k === 'a')) {
        e.preventDefault()
        setSelectedKeys(new Set(notesRef.current.keys()))
      } else if (e.code === 'Space') {
        e.preventDefault()
        togglePlay()
      } else if (e.code === 'Enter') {
        // Reset the playhead to beat 0. If currently playing, stop first so
        // the rAF doesn't immediately overwrite the position. Space resumes
        // from the new playhead.
        e.preventDefault()
        if (playStateRef.current) stopPlayback(false)
        setPlayheadBeat(0)
      } else if (e.code === 'Delete' || e.code === 'Backspace') {
        if (selectedKeys.size > 0) {
          e.preventDefault()
          pushHistory()
          setNotes((prev) => {
            const next = new Map(prev)
            for (const k of selectedKeys) next.delete(k)
            return next
          })
          setSelectedKeys(new Set())
        }
      } else if (e.code === 'Escape') {
        if (selectedKeys.size > 0) setSelectedKeys(new Set())
        if (chordModalOpen) setChordModalOpen(false)
        if (loop) setLoop(null)
        if (tHeldRef.current) {
          tHeldRef.current = false
          setTHeld(false)
        }
      } else if (e.shiftKey && e.code === 'KeyH') {
        e.preventDefault()
        flipHorizontal()
      } else if (e.shiftKey && e.code === 'KeyV') {
        e.preventDefault()
        flipVertical()
      } else if (e.code === 'BracketRight') {
        e.preventDefault()
        growSelection()
      } else if (e.code === 'BracketLeft') {
        e.preventDefault()
        shrinkSelection()
      } else if (e.code === 'KeyT') {
        // Toggle: press T to enter Rotate mode (badge stays lit, arrow
        // keys rotate the selection's pitches). Press T again to exit.
        if (!e.repeat) {
          tHeldRef.current = !tHeldRef.current
          setTHeld(tHeldRef.current)
        }
      } else if (e.code === 'ArrowUp' && selectedKeys.size > 0) {
        e.preventDefault()
        if (tHeldRef.current) rotateSelection(1)
        else nudgeSelection(0, 1)
      } else if (e.code === 'ArrowDown' && selectedKeys.size > 0) {
        e.preventDefault()
        if (tHeldRef.current) rotateSelection(-1)
        else nudgeSelection(0, -1)
      } else if (e.code === 'ArrowRight' && selectedKeys.size > 0) {
        e.preventDefault()
        nudgeSelection(1, 0)
      } else if (e.code === 'ArrowLeft' && selectedKeys.size > 0) {
        e.preventDefault()
        nudgeSelection(-1, 0)
      }
    }
    window.addEventListener('keydown', handler)
    return () => {
      window.removeEventListener('keydown', handler)
    }
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

  const playOneNote = (midi, startAt, duration = 0.22, peakGain = 0.22) => {
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
    gain.gain.linearRampToValueAtTime(peakGain, t + 0.015)
    gain.gain.exponentialRampToValueAtTime(0.001, t + duration)
    osc.start(t)
    osc.stop(t + duration + 0.02)
    scheduledVoicesRef.current.push({ osc, gain })
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
    scheduledVoicesRef.current.push({ osc, gain })
  }

  const killScheduledVoices = () => {
    const voices = scheduledVoicesRef.current
    scheduledVoicesRef.current = []
    const ctx = audioCtxRef.current
    if (!ctx) return
    const now = ctx.currentTime
    for (const { osc, gain } of voices) {
      try {
        gain.gain.cancelScheduledValues(now)
        gain.gain.setValueAtTime(gain.gain.value, now)
        gain.gain.linearRampToValueAtTime(0, now + 0.02)
      } catch {}
      try { osc.stop(now + 0.03) } catch {}
      try { osc.disconnect() } catch {}
      try { gain.disconnect() } catch {}
    }
  }

  const pitches = useMemo(() => {
    const list = []
    for (let m = MIDI_HIGH; m >= MIDI_LOW; m--) list.push(m)
    return list
  }, [])

  if (!scale) return null

  const inScale = (pc) =>
    scale.notes.some((n) => (n + root) % 12 === pc)

  // Chord-pair membership for coloring. Resolved chord notes are absolute pcs
  // (transposed by `root`); we just need them as Sets so the render code can
  // tag each piano key, grid row, and note block by which chord it belongs to.
  // We pass rawScale.notes (unrotated) here because resolveChordPair rotates
  // internally by rootStep — feeding it the already-rotated set would
  // double-rotate.
  const _pair = chordPairs.find((p) => p.scaleId === rawScale.id)
  const _resolved = _pair
    ? resolveChordPair(_pair, rawScale.notes, root, _rsRoll)
    : null
  const leftChordPcs = new Set(_resolved ? _resolved.leftNotes : [])
  const rightChordPcs = new Set(_resolved ? _resolved.rightNotes : [])
  const chordClassFor = (pc) => {
    const inL = leftChordPcs.has(pc)
    const inR = rightChordPcs.has(pc)
    if (inL && inR) return 'chord-both'
    if (inL) return 'chord-left'
    if (inR) return 'chord-right'
    if (!inScale(pc)) return 'chord-electron'
    return ''
  }

  // Chord-pair palette: 4 inversions of each of the scale's two chord
  // shapes, anchored at C3 (MIDI 48) so chords sit one octave below the
  // C4-based melody pattern. Each entry carries its 4 MIDI notes ready to
  // drop into the grid.
  const CHORD_BASE_MIDI = 48 // C3
  const chordPalette = useMemo(() => {
    if (!_resolved) return []
    const buildInversion = (pcs, inv) => {
      // pcs are in chord-degree order (root, 3rd, 5th, 7th). Rotate by `inv`
      // so the inversion's bass comes first, then build ascending MIDIs.
      const rotated = [...pcs.slice(inv), ...pcs.slice(0, inv)]
      const midis = []
      for (let i = 0; i < rotated.length; i++) {
        const pc = rotated[i]
        let m = Math.floor(CHORD_BASE_MIDI / 12) * 12 + pc
        if (m < CHORD_BASE_MIDI) m += 12
        while (i > 0 && m <= midis[i - 1]) m += 12
        midis.push(m)
      }
      return midis
    }
    const side = (which, chordLabel, pcs, rootPc) => {
      return [0, 1, 2, 3].map((inv) => {
        const midis = buildInversion(pcs, inv)
        const bassPc = midis[0] % 12
        return {
          id: `${which}-inv-${inv}`,
          side: which,
          inversion: inv,
          midis,
          chordLabel,
          rootName: pcName(rootPc, useFlats),
          bassName: pcName(bassPc, useFlats),
        }
      })
    }
    return [
      ...side('left', _pair.left, _resolved.leftNotes, _resolved.leftRoot),
      ...side('right', _pair.right, _resolved.rightNotes, _resolved.rightRoot),
    ]
  }, [_resolved, _pair, useFlats])

  // Map a MIDI value (assumed to be on-scale) to a global scale-step index
  // = octave * scale.notes.length + degree. Step indices are monotone in
  // MIDI within a single root/scale, so subtracting two of them gives the
  // number of scale steps between the two pitches.
  const midiToScaleStep = (midi) => {
    const pc = ((midi % 12) + 12) % 12
    const n = scale.notes.length
    for (let s = 0; s < n; s++) {
      if (((scale.notes[s] + root) % 12 + 12) % 12 === pc) {
        const total = scale.notes[s] + root
        const wrap = Math.floor(total / 12)
        const baseMidi = ((total % 12) + 12) % 12
        const oct = (midi - baseMidi) / 12 - wrap
        return oct * n + s
      }
    }
    return null
  }

  // Inverse of midiToScaleStep. Accepts any integer index (negative or
  // overflowing) and resolves it to the corresponding MIDI value.
  const scaleStepToMidi = (idx) => {
    const n = scale.notes.length
    const s = ((idx % n) + n) % n
    const oct = Math.floor((idx - s) / n)
    const total = scale.notes[s] + root
    const wrap = Math.floor(total / 12)
    const baseMidi = ((total % 12) + 12) % 12
    return baseMidi + (oct + wrap) * 12
  }

  // Snap a MIDI value to the nearest pitch that belongs to the current scale.
  const nearestScaleMidi = (midi) => {
    const clamped = Math.max(MIDI_LOW, Math.min(MIDI_HIGH, midi))
    if (inScale(clamped % 12)) return clamped
    for (let d = 1; d < 12; d++) {
      if (clamped + d <= MIDI_HIGH && inScale((clamped + d) % 12))
        return clamped + d
      if (clamped - d >= MIDI_LOW && inScale(((clamped - d) % 12 + 12) % 12))
        return clamped - d
    }
    return clamped
  }

  const snapshotState = () => ({
    notes: new Map(notesRef.current),
  })

  const restoreSnapshot = (snap) => {
    setNotes(snap.notes)
    setSelectedKeys(new Set())
  }

  const pushHistory = (snapshot) => {
    historyRef.current.push(snapshot ?? snapshotState())
    if (historyRef.current.length > 200) historyRef.current.shift()
    futureRef.current = []
  }

  const undo = () => {
    if (historyRef.current.length === 0) return
    const prev = historyRef.current.pop()
    futureRef.current.push(snapshotState())
    if (futureRef.current.length > 200) futureRef.current.shift()
    restoreSnapshot(prev)
  }

  const redo = () => {
    if (futureRef.current.length === 0) return
    const next = futureRef.current.pop()
    historyRef.current.push(snapshotState())
    if (historyRef.current.length > 200) historyRef.current.shift()
    restoreSnapshot(next)
  }

  const copyNotes = () => {
    if (selectedKeys.size === 0) return
    let minBeat = Infinity
    let maxEndBeat = -Infinity
    const items = []
    for (const key of selectedKeys) {
      const [beatStr, midiStr] = key.split('-')
      const b = Number(beatStr)
      const length = notes.get(key) ?? 1
      items.push({ beat: b, midi: Number(midiStr), length })
      if (b < minBeat) minBeat = b
      if (b + length > maxEndBeat) maxEndBeat = b + length
    }
    clipboardRef.current = {
      items: items.map((it) => ({
        relBeat: it.beat - minBeat,
        midi: it.midi,
        length: it.length,
      })),
      sourceMinBeat: minBeat,
      sourceWidth: maxEndBeat - minBeat,
    }
  }

  // Convert each note in the roll to a { beat, degree, octave } record,
  // where degree is the position within the parent scale (0..7) and octave
  // is the offset in octaves from the root + C4 base. Notes outside the
  // current scale are skipped — the template only tracks scale degrees so it
  // can be reapplied to any other scale's note set.
  const captureCurrentTemplate = () => {
    if (!scale) return []
    const baseRoot = 60 + root
    const items = []
    for (const [key, length] of notesRef.current) {
      const [beatStr, midiStr] = key.split('-')
      const beat = Number(beatStr)
      const midi = Number(midiStr)
      const pcRelative = ((midi - root) % 12 + 12) % 12
      const degree = scale.notes.indexOf(pcRelative)
      if (degree === -1) continue
      const octave = Math.round((midi - baseRoot - scale.notes[degree]) / 12)
      items.push({ beat, degree, octave, length })
    }
    return items
  }

  const saveCurrentAsTemplate = () => {
    if (!setTemplates) return
    const items = captureCurrentTemplate()
    if (items.length === 0) {
      setCaptureOpen(false)
      return
    }
    const tpl = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      name: captureName.trim() || `Template ${templates.length + 1}`,
      capturedFrom: { scaleId: scale.id, root },
      notes: items,
    }
    setTemplates([...templates, tpl])
    setCaptureOpen(false)
    setCaptureName('')
  }

  // Resolve a template's scale degrees back to absolute MIDI using the
  // current scale + root. Notes whose degree exceeds the current scale
  // length, or whose computed MIDI lands outside the visible range, are
  // skipped silently.
  const applyTemplate = (tpl) => {
    if (!scale || !tpl) return
    const baseRoot = 60 + root
    const next = new Map()
    for (const item of tpl.notes) {
      if (item.degree < 0 || item.degree >= scale.notes.length) continue
      const midi = baseRoot + scale.notes[item.degree] + item.octave * 12
      if (midi < MIDI_LOW || midi > MIDI_HIGH) continue
      next.set(`${item.beat}-${midi}`, item.length ?? 1)
    }
    pushHistory()
    setNotes(next)
    setSelectedKeys(new Set())
  }

  const deleteTemplate = (id) => {
    if (!setTemplates) return
    setTemplates(templates.filter((t) => t.id !== id))
  }

  const exportTemplates = async () => {
    if (templates.length === 0) return
    const code = `export const templates = ${JSON.stringify(templates, null, 2)}\n`
    try {
      await navigator.clipboard.writeText(code)
      setExportFeedback('Copied')
    } catch (e) {
      // Fallback for non-secure contexts
      const ta = document.createElement('textarea')
      ta.value = code
      document.body.appendChild(ta)
      ta.select()
      try {
        document.execCommand('copy')
        setExportFeedback('Copied')
      } catch (_) {
        setExportFeedback('Failed')
      } finally {
        document.body.removeChild(ta)
      }
    }
    setTimeout(() => setExportFeedback(''), 1600)
  }

  // Click a chord card → insert the chord at the current playhead position.
  // 4 notes (the chord voicing) are added to the grid, anchored at C3 so
  // they sit one octave below the C4-based melody.
  const insertChordAtPlayhead = (entry) => {
    if (!entry) return
    const rawBeat = playheadBeat ?? 0
    let beat = freeMode ? rawBeat : Math.round(rawBeat)
    beat = Math.max(0, Math.min(totalBeats - 1, beat))
    pushHistory()
    const length = 4
    const addedKeys = new Set()
    setNotes((prev) => {
      const next = new Map(prev)
      for (const m of entry.midis) {
        const key = `${beat}-${m}`
        next.set(key, length)
        addedKeys.add(key)
      }
      return next
    })
    setSelectedKeys(addedKeys)
  }

  // Reverse the order of selected notes in time — the bounding range
  // [minStart, maxEnd] stays the same, each note's end becomes the new
  // note's start in the mirrored position. Pitch + length are preserved.
  const flipHorizontal = () => {
    if (selectedKeys.size === 0) return
    let minStart = Infinity
    let maxEnd = -Infinity
    for (const key of selectedKeys) {
      const [beatStr] = key.split('-')
      const b = Number(beatStr)
      const length = notesRef.current.get(key) ?? 1
      if (b < minStart) minStart = b
      if (b + length > maxEnd) maxEnd = b + length
    }
    pushHistory()
    const newSel = new Set()
    setNotes((prev) => {
      const next = new Map(prev)
      for (const key of selectedKeys) next.delete(key)
      for (const key of selectedKeys) {
        const [beatStr, midiStr] = key.split('-')
        const b = Number(beatStr)
        const length = notesRef.current.get(key) ?? 1
        const newB = minStart + maxEnd - (b + length)
        const newKey = `${newB}-${midiStr}`
        next.set(newKey, length)
        newSel.add(newKey)
      }
      return next
    })
    setSelectedKeys(newSel)
  }

  // Flip the selected notes around the midpoint of their pitch range.
  // Pure-scale selections invert by scale-step (bijection that stays on
  // the scale). Selections containing any off-scale note invert
  // chromatically (newMidi = midiSum - oldMidi) — also bijective, but
  // preserves the chromatic positions rather than snapping anything to
  // the scale and risking collisions.
  const flipVertical = () => {
    if (selectedKeys.size === 0) return
    const records = []
    let minStep = Infinity
    let maxStep = -Infinity
    let minMidi = Infinity
    let maxMidi = -Infinity
    let anyOffScale = false
    for (const key of selectedKeys) {
      const [beatStr, midiStr] = key.split('-')
      const m = Number(midiStr)
      const length = notesRef.current.get(key) ?? 1
      const step = midiToScaleStep(m)
      records.push({ key, beatStr, midi: m, length, step })
      if (m < minMidi) minMidi = m
      if (m > maxMidi) maxMidi = m
      if (step != null) {
        if (step < minStep) minStep = step
        if (step > maxStep) maxStep = step
      } else {
        anyOffScale = true
      }
    }
    const useChromatic = anyOffScale || minStep === Infinity
    const stepSum = !useChromatic ? minStep + maxStep : 0
    const midiSum = minMidi + maxMidi
    pushHistory()
    const newSel = new Set()
    setNotes((prev) => {
      const next = new Map(prev)
      for (const r of records) next.delete(r.key)
      for (const r of records) {
        let newMidi
        if (!useChromatic) {
          newMidi = scaleStepToMidi(stepSum - r.step)
        } else {
          newMidi = midiSum - r.midi
        }
        const newKey = `${r.beatStr}-${newMidi}`
        next.set(newKey, r.length)
        newSel.add(newKey)
      }
      return next
    })
    setSelectedKeys(newSel)
  }

  // Grow each selected note symmetrically — beat - 1 on the left and
  // length + 2 on the right — clamped to the timeline. Notes already at
  // beat 0 only grow rightward; notes whose right edge would pass
  // totalBeats only grow leftward.
  // Rotate the pitches of the selected sequence one slot, keeping the
  // beat slots fixed. T+Up: the note at the lowest beat is transposed +1
  // octave and becomes the latest pitch — every other pitch shifts one
  // beat-slot earlier. T+Down: mirror — the latest-beat note drops -1
  // octave and becomes the earliest. Lengths follow their pitch so the
  // shape of the rotated sequence stays intact.
  const rotateSelection = (direction) => {
    if (selectedKeys.size < 2) return
    const sorted = [...selectedKeys]
      .map((k) => {
        const [bStr, mStr] = k.split('-')
        return {
          key: k,
          beat: Number(bStr),
          midi: Number(mStr),
          length: notesRef.current.get(k) ?? 1,
        }
      })
      .sort((a, b) => a.beat - b.beat || a.midi - b.midi)
    const n = sorted.length
    const beats = sorted.map((s) => s.beat)
    const midis = sorted.map((s) => s.midi)
    const lengths = sorted.map((s) => s.length)
    let newMidis, newLengths
    if (direction === 1) {
      // Lowest-beat pitch goes up an octave and becomes the latest pitch.
      newMidis = [...midis.slice(1), midis[0] + 12]
      newLengths = [...lengths.slice(1), lengths[0]]
    } else {
      // Latest-beat pitch goes down an octave and becomes the earliest.
      newMidis = [midis[n - 1] - 12, ...midis.slice(0, n - 1)]
      newLengths = [lengths[n - 1], ...lengths.slice(0, n - 1)]
    }
    // Bail out if any rotated pitch would leave the keyboard range.
    if (newMidis.some((m) => m < MIDI_LOW || m > MIDI_HIGH)) return
    pushHistory()
    const newSel = new Set()
    setNotes((prev) => {
      const next = new Map(prev)
      for (const s of sorted) next.delete(s.key)
      for (let i = 0; i < n; i++) {
        const newKey = `${beats[i]}-${newMidis[i]}`
        next.set(newKey, newLengths[i])
        newSel.add(newKey)
      }
      return next
    })
    setSelectedKeys(newSel)
  }

  // Keyboard nudge for the selection. `beatDelta` shifts horizontally on
  // the grid; `stepDelta` shifts vertically by scale steps. Both clamp to
  // the timeline + MIDI bounds. Notes that aren't on a scale step (free
  // mode) fall back to ±1 semitone for stepDelta so they still move.
  const nudgeSelection = (beatDelta, stepDelta) => {
    if (selectedKeys.size === 0) return
    pushHistory()
    const newSel = new Set()
    setNotes((prev) => {
      const next = new Map(prev)
      const moves = []
      for (const k of selectedKeys) {
        const [bStr, midiStr] = k.split('-')
        const oldBeat = Number(bStr)
        const oldMidi = Number(midiStr)
        const len = prev.get(k) ?? 1
        let newBeat = oldBeat + beatDelta
        newBeat = Math.max(0, Math.min(totalBeats - len, newBeat))
        let newMidi = oldMidi
        if (stepDelta !== 0) {
          const gStep = midiToScaleStep(oldMidi)
          newMidi =
            gStep != null
              ? scaleStepToMidi(gStep + stepDelta)
              : nearestScaleMidi(oldMidi + stepDelta)
        }
        newMidi = Math.max(MIDI_LOW, Math.min(MIDI_HIGH, newMidi))
        moves.push({ oldKey: k, newKey: `${newBeat}-${newMidi}`, length: len })
      }
      for (const m of moves) next.delete(m.oldKey)
      for (const m of moves) {
        next.set(m.newKey, m.length)
        newSel.add(m.newKey)
      }
      return next
    })
    setSelectedKeys(newSel)
  }

  const growSelection = () => {
    if (selectedKeys.size === 0) return
    pushHistory()
    const newSel = new Set()
    setNotes((prev) => {
      const next = new Map(prev)
      for (const key of selectedKeys) next.delete(key)
      for (const key of selectedKeys) {
        const [bStr, midiStr] = key.split('-')
        const oldBeat = Number(bStr)
        const oldLength = notesRef.current.get(key) ?? 1
        const grownLeft = Math.max(0, oldBeat - 1)
        const grownEnd = Math.min(totalBeats, oldBeat + oldLength + 1)
        const newKey = `${grownLeft}-${midiStr}`
        next.set(newKey, grownEnd - grownLeft)
        newSel.add(newKey)
      }
      return next
    })
    setSelectedKeys(newSel)
  }

  // Shrink each selected note symmetrically — beat + 1 on the left and
  // length - 2 on the right. Stops shrinking when the note is at minimum
  // length so we don't drop it.
  const shrinkSelection = () => {
    if (selectedKeys.size === 0) return
    pushHistory()
    const newSel = new Set()
    const minLen = freeMode ? 0.25 : 1
    setNotes((prev) => {
      const next = new Map(prev)
      for (const key of selectedKeys) next.delete(key)
      for (const key of selectedKeys) {
        const [bStr, midiStr] = key.split('-')
        const oldBeat = Number(bStr)
        const oldLength = notesRef.current.get(key) ?? 1
        // If length is already at min, leave the note unchanged. Otherwise
        // squeeze a cell off each end if there's room; if only one side has
        // room, squeeze that side.
        if (oldLength <= minLen) {
          next.set(`${oldBeat}-${midiStr}`, oldLength)
          newSel.add(`${oldBeat}-${midiStr}`)
          continue
        }
        let newBeat = oldBeat
        let newLength = oldLength
        if (newLength - 2 >= minLen) {
          newBeat = oldBeat + 1
          newLength = oldLength - 2
        } else {
          // Only one cell to shave off — take it from the right.
          newLength = oldLength - 1
        }
        const newKey = `${newBeat}-${midiStr}`
        next.set(newKey, newLength)
        newSel.add(newKey)
      }
      return next
    })
    setSelectedKeys(newSel)
  }

  const pasteNotes = () => {
    const clip = clipboardRef.current
    if (!clip || !clip.items || clip.items.length === 0) return
    // Paste at the playhead if it's set AND different from the source's
    // start; otherwise drop the paste right after the source so a plain
    // Ctrl+C → Ctrl+V duplicates the selection to the immediate right
    // instead of stacking it on top of the original.
    let target
    if (playheadBeat != null && playheadBeat !== clip.sourceMinBeat) {
      target = playheadBeat
    } else {
      target = clip.sourceMinBeat + clip.sourceWidth
    }
    pushHistory()
    const newSelection = new Set()
    setNotes((prev) => {
      const next = new Map(prev)
      for (const item of clip.items) {
        let beat = target + item.relBeat
        if (!freeMode) beat = Math.round(beat)
        if (beat < 0 || beat >= totalBeats) continue
        const key = `${beat}-${item.midi}`
        next.set(key, item.length ?? 1)
        newSelection.add(key)
      }
      return next
    })
    setSelectedKeys(newSelection)
  }

  const removeNote = (key) => {
    setNotes((prev) => {
      if (!prev.has(key)) return prev
      const next = new Map(prev)
      next.delete(key)
      return next
    })
  }

  const handleRowMouseDown = (e, midi) => {
    // Ignore mousedown on a child note — it has its own drag handler.
    if (e.target !== e.currentTarget) return
    // Right-click on the grid: shift+right starts a delete-marquee; plain
    // right-click without shift just suppresses the browser context menu
    // and does nothing.
    const isRightClick = e.pointerType === 'mouse' && e.button === 2
    if (isRightClick) e.preventDefault()
    // Block placing notes on rows that aren't in the scale. Marquee selection
    // still works because it relies on mousemove past the threshold.
    const isInScale = inScale(midi % 12)

    // Alt+click+drag: insert a note at the click beat and drag in either
    // direction to set its length in one gesture. Drag past the click sets
    // length forward; drag before it moves the note's start back. On
    // release, the resulting length becomes the new default for future
    // single clicks (mirrors the resize-handle behavior).
    if (e.altKey && !isRightClick) {
      if (!isInScale && !allowOutOfScale) {
        setSelectedKeys(new Set())
        return
      }
      e.preventDefault()
      e.stopPropagation()
      const trackEl = e.currentTarget
      const trackRect = trackEl.getBoundingClientRect()
      try {
        trackEl.setPointerCapture?.(e.pointerId)
      } catch {}
      let startBeat = (e.clientX - trackRect.left) / BEAT_WIDTH
      if (!freeMode) startBeat = Math.floor(startBeat)
      startBeat = Math.max(0, Math.min(totalBeats - 1, startBeat))
      pushHistory()
      let currentKey = `${startBeat}-${midi}`
      const initialLength = freeMode ? 0.25 : 1
      setNotes((prev) => {
        const next = new Map(prev)
        next.set(currentKey, initialLength)
        return next
      })
      setSelectedKeys(new Set([currentKey]))
      const move = (mv) => {
        if (mv.pointerId !== e.pointerId) return
        let curBeat = (mv.clientX - trackRect.left) / BEAT_WIDTH
        if (!freeMode) curBeat = Math.floor(curBeat)
        curBeat = Math.max(0, Math.min(totalBeats - 0.001, curBeat))
        const newBeat = Math.min(startBeat, curBeat)
        const endBeat = Math.max(startBeat, curBeat)
        const newLength = Math.max(
          freeMode ? 0.25 : 1,
          freeMode ? endBeat - newBeat : endBeat - newBeat + 1
        )
        const newKey = `${newBeat}-${midi}`
        setNotes((prev) => {
          const next = new Map(prev)
          if (newKey !== currentKey) next.delete(currentKey)
          next.set(newKey, newLength)
          return next
        })
        if (newKey !== currentKey) {
          currentKey = newKey
          setSelectedKeys(new Set([newKey]))
        }
      }
      const up = (uv) => {
        if (uv.pointerId !== e.pointerId) return
        trackEl.removeEventListener('pointermove', move)
        trackEl.removeEventListener('pointerup', up)
        trackEl.removeEventListener('pointercancel', up)
        try { trackEl.releasePointerCapture?.(e.pointerId) } catch {}
        const finalLength = notesRef.current.get(currentKey)
        if (finalLength != null) defaultNoteLengthRef.current = finalLength
        playOneNote(midi, undefined, 0.3)
      }
      trackEl.addEventListener('pointermove', move)
      trackEl.addEventListener('pointerup', up)
      trackEl.addEventListener('pointercancel', up)
      return
    }

    const additive = e.shiftKey && !isRightClick
    const isDeleteMarquee = isRightClick
    // Snapshot the existing selection so a shift+marquee can union with it
    // even after we re-render.
    const baseSelection = additive ? new Set(selectedKeys) : null
    const trackRect = e.currentTarget.getBoundingClientRect()
    const rowIdx = MIDI_HIGH - midi
    const startContentX = e.clientX - trackRect.left
    const startContentY = rowIdx * ROW_HEIGHT + (e.clientY - trackRect.top)
    const initialX = e.clientX
    const initialY = e.clientY

    let beat = startContentX / BEAT_WIDTH
    if (!freeMode) beat = Math.floor(beat)
    beat = Math.max(0, Math.min(totalBeats - 0.001, beat))
    let moved = false

    const move = (mv) => {
      const dx = mv.clientX - initialX
      const dy = mv.clientY - initialY
      if (!moved && Math.abs(dx) < 3 && Math.abs(dy) < 3) return
      moved = true
      const curX = startContentX + dx
      const curY = startContentY + dy
      const m = {
        x1: Math.max(0, Math.min(startContentX, curX)),
        y1: Math.max(0, Math.min(startContentY, curY)),
        x2: Math.max(startContentX, curX),
        y2: Math.max(startContentY, curY),
      }
      marqueeRef.current = m
      setMarquee(m)
    }

    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', up)
      if (!moved) {
        // Right-click without drag — do nothing (and never place a note).
        if (isRightClick) return
        // Shift+click on empty space: preserve the current selection so the
        // user can keep building it across separate gestures.
        if (additive) return
        // Click on empty space → add note. By default only on in-scale rows;
        // the Settings toggle "Allow notes outside the scale" lifts that gate.
        if (!isInScale && !allowOutOfScale) {
          setSelectedKeys(new Set())
          return
        }
        const key = `${beat}-${midi}`
        pushHistory()
        const newLength = defaultNoteLengthRef.current
        setNotes((prev) => {
          const next = new Map(prev)
          next.set(key, newLength)
          return next
        })
        playOneNote(midi, undefined, 0.3)
        setSelectedKeys(new Set())
      } else {
        const m = marqueeRef.current
        const inMarquee = (key) => {
          const [beatStr, midiStr] = key.split('-')
          const noteBeat = Number(beatStr)
          const noteMidi = Number(midiStr)
          const nx1 = noteBeat * BEAT_WIDTH
          const nx2 = nx1 + BEAT_WIDTH
          const ny1 = (MIDI_HIGH - noteMidi) * ROW_HEIGHT
          const ny2 = ny1 + ROW_HEIGHT
          return nx1 < m.x2 && nx2 > m.x1 && ny1 < m.y2 && ny2 > m.y1
        }
        if (isDeleteMarquee) {
          const victims = []
          for (const [key] of notes) if (inMarquee(key)) victims.push(key)
          if (victims.length > 0) {
            pushHistory()
            setNotes((prev) => {
              const next = new Map(prev)
              for (const k of victims) next.delete(k)
              return next
            })
            setSelectedKeys((prev) => {
              if (victims.every((k) => !prev.has(k))) return prev
              const ns = new Set(prev)
              for (const k of victims) ns.delete(k)
              return ns
            })
          }
        } else {
          const picked = additive ? new Set(baseSelection) : new Set()
          for (const [key] of notes) if (inMarquee(key)) picked.add(key)
          setSelectedKeys(picked)
        }
        setMarquee(null)
        marqueeRef.current = null
      }
    }

    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', up)
  }

  const handleNoteMouseDown = (e, key, beat, midi, length = 1) => {
    e.stopPropagation()
    e.preventDefault()

    // Right-click on a note (mouse only): delete it immediately. If the note
    // is part of the active selection, delete the whole selection too. Touch
    // delete uses long-press handled below.
    if (e.pointerType === 'mouse' && e.button === 2) {
      pushHistory()
      const victims = selectedKeys.has(key) ? new Set(selectedKeys) : new Set([key])
      setNotes((prev) => {
        const next = new Map(prev)
        for (const k of victims) next.delete(k)
        return next
      })
      setSelectedKeys((prev) => {
        if (victims.size === 0) return prev
        const ns = new Set(prev)
        for (const k of victims) ns.delete(k)
        return ns
      })
      return
    }

    // Shift+click on a note toggles its membership in the selection without
    // dragging or deleting — lets the user build up a selection by clicking
    // notes one at a time alongside any earlier marquee picks.
    if (e.shiftKey) {
      setSelectedKeys((prev) => {
        const next = new Set(prev)
        if (next.has(key)) next.delete(key)
        else next.add(key)
        return next
      })
      return
    }

    // If the clicked note is part of an active multi-selection, drag the
    // whole group together. Otherwise, drag just this note.
    const isGroup = selectedKeys.has(key) && selectedKeys.size > 1
    const group = []
    if (isGroup) {
      for (const k of selectedKeys) {
        const [bStr, mStr] = k.split('-')
        group.push({
          currentKey: k,
          originalBeat: Number(bStr),
          originalMidi: Number(mStr),
          length: notesRef.current.get(k) ?? 1,
        })
      }
    } else {
      group.push({
        currentKey: key,
        originalBeat: beat,
        originalMidi: midi,
        length,
      })
    }

    const drag = {
      originalBeat: beat,
      originalMidi: midi,
      group,
      isGroup,
      lastMidi: midi,
      startX: e.clientX,
      startY: e.clientY,
      hasMoved: false,
      // Snapshot the notes at drag start. Each move recomputes the live
      // map from this snapshot so stationary notes the dragged group
      // passes over are temporarily covered but reappear when the
      // dragged group moves on.
      snapshot: new Map(notesRef.current),
      originalKeys: group.map((g) => `${g.originalBeat}-${g.originalMidi}`),
      cancelled: false,
    }
    dragRef.current = drag

    // Long-press delete (touch only). On a non-mouse pointer, if the finger
    // doesn't move >3 px within 500 ms we delete the note(s), mirroring the
    // right-click delete on desktop.
    let longPressTimer = null
    if (e.pointerType !== 'mouse') {
      longPressTimer = setTimeout(() => {
        longPressTimer = null
        if (drag.hasMoved) return
        drag.cancelled = true
        pushHistory()
        const victims = selectedKeys.has(key) ? new Set(selectedKeys) : new Set([key])
        setNotes((prev) => {
          const next = new Map(prev)
          for (const k of victims) next.delete(k)
          return next
        })
        setSelectedKeys((prev) => {
          const ns = new Set(prev)
          for (const k of victims) ns.delete(k)
          return ns
        })
      }, 500)
    }

    let snapshotPushed = false
    const move = (mv) => {
      if (!dragRef.current || drag.cancelled) return
      const dx = mv.clientX - drag.startX
      const dy = mv.clientY - drag.startY
      if (!drag.hasMoved && Math.abs(dx) < 3 && Math.abs(dy) < 3) return
      // The user is dragging — cancel any pending long-press.
      if (longPressTimer != null) {
        clearTimeout(longPressTimer)
        longPressTimer = null
      }
      if (!snapshotPushed) {
        pushHistory()
        snapshotPushed = true
      }
      drag.hasMoved = true

      // Same beat + step delta applied to the whole group so the interval
      // shape is preserved. One row of vertical drag = one scale step.
      let newAnchorBeat = drag.originalBeat + dx / BEAT_WIDTH
      if (!freeMode) newAnchorBeat = Math.round(newAnchorBeat)
      newAnchorBeat = Math.max(0, Math.min(totalBeats - 0.001, newAnchorBeat))
      const beatDelta = newAnchorBeat - drag.originalBeat

      // One scale step averages 12 / scale.notes.length semitones, so the
      // step threshold matches that many visual rows. Without this scale,
      // notes shot ahead of the cursor on scales whose steps span 2
      // semitones (1.5 average for 8-note scales).
      const rowsPerStep = scale.notes.length > 0 ? 12 / scale.notes.length : 1
      const stepDelta = -Math.round(dy / (ROW_HEIGHT * rowsPerStep))

      const newPositions = drag.group.map((g) => {
        let nb = g.originalBeat + beatDelta
        nb = Math.max(0, Math.min(totalBeats - 0.001, nb))
        const gStep = midiToScaleStep(g.originalMidi)
        let nm =
          gStep != null
            ? scaleStepToMidi(gStep + stepDelta)
            : nearestScaleMidi(g.originalMidi + stepDelta)
        nm = Math.max(MIDI_LOW, Math.min(MIDI_HIGH, nm))
        return { newBeat: nb, newMidi: nm, newKey: `${nb}-${nm}`, length: g.length }
      })

      const newAnchorMidi =
        newPositions.find(
          (np, i) => drag.group[i].originalMidi === drag.originalMidi
        )?.newMidi ?? drag.originalMidi

      const anyChanged = newPositions.some((np, i) => np.newKey !== drag.group[i].currentKey)
      if (!anyChanged) return

      newPositions.forEach((np, i) => {
        drag.group[i].currentKey = np.newKey
      })

      // Recompute live notes from the drag-start snapshot. The dragged
      // group's original keys are removed; the new positions are placed
      // on top. Notes the dragged group covers temporarily appear gone,
      // but they're still in `drag.snapshot`, so the next move iteration
      // (or release) restores them once the cursor moves past.
      const next = new Map(drag.snapshot)
      for (const ok of drag.originalKeys) next.delete(ok)
      for (const np of newPositions) next.set(np.newKey, np.length)
      setNotes(next)

      if (drag.isGroup) {
        setSelectedKeys(new Set(newPositions.map((np) => np.newKey)))
      }

      if (newAnchorMidi !== drag.lastMidi) {
        playOneNote(newAnchorMidi, undefined, 0.2)
        drag.lastMidi = newAnchorMidi
      }
    }

    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', up)
      document.body.style.cursor = ''
      if (longPressTimer != null) {
        clearTimeout(longPressTimer)
        longPressTimer = null
      }
      // If the long-press fired (drag.cancelled) the note is already gone —
      // don't re-select or audition.
      if (drag.cancelled) {
        dragRef.current = null
        return
      }
      // Click without drag (and not part of a multi-selection drag) → select
      // and audition the note. Deletion is handled by right-click / long-press.
      if (!drag.hasMoved && !drag.isGroup) {
        setSelectedKeys(new Set([drag.group[0].currentKey]))
        playOneNote(midi, undefined, 0.3)
      }
      dragRef.current = null
    }

    document.body.style.cursor = 'grabbing'
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', up)
  }

  // Right-edge resize. If the dragged note is part of a multi-selection,
  // the same length delta is applied to every selected note (each clamped
  // independently to its own bounds). Otherwise just resize this note.
  const handleNoteResize = (e, key, beat, midi, currentLength) => {
    e.stopPropagation()
    e.preventDefault()
    const startX = e.clientX
    const isGroup = selectedKeys.has(key) && selectedKeys.size > 1
    const group = isGroup
      ? Array.from(selectedKeys).map((k) => {
          const [bStr, mStr] = k.split('-')
          return {
            key: k,
            beat: Number(bStr),
            midi: Number(mStr),
            originalLength: notesRef.current.get(k) ?? 1,
          }
        })
      : [{ key, beat, midi, originalLength: currentLength }]
    let snapshotPushed = false
    let lastDraggedLength = currentLength
    const move = (mv) => {
      const dx = mv.clientX - startX
      if (!snapshotPushed && Math.abs(dx) < 2) return
      if (!snapshotPushed) {
        pushHistory()
        snapshotPushed = true
      }
      let lengthDelta = dx / BEAT_WIDTH
      if (!freeMode) lengthDelta = Math.round(lengthDelta)
      setNotes((prev) => {
        const next = new Map(prev)
        for (const g of group) {
          let newLength = g.originalLength + lengthDelta
          newLength = Math.max(
            freeMode ? 0.25 : 1,
            Math.min(totalBeats - g.beat, newLength)
          )
          next.set(g.key, newLength)
          if (g.key === key) lastDraggedLength = newLength
        }
        return next
      })
    }
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', up)
      document.body.style.cursor = ''
      if (snapshotPushed) defaultNoteLengthRef.current = lastDraggedLength
    }
    document.body.style.cursor = 'ew-resize'
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', up)
  }

  // Left-edge resize: each note's right edge stays anchored, start beat and
  // length both change. With a multi-selection, the same beat delta moves
  // every selected note's start (clamped per-note). Notes' keys change as
  // their beat changes, so we track currentKey per group entry.
  const handleNoteResizeLeft = (e, key, beat, midi, currentLength) => {
    e.stopPropagation()
    e.preventDefault()
    const startX = e.clientX
    const isGroup = selectedKeys.has(key) && selectedKeys.size > 1
    const group = isGroup
      ? Array.from(selectedKeys).map((k) => {
          const [bStr, mStr] = k.split('-')
          const b = Number(bStr)
          const m = Number(mStr)
          const len = notesRef.current.get(k) ?? 1
          return {
            currentKey: k,
            originalBeat: b,
            midi: m,
            rightEdge: b + len,
          }
        })
      : [{ currentKey: key, originalBeat: beat, midi, rightEdge: beat + currentLength }]
    let snapshotPushed = false
    let lastDraggedLength = currentLength
    const move = (mv) => {
      const dx = mv.clientX - startX
      if (!snapshotPushed && Math.abs(dx) < 2) return
      if (!snapshotPushed) {
        pushHistory()
        snapshotPushed = true
      }
      let beatDelta = dx / BEAT_WIDTH
      if (!freeMode) beatDelta = Math.round(beatDelta)
      const minLen = freeMode ? 0.25 : 1
      const newPositions = group.map((g) => {
        let nb = g.originalBeat + beatDelta
        nb = Math.max(0, Math.min(g.rightEdge - minLen, nb))
        return { ...g, newBeat: nb, newLength: g.rightEdge - nb, newKey: `${nb}-${g.midi}` }
      })
      const anyChanged = newPositions.some(
        (np, i) => np.newKey !== group[i].currentKey
      )
      if (!anyChanged) return
      const draggedIdx = group.findIndex((g) => g.midi === midi && g.rightEdge === beat + currentLength)
      if (draggedIdx !== -1) lastDraggedLength = newPositions[draggedIdx].newLength
      setNotes((prev) => {
        const next = new Map(prev)
        for (const g of group) next.delete(g.currentKey)
        for (const np of newPositions) next.set(np.newKey, np.newLength)
        return next
      })
      if (isGroup) {
        setSelectedKeys(new Set(newPositions.map((np) => np.newKey)))
      } else {
        setSelectedKeys((prev) => {
          const np = newPositions[0]
          if (!prev.has(group[0].currentKey)) return prev
          const ns = new Set(prev)
          ns.delete(group[0].currentKey)
          ns.add(np.newKey)
          return ns
        })
      }
      newPositions.forEach((np, i) => {
        group[i].currentKey = np.newKey
      })
    }
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', up)
      document.body.style.cursor = ''
      if (snapshotPushed) defaultNoteLengthRef.current = lastDraggedLength
    }
    document.body.style.cursor = 'ew-resize'
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', up)
  }

  const notesByMidi = useMemo(() => {
    const map = new Map()
    for (const [key, length] of notes) {
      const [beatStr, midiStr] = key.split('-')
      const midi = Number(midiStr)
      const beat = Number(beatStr)
      const arr = map.get(midi) ?? []
      arr.push({ key, beat, length })
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
    killScheduledVoices()
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
    const activeLoop = loopRef.current
    if (activeLoop && (startBeat < activeLoop.start || startBeat >= activeLoop.end)) {
      startBeat = activeLoop.start
    }
    // Schedule every melody note (and metronome click, if on) whose beat
    // falls in [rangeStart, rangeEnd), relative to scheduleStartTime as
    // t=rangeStart. Reads notes / metronome / swing from live refs at call
    // time so loop iterations scheduled AFTER an edit reflect the new
    // state without needing to restart playback.
    const scheduleRange = (rangeStart, rangeEnd, scheduleStartTime) => {
      const liveSwing = swingPctRef.current
      const swungRangeStart = applySwingBeat(rangeStart, liveSwing)
      for (const [key, length] of notesRef.current) {
        const [beatStr, midiStr] = key.split('-')
        const beat = Number(beatStr)
        const midi = Number(midiStr)
        if (beat >= rangeStart && beat < rangeEnd) {
          const swungNoteStart = applySwingBeat(beat, liveSwing)
          const swungNoteEnd = applySwingBeat(beat + length, liveSwing)
          const noteTime =
            scheduleStartTime + (swungNoteStart - swungRangeStart) * cellDur
          const noteDur = Math.max(0.06, (swungNoteEnd - swungNoteStart) * cellDur)
          playOneNote(midi, noteTime, noteDur)
        }
      }
      if (metronomeRef.current) {
        const CELLS_PER_BEAT = 4
        const CELLS_PER_MEASURE = 16
        const first = Math.ceil(rangeStart / CELLS_PER_BEAT) * CELLS_PER_BEAT
        for (let b = first; b < rangeEnd; b += CELLS_PER_BEAT) {
          const clickTime = scheduleStartTime + (b - rangeStart) * cellDur
          playClick(clickTime, b % CELLS_PER_MEASURE === 0)
        }
      }
    }

    if (activeLoop) {
      // Loop mode: schedule the partial first iteration (from startBeat to
      // loop.end), then pre-schedule full iterations ahead so the boundary
      // is seamless — Web Audio plays the queued samples continuously and
      // never sees a gap.
      const loopStart = activeLoop.start
      const loopEnd = activeLoop.end
      const swungStart = applySwingBeat(startBeat, swing)
      const swungLoopStart = applySwingBeat(loopStart, swing)
      const swungLoopEnd = applySwingBeat(loopEnd, swing)
      const firstIterDur = (swungLoopEnd - swungStart) * cellDur
      const iterationDur = (swungLoopEnd - swungLoopStart) * cellDur
      const firstIterEndTime = startBase + firstIterDur
      scheduleRange(startBeat, loopEnd, startBase)
      playStateRef.current = {
        mode: 'loop',
        startTime: startBase,
        cellDur,
        swing,
        swungStart,
        swungLoopStart,
        swungLoopEnd,
        firstIterEndTime,
        iterationDur,
        loopStart,
        loopEnd,
        scheduleRange,
        nextIterStartTime: firstIterEndTime,
        offsetBeat: startBeat,
      }
      setPlayheadBeat(startBeat)
    } else {
      // One-shot mode: schedule once, end at the last note's right edge.
      let lastBeat = 0
      for (const [key, length] of notesRef.current) {
        const [beatStr] = key.split('-')
        const beat = Number(beatStr)
        const noteEndBeat = beat + length
        if (noteEndBeat > lastBeat) lastBeat = noteEndBeat
      }
      const endBeat = notesRef.current.size > 0 ? lastBeat : totalBeats
      scheduleRange(startBeat, endBeat, startBase)
      const swungStart = applySwingBeat(startBeat, swing)
      playStateRef.current = {
        mode: 'oneshot',
        startTime: startBase,
        cellDur,
        swing,
        swungStart,
        swungEnd: applySwingBeat(endBeat, swing),
        endBeat,
        offsetBeat: startBeat,
      }
      setPlayheadBeat(startBeat)
    }

    // Keep at least LOOKAHEAD seconds of loop iterations scheduled ahead of
    // ctx.currentTime. Cheap to call every rAF; only does work when the
    // scheduling horizon has advanced past the next iteration's start time.
    const LOOKAHEAD = 0.5
    const ensureScheduled = () => {
      const st = playStateRef.current
      if (!st || st.mode !== 'loop') return
      const ctx2 = audioCtxRef.current
      if (!ctx2) return
      const horizon = ctx2.currentTime + LOOKAHEAD
      while (st.nextIterStartTime < horizon) {
        st.scheduleRange(st.loopStart, st.loopEnd, st.nextIterStartTime)
        st.nextIterStartTime += st.iterationDur
      }
    }
    ensureScheduled()

    const tick = () => {
      const state = playStateRef.current
      const ctx2 = audioCtxRef.current
      if (!state || !ctx2) return
      const elapsedTime = ctx2.currentTime - state.startTime
      let currentSwungBeat
      if (state.mode === 'loop') {
        ensureScheduled()
        if (elapsedTime < state.firstIterEndTime - state.startTime) {
          currentSwungBeat = state.swungStart + elapsedTime / state.cellDur
        } else {
          const timeInFullIter =
            (elapsedTime - (state.firstIterEndTime - state.startTime)) %
            state.iterationDur
          currentSwungBeat =
            state.swungLoopStart + timeInFullIter / state.cellDur
        }
      } else {
        currentSwungBeat = state.swungStart + elapsedTime / state.cellDur
        if (currentSwungBeat >= state.swungEnd) {
          stopPlayback(true)
          return
        }
      }
      const musicalBeat = unswingTimeBeat(currentSwungBeat, state.swing)
      const current = Math.max(0, musicalBeat)
      setPlayheadBeat(current)
      const sc = scrollRef.current
      if (sc) {
        const playheadX = current * BEAT_WIDTH + 52
        const margin = 80
        if (playheadX > sc.scrollLeft + sc.clientWidth - margin) {
          sc.scrollLeft = playheadX - sc.clientWidth + margin * 2
        } else if (playheadX < sc.scrollLeft + 52 + 4) {
          sc.scrollLeft = Math.max(0, playheadX - 52 - 4)
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

  // Live re-schedule during loop playback: kill queued voices, then
  // schedule the remainder of the current iteration starting at the
  // playhead. Used when notes change so edits are heard immediately
  // rather than at the next iteration boundary.
  const liveRescheduleLoop = () => {
    const st = playStateRef.current
    if (!st || st.mode !== 'loop' || !st.scheduleRange) return
    const ctx = audioCtxRef.current
    if (!ctx) return
    const now = ctx.currentTime
    const elapsed = now - st.startTime
    const firstIterDur = st.firstIterEndTime - st.startTime
    let currentSwungBeat
    let iterEndTime
    if (elapsed < firstIterDur) {
      currentSwungBeat = st.swungStart + elapsed / st.cellDur
      iterEndTime = st.firstIterEndTime
    } else {
      const elapsedFull = elapsed - firstIterDur
      const nIter = Math.floor(elapsedFull / st.iterationDur)
      const timeInIter = elapsedFull - nIter * st.iterationDur
      currentSwungBeat = st.swungLoopStart + timeInIter / st.cellDur
      iterEndTime = st.firstIterEndTime + (nIter + 1) * st.iterationDur
    }
    killScheduledVoices()
    const currentMusicalBeat = unswingTimeBeat(currentSwungBeat, st.swing)
    st.scheduleRange(currentMusicalBeat, st.loopEnd, now)
    st.nextIterStartTime = iterEndTime
  }

  // Debounced trigger: when notes change during loop playback, wait a beat
  // for rapid changes (drags, multi-step edits) to settle, then reschedule
  // from the current playhead so the audio reflects the edit immediately.
  useEffect(() => {
    const st = playStateRef.current
    if (!st || st.mode !== 'loop') return
    const id = setTimeout(() => liveRescheduleLoop(), 60)
    return () => clearTimeout(id)
  }, [notes])

  const playFromStart = () => {
    playFromBeat(0)
  }

  const handleTimelineMouseDown = (e) => {
    const rect = e.currentTarget.getBoundingClientRect()
    const startX = e.clientX - rect.left
    // Snap beats to whole numbers when grid-snap is on, free otherwise.
    const snapBeat = (b) => (freeMode ? b : Math.round(b))
    const initialBeat = Math.max(
      0,
      Math.min(totalBeats, snapBeat(startX / BEAT_WIDTH))
    )

    const currentLoop = loopRef.current
    const EDGE_PX = 10
    let mode = 'create'
    let initialLoopSnap = null
    if (currentLoop) {
      const loopStartX = currentLoop.start * BEAT_WIDTH
      const loopEndX = currentLoop.end * BEAT_WIDTH
      if (Math.abs(startX - loopStartX) <= EDGE_PX) mode = 'resize-start'
      else if (Math.abs(startX - loopEndX) <= EDGE_PX) mode = 'resize-end'
      else if (startX > loopStartX && startX < loopEndX) mode = 'move-loop'
      initialLoopSnap = { ...currentLoop }
    }

    let moved = false
    const move = (mv) => {
      const x = mv.clientX - rect.left
      const dx = x - startX
      if (!moved && Math.abs(dx) < 3) return
      moved = true
      const beat = Math.max(0, Math.min(totalBeats, snapBeat(x / BEAT_WIDTH)))

      if (mode === 'create') {
        const a = Math.min(initialBeat, beat)
        const b = Math.max(initialBeat, beat)
        setLoop({ start: a, end: b })
      } else if (mode === 'resize-start') {
        const end = initialLoopSnap.end
        const maxStart = freeMode ? end - 0.25 : end - 1
        setLoop({
          start: Math.max(0, Math.min(beat, maxStart)),
          end,
        })
      } else if (mode === 'resize-end') {
        const start = initialLoopSnap.start
        const minEnd = freeMode ? start + 0.25 : start + 1
        setLoop({
          start,
          end: Math.min(totalBeats, Math.max(beat, minEnd)),
        })
      } else if (mode === 'move-loop') {
        const len = initialLoopSnap.end - initialLoopSnap.start
        const delta = beat - initialBeat
        let ns = initialLoopSnap.start + delta
        ns = Math.max(0, Math.min(totalBeats - len, ns))
        setLoop({ start: ns, end: ns + len })
      }
    }

    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', up)
      if (!moved) {
        // A no-drag click only clears the loop if it landed OUTSIDE the
        // loop body (mode === 'create'). Clicks on the loop edges or its
        // body are intent-to-resize / intent-to-move and must preserve
        // the loop so the user can try again. Then seek to the click.
        if (currentLoop && mode === 'create') setLoop(null)
        if (playStateRef.current) {
          playFromBeat(initialBeat)
        } else {
          setPlayheadBeat(initialBeat)
        }
      } else {
        const final = loopRef.current
        if (final && final.end - final.start < 0.5) setLoop(null)
      }
    }

    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', up)
  }

  return (
    <div
      className={`roll-view ${allowOutOfScale ? 'allow-oos' : ''}`}
      onContextMenu={(e) => e.preventDefault()}
    >
      <header className={`roll-header ${mobileMenuOpen ? 'menu-open' : ''}`}>
        <button className="back-btn" onClick={onBack} aria-label="back to matrix">
          <BackIcon />
          <span>back</span>
        </button>
        <div className="roll-title">
          <span className="roll-number">{padId(scale.id)}</span>
          <span className="roll-divider">·</span>
          <span className="roll-name">rooted in {NOTE_DISPLAY[root]}</span>
          {tHeld && (
            <span
              className="hotkey-badge"
              title="Rotate mode on — ArrowUp/Down rotates the selection's pitches. Press T (or Esc) to exit."
            >
              T · ROTATE
            </span>
          )}
        </div>
        <button
          type="button"
          className={`roll-toolbar-toggle ${mobileMenuOpen ? 'on' : ''}`}
          onClick={() => setMobileMenuOpen((v) => !v)}
          aria-pressed={mobileMenuOpen}
          aria-label="toggle toolbar"
        >
          <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
            <path d="M2 4h12M2 8h12M2 12h12" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
          </svg>
        </button>
        <div className="roll-toolbar-sub">
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
          className="mode-toggle icon-toggle"
          onClick={() => {
            setCaptureName('')
            setCaptureOpen(true)
          }}
          aria-label="capture template"
          title="Save current pattern as a scale-degree template"
        >
          <Camera size={16} strokeWidth={1.8} />
        </button>
        <button
          type="button"
          className={`mode-toggle ${chordModalOpen ? 'on' : ''}`}
          onClick={() => setChordModalOpen((v) => !v)}
          aria-pressed={chordModalOpen}
          title="Open the chord palette — drag chords onto the chord lane"
        >
          Chords
        </button>
        <button
          type="button"
          className={`mode-toggle icon-toggle ${metronome ? 'on' : ''}`}
          onClick={() => setMetronome((v) => !v)}
          aria-pressed={metronome}
          aria-label="metronome"
          title="Metronome click on every quarter note (straight, ignores swing)"
        >
          <Metronome size={16} strokeWidth={1.8} />
        </button>
        <button
          type="button"
          className={`mode-toggle icon-toggle ${loop ? 'on' : ''}`}
          onClick={() => {
            if (loop) {
              setLoop(null)
              // If we're mid-playback inside a loop, halt it — the user just
              // asked for the loop to stop, so the already-queued next
              // iteration shouldn't keep wrapping in the audio.
              if (playStateRef.current?.mode === 'loop') stopPlayback(false)
            } else if (lastLoopRef.current) {
              setLoop(lastLoopRef.current)
            }
          }}
          disabled={!loop && !lastLoopRef.current}
          aria-pressed={!!loop}
          aria-label={loop ? 'clear loop' : 'restore previous loop'}
          title={
            loop
              ? 'Loop — click to clear. Drag on the timeline to create a new region.'
              : lastLoopRef.current
              ? 'Loop — click to restore the previous region.'
              : 'Drag on the timeline to create a loop region.'
          }
        >
          <Repeat size={16} strokeWidth={1.8} />
        </button>
        <button
          type="button"
          className={`mode-toggle icon-toggle ${!freeMode ? 'on' : ''}`}
          onClick={() => setFreeMode((v) => !v)}
          aria-pressed={!freeMode}
          aria-label={freeMode ? 'Enable grid snap' : 'Disable grid snap (free placement)'}
          title={
            freeMode
              ? 'Free placement — click to snap to grid'
              : 'Snap to grid — click for free placement'
          }
        >
          <Magnet size={14} strokeWidth={2} />
        </button>
        </div>
        <button
          className="play roll-play"
          onClick={togglePlay}
          aria-label="play roll"
          title="Space: play/pause · Enter: play from start"
        >
          <PlayIcon />
        </button>
      </header>

      <div className="roll-scale-bar">
        <span className="roll-scale-tag">Scale</span>
        <div className="roll-scale-pattern">
          {Array.from({ length: 12 }, (_, c) => {
            const isIn = scale.notes.includes(c)
            const pc = (root + c) % 12
            return (
              <div
                key={c}
                className={`roll-scale-cell ${isIn ? 'on' : 'off'} ${chordClassFor(pc)}`}
                title={NOTE_DISPLAY[pc]}
              >
                {isIn ? NOTE_DISPLAY[pc] : ''}
              </div>
            )
          })}
        </div>
      </div>

      <div className="roll-body">
        <aside className="variation-panel">
          <div className="templates-header">
            <span className="label">Templates</span>
            {templates.length > 0 && (
              <button
                type="button"
                className="templates-export"
                onClick={exportTemplates}
                title="Copy all templates as a JS code block for src/templates.js"
              >
                {exportFeedback || 'Export'}
              </button>
            )}
          </div>
          {templates.length === 0 ? (
            <div className="hint">
              Capture a pattern to reuse on any scale.
            </div>
          ) : (
            <ul className="templates-list">
              {templates.map((tpl) => (
                <li
                  key={tpl.id}
                  className="template-row"
                  onClick={() => applyTemplate(tpl)}
                  title={`Captured from scale ${padId(
                    tpl.capturedFrom.scaleId
                  )} · ${tpl.notes.length} notes`}
                >
                  <span className="template-name">{tpl.name}</span>
                  <span className="template-meta">
                    {tpl.notes.length}n
                    <button
                      type="button"
                      className="template-delete"
                      onClick={(e) => {
                        e.stopPropagation()
                        deleteTemplate(tpl.id)
                      }}
                      aria-label="delete template"
                    >
                      ×
                    </button>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </aside>
        <div className="roll-stage">
          <div className="roll-scroll" ref={scrollRef}>
            <div className="timeline">
              <div className="timeline-corner" />
              <div
                className="timeline-bar"
                style={{ width: totalBeats * BEAT_WIDTH }}
                onPointerDown={handleTimelineMouseDown}
              >
                {loop && (
                  <div
                    className="timeline-loop"
                    style={{
                      left: `${loop.start * BEAT_WIDTH}px`,
                      width: `${(loop.end - loop.start) * BEAT_WIDTH}px`,
                    }}
                  />
                )}
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
              <div className="kbd-column" style={{ height: KBD_COLUMN_HEIGHT }}>
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
                      } ${isRoot ? 'is-root' : ''} ${chordClassFor(pc)}`}
                      style={{ top: `${pos.top}px`, height: `${pos.height}px` }}
                    >
                      <span className="key-label">
                        {showOctaveLabel
                          ? `C${octave}`
                          : NOTE_DISPLAY[pc]}
                      </span>
                    </div>
                  )
                })}
              </div>
              <div className="grid-area" ref={gridAreaRef}>
                {loop && (
                  <div
                    className="grid-loop"
                    style={{
                      left: `${loop.start * BEAT_WIDTH}px`,
                      width: `${(loop.end - loop.start) * BEAT_WIDTH}px`,
                    }}
                  />
                )}
                {marquee && (
                  <div
                    className="marquee"
                    style={{
                      left: `${marquee.x1}px`,
                      top: `${marquee.y1}px`,
                      width: `${marquee.x2 - marquee.x1}px`,
                      height: `${marquee.y2 - marquee.y1}px`,
                    }}
                  />
                )}
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
                      } ${isIn ? 'in' : ''} ${isRoot ? 'is-root' : ''} ${chordClassFor(pc)}`}
                    >
                      <div
                        className={`beats-track ${freeMode ? 'free' : ''}`}
                        style={{ width: totalBeats * BEAT_WIDTH }}
                        onPointerDown={(e) => handleRowMouseDown(e, midi)}
                      >
                        {rowNotes.map(({ key, beat, length }) => (
                          <div
                            key={key}
                            className={`row-note ${
                              selectedKeys.has(key) ? 'selected' : ''
                            } ${chordClassFor(midi % 12)}`}
                            style={{
                              left: `${beat * BEAT_WIDTH}px`,
                              width: `${length * BEAT_WIDTH}px`,
                            }}
                            onPointerDown={(e) =>
                              handleNoteMouseDown(e, key, beat, midi, length)
                            }
                            onMouseEnter={(e) =>
                              setNotePitchTip({
                                label: midiPitchLabel(midi),
                                x: e.clientX,
                                y: e.clientY,
                              })
                            }
                            onMouseMove={(e) =>
                              setNotePitchTip({
                                label: midiPitchLabel(midi),
                                x: e.clientX,
                                y: e.clientY,
                              })
                            }
                            onMouseLeave={() => setNotePitchTip(null)}
                          >
                            <div
                              className="row-note-handle left"
                              onPointerDown={(e) =>
                                handleNoteResizeLeft(e, key, beat, midi, length)
                              }
                            />
                            <div
                              className="row-note-handle"
                              onPointerDown={(e) =>
                                handleNoteResize(e, key, beat, midi, length)
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
        </div>
      </div>

      {captureOpen && (
        <div
          className="modal-backdrop"
          onClick={() => setCaptureOpen(false)}
          onPointerDown={(e) => e.stopPropagation()}
        >
          <div
            className="modal"
            onClick={(e) => e.stopPropagation()}
            onPointerDown={(e) => e.stopPropagation()}
          >
            <h3>Capture template</h3>
            <p className="modal-sub">
              {(() => {
                const items = captureCurrentTemplate()
                return `Save this pattern by scale degree so you can replay it on any other scale. ${items.length} of ${notes.size} note${
                  notes.size === 1 ? '' : 's'
                } sit on a scale degree.`
              })()}
            </p>
            <input
              autoFocus
              type="text"
              value={captureName}
              onChange={(e) => setCaptureName(e.target.value)}
              placeholder="Template name"
              onKeyDown={(e) => {
                if (e.key === 'Enter') saveCurrentAsTemplate()
                if (e.key === 'Escape') setCaptureOpen(false)
              }}
            />
            <div className="modal-actions">
              <button type="button" onClick={() => setCaptureOpen(false)}>
                Cancel
              </button>
              <button
                type="button"
                className="primary"
                onClick={saveCurrentAsTemplate}
              >
                Save
              </button>
            </div>
          </div>
        </div>
      )}

      {chordModalOpen && (
        <div className="chord-palette-modal">
          <div className="chord-palette-header">
            <span className="label">
              Chords — {padId(scale.id)} · {NOTE_DISPLAY[root]}
            </span>
            <button
              type="button"
              className="chord-palette-close"
              onClick={() => setChordModalOpen(false)}
              aria-label="close chord palette"
            >
              ×
            </button>
          </div>
          <p className="chord-palette-hint">
            Click a card to insert the chord at the playhead. Notes drop at C3, an octave below the melody.
          </p>
          <div className="chord-palette-grid">
            {chordPalette.map((entry) => {
              const noteNames = entry.midis
                .map((m) => NOTE_DISPLAY[((m % 12) + 12) % 12])
                .join(' ')
              const invLabel = entry.inversion === 0
                ? 'root'
                : `${entry.inversion}${
                    entry.inversion === 1 ? 'st' : entry.inversion === 2 ? 'nd' : 'rd'
                  } inv`
              return (
                <button
                  type="button"
                  key={entry.id}
                  className={`chord-card chord-card-${entry.side}`}
                  onClick={() => insertChordAtPlayhead(entry)}
                  title={`${entry.rootName} ${entry.chordLabel}${
                    entry.inversion > 0 ? `/${entry.bassName}` : ''
                  } — ${noteNames}`}
                >
                  <span className="chord-card-roman">{invLabel}</span>
                  <span className="chord-card-name">
                    {entry.rootName} {entry.chordLabel}
                    {entry.inversion > 0 ? `/${entry.bassName}` : ''}
                  </span>
                  <span className="chord-card-notes">{noteNames}</span>
                </button>
              )
            })}
          </div>
        </div>
      )}

      {notePitchTip && (
        <div
          className="note-pitch-tip"
          style={{ left: notePitchTip.x + 12, top: notePitchTip.y + 16 }}
        >
          {notePitchTip.label}
        </div>
      )}
    </div>
  )
}
