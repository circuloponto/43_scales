import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import {
  Magnet,
  Repeat,
  Metronome,
  ClipboardPaste,
  Upload,
  Guitar,
  Search,
  X,
  Tags,
  Plus,
  FolderPlus,
  FilePlus,
  ChevronRight,
  ChevronLeft,
  ChevronDown,
  ChevronUp,
} from 'lucide-react'
import { rootSteps } from './scales'
import { chordPairs } from './chordPairs'
import { resolveChordPair, pcName } from './chordVocab'
import Fretboard from './Fretboard'
import { useSaveAs } from './useSaveAs'
import { isHotkey } from './hotkeys'
import ChordDiagram from './ChordDiagram'
import { buildVoicings, FAMILIES } from './voicings'
import TemplateEditorModal from './TemplateEditorModal'
import TagsModal from './TagsModal'
import ImportConflictsModal from './ImportConflictsModal'
import TemplateTree from './TemplateTree'

// Module-scope clipboard so copy/paste survives PianoRoll remounts (which
// happen every time the user switches songs via key={activeSongId}). Every
// mounted PianoRoll — matrix roll, chord palette drag, or a re-entered song
// tab — reads and writes the same slot, so notes can be copied from one song
// or track and pasted into another.
let sharedClipboard = null

// Module-scope tab-switch resume slot. React state can't carry this across
// the unmount → mount seam reliably because the outgoing tab's cleanup and
// the incoming tab's mount effect happen in the same commit — any
// setState from cleanup would only be visible on the NEXT render, which
// is after the new mount effect fires. A plain module variable is
// synchronous and survives the seam so the new tab's mount effect sees it
// immediately. Carries the musical beat AND the audio-clock time at which
// it was captured, so the incoming tab can advance the beat by however
// long the remount actually took and stay perfectly in time.
let pendingResume = null // { beat, ctxTime } | null

// Module-scope AudioContext, shared by every PianoRoll instance. Because
// tab switches remount PianoRoll (key={activeSongId}), a per-instance
// context would be re-created on every switch — its clock would reset and
// there'd be an init pop / gap. A single persistent context keeps the
// clock continuous so the outgoing song's tail and the incoming song's
// start can overlap seamlessly.
let sharedAudioCtx = null

// Musical-note glyph for the rhythm indicator. `value` is the note
// denominator (1 = whole, 2 = half, 4 = quarter, 8 = 8th, 16 = 16th, …).
// Drawn as a notehead + optional stem + flags so it reads at a glance
// regardless of font support for Unicode music symbols.
function NoteGlyph({ value = 4, size = 16 }) {
  const filled = value >= 4 // quarter and shorter are filled
  const hasStem = value >= 2 // everything but the whole note
  // 8th → 1 flag, 16th → 2, 32nd → 3, … capped so the icon stays legible.
  const flags = value >= 8 ? Math.min(4, Math.round(Math.log2(value)) - 2) : 0
  const headCx = 7
  const headCy = 17
  const stemX = 10.6
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      aria-hidden="true"
    >
      <ellipse
        cx={headCx}
        cy={headCy}
        rx="4"
        ry="3"
        transform={`rotate(-20 ${headCx} ${headCy})`}
        fill={filled ? 'currentColor' : 'none'}
        strokeWidth="1.4"
      />
      {hasStem && (
        <line x1={stemX} y1={headCy - 1.5} x2={stemX} y2="4" strokeWidth="1.4" />
      )}
      {Array.from({ length: flags }, (_, i) => (
        <path
          key={i}
          d={`M ${stemX} ${4 + i * 3.2} q 5 1.5 4.5 6`}
          strokeWidth="1.4"
          strokeLinecap="round"
        />
      ))}
    </svg>
  )
}

// A fixed-position context menu that keeps itself on screen. Opened at the
// cursor, it measures itself and — if it would run past the bottom edge — flips
// above the cursor instead (then clamps, for menus taller than the viewport).
// The same goes for the right edge. It stays hidden for the measuring frame so
// it never flashes at the un-clamped spot.
function ContextMenu({ x, y, className = 'tab-context-menu', children, ...rest }) {
  const ref = useRef(null)
  const [pos, setPos] = useState(null)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const { width, height } = el.getBoundingClientRect()
    const M = 8 // viewport margin
    let top = y
    if (top + height > window.innerHeight - M) top = y - height // flip up
    top = Math.max(M, Math.min(top, window.innerHeight - M - height))
    let left = x
    if (left + width > window.innerWidth - M) left = x - width // flip left
    left = Math.max(M, Math.min(left, window.innerWidth - M - width))
    setPos({ left, top })
  }, [x, y])
  return (
    <div
      ref={ref}
      className={className}
      style={
        pos
          ? { left: pos.left, top: pos.top }
          : { left: x, top: y, visibility: 'hidden' }
      }
      {...rest}
    >
      {children}
    </div>
  )
}

// A single song tab with HTML5 drag/drop wiring. Kept at module scope so
// PianoRoll's giant render body stays readable; state changes come in via
// props (dragState / setDragState) so all tabs share one drag session.
function SongTab({
  song,
  isActive,
  canClose,
  onRename,
  onRemove,
  onContextMenu,
  isDragging,
  dx = 0,
  shift = 0,
  onPointerDownTab,
  groupColour,
}) {
  // In-place rename: double-click swaps the label for an input (no more
  // window.prompt). Commits on Enter / blur, cancels on Escape.
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(song.name)
  const inputRef = useRef(null)
  useEffect(() => {
    if (editing) {
      inputRef.current?.focus()
      inputRef.current?.select()
    }
  }, [editing])
  const startEdit = () => {
    if (!onRename) return
    setDraft(song.name)
    setEditing(true)
  }
  const commitEdit = () => {
    if (!editing) return
    setEditing(false)
    const t = draft.trim()
    if (t && t !== song.name) onRename(song.id, t)
  }
  const cancelEdit = () => {
    setEditing(false)
    setDraft(song.name)
  }

  // While dragging, the tab follows the cursor (translateX by dx) and lifts
  // above the others with no transition so it tracks 1:1. Otherwise it
  // slides to the drop-gap via `shift` with the CSS transition.
  const style = {
    ...(groupColour ? { '--group-colour': groupColour } : {}),
    ...(isDragging
      ? { transform: `translateX(${dx}px)`, transition: 'none', zIndex: 20 }
      : shift
      ? { transform: `translateX(${shift}px)` }
      : {}),
  }
  return (
    <div
      role="tab"
      aria-selected={isActive}
      data-song-id={song.id}
      className={`song-tab ${isActive ? 'active' : ''} ${isDragging ? 'dragging' : ''} ${
        groupColour ? 'in-group' : ''
      }`}
      style={style}
      onPointerDown={(e) => {
        // Don't start a drag from inside the rename input.
        if (editing) return
        onPointerDownTab?.(e, song)
      }}
      onDoubleClick={startEdit}
      onContextMenu={(e) => {
        e.preventDefault()
        onContextMenu?.({ songId: song.id, x: e.clientX, y: e.clientY })
      }}
      title={`${song.name}${isActive ? ' · double-click to rename · right-click for groups' : ''}`}
    >
      {editing ? (
        <input
          ref={inputRef}
          className="song-tab-rename"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onPointerDown={(e) => e.stopPropagation()}
          onDoubleClick={(e) => e.stopPropagation()}
          onBlur={commitEdit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commitEdit()
            else if (e.key === 'Escape') cancelEdit()
            e.stopPropagation()
          }}
        />
      ) : (
        <span className="song-tab-name">{song.name}</span>
      )}
      {canClose && onRemove && (
        <button
          type="button"
          className="song-tab-close"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation()
            onRemove(song.id)
          }}
          aria-label={`Close ${song.name}`}
          title="Close song"
        >
          ×
        </button>
      )}
    </div>
  )
}

const NOTE_NAMES_SHARP = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B']
const NOTE_NAMES_FLAT  = ['C', 'D♭', 'D', 'E♭', 'E', 'F', 'G♭', 'G', 'A♭', 'A', 'B♭', 'B']
const WHITE_PCS = new Set([0, 2, 4, 5, 7, 9, 11])

// One grid cell is a 16th note; a whole note is 16 cells. Note durations
// are absolute (independent of time signature), so this is the fixed
// reference for note-value math. Measure/beat lengths in cells come from
// the time signature (cellsPerMeasure / cellsPerBeat, computed per render).
const CELLS_PER_WHOLE = 16
// Swing groove grid: a FIXED 8th note, independent of the rhythm selector.
// Swing displaces whatever falls on the off-8th positions by onset, so a phrase
// mixing quarters, 8ths and triplets all grooves consistently — the selector
// only governs note ENTRY, never the feel. (16 / 8 = 2 cells = one 8th.)
const SWING_GRID_CELLS = CELLS_PER_WHOLE / 8

// PC → "white index from top of octave" (0 = B, 1 = A, ..., 6 = C)
const PC_TO_WHITE_IDX = { 11: 0, 9: 1, 7: 2, 5: 3, 4: 4, 2: 5, 0: 6 }
// PC of a black key → the white-index ABOVE it (where its boundary lives)
const BLACK_PC_TO_ABOVE_WHITE_IDX = { 10: 0, 8: 1, 6: 2, 3: 4, 1: 5 }

// Geometry. Whites are 36 px tall, blacks 24 px, centered on the boundary
// between two whites. Octave height = 7 × 36 = 12 × 21 = 252 px,
// so the keyboard column and the 21 px grid rows share total height.
// Row height + beat width are `let` so the roll can scale in and out via
// ctrl/shift + wheel. The base values live in *_BASE constants; the render
// syncs the mutable copies from the current zoom state on every pass so
// every consumer — component code, module-level helpers, JSX styles —
// reads the same up-to-date value.
const ROW_HEIGHT_BASE = 21
const BEAT_WIDTH_BASE = 28
let ROW_HEIGHT = ROW_HEIGHT_BASE
let BEAT_WIDTH = BEAT_WIDTH_BASE

// MIDI range — full 88-key piano: A0 to C8.
const MIDI_LOW = 21 // A0
const MIDI_HIGH = 108 // C8
const TOP_OCTAVE = Math.floor(MIDI_HIGH / 12) - 1 // 8

const DEFAULT_BEATS = 64
const MIN_BEATS = 8
// Upper bound on the auto-extending timeline. High enough to feel unbounded
// while still capping runaway growth (2048 cells = 128 measures of 4/4).
const MAX_BEATS = 2048
const DEFAULT_BPM = 120
const MIN_BPM = 40
const MAX_BPM = 300
// ── Swing / groove ─────────────────────────────────────────────────────────
// Swing is a monotonic time-warp of the timeline, not a property of individual
// notes. Notes are stored at RAW (straight) positions; the scheduler warps
// raw→swung and the playhead / mouse input unwarp swung→raw. Nothing is ever
// rewritten. The control is BIPOLAR: `amount` runs -1..+1 (shown as -100..+100,
// detented at 0). +amount swings the offbeat LATE (up to a triplet feel),
// -amount PUSHES it early; 0 is straight. Downbeats never move at any amount.
//
// Internally we carry the ratio `s` (the fraction of a swing pair given to the
// first note) as swingPct = s*100 — so old saved songs (50 = straight … 75)
// stay valid — and clamp it to a musically safe, non-degenerate range so the
// inverse warp can never divide by zero.
const SWING_TARGET = 2 / 3 // ratio s at full +amount (triplet swing)
const S_MIN = 0.1
const S_MAX = 0.9
const DEFAULT_SWING = 50 // s = 0.5 → straight
const swClamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v))
// amount (-1..+1) → ratio s. target is the swing CHARACTER at full amount.
function amountToRatio(amount, target = SWING_TARGET) {
  const a = swClamp(amount, -1, 1)
  return swClamp(0.5 + a * (target - 0.5), S_MIN, S_MAX)
}
// ratio s → amount (-1..+1). Inverse of amountToRatio within its range.
function ratioToAmount(s, target = SWING_TARGET) {
  if (target === 0.5) return 0
  return swClamp((s - 0.5) / (target - 0.5), -1, 1)
}

// Map a musical beat (cells on the linear grid) to swung playback time. Notes
// are grouped into pairs of `unit` cells — the swing note value — where the
// first unit takes ratio `s` of the pair and the second the rest. s > 0.5 makes
// the offbeat late (swing), s < 0.5 early (push). `unit` is the swing grid in
// cells (a fixed 8th by default). Piecewise-linear and strictly monotonic for
// any 0 < s < 1, so note order can never be violated.
function applySwingBeat(beat, swingPct, unit = 1) {
  if (!(unit > 0)) return beat
  const swing = swClamp(swingPct / 100, S_MIN, S_MAX)
  if (swing === 0.5) return beat
  const pair = 2 * unit
  const pairIdx = Math.floor(beat / pair)
  const local = beat - pairIdx * pair
  let timeInPair
  if (local < unit) {
    timeInPair = (local / unit) * (swing * pair)
  } else {
    timeInPair = swing * pair + ((local - unit) / unit) * ((1 - swing) * pair)
  }
  return pairIdx * pair + timeInPair
}

// Inverse: given swung playback time in cells, recover the musical beat (where
// the playhead should sit on the linear grid). Exact inverse of applySwingBeat.
function unswingTimeBeat(t, swingPct, unit = 1) {
  if (!(unit > 0)) return t
  const swing = swClamp(swingPct / 100, S_MIN, S_MAX)
  if (swing === 0.5) return t
  const pair = 2 * unit
  const pairIdx = Math.floor(t / pair)
  const localT = t - pairIdx * pair
  const firstDur = swing * pair
  let localMusic
  if (localT < firstDur) {
    localMusic = (localT / firstDur) * unit
  } else {
    localMusic = unit + ((localT - firstDur) / ((1 - swing) * pair)) * unit
  }
  return pairIdx * pair + localMusic
}

function padId(id) {
  return String(id).padStart(2, '0')
}

function midiToOctave(midi) {
  return Math.floor(midi / 12) - 1
}

// Canonical fingerprint of a template's musical shape, used to detect
// duplicates. Two templates are "the same" when they share BOTH:
//  1. Scalar relationship — the pitch contour in scale-step space
//     (octave*8 + degree), invariant to transposition (we subtract the
//     lowest step). `semis` (chromatic offset) is kept so off-scale variants
//     stay distinct.
//  2. Rhythmic relationship — the pattern of onsets + durations, invariant to
//     the absolute note value (we divide every time quantity by their GCD, so
//     the same figure written in 16ths or 8ths collapses to one signature).
// Returns a stable string; equal strings ⇒ duplicate.
function templateSignature(notes) {
  if (!notes || !notes.length) return ''
  // Encode (octave, degree) as a single monotone step index. N just has to
  // exceed any scale's note count so per-octave indices never overlap — 12
  // (the chromatic max) covers scales of any size, including custom ones.
  const N = 12
  const steps = notes.map((n) => (n.octave || 0) * N + n.degree)
  const minStep = Math.min(...steps)
  const minBeat = Math.min(...notes.map((n) => n.beat))
  const S = 48 // scale factor to turn tuplet fractions into integers
  const scaled = notes.map((n, i) => ({
    step: steps[i] - minStep,
    semis: n.semis || 0,
    onset: Math.round((n.beat - minBeat) * S),
    len: Math.round((n.length || 1) * S),
  }))
  const gcd2 = (a, b) => (b ? gcd2(b, a % b) : a)
  let g = 0
  for (const s of scaled) {
    if (s.onset > 0) g = gcd2(g, s.onset)
    g = gcd2(g, s.len)
  }
  if (!g) g = 1
  const tokens = scaled.map(
    (s) => `${s.step}:${s.semis}:${s.onset / g}:${s.len / g}`
  )
  tokens.sort()
  return tokens.join(';')
}

// Each MIDI row in the keyboard column occupies exactly one ROW_HEIGHT, so
// the keyboard and the grid are pixel-perfectly aligned at every semitone.
// White keys fill the column's full width; black keys are narrower and
// right-aligned, so the layout still reads as a piano without the visual
// overlap drift that came from mixing white-key spacing with semitone rows.
// Recomputed on every render (see zoom sync) so vertical zoom scales the
// keyboard column as well as the grid.
let KBD_COLUMN_HEIGHT = (MIDI_HIGH - MIDI_LOW + 1) * ROW_HEIGHT

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

// Small type-to-edit integer field for the time signature (numerator /
// denominator). Commits on Enter / blur, clamps to [min, max], Escape
// reverts. No dropdown — just type.
function TimeSigInput({ value, min, max, onCommit, ariaLabel }) {
  const [draft, setDraft] = useState(String(value))
  const focusedRef = useRef(false)
  useEffect(() => {
    if (!focusedRef.current) setDraft(String(value))
  }, [value])
  const maxLen = String(max).length
  const commit = () => {
    const v = Math.round(Number(draft))
    if (Number.isFinite(v) && draft !== '') {
      const c = Math.max(min, Math.min(max, v))
      onCommit(c)
      setDraft(String(c))
    } else {
      setDraft(String(value))
    }
  }
  // A text field (not type="number") so we can read the selection — number
  // inputs disallow selectionStart. Digit entry is handled explicitly: a key
  // press replaces the value when the field is fully selected (fresh focus /
  // Ctrl+A) and otherwise appends, capped to the max's digit count. This
  // guarantees ONE press = ONE digit — no doubling from a lost selection, no
  // auto-repeat spam from a held key.
  return (
    <input
      type="text"
      inputMode="numeric"
      className="time-sig-input"
      value={draft}
      aria-label={ariaLabel}
      onFocus={(e) => {
        focusedRef.current = true
        e.target.select()
      }}
      onBlur={() => {
        focusedRef.current = false
        commit()
      }}
      onChange={(e) => {
        // Backspace / paste path (digit keys are consumed in onKeyDown).
        setDraft(e.target.value.replace(/\D/g, '').slice(0, maxLen))
      }}
      onKeyDown={(e) => {
        if (e.repeat) {
          e.preventDefault()
          return
        }
        if (e.key === 'Enter') {
          e.currentTarget.blur()
          return
        }
        if (e.key === 'Escape') {
          setDraft(String(value))
          e.currentTarget.blur()
          return
        }
        if (/^\d$/.test(e.key)) {
          e.preventDefault()
          const el = e.currentTarget
          const fullySelected =
            el.selectionStart === 0 && el.selectionEnd === el.value.length
          setDraft((d) => ((fullySelected ? '' : d) + e.key).slice(-maxLen))
        }
      }}
    />
  )
}

function PlayIcon() {
  return (
    <svg width="12" height="14" viewBox="0 0 12 14" aria-hidden="true">
      <path d="M2 1 L11 7 L2 13 Z" fill="currentColor" />
    </svg>
  )
}

// Orientation toggle glyph: a minimal fret-grid (tic-tac-toe style — inner
// lines only, no outer border). ONE persistent SVG so switching animates: the
// core 3×3 turns a quarter-turn while the two outer columns grow in, so it
// literally "turns the guitar and gets wider". `orientation` = current view.
function FretDiagramIcon({ orientation = 'horizontal' }) {
  const s = { stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round' }
  return (
    <svg
      className={`fret-orient-icon ${orientation}`}
      width="17"
      height="17"
      viewBox="-11 -11 22 22"
      aria-hidden="true"
    >
      {/* core 3×3 (always shown) */}
      <line x1="-2" y1="-6" x2="-2" y2="6" {...s} />
      <line x1="2" y1="-6" x2="2" y2="6" {...s} />
      <line x1="-6" y1="-2" x2="6" y2="-2" {...s} />
      <line x1="-6" y1="2" x2="6" y2="2" {...s} />
      {/* extra column on the right — grows in for the wide (horizontal) board */}
      <g className="fret-orient-col">
        <line x1="6" y1="-6" x2="6" y2="6" {...s} />
        <line x1="6" y1="-2" x2="10" y2="-2" {...s} />
        <line x1="6" y1="2" x2="10" y2="2" {...s} />
      </g>
      {/* extra column on the left */}
      <g className="fret-orient-col">
        <line x1="-6" y1="-6" x2="-6" y2="6" {...s} />
        <line x1="-10" y1="-2" x2="-6" y2="-2" {...s} />
        <line x1="-10" y1="2" x2="-6" y2="2" {...s} />
      </g>
    </svg>
  )
}

// Six-dot "grip" used as the panel reorder anchor.
function AnchorGripIcon() {
  return (
    <svg width="10" height="14" viewBox="0 0 10 14" aria-hidden="true">
      {[3, 7, 11].map((cy) =>
        [2.5, 7.5].map((cx) => (
          <circle key={`${cx}-${cy}`} cx={cx} cy={cy} r="1.1" fill="currentColor" />
        ))
      )}
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

// Available synth oscillator types. Each track picks one and the scheduler
// plays its notes with that oscillator, giving tracks distinct timbres.
const SYNTH_TYPES = [
  { id: 'triangle', label: 'Triangle', gainScale: 1.0 },
  { id: 'sine', label: 'Sine', gainScale: 1.05 },
  { id: 'sawtooth', label: 'Saw', gainScale: 0.55 },
  { id: 'square', label: 'Square', gainScale: 0.5 },
]

export default function PianoRoll({
  scale: rawScale,
  root,
  onBack,
  templates = [],
  setTemplates,
  modeStep = null,
  settings = {},
  overlayOpen = false,
  songs = [],
  activeSongId = null,
  onSelectSong,
  onAddSong,
  onRemoveSong,
  onRenameSong,
  songGroups = [],
  onAddGroup,
  onRemoveGroup,
  onRenameGroup,
  onSetGroupColour,
  onToggleGroupCollapsed,
  onMoveSong,
  onMoveGroup,
  onAssignSongToGroup,
  onFallbackUndo,
  onFallbackRedo,
  initialTracks = null,
  initialActiveTrackId = null,
  onPersistTracks,
  initialBpm = null,
  initialSwing = null,
  initialLoop = null,
  initialTotalBeats = null,
  initialTimeSig = null,
  onPersistPlayback,
  tabSwitchPlayback = 'stop',
}) {
  const allowOutOfScale = !!settings.allowOutOfScale
  const useFlats = !!settings.useFlats
  // Song-tab appearance: 'pill' (current) or 'classic' (the white Chrome-style
  // tabs on a baseline). Drives a class on the .song-tabs container.
  const tabStyle = settings.tabStyle === 'classic' ? 'classic' : 'pill'
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
  // Intrinsic root degree: an explicit mode pick wins; else the scale's own
  // rootStep (custom scales carry it) or the built-in rootSteps table.
  const _rsRoll = rawScale
    ? modeStep ?? rawScale.rootStep ?? rootSteps[rawScale.id - 1]
    : null
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
  // Tracks: each carries its own notes Map + name + volume/mute/solo.
  // The existing single-track API (`notes` / `setNotes`) below routes
  // through the active track so every existing handler keeps working.
  const makeTrackId = () =>
    `tr-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
  // Default track factory used by song initialisation + the "+ track" button.
  // attackMs: how long the gain envelope takes to ramp to peak (0.5–60 ms).
  // releaseMs: how long the gain envelope takes to fall to silence (5–800 ms).
  // detuneCents: pitch offset in cents (-100 to +100) — adds shimmer or
  //              tunes the voice off the equal-temperament center.
  const buildDefaultTrack = (overrides = {}) => ({
    id: makeTrackId(),
    name: 'Melody',
    notes: new Map(),
    volume: 0.85,
    muted: false,
    soloed: false,
    synth: 'triangle',
    attackMs: 15,
    releaseMs: 220,
    detuneCents: 0,
    ...overrides,
  })
  const [tracks, setTracks] = useState(() => {
    if (initialTracks && initialTracks.length > 0) {
      // Hydrate from the song's persisted tracks. Notes may arrive as a
      // plain Map (in-session) or absent — guard either way.
      return initialTracks.map((t) => ({
        ...buildDefaultTrack(),
        ...t,
        notes: t.notes instanceof Map ? t.notes : new Map(t.notes ?? []),
      }))
    }
    // Fresh song → one empty, generically-named track. The user fills it in
    // themselves; no auto-generated pattern is placed on the grid.
    return [buildDefaultTrack({ name: 'Track 1' })]
  })
  const [activeTrackId, setActiveTrackId] = useState(
    () => initialActiveTrackId ?? null
  )
  // Resolve the active track (first one if no explicit selection).
  const activeTrack =
    tracks.find((t) => t.id === activeTrackId) ?? tracks[0] ?? null
  // Existing call sites read `notes` and call `setNotes(updater)`; both
  // now operate on the active track's notes. `setNotes` accepts either a
  // value or an updater function, matching React's useState contract.
  const notes = activeTrack ? activeTrack.notes : new Map()
  const setNotes = (updater) => {
    const targetId = activeTrack ? activeTrack.id : null
    if (!targetId) return
    setTracks((prev) =>
      prev.map((t) => {
        if (t.id !== targetId) return t
        const next =
          typeof updater === 'function' ? updater(t.notes) : updater
        return { ...t, notes: next }
      })
    )
  }
  const [totalBeats, setTotalBeats] = useState(
    initialTotalBeats ?? DEFAULT_BEATS
  )
  const [bpm, setBpm] = useState(initialBpm ?? DEFAULT_BPM)
  const [swingPct, setSwingPct] = useState(initialSwing ?? DEFAULT_SWING)
  // Time signature. `num` = beats per measure, `den` = note value that gets
  // the beat (4 = quarter, 8 = eighth, 2 = half). Everything on the grid is
  // still measured in 16th-note cells, so a beat spans `16 / den` cells and
  // a measure `num × (16 / den)` cells — the timeline, grid lines, metronome
  // and the rhythm "bar" unit all derive from these.
  const [timeSig, setTimeSig] = useState(
    initialTimeSig && initialTimeSig.num && initialTimeSig.den
      ? initialTimeSig
      : { num: 4, den: 4 }
  )
  const cellsPerBeat = CELLS_PER_WHOLE / timeSig.den
  const cellsPerMeasure = timeSig.num * cellsPerBeat
  // Ableton-style auto-extending timeline: the grid grows in whole-measure
  // chunks as the user scrolls to the right edge or drags/places notes past
  // the current end. `totalBeatsRef` mirrors state so live pointer handlers
  // (which close over a stale `totalBeats`) can read/extend the real length.
  const totalBeatsRef = useRef(totalBeats)
  useEffect(() => {
    totalBeatsRef.current = totalBeats
  }, [totalBeats])
  // Grow the timeline so `endBeat` fits (rounded up to a measure), capped at
  // MAX_BEATS. Updates the ref synchronously so a single pointer handler can
  // extend and immediately clamp against the new length. Returns the length.
  const growBeatsForEnd = (endBeat) => {
    const cur = totalBeatsRef.current
    if (endBeat <= cur - 1) return cur
    const grown = Math.min(
      MAX_BEATS,
      Math.ceil((endBeat + 1) / cellsPerMeasure) * cellsPerMeasure
    )
    if (grown > cur) {
      totalBeatsRef.current = grown
      setTotalBeats(grown)
    }
    return totalBeatsRef.current
  }
  const [playheadBeat, setPlayheadBeat] = useState(null)
  const [freeMode, setFreeMode] = useState(false)
  // Roll zoom (horizontal + vertical, independent). 1 = default. Bounded to
  // sensible min/max so the user can't accidentally zoom out to zero.
  // Ctrl + wheel → horizontal zoom; Ctrl + Shift + wheel → vertical zoom.
  // Shift + wheel scrolls horizontally (see the wheel handler).
  const [zoomX, setZoomX] = useState(1)
  const [zoomY, setZoomY] = useState(1)
  const ZOOM_MIN = 0.3
  const ZOOM_MAX = 4
  // Wheel-driven zoom. Attached imperatively so we can pass { passive:false }
  // and preventDefault the scroll — React's onWheel is passive in modern
  // browsers, which blocks preventDefault. Zoom pivots on the cursor: we
  // adjust scrollLeft/scrollTop after the zoom so the point under the mouse
  // stays under the mouse (Figma / Illustrator behaviour).
  useEffect(() => {
    const sc = scrollRef.current
    if (!sc) return
    // Fixed, non-scaling offsets of the scroll content: the sticky keyboard
    // column on the left (52 px) and the sticky timeline on top (26 px).
    // Only the region PAST these offsets scales with zoom, so the cursor
    // pivot must subtract them — otherwise the content drifts out from
    // under the timeline as you zoom.
    const LEFT_COL = 52
    const TOP_ROW = 26
    const onWheel = (e) => {
      const meta = e.ctrlKey || e.metaKey
      // Modifier map:
      //  Ctrl/⌘             → horizontal zoom
      //  Ctrl/⌘ + Shift     → vertical zoom
      //  Shift              → horizontal scroll
      //  (none)             → scroll both axes (driven explicitly below so
      //                       trackpad vertical scrolling is reliable)
      if (!meta && !e.shiftKey) {
        // Plain wheel / trackpad two-finger scroll. Drive the container
        // directly in both axes so vertical scrolling works on trackpads
        // and browsers that don't deliver native scroll here. deltaMode 1
        // (lines) / 2 (pages) are scaled to pixels. Always attempt the
        // scroll (scrollTop/Left auto-clamp) and only preventDefault if it
        // actually moved, so edge cases fall through to native.
        const vScale =
          e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? sc.clientHeight : 1
        const hScale =
          e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? sc.clientWidth : 1
        const beforeTop = sc.scrollTop
        const beforeLeft = sc.scrollLeft
        if (e.deltaY) sc.scrollTop = beforeTop + e.deltaY * vScale
        if (e.deltaX) sc.scrollLeft = beforeLeft + e.deltaX * hScale
        if (sc.scrollTop !== beforeTop || sc.scrollLeft !== beforeLeft) {
          e.preventDefault()
        }
        return
      }
      e.preventDefault()
      const rect = sc.getBoundingClientRect()
      const cursorViewX = e.clientX - rect.left
      const cursorViewY = e.clientY - rect.top
      const factor = Math.pow(1.0015, -e.deltaY)
      if (!meta && e.shiftKey) {
        // Shift + wheel → scroll horizontally. Trackpads send horizontal
        // intent as deltaX; a plain wheel sends deltaY — use whichever is
        // larger in magnitude.
        const delta =
          Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY
        sc.scrollLeft = Math.max(
          0,
          Math.min(sc.scrollWidth - sc.clientWidth, sc.scrollLeft + delta)
        )
      } else if (meta && e.shiftKey) {
        // Ctrl/⌘ + Shift → vertical zoom, pivoting on the cursor row.
        setZoomY((z) => {
          const nz = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, z * factor))
          if (nz === z) return z
          const r = nz / z
          requestAnimationFrame(() => {
            sc.scrollTop = Math.max(
              0,
              TOP_ROW + (sc.scrollTop + cursorViewY - TOP_ROW) * r - cursorViewY
            )
          })
          return nz
        })
      } else {
        // Ctrl/⌘ → horizontal zoom, pivoting on the cursor beat.
        setZoomX((z) => {
          const nz = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, z * factor))
          if (nz === z) return z
          const r = nz / z
          requestAnimationFrame(() => {
            sc.scrollLeft = Math.max(
              0,
              LEFT_COL + (sc.scrollLeft + cursorViewX - LEFT_COL) * r - cursorViewX
            )
          })
          return nz
        })
      }
    }
    sc.addEventListener('wheel', onWheel, { passive: false })
    return () => sc.removeEventListener('wheel', onWheel)
  }, [])
  // Push the current zoom multipliers into the module-level pixel constants
  // so every downstream consumer — helper functions, JSX styles, drag/hit
  // math — reads the same scaled value on this render pass.
  BEAT_WIDTH = BEAT_WIDTH_BASE * zoomX
  ROW_HEIGHT = ROW_HEIGHT_BASE * zoomY
  KBD_COLUMN_HEIGHT = (MIDI_HIGH - MIDI_LOW + 1) * ROW_HEIGHT
  const [metronome, setMetronome] = useState(false)
  // ── Swung-grid display (opt-in, default off) ─────────────────────────────
  // When ON and swing is active, notes AND gridlines draw at their SWUNG
  // positions, so notes sit visually on the grid and you can see where they
  // fire. Notes stay STORED raw; `beatToX` warps raw→screen for drawing and
  // `xToBeat` unwarps screen→raw for input, so dragging / placement still land
  // on raw positions. Both are the identity when the mode is off (or swing is
  // straight), leaving the default display byte-for-byte unchanged.
  const [swungDisplay, setSwungDisplay] = useState(
    () => localStorage.getItem('roll.swungDisplay') === '1'
  )
  useEffect(() => {
    try {
      localStorage.setItem('roll.swungDisplay', swungDisplay ? '1' : '0')
    } catch {}
  }, [swungDisplay])
  const swingViewActive = swungDisplay && swingPct !== 50
  const beatToX = (beat) =>
    (swingViewActive
      ? applySwingBeat(beat, swingPct, SWING_GRID_CELLS)
      : beat) * BEAT_WIDTH
  const xToBeat = (px) => {
    const raw = px / BEAT_WIDTH
    return swingViewActive
      ? unswingTimeBeat(raw, swingPct, SWING_GRID_CELLS)
      : raw
  }
  // Note WIDTH in swung space is the warped span, not len·BW (warp is non-linear).
  const spanToX = (beat, len) => beatToX(beat + len) - beatToX(beat)
  // Move a raw beat by a pixel delta. In straight mode this is beat + dx/BW; in
  // swung mode the delta is applied in SCREEN space and unwarped, since a fixed
  // pixel delta is not a fixed beat delta across a pair boundary (spec §5).
  const shiftBeatByPx = (beat, dxPx) => xToBeat(beatToX(beat) + dxPx)
  const [selectedKeys, setSelectedKeys] = useState(() => new Set())
  // Template waiting to be placed by the user's next grid click. Carries
  // the full template object so the placement handler can compute the
  // beat + scale-step shift from the click position.
  const [pendingTemplate, setPendingTemplate] = useState(null)
  const [marquee, setMarquee] = useState(null)
  const [loop, setLoop] = useState(initialLoop ?? null)
  const [exportFeedback, setExportFeedback] = useState('')
  const [chordModalOpen, setChordModalOpen] = useState(false)
  // Chord-voicings fretboard viewer (separate from the insert palette above).
  const [chordVoicingOpen, setChordVoicingOpen] = useState(false)
  const [voicingSide, setVoicingSide] = useState('left') // which of the 2 chords
  const [voicingIndex, setVoicingIndex] = useState(0) // index into that side's list
  // Floating pitch label that follows the cursor while hovering a row-note.
  // Carries the hovered note's `key` so we can dismiss the label if that
  // note is deleted out from under the cursor (delete removes the DOM node
  // before its onMouseLeave can fire, otherwise the label would stick).
  const [notePitchTip, setNotePitchTip] = useState(null)
  // Mobile-only UI state. Desktop ignores these via CSS.
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false)
  const [mobileDrawerOpen, setMobileDrawerOpen] = useState(false)
  // Visible badge that lights up while T is held so the user can see that
  // ArrowUp/Down do a pitch rotation instead of the regular step nudge.
  const [tHeld, setTHeld] = useState(false)
  // Song-tab drag state (HTML5 DnD). `draggingId` = which song OR group is
  // being dragged (see `kind`); `overBeforeId` = which sibling the drop
  // indicator sits before (or "__tail" for the trailing zone). `kind` is
  // 'tab' when dragging a song tab or 'group' when dragging a group pill —
  // the drop handlers check this to decide between moveSong / moveGroup.
  const [tabDrag, setTabDrag] = useState({
    draggingId: null,
    kind: null,
    overBeforeId: null,
    width: 0,
    dx: 0,
  })
  const songTabsListRef = useRef(null)
  // True for one frame right after a tab drop so the reordered tabs snap to
  // their final slots without the leftover translateX briefly animating (the
  // "flick"). CSS disables tab transitions while this is set.
  const [tabSettling, setTabSettling] = useState(false)
  // Floating context menus on the song-tab bar. `tabMenu` opens on
  // right-click of a song tab (group-management actions); `groupMenu` opens
  // on right-click of a group strip. Coordinates are viewport pixels.
  const [tabMenu, setTabMenu] = useState(null)
  const [groupMenu, setGroupMenu] = useState(null)
  // Template-sharing UI state (multi-select, right-click menu, inline rename).
  // Declared here — before the close-menu effect that reads `templateMenu` —
  // to avoid a temporal-dead-zone ReferenceError during render.
  const [selectedTemplateIds, setSelectedTemplateIds] = useState(() => new Set())
  const [templateMenu, setTemplateMenu] = useState(null) // { x, y, id }
  const [renamingTemplateId, setRenamingTemplateId] = useState(null)
  const [renameValue, setRenameValue] = useState('')
  const templateFileInputRef = useRef(null)
  // "+" creation dropdown, the from-scratch editor modal, and live drag-reorder
  // state. `dragNodeId` = node being dragged (rendered dimmed in place while a
  // floating `dragGhost` follows the cursor and the list reorders live).
  const [newMenu, setNewMenu] = useState(null) // null | { x, y } (fixed pos)
  // Template search: an icon toggles a filter bar; typing narrows the list
  // (case-insensitive, by name). Dismissed by the icon or an outside click.
  const [searchOpen, setSearchOpen] = useState(false)
  const [templateSearch, setTemplateSearch] = useState('')
  const searchWrapRef = useRef(null)
  const searchBtnRef = useRef(null)
  const closeSearch = () => {
    setSearchOpen(false)
    setTemplateSearch('')
  }
  // Clicking a search result jumps to that template in the full list: close the
  // filter, expand its ancestor folders, centre it in view and flash it.
  const [flashTemplateId, setFlashTemplateId] = useState(null)
  const flashTimerRef = useRef(null)
  const revealTemplate = (node) => {
    closeSearch()
    const byId = new Map(templates.map((n) => [n.id, n]))
    const toExpand = new Set()
    let p = node.parentId
    while (p != null && byId.has(p)) {
      toExpand.add(p)
      p = byId.get(p).parentId
    }
    if (toExpand.size && setTemplates) {
      setTemplates((prev) =>
        prev.map((n) => (toExpand.has(n.id) ? { ...n, collapsed: false } : n))
      )
    }
    setFlashTemplateId(node.id)
    // Wait for the filter-close + folder-expand to render, then centre it.
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        const el = document.querySelector(`[data-node-id="${node.id}"]`)
        if (el) el.scrollIntoView({ block: 'center', behavior: 'smooth' })
      })
    )
    if (flashTimerRef.current) clearTimeout(flashTimerRef.current)
    flashTimerRef.current = setTimeout(() => setFlashTemplateId(null), 1500)
  }
  useEffect(() => {
    if (!searchOpen) return
    const onDown = (e) => {
      if (
        searchWrapRef.current?.contains(e.target) ||
        searchBtnRef.current?.contains(e.target)
      )
        return
      // A click on a result row must reach the row's own click (which reveals
      // and closes) — don't pre-empt it here.
      if (e.target.closest?.('[data-node-id]')) return
      closeSearch()
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [searchOpen])
  // ── Tags ────────────────────────────────────────────────────────────────
  // The tag library = a persisted registry (tags created but not yet applied)
  // unioned with every tag found on a template. The Tags modal manages this
  // library and builds a "working set" that can be applied as a filter.
  const [tagsModalOpen, setTagsModalOpen] = useState(false)
  const [importConflicts, setImportConflicts] = useState(null)
  // Tag filter. `tagFilter` is the selection being built in the Tags modal
  // (green = include, red = exclude); `appliedTagFilter` is what the template
  // list actually filters by — committed via the modal's "Apply as filters".
  const EMPTY_TAG_FILTER = { include: [], exclude: [] }
  const [tagFilter, setTagFilter] = useState(EMPTY_TAG_FILTER)
  const [appliedTagFilter, setAppliedTagFilter] = useState(EMPTY_TAG_FILTER)
  const tagFilterActive =
    appliedTagFilter.include.length > 0 || appliedTagFilter.exclude.length > 0
  const [tagRegistry, setTagRegistry] = useState(() => {
    try {
      const v = JSON.parse(localStorage.getItem('eightFold.tagRegistry') || '[]')
      return Array.isArray(v) ? v : []
    } catch {
      return []
    }
  })
  useEffect(() => {
    try {
      localStorage.setItem('eightFold.tagRegistry', JSON.stringify(tagRegistry))
    } catch {}
  }, [tagRegistry])
  const allTags = useMemo(() => {
    const seen = new Map()
    const add = (t) => {
      if (t && !seen.has(t.toLowerCase())) seen.set(t.toLowerCase(), t)
    }
    tagRegistry.forEach(add)
    for (const n of templates) (n.tags || []).forEach(add)
    return [...seen.values()].sort((a, b) => a.localeCompare(b))
  }, [tagRegistry, templates])
  const registerTags = (names) =>
    setTagRegistry((prev) => {
      const set = new Set(prev.map((t) => t.toLowerCase()))
      const extra = names.filter((n) => n && !set.has(n.toLowerCase()))
      return extra.length ? [...prev, ...extra] : prev
    })
  const deleteTagEverywhere = (tag) => {
    const low = tag.toLowerCase()
    setTagRegistry((prev) => prev.filter((t) => t.toLowerCase() !== low))
    if (setTemplates)
      setTemplates((prev) =>
        prev.map((n) =>
          n.tags?.some((t) => t.toLowerCase() === low)
            ? { ...n, tags: n.tags.filter((t) => t.toLowerCase() !== low) }
            : n
        )
      )
    const strip = (f) => ({
      include: f.include.filter((t) => t.toLowerCase() !== low),
      exclude: f.exclude.filter((t) => t.toLowerCase() !== low),
    })
    setTagFilter(strip)
    setAppliedTagFilter(strip)
  }
  // Renaming is case-SENSITIVE: "jazz" → "Jazz" is a real rename, so only an
  // exact-string match (or an empty name) is a no-op.
  const renameTagEverywhere = (oldTag, newName) => {
    const nn = (newName || '').trim()
    const low = oldTag.toLowerCase()
    if (!nn || nn === oldTag) return
    const swap = (arr) => [
      ...new Set(arr.map((t) => (t.toLowerCase() === low ? nn : t))),
    ]
    setTagRegistry((prev) => swap(prev))
    if (setTemplates)
      setTemplates((prev) =>
        prev.map((n) =>
          n.tags?.some((t) => t.toLowerCase() === low)
            ? { ...n, tags: swap(n.tags) }
            : n
        )
      )
    const swapFilter = (f) => ({
      include: swap(f.include),
      exclude: swap(f.exclude),
    })
    setTagFilter(swapFilter)
    setAppliedTagFilter(swapFilter)
  }
  const [templateEditorOpen, setTemplateEditorOpen] = useState(false)
  // id of the template being edited (null = creating a brand-new one).
  const [editingTemplateId, setEditingTemplateId] = useState(null)
  // `paramsOpen` is the centered "Roll settings" modal holding every option;
  // opened by the ⋯ button or the M key. Escape (and its backdrop) close it.
  const [paramsOpen, setParamsOpen] = useState(false)
  useEffect(() => {
    if (!paramsOpen) return
    const onKey = (e) => {
      if (e.key === 'Escape') setParamsOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [paramsOpen])
  // Inline-editable group name state. Only one pill can be in edit mode at a
  // time; the input starts prefilled with the current name and commits on
  // Enter / blur (Esc cancels without saving).
  const [renamingGroup, setRenamingGroup] = useState(null) // { id, draft } | null
  // Cursor anchor while a template is queued for placement. Every grid row
  // pushes { beat, midi } here on mousemove so we can render a ghost preview
  // of what a click would drop onto the roll. Null → no preview.
  const [templateHover, setTemplateHover] = useState(null) // { beat, midi } | null
  useEffect(() => {
    if (!pendingTemplate) setTemplateHover(null)
  }, [pendingTemplate])
  // General cursor hover — a single grid cell under the pointer, drawn as a
  // thin outlined rectangle so the user knows exactly which beat + midi row
  // a click would land on. Cleared on mouseleave of the grid area.
  const [hoveredCell, setHoveredCell] = useState(null) // { beat, midi } | null
  // MIDI regions ("runes") created by the R key: each is a detached staircase
  // clip you can pitch-shift, move, extend, select, and delete (baking its
  // notes onto the timeline). Array so several can coexist (Rune 1, 2, …).
  const [midiRegions, setMidiRegions] = useState([])
  const [selectedRegionId, setSelectedRegionId] = useState(null)
  // Fretboard preview: 'off' (templates + roll), 'vertical' (fretboard replaces
  // the templates sidebar), or 'horizontal' (fretboard replaces the roll).
  const [fretboardView, setFretboardView] = useState('off')
  // Fretboard "position": the lower fret of the 5-fret span notes are placed in.
  // Set with the P key + a number; auto-shifts when an entered note is outside.
  const [fretPosition, setFretPosition] = useState(0)
  const [fretPosPriming, setFretPosPriming] = useState(false)
  const fretPosPrimingRef = useRef(false)
  fretPosPrimingRef.current = fretPosPriming
  const fretPosBufRef = useRef('')
  const fretPosTimerRef = useRef(null)
  // Dockable, resizable layout. Panels are keyed ('templates' | 'roll' |
  // 'synth'); `panelOrder` is their left-to-right arrangement (reorder by
  // dragging a panel's anchor grip). Widths are per sidebar (the roll always
  // flexes); heights are per panel (null = stretch full). Persisted.
  const loadJSON = (k, d) => {
    try {
      const v = localStorage.getItem(k)
      return v ? JSON.parse(v) : d
    } catch {
      return d
    }
  }
  const [panelOrder, setPanelOrder] = useState(() => {
    const a = loadJSON('roll.order', null)
    return Array.isArray(a) && a.length === 3 ? a : ['templates', 'roll', 'synth']
  })
  const [panelW, setPanelW] = useState(() =>
    loadJSON('roll.w', { templates: 220, synth: 220 })
  )
  const [panelH, setPanelH] = useState(() =>
    loadJSON('roll.h', { templates: null, roll: null, synth: null })
  )
  // Collapsed side panels shrink to a thin vertical strip (name written
  // top-to-bottom) so the timeline gets the room. The roll itself never
  // collapses. Persisted.
  const [panelCollapsed, setPanelCollapsed] = useState(() =>
    loadJSON('roll.collapsed', { templates: false, synth: false })
  )
  const COLLAPSED_W = 40
  const toggleCollapse = (key) =>
    setPanelCollapsed((prev) => ({ ...prev, [key]: !prev[key] }))
  // The whole top chrome (settings header + scale spelling + tabs) collapses
  // into a thin summary row (play · BPM · quick tab switcher) so the stage
  // below reclaims the vertical space. Persisted.
  const [topCollapsed, setTopCollapsed] = useState(() =>
    loadJSON('roll.topCollapsed', false)
  )
  useEffect(() => {
    try {
      localStorage.setItem('roll.topCollapsed', JSON.stringify(topCollapsed))
    } catch {}
  }, [topCollapsed])
  // While reordering: { key, dx } — the panel being dragged and how far it has
  // moved from its slot (so it follows the cursor). null when not dragging.
  const [dragState, setDragState] = useState(null)
  const rollBodyRef = useRef(null)
  const panelOrderRef = useRef(panelOrder)
  panelOrderRef.current = panelOrder
  useEffect(() => {
    try {
      localStorage.setItem('roll.order', JSON.stringify(panelOrder))
      localStorage.setItem('roll.w', JSON.stringify(panelW))
      localStorage.setItem('roll.h', JSON.stringify(panelH))
      localStorage.setItem('roll.collapsed', JSON.stringify(panelCollapsed))
    } catch {}
  }, [panelOrder, panelW, panelH, panelCollapsed])
  const setPanelWidth = (key, w) =>
    setPanelW((prev) => ({ ...prev, [key]: w }))
  const setPanelHeight = (key, h) =>
    setPanelH((prev) => ({ ...prev, [key]: h }))
  // Flex/order style for a panel. The roll flexes (no fixed width); a resized
  // panel is bottom-anchored so it grows toward the TOP.
  const panelStyle = (key) => {
    const collapsed = key !== 'roll' && panelCollapsed[key]
    const w = collapsed ? COLLAPSED_W : key === 'roll' ? null : panelW[key]
    // The roll (main timeline) always stretches to fill the available height so
    // it grows when the top chrome collapses; only side panels take a saved height.
    const h = collapsed || key === 'roll' ? null : panelH[key]
    const dragging = dragState && dragState.key === key
    return {
      order: panelOrder.indexOf(key) * 2,
      ...(w != null ? { flex: `0 0 ${w}px`, width: `${w}px` } : {}),
      ...(h != null ? { height: `${h}px`, alignSelf: 'flex-end' } : {}),
      // The dragged panel follows the cursor and floats above the others.
      ...(dragging
        ? {
            transform: `translateX(${dragState.dx}px)`,
            zIndex: 40,
            transition: 'none',
            pointerEvents: 'none',
          }
        : {}),
    }
  }
  // Drag a vertical splitter → resize the sidebar next to that boundary.
  const startColResize = (boundary) => (e) => {
    if (e.button !== 0) return
    e.preventDefault()
    const keyL = panelOrder[boundary]
    const keyR = panelOrder[boundary + 1]
    const sideKey = keyL !== 'roll' ? keyL : keyR // the fixed-width neighbour
    const sign = keyL !== 'roll' ? 1 : -1 // sidebar on the left grows when →
    const start = panelW[sideKey]
    const startX = e.clientX
    const move = (mv) => {
      const dx = mv.clientX - startX
      const w = start + sign * dx
      setPanelWidth(sideKey, Math.max(120, Math.min(560, Math.round(w))))
    }
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      document.body.style.cursor = ''
    }
    document.body.style.cursor = 'col-resize'
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }
  // Drag a panel's top OR bottom edge → resize that panel's height (delta-based
  // so it works from either edge). Double-click resets to full-height stretch.
  const startHeightResize = (key, edge = 'bottom') => (e) => {
    if (e.button !== 0) return
    e.preventDefault()
    e.stopPropagation()
    const panel = e.currentTarget.parentElement
    const row = panel.parentElement // roll-body — bounds the max height
    const startH = panel.getBoundingClientRect().height
    const startY = e.clientY
    const move = (mv) => {
      const dy = mv.clientY - startY
      let h = edge === 'top' ? startH - dy : startH + dy
      const maxH = row ? row.getBoundingClientRect().height : Infinity
      h = Math.max(140, Math.min(maxH, h))
      setPanelHeight(key, Math.round(h))
    }
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      document.body.style.cursor = ''
    }
    document.body.style.cursor = 'row-resize'
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }
  const resetColWidth = (boundary) => {
    const keyL = panelOrder[boundary]
    const keyR = panelOrder[boundary + 1]
    setPanelWidth(keyL !== 'roll' ? keyL : keyR, 220)
  }
  // Drag a panel's anchor grip → the panel follows the cursor; the others reflow
  // as its centre passes theirs (CSS `order`). On release it settles in its slot.
  const startReorder = (key) => (e) => {
    if (e.button !== 0) return
    e.preventDefault()
    e.stopPropagation()
    const body = rollBodyRef.current
    if (!body) return
    const el = body.querySelector(`[data-panel="${key}"]`)
    const grabOffset = e.clientX - el.getBoundingClientRect().left
    let curDx = 0
    setDragState({ key, dx: 0 })
    const move = (mv) => {
      const dEl = body.querySelector(`[data-panel="${key}"]`)
      if (!dEl) return
      // Keep the panel's left under the cursor, accounting for its current
      // transform and any slot change from a reorder.
      const naturalLeft = dEl.getBoundingClientRect().left - curDx
      curDx = mv.clientX - grabOffset - naturalLeft
      setDragState({ key, dx: curDx })
      // Reorder by comparing centres: the dragged panel's centre (with its
      // transform) vs the others' natural centres. Stable → no thrash.
      const order = panelOrderRef.current
      const centres = order.map((k) => {
        const kEl = body.querySelector(`[data-panel="${k}"]`)
        const r = kEl.getBoundingClientRect()
        return { k, c: r.left + r.width / 2 }
      })
      centres.sort((a, b) => a.c - b.c)
      const next = centres.map((o) => o.k)
      if (next.join() !== order.join()) setPanelOrder(next)
    }
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      document.body.style.cursor = ''
      setDragState(null)
    }
    document.body.style.cursor = 'grabbing'
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }
  // Live mirrors so pointer handlers read current values synchronously (no
  // state-sync effect, which would race a fast drag).
  const midiRegionsRef = useRef([])
  midiRegionsRef.current = midiRegions
  const selectedRegionIdRef = useRef(null)
  selectedRegionIdRef.current = selectedRegionId
  const runeCounterRef = useRef(0)
  useEffect(() => {
    if (!tabMenu && !groupMenu && !templateMenu && !newMenu) return
    const close = () => {
      setTabMenu(null)
      setGroupMenu(null)
      setTemplateMenu(null)
      setNewMenu(null)
    }
    // Close on next click anywhere and on Escape — matches OS convention.
    window.addEventListener('mousedown', close)
    window.addEventListener('keydown', (e) => e.key === 'Escape' && close())
    return () => {
      window.removeEventListener('mousedown', close)
      window.removeEventListener('keydown', close)
    }
  }, [tabMenu, groupMenu, templateMenu, newMenu])
  // A shared drop handler used by both tab-drop and pill-drop targets. It
  // reads `tabDrag.kind` to decide whether the payload is a song (moveSong)
  // or an entire group (moveGroup). Drop targets translate their "before"
  // reference into a target songId (or null for the tail); when the payload
  // is a group, we normalise "drop before another group's pill" to "drop
  // before the first member of that group" so the target reference always
  // points at a real song.
  const handleDropBefore = (beforeId) => {
    const { draggingId, kind } = tabDrag
    if (!draggingId) {
      setTabDrag({ draggingId: null, kind: null, overBeforeId: null })
      return
    }
    if (kind === 'group') {
      onMoveGroup?.(draggingId, beforeId)
    } else {
      onMoveSong?.(draggingId, beforeId, undefined)
    }
    setTabDrag({ draggingId: null, kind: null, overBeforeId: null })
  }

  // Pointer-based tab drag (replaces the fragile HTML5 DnD). The tab follows
  // the cursor via translateX; the other tabs slide to open a gap. Below the
  // move threshold a pointerup is treated as a plain click (select tab).
  const handleTabPointerDown = (e, song) => {
    if (e.button != null && e.button !== 0) return // left button only
    // Let the close button / anything interactive handle its own pointerdown.
    if (e.target?.closest?.('.song-tab-close')) return
    const tabEl = e.currentTarget
    const startX = e.clientX
    const width = tabEl.offsetWidth
    const pointerId = e.pointerId
    let dragging = false
    let currentBeforeId = '__tail'
    try { tabEl.setPointerCapture?.(pointerId) } catch {}

    const computeBeforeId = (clientX) => {
      const list = songTabsListRef.current
      if (!list) return '__tail'
      const cx = clientX - list.getBoundingClientRect().left
      // offsetLeft is the LAYOUT position — unaffected by the sliding
      // transforms — so targeting stays stable while tabs animate.
      for (const el of list.querySelectorAll('.song-tab')) {
        if (el.dataset.songId === song.id) continue
        const mid = el.offsetLeft + el.offsetWidth / 2
        if (cx < mid) return el.dataset.songId
      }
      return '__tail'
    }

    const move = (mv) => {
      if (mv.pointerId !== pointerId) return
      const dx = mv.clientX - startX
      if (!dragging) {
        if (Math.abs(dx) < 4) return
        dragging = true
      }
      currentBeforeId = computeBeforeId(mv.clientX)
      setTabDrag({
        draggingId: song.id,
        kind: 'tab',
        overBeforeId: currentBeforeId,
        width,
        dx,
      })
    }
    const up = (uv) => {
      if (uv.pointerId !== pointerId) return
      tabEl.removeEventListener('pointermove', move)
      tabEl.removeEventListener('pointerup', up)
      tabEl.removeEventListener('pointercancel', up)
      try { tabEl.releasePointerCapture?.(pointerId) } catch {}
      if (dragging) {
        const target = currentBeforeId === '__tail' ? null : currentBeforeId
        onMoveSong?.(song.id, target, undefined)
        // Suppress tab transitions for one frame so the reorder + transform
        // reset apply instantly at the new layout positions (no flick), then
        // re-enable them.
        setTabSettling(true)
        requestAnimationFrame(() => setTabSettling(false))
      } else if (song.id !== activeSongId) {
        onSelectSong?.(song.id)
      }
      setTabDrag({ draggingId: null, kind: null, overBeforeId: null, width: 0, dx: 0 })
    }
    tabEl.addEventListener('pointermove', move)
    tabEl.addEventListener('pointerup', up)
    tabEl.addEventListener('pointercancel', up)
  }
  const audioCtxRef = useRef(null)
  // Keep the per-instance ref pointing at the shared module context (if one
  // exists yet) so code paths that read audioCtxRef.current before the
  // first getAudioContext() call still find the live context.
  if (sharedAudioCtx) audioCtxRef.current = sharedAudioCtx
  const playStateRef = useRef(null)
  const rafRef = useRef(null)
  const scheduledVoicesRef = useRef([])
  const scrollRef = useRef(null)
  // Custom DAW-style horizontal scrollbar. `hbar` holds the thumb geometry as
  // fractions of the scroll range (pos = left edge, size = visible portion).
  // Dragging the thumb body scrolls; dragging either end grip resizes the
  // thumb, which maps to a horizontal zoom anchored on the opposite edge.
  const [hbar, setHbar] = useState({ pos: 0, size: 1 })
  const hbarTrackRef = useRef(null)
  // Last horizontal scroll position — used to distinguish an actual rightward
  // scroll (which may extend the timeline) from the edge merely becoming
  // visible after a zoom-out (which must NOT extend it).
  const lastScrollLeftRef = useRef(0)
  // True while the user is dragging the custom scrollbar (thumb or a grip).
  // Interacting with the scrollbar must NEVER add beats — the timeline only
  // grows from scrolling the grid itself or dragging notes past the end.
  const hbarInteractingRef = useRef(false)
  // Fixed (non-scaling) left offset of the scroll content — the sticky
  // keyboard column. The grid region past it is what actually zooms, so all
  // scrollLeft anchoring math subtracts it. Mirrors LEFT_COL in the wheel zoom.
  const LEFT_COL = 52
  const updateHBar = () => {
    const sc = scrollRef.current
    if (!sc) return
    const sw = sc.scrollWidth || 1
    setHbar({
      pos: sc.scrollLeft / sw,
      size: Math.min(1, sc.clientWidth / sw),
    })
  }
  // Re-sync the thumb whenever the content width (zoom / beats / time sig) or
  // the viewport size changes. Scroll-driven updates come from onScroll.
  useEffect(() => {
    updateHBar()
    const sc = scrollRef.current
    if (!sc || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => updateHBar())
    ro.observe(sc)
    return () => ro.disconnect()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [zoomX, zoomY, totalBeats, timeSig])
  // Grip-resize applies a new zoom AND a new scrollLeft together; the scroll
  // has to land after the DOM re-renders at the new width, so it's deferred
  // here via a pending ref applied in the layout phase.
  const pendingHScrollRef = useRef(null)
  useLayoutEffect(() => {
    if (pendingHScrollRef.current != null && scrollRef.current) {
      const sc = scrollRef.current
      sc.scrollLeft = Math.max(
        0,
        Math.min(sc.scrollWidth - sc.clientWidth, pendingHScrollRef.current)
      )
      pendingHScrollRef.current = null
      updateHBar()
    }
  })
  // Drag the thumb body → scroll horizontally.
  const handleHbarThumbDown = (e) => {
    if (e.button !== 0) return
    e.preventDefault()
    e.stopPropagation()
    const sc = scrollRef.current
    const track = hbarTrackRef.current
    if (!sc || !track) return
    const W = track.getBoundingClientRect().width
    const sw0 = sc.scrollWidth
    const cw0 = sc.clientWidth
    const sl0 = sc.scrollLeft
    const startX = e.clientX
    hbarInteractingRef.current = true
    const move = (mv) => {
      const dx = mv.clientX - startX
      sc.scrollLeft = Math.max(
        0,
        Math.min(sw0 - cw0, sl0 + (dx / W) * sw0)
      )
      updateHBar()
    }
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      hbarInteractingRef.current = false
      document.body.style.cursor = ''
    }
    document.body.style.cursor = 'grabbing'
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }
  // Drag an end grip → zoom horizontally, anchoring the opposite edge so that
  // side of the view stays put (Ableton / DAW behaviour).
  const handleHbarGripDown = (side) => (e) => {
    if (e.button !== 0) return
    e.preventDefault()
    e.stopPropagation()
    const sc = scrollRef.current
    const track = hbarTrackRef.current
    if (!sc || !track) return
    const W = track.getBoundingClientRect().width
    const cw0 = sc.clientWidth
    const sw0 = sc.scrollWidth
    const sl0 = sc.scrollLeft
    const bw0 = BEAT_WIDTH
    const F = LEFT_COL
    const size0 = Math.min(1, cw0 / sw0)
    // Beat currently at each visible edge (grid coords, zoom-invariant).
    const bLeft = (sl0 - F) / bw0
    const bRight = (sl0 + cw0 - F) / bw0
    const beats = totalBeatsRef.current
    const startX = e.clientX
    hbarInteractingRef.current = true
    const move = (mv) => {
      const dx = mv.clientX - startX
      // Right grip: dragging right enlarges the thumb (zoom out). Left grip:
      // dragging right shrinks it (zoom in) while the right edge stays fixed.
      const newSize =
        side === 'right'
          ? Math.max(0.03, Math.min(1, size0 + dx / W))
          : Math.max(0.03, Math.min(1, size0 - dx / W))
      // Visible fraction → target content width → target zoom.
      const targetSw = cw0 / newSize
      let newZoom = (targetSw - F) / (beats * BEAT_WIDTH_BASE)
      newZoom = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, newZoom))
      const newBw = BEAT_WIDTH_BASE * newZoom
      // Anchor the opposite edge by keeping its beat under the same viewport x.
      const newSl =
        side === 'right'
          ? F + bLeft * newBw
          : F + bRight * newBw - cw0
      setZoomX(newZoom)
      pendingHScrollRef.current = Math.max(0, newSl)
    }
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      // Release on the next frame so the trailing scroll from the final zoom
      // apply can't slip through and add a beat.
      requestAnimationFrame(() => {
        hbarInteractingRef.current = false
      })
      document.body.style.cursor = ''
    }
    document.body.style.cursor = 'ew-resize'
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }
  const dragRef = useRef(null)
  const marqueeRef = useRef(null)
  const historyRef = useRef([])
  const futureRef = useRef([])
  // Copy/paste clipboard lives at module scope (see sharedClipboard below) so
  // it survives PianoRoll remounts triggered by switching songs. Undo/redo
  // history is per-song and stays per-instance.
  const clipboardRef = { get current() { return sharedClipboard }, set current(v) { sharedClipboard = v } }
  const notesRef = useRef(notes)
  notesRef.current = notes
  // Off-screen holding store for notes the arrow keys have pushed left of
  // beat 0. They aren't in the notes map (so not rendered / played) but are
  // still "selected" — nudging right brings them back, matching the mouse
  // drag. They're deleted for good when the selection is cleared. Each entry
  // is { beat (< 0), midi, len }.
  const offscreenNotesRef = useRef([])
  // Set true by nudgeSelection so the deselect-cleanup effect can tell a
  // selection change caused by a nudge (keep off-screen notes) from one
  // caused by clicking / marquee / Escape (flush them).
  const nudgeJustRanRef = useRef(false)
  // When the selection changes for any reason OTHER than a nudge, commit the
  // off-screen notes by deleting them for good — "only when I deselect the
  // notes we can delete them".
  useEffect(() => {
    if (nudgeJustRanRef.current) {
      nudgeJustRanRef.current = false
      return
    }
    if (offscreenNotesRef.current.length > 0) {
      offscreenNotesRef.current = []
    }
  }, [selectedKeys])
  // All tracks (with their notes + volume/mute/solo) — the loop scheduler
  // reads from this so live edits or volume changes show up in subsequent
  // iterations without restarting playback.
  const tracksRef = useRef(tracks)
  tracksRef.current = tracks
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
  // Mirror the default length in state so render consumers (the grid hover box)
  // resize the instant it changes — e.g. picking a new subdivision — instead of
  // only on the next mouse move. The ref stays for synchronous handler reads.
  const [defaultNoteLen, setDefaultNoteLen] = useState(1)
  const setDefaultNoteLength = (len) => {
    defaultNoteLengthRef.current = len
    setDefaultNoteLen(len)
  }
  // Rhythm entry system. The reference UNIT is either a beat (4 cells) or a
  // bar/measure (16 cells) — toggled via `rhythmUnit`. A digit 1-9 divides
  // that unit exactly: ÷1 = the whole unit, ÷2 = half, ÷3 = a triplet, ÷4 =
  // a quarter, ÷6 = a sextuplet (six per unit), … so length =
  // unitCells / n cells. Press X then a digit m for an integer multiplier.
  // The placed length (in grid cells) = unitCells × multiplier / n.
  const [rhythmUnit, setRhythmUnit] = useState('beat') // 'beat' | 'bar'
  const [rhythmDenominator, setRhythmDenominator] = useState(4) // 1-9
  const [rhythmMult, setRhythmMult] = useState(1) // integer multiplier
  const [rhythmAwaitingMultiplier, setRhythmAwaitingMultiplier] = useState(false)
  const rhythmUnitCells = rhythmUnit === 'bar' ? cellsPerMeasure : cellsPerBeat
  const rhythmBaseCells = rhythmUnitCells / rhythmDenominator
  const rhythmLength = rhythmBaseCells * rhythmMult
  useEffect(() => {
    defaultNoteLengthRef.current = rhythmLength
    setDefaultNoteLen(rhythmLength)
  }, [rhythmLength])
  // Auto-cancel the multiplier prompt if the user doesn't follow up with
  // a digit within a couple of seconds — otherwise a stray digit later
  // would keep multiplying instead of setting a fresh subdivision.
  useEffect(() => {
    if (!rhythmAwaitingMultiplier) return
    const id = setTimeout(() => setRhythmAwaitingMultiplier(false), 2000)
    return () => clearTimeout(id)
  }, [rhythmAwaitingMultiplier])
  // Note value derived from the base length in cells (16 cells = whole).
  // Powers of 2 get their note-value name; the rest are tuplets named by
  // the divisor. The glyph draws the nearest power-of-2 note plus a tuplet
  // badge — so a beat-triplet shows an 8th note with a small "3".
  const rhythmNoteDenom = CELLS_PER_WHOLE / rhythmBaseCells // 1=whole, 2=half…
  const isPow2 = (x) => x >= 1 && (x & (x - 1)) === 0
  const rhythmNoteName = (() => {
    const noteNames = {
      1: 'whole', 2: 'half', 4: 'quarter', 8: '8th',
      16: '16th', 32: '32nd', 64: '64th',
    }
    if (isPow2(rhythmDenominator) && noteNames[rhythmNoteDenom]) {
      return noteNames[rhythmNoteDenom]
    }
    const tupletNames = {
      3: 'triplet', 5: 'quintuplet', 6: 'sextuplet',
      7: 'septuplet', 9: 'nonuplet',
    }
    return tupletNames[rhythmDenominator] ?? `÷${rhythmDenominator}`
  })()
  const rhythmGlyphValue = Math.pow(
    2,
    Math.max(0, Math.floor(Math.log2(rhythmNoteDenom)))
  )
  const rhythmTuplet = isPow2(rhythmDenominator) ? null : rhythmDenominator
  // Multi-digit entry via type-ahead accumulation: a digit applies live,
  // and a second digit typed within RHYTHM_TYPE_WINDOW ms extends the
  // number (1 then 2 → 12). After the window closes (or on any non-digit
  // action) the next digit starts fresh. `kind` tracks whether we're
  // building the divisor or the multiplier; `pendingKind` is set by X so
  // the following digit routes to the multiplier.
  const RHYTHM_TYPE_WINDOW = 800
  const RHYTHM_MAX_DIV = 64
  const RHYTHM_MAX_MULT = 32
  const rhythmBufRef = useRef({ kind: null, str: '', t: 0 })
  const rhythmBufTimerRef = useRef(null)
  const rhythmPendingKindRef = useRef(null)
  const feedRhythmDigit = (d) => {
    const now = Date.now()
    const buf = rhythmBufRef.current
    // Resolve which value this digit builds: an explicit X-primed kind
    // wins, else continue the live buffer if still in the window, else a
    // fresh divisor entry.
    const kind =
      rhythmPendingKindRef.current ||
      (buf.kind && now - buf.t < RHYTHM_TYPE_WINDOW ? buf.kind : 'div')
    rhythmPendingKindRef.current = null
    const continuing =
      buf.kind === kind && now - buf.t < RHYTHM_TYPE_WINDOW && buf.str !== ''
    let str = continuing ? buf.str + String(d) : String(d)
    let num = parseInt(str, 10)
    // A lone leading 0 is meaningless (÷0 / ×0) — ignore it entirely.
    if (!continuing && d === 0) return
    if (!Number.isFinite(num) || num < 1) num = 1
    const max = kind === 'mult' ? RHYTHM_MAX_MULT : RHYTHM_MAX_DIV
    if (num > max) {
      num = max
      str = String(max)
    }
    rhythmBufRef.current = { kind, str, t: now }
    if (kind === 'mult') {
      setRhythmMult(num)
      setRhythmAwaitingMultiplier(false)
    } else {
      setRhythmDenominator(num)
      setRhythmMult(1)
    }
    if (rhythmBufTimerRef.current) clearTimeout(rhythmBufTimerRef.current)
    rhythmBufTimerRef.current = setTimeout(() => {
      rhythmBufRef.current = { kind: null, str: '', t: 0 }
    }, RHYTHM_TYPE_WINDOW)
  }
  // Snap a raw beat (grid cells) to the current rhythm's division grid so
  // notes — including tuplets — land on evenly-spaced positions. Snapping
  // to the base division (not the multiplied length) means e.g. a bar ÷6
  // grid gives six positions across the measure, so pressing 6 lets you
  // place six notes that fill the bar. Free mode bypasses snapping.
  const snapPlacementBeat = (raw) => {
    const clamp = (v) => Math.max(0, Math.min(totalBeats - 0.001, v))
    if (freeMode) return clamp(raw)
    // The snap increment is the rhythm SUBDIVISION (rhythmBaseCells) — the
    // multiplier only lengthens the note, it must not coarsen the grid, so a
    // ×3 8th still snaps every 8th. The one exception: never snap coarser than
    // the box itself, otherwise a box shorter than the subdivision (e.g. after
    // resizing a note down) would sit to the cursor's left ("previous beat"
    // drift). So step = min(subdivision, box length).
    const box =
      defaultNoteLengthRef.current > 0 ? defaultNoteLengthRef.current : 1
    const sub = rhythmBaseCells > 0 ? rhythmBaseCells : box
    const step = Math.min(sub, box)
    // Floor (not round-to-nearest) so the start is always at or left of the
    // cursor; the epsilon absorbs float error on exact grid lines.
    return clamp(Math.floor(raw / step + 1e-9) * step)
  }
  // Snap a DRAGGED beat to the current subdivision grid (nearest, so a moved
  // note lands on the same divisions placement uses — not the raw 16th/cell
  // grid). The multiplier only affects length, so snap to rhythmBaseCells.
  const snapDragBeat = (b) => {
    if (freeMode) return b
    const step = rhythmBaseCells > 0 ? rhythmBaseCells : 1
    return Math.round(b / step) * step
  }
  // No overlaps allowed: if a snapped placement start lands INSIDE an existing
  // note on the row (the grid tiles from beat 0, so the floored start can fall
  // back into the preceding note), begin at that note's end instead — the box
  // and any placed note then start on the empty space after it.
  const avoidLeftOverlap = (beat, rowMidi) => {
    for (const [k, len] of notesRef.current) {
      const sep = k.indexOf('-')
      if (Number(k.slice(sep + 1)) !== rowMidi) continue
      const b = Number(k.slice(0, sep))
      if (b <= beat + 1e-9 && b + len > beat + 1e-9) return b + len
    }
    return beat
  }
  // Reflect a note length (grid cells) back into the rhythm selector so that
  // resizing a note "captures" its length as the current value. Prefer a clean
  // single subdivision of the current unit (÷denom, multiplier 1) — e.g. a
  // 2-cell note under a beat unit becomes ÷2 = an 8th. If the length isn't a
  // whole subdivision, keep the current subdivision and set the nearest whole
  // multiplier instead, so the shown length still tracks the note.
  const applyLengthToRhythm = (lengthCells) => {
    if (!(lengthCells > 0)) return
    const unitCells = rhythmUnitCells
    const EPS = 1e-6
    const denom = Math.round(unitCells / lengthCells)
    if (
      denom >= 1 &&
      denom <= RHYTHM_MAX_DIV &&
      Math.abs(unitCells / denom - lengthCells) < EPS
    ) {
      setRhythmDenominator(denom)
      setRhythmMult(1)
      return
    }
    const base = rhythmBaseCells > 0 ? rhythmBaseCells : 1
    const mult = Math.max(
      1,
      Math.min(RHYTHM_MAX_MULT, Math.round(lengthCells / base))
    )
    setRhythmMult(mult)
  }
  // Dismiss the floating pitch label the instant its note is deleted —
  // covers every delete path (right-click, Delete key, long-press, marquee)
  // since they all mutate `notes`. Skipped while a drag is in flight so a
  // note being moved (its key changes) doesn't flicker the label off.
  useEffect(() => {
    if (notePitchTip && !dragRef.current && !notes.has(notePitchTip.key)) {
      setNotePitchTip(null)
    }
  }, [notes, notePitchTip])
  // `T` is a held modifier: while it's down, ArrowUp/Down rotate the
  // selection's pitches instead of nudging them by a scale step.
  const tHeldRef = useRef(false)

  useEffect(() => {
    // Scroll the roll vertically so the active track's notes (or the
    // initial pattern as a fallback) sit roughly in the middle of the
    // viewport. Track resets are no longer triggered here — the song-based
    // state in App.jsx owns track lifecycle now, so switching scales or
    // roots leaves existing tracks in place; the user can clear or redo
    // tracks deliberately. Only auto-scroll fires on scale/root change.
    requestAnimationFrame(() => {
      const sc = scrollRef.current
      if (!sc) return
      const noteMap =
        (tracksRef.current[0] && tracksRef.current[0].notes) ||
        buildInitialPattern(scale, root)
      let avgMidi = 60 + root
      if (noteMap.size > 0) {
        let sum = 0
        for (const [k] of noteMap) sum += Number(k.split('-')[1])
        avgMidi = sum / noteMap.size
      }
      const targetTop = (MIDI_HIGH - avgMidi) * ROW_HEIGHT
      sc.scrollTop = Math.max(0, targetTop - sc.clientHeight / 2 + ROW_HEIGHT / 2)
    })
  }, [scale?.id, root])

  // Persist tracks back to the active song in App.jsx whenever they change,
  // so switching songs (which re-mounts PianoRoll) restores the saved tracks.
  useEffect(() => {
    if (!onPersistTracks) return
    // Serialize the Maps as plain arrays so they survive across remounts.
    const serialized = tracks.map((t) => ({
      ...t,
      notes: Array.from(t.notes.entries()),
    }))
    onPersistTracks(serialized, activeTrackId)
  }, [tracks, activeTrackId])

  // Persist playback settings (tempo, swing, loop region, beat count) so
  // switching tabs restores each song's own numbers instead of resetting
  // to the module defaults. The loop is stored as { start, end } | null.
  // - The onPersistPlayback prop is kept in a ref so the effect always calls
  //   the FRESHEST version — otherwise a stale closure would occasionally
  //   write into whichever song was active when the effect first captured.
  // - We skip the mount-time write. State was just seeded from the song's
  //   persisted values (or defaults for a brand-new song); persisting the
  //   defaults right back would either be a no-op or, worse, clobber the
  //   song's real numbers if activeSong resolved to a stale reference at the
  //   moment the effect fired. Persistence only runs on actual user changes.
  const persistPlaybackRef = useRef(onPersistPlayback)
  persistPlaybackRef.current = onPersistPlayback
  const playbackHydratedRef = useRef(false)
  useEffect(() => {
    if (!playbackHydratedRef.current) {
      playbackHydratedRef.current = true
      return
    }
    persistPlaybackRef.current?.({
      bpm,
      swing: swingPct,
      loop,
      totalBeats,
      timeSig,
    })
  }, [bpm, swingPct, loop, totalBeats, timeSig])

  // Latest playhead + play-state, mirrored into a ref so the unmount
  // cleanup can read them without stale-closure issues. Updated every
  // render from the current values.
  const playheadBeatRef = useRef(0)
  // Beat that playback last started from — Enter returns the playhead here,
  // and pressing Enter again (when already there) jumps to the beginning.
  const lastPlayStartBeatRef = useRef(0)
  const isPlayingRef = useRef(false)
  useEffect(() => {
    if (playheadBeat != null) playheadBeatRef.current = playheadBeat
  }, [playheadBeat])
  useEffect(() => {
    isPlayingRef.current = playStateRef.current != null
  })

  // Keep the tabSwitchPlayback prop in a ref so the unmount cleanup sees
  // the freshest value even if the prop's identity ping-pongs on the way
  // out. React would otherwise snapshot the value at effect setup.
  const tabSwitchPlaybackRef = useRef(tabSwitchPlayback)
  tabSwitchPlaybackRef.current = tabSwitchPlayback

  useEffect(() => {
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current)
      // If the user asked for cross-tab continue and playback was active,
      // stash the current beat + audio-clock time in the module-level slot
      // so the incoming tab's mount effect can pick up exactly where we
      // left off. React state wouldn't work here: a setState from cleanup
      // only lands on the next render, after the new mount effect runs.
      const wasPlaying = playStateRef.current != null
      const continuing =
        tabSwitchPlaybackRef.current === 'continue' && wasPlaying
      playStateRef.current = null
      if (continuing && sharedAudioCtx) {
        pendingResume = {
          beat: playheadBeatRef.current ?? 0,
          ctxTime: sharedAudioCtx.currentTime,
        }
        // Crossfade instead of a hard cut: let the outgoing song's voices
        // fade over ~120 ms so their tail overlaps the incoming song's
        // start (which the new mount schedules immediately). The result
        // reads as continuous rather than a stop-then-start gap.
        fadeOutScheduledVoices(0.12)
      } else {
        // Normal teardown — silence queued voices quickly.
        killScheduledVoices()
      }
    }
  }, [])

  // On mount, if the module slot has a pending resume, auto-start playback
  // at the captured beat — advanced by however long the remount actually
  // took — so the timeline stays continuous. The new notes start with the
  // scheduler's small lead, overlapping the outgoing song's fade tail for
  // a gapless handoff.
  //
  // The slot is consumed INSIDE the rAF, not before scheduling it. Under
  // React StrictMode the mount → cleanup → mount cycle would otherwise
  // consume it on the first mount, have its rAF cancelled by the cleanup,
  // then find an empty slot on the real second mount — so playback would
  // never start in dev. Reading the slot lazily lets the surviving mount's
  // rAF pick it up.
  useEffect(() => {
    if (pendingResume == null) return
    const id = requestAnimationFrame(() => {
      const slot = pendingResume
      if (slot == null) return
      pendingResume = null
      const ctx = getAudioContext()
      // playFromBeat's internal lead (see startBase = currentTime + 0.05).
      const LEAD = 0.05
      const cellDur = beatDurForBpm(bpm)
      // How much audio-clock time passed between capture and this note
      // actually sounding (remount time + the scheduler lead). Advance the
      // beat by that so we don't drop or repeat any beats.
      const elapsed = Math.max(0, ctx.currentTime + LEAD - slot.ctxTime)
      const advancedBeat = (slot.beat ?? 0) + elapsed / cellDur
      try { playFromBeat(advancedBeat) } catch {}
    })
    return () => cancelAnimationFrame(id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    const handler = (e) => {
      const tag = e.target.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || e.target.isContentEditable) return
      // The template editor modal owns all shortcuts (its own transport) while
      // it's open — don't let the roll react underneath it.
      if (templateEditorOpen) return
      // App-level modals (settings / shortcuts / finder / scale settings) also
      // own the keyboard while open — suppress roll shortcuts underneath them.
      if (overlayOpen) return
      // While the chord-voicings viewer is open, ←/→ cycle through voicings
      // (and take precedence over the note-nudge arrows below).
      if (chordVoicingOpen && (e.code === 'ArrowLeft' || e.code === 'ArrowRight')) {
        e.preventDefault()
        stepVoicing(e.code === 'ArrowRight' ? 1 : -1)
        return
      }
      const meta = e.ctrlKey || e.metaKey
      const k = (e.key || '').toLowerCase()
      // Editable action hotkeys (see hotkeys.js). Ctrl/Cmd + Y stays a fixed
      // redo alias alongside the rebindable redo binding.
      if (isHotkey('undo', e)) {
        e.preventDefault()
        undo()
      } else if (isHotkey('redo', e) || (meta && e.code === 'KeyY')) {
        e.preventDefault()
        redo()
      } else if (isHotkey('copy', e)) {
        e.preventDefault()
        copyNotes()
      } else if (isHotkey('paste', e)) {
        e.preventDefault()
        pasteNotes()
      } else if (isHotkey('selectAll', e)) {
        e.preventDefault()
        setSelectedKeys(new Set(notesRef.current.keys()))
      } else if (isHotkey('play', e)) {
        e.preventDefault()
        togglePlay()
      } else if (isHotkey('returnPlayhead', e)) {
        // Enter returns the playhead to where playback last started; pressing
        // it again there (or when that start was already 0) jumps to the very
        // beginning. Stop first if playing so the rAF doesn't overwrite the
        // position — Space then resumes from the new playhead.
        e.preventDefault()
        if (playStateRef.current) stopPlayback(false)
        const startPos = lastPlayStartBeatRef.current ?? 0
        const cur = playheadBeatRef.current ?? 0
        const EPS = 1e-6
        const target =
          startPos > EPS && Math.abs(cur - startPos) > EPS ? startPos : 0
        setPlayheadBeat(target)
        // Update the ref immediately so a rapid second Enter reads the new
        // position rather than the pre-render value.
        playheadBeatRef.current = target
      } else if (isHotkey('delete', e)) {
        // A selected region takes priority: delete it, baking its window notes
        // onto the timeline.
        if (selectedRegionIdRef.current) {
          e.preventDefault()
          bakeRegion(selectedRegionIdRef.current)
        } else if (selectedKeys.size > 0) {
          e.preventDefault()
          pushHistory()
          setNotes((prev) => {
            const next = new Map(prev)
            for (const k of selectedKeys) next.delete(k)
            return next
          })
          setSelectedKeys(new Set())
        }
      } else if (isHotkey('clearSelection', e)) {
        // Just drop the selection — deliberately NOT exiting any active mode
        // (Rotate, pending Rune, template placement…). That's the whole point:
        // Escape clears the selection AND leaves modes, this stays put so you
        // can reselect without breaking your flow. Covers everything selectable:
        // timeline notes, a selected region, and selected templates.
        e.preventDefault()
        if (selectedKeys.size > 0) setSelectedKeys(new Set())
        if (selectedRegionId) setSelectedRegionId(null)
        if (selectedTemplateIds.size > 0) setSelectedTemplateIds(new Set())
      } else if (e.code === 'Escape') {
        if (fretPosPriming) setFretPosPriming(false)
        if (pendingTemplate) setPendingTemplate(null)
        if (selectedKeys.size > 0) setSelectedKeys(new Set())
        if (selectedRegionId) setSelectedRegionId(null)
        if (chordModalOpen) setChordModalOpen(false)
        if (chordVoicingOpen) setChordVoicingOpen(false)
        if (loop) setLoop(null)
        if (tHeldRef.current) {
          tHeldRef.current = false
          setTHeld(false)
        }
      } else if (
        isHotkey('flipH', e) &&
        (pendingTemplate || selectedKeys.size > 0)
      ) {
        // With a template armed for placement, the transforms reshape the GHOST
        // so you can build a variation before committing; otherwise they act on
        // the current selection as before.
        e.preventDefault()
        if (pendingTemplate) transformPendingTemplate('flipH')
        else flipHorizontal()
      } else if (
        isHotkey('flipV', e) &&
        (pendingTemplate || selectedKeys.size > 0)
      ) {
        e.preventDefault()
        if (pendingTemplate) transformPendingTemplate('flipV')
        else flipVertical()
      } else if (
        isHotkey('stretch', e) &&
        (pendingTemplate || selectedKeys.size > 0)
      ) {
        e.preventDefault()
        if (pendingTemplate) transformPendingTemplate('grow')
        else growSelection()
      } else if (
        isHotkey('compress', e) &&
        (pendingTemplate || selectedKeys.size > 0)
      ) {
        e.preventDefault()
        if (pendingTemplate) transformPendingTemplate('shrink')
        else shrinkSelection()
      } else if (
        isHotkey('rotate', e) &&
        (selectedKeys.size > 0 || tHeldRef.current)
      ) {
        // Toggle: press T to enter Rotate mode (badge stays lit, arrow
        // keys rotate the selection's pitches). Press T again to exit.
        if (!e.repeat) {
          tHeldRef.current = !tHeldRef.current
          setTHeld(tHeldRef.current)
        }
      } else if (e.code === 'KeyM') {
        // Toggle the full Roll settings modal.
        e.preventDefault()
        setParamsOpen((v) => !v)
      } else if (e.code === 'KeyP' && fretboardView !== 'off') {
        // Prime fretboard-position entry — only when a fretboard is actually
        // open, so P doesn't hijack the digit keys (rhythm entry) otherwise.
        // The next digit(s) set the position (lower fret of the 5-fret span).
        // Ends on Enter/Escape or a timeout.
        if (!e.repeat) {
          e.preventDefault()
          setFretPosPriming(true)
          fretPosBufRef.current = ''
          if (fretPosTimerRef.current) clearTimeout(fretPosTimerRef.current)
          fretPosTimerRef.current = setTimeout(
            () => setFretPosPriming(false),
            1500
          )
        }
      } else if (isHotkey('rune', e) && selectedKeys.size > 0) {
        // Turn the selection into a MIDI region. The pattern is tiled across
        // every octave that fits the keyboard, but laid out SEQUENTIALLY IN
        // TIME (lowest octave first, ascending) into a hidden source sequence.
        // The region is a window onto that sequence — only the window's slice
        // is materialised as notes; dragging inside the box scrolls the window
        // so you can start on any octave / pitch range. See createRegion.
        e.preventDefault()
        createRegionFromSelection()
      } else if (e.code === 'ArrowUp' && selectedKeys.size > 0) {
        e.preventDefault()
        if (tHeldRef.current) rotateSelection(1)
        else nudgeSelection(0, 1)
      } else if (e.code === 'ArrowDown' && selectedKeys.size > 0) {
        e.preventDefault()
        if (tHeldRef.current) rotateSelection(-1)
        else nudgeSelection(0, -1)
      } else if (
        e.code === 'ArrowRight' &&
        (selectedKeys.size > 0 || offscreenNotesRef.current.length > 0)
      ) {
        // Right nudge also brings back notes parked off-screen to the left,
        // even when the visible selection is empty.
        e.preventDefault()
        nudgeSelection(1, 0)
      } else if (e.code === 'ArrowLeft' && selectedKeys.size > 0) {
        e.preventDefault()
        nudgeSelection(-1, 0)
      } else if (
        !meta &&
        !e.shiftKey &&
        !e.altKey &&
        (e.code === 'KeyX' || k === 'x')
      ) {
        // Prime the multiplier — the next digit(s) set the multiplier
        // instead of a fresh base note value.
        e.preventDefault()
        setRhythmAwaitingMultiplier(true)
        rhythmPendingKindRef.current = 'mult'
        rhythmBufRef.current = { kind: null, str: '', t: 0 }
      } else if (
        !meta &&
        !e.shiftKey &&
        !e.altKey &&
        /^Digit[0-9]$/.test(e.code)
      ) {
        e.preventDefault()
        // Ignore auto-repeat from a held key — otherwise holding a digit spams
        // the type-ahead accumulator (e.g. "3" → "333…"), landing on the wrong
        // subdivision. Only the initial press counts.
        if (e.repeat) return
        // While P-primed (and a fretboard is open), digits build the fretboard
        // position instead of the rhythm value.
        if (fretPosPrimingRef.current && fretboardView !== 'off') {
          const d = e.code.slice(5)
          fretPosBufRef.current = (fretPosBufRef.current + d).slice(-2)
          setFretPosition(
            Math.max(0, Math.min(20, Number(fretPosBufRef.current)))
          )
          if (fretPosTimerRef.current) clearTimeout(fretPosTimerRef.current)
          fretPosTimerRef.current = setTimeout(
            () => setFretPosPriming(false),
            1500
          )
          return
        }
        feedRhythmDigit(Number(e.code.slice(5)))
      }
    }
    window.addEventListener('keydown', handler)
    return () => {
      window.removeEventListener('keydown', handler)
    }
  })

  const getAudioContext = () => {
    if (!sharedAudioCtx) {
      const Ctx = window.AudioContext || window.webkitAudioContext
      sharedAudioCtx = new Ctx()
    }
    // Point the per-instance ref at the shared context so every existing
    // `audioCtxRef.current` read keeps working unchanged.
    audioCtxRef.current = sharedAudioCtx
    if (sharedAudioCtx.state === 'suspended') sharedAudioCtx.resume()
    return sharedAudioCtx
  }

  // Audition a single note using the active track's synth + envelope, so
  // input clicks / drags sound like whatever the user picked in the track
  // sidebar (not always a triangle wave). Falls through to playOneNote with
  // the resolved oscType / voice pulled from tracks[activeTrackId].
  const auditionNote = (midi, duration = 0.22, peakGain = 0.22) => {
    const t = tracksRef.current.find((tk) => tk.id === activeTrackId)
      ?? tracksRef.current[0]
    playOneNote(midi, undefined, duration, peakGain, t?.synth ?? 'triangle', {
      attackMs: t?.attackMs,
      releaseMs: t?.releaseMs,
      detuneCents: t?.detuneCents,
    })
  }

  // Strum a chord voicing (low→high, ~28 ms apart) using the active track's
  // synth. Used by the chord-voicings viewer on view + on click.
  const strumVoicing = (midis) => {
    if (!midis || !midis.length) return
    const ctx = getAudioContext()
    const t =
      tracksRef.current.find((tk) => tk.id === activeTrackId) ??
      tracksRef.current[0]
    const start = ctx.currentTime + 0.02
    midis.forEach((m, i) => {
      playOneNote(m, start + i * 0.028, 0.9, 0.16, t?.synth ?? 'triangle', {
        attackMs: t?.attackMs,
        releaseMs: t?.releaseMs,
        detuneCents: t?.detuneCents,
      })
    })
  }

  const playOneNote = (
    midi,
    startAt,
    duration = 0.22,
    peakGain = 0.22,
    oscType = 'triangle',
    voice = {}
  ) => {
    const attackMs = voice.attackMs ?? 15
    const releaseMs = voice.releaseMs ?? 220
    const detuneCents = voice.detuneCents ?? 0
    const ctx = getAudioContext()
    const t = startAt ?? ctx.currentTime
    const freq = 440 * Math.pow(2, (midi - 69) / 12)
    const osc = ctx.createOscillator()
    const gain = ctx.createGain()
    osc.type = oscType
    osc.frequency.value = freq
    if (detuneCents) osc.detune.value = detuneCents
    osc.connect(gain)
    gain.connect(ctx.destination)
    // Sawtooth / square have far more harmonic energy than triangle / sine,
    // so scale the gain so different synths sound roughly balanced.
    const synth = SYNTH_TYPES.find((s) => s.id === oscType)
    const adjustedPeak = peakGain * (synth ? synth.gainScale : 1)
    // Attack / release shape the envelope. Attack ramps gain to peak; the
    // remainder of the note holds + tails out via the release. Release is
    // capped at the note's hold time so very short notes don't sound flat.
    const attack = Math.max(0.0005, attackMs / 1000)
    const release = Math.max(0.005, releaseMs / 1000)
    const holdEnd = Math.max(t + attack + 0.001, t + duration - release)
    gain.gain.setValueAtTime(0, t)
    gain.gain.linearRampToValueAtTime(adjustedPeak, t + attack)
    gain.gain.setValueAtTime(adjustedPeak, holdEnd)
    gain.gain.exponentialRampToValueAtTime(0.001, holdEnd + release)
    osc.start(t)
    osc.stop(holdEnd + release + 0.02)
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

  // Softer variant of killScheduledVoices: ramps voices down over `fadeSec`
  // instead of the abrupt 20 ms cut. Used for the cross-tab handoff so the
  // outgoing song's tail overlaps the incoming song's first notes and there
  // is no audible gap. Voices belong to the shared context and keep playing
  // even after this instance unmounts.
  const fadeOutScheduledVoices = (fadeSec = 0.12) => {
    const voices = scheduledVoicesRef.current
    scheduledVoicesRef.current = []
    const ctx = sharedAudioCtx || audioCtxRef.current
    if (!ctx) return
    const now = ctx.currentTime
    for (const { osc, gain } of voices) {
      try {
        gain.gain.cancelScheduledValues(now)
        gain.gain.setValueAtTime(Math.max(0.0001, gain.gain.value), now)
        gain.gain.exponentialRampToValueAtTime(0.0001, now + fadeSec)
      } catch {}
      try { osc.stop(now + fadeSec + 0.02) } catch {}
    }
  }

  const pitches = useMemo(() => {
    const list = []
    for (let m = MIDI_HIGH; m >= MIDI_LOW; m--) list.push(m)
    return list
  }, [])

  // Native OS save dialog for template / folder exports (declared above the
  // early return so hook order stays consistent).
  const { requestSave, requestSaveTree } = useSaveAs()

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

  // ── Chord-voicings fretboard viewer ────────────────────────────────────
  // Every drop/close voicing of the scale's two chords, per side, ready to draw
  // as chord boxes and to strum. Recomputed only when the scale/root changes.
  const chordVoicings = useMemo(() => {
    if (!_resolved) return { left: [], right: [] }
    return {
      left: buildVoicings(_resolved.leftNotes, _resolved.leftRoot),
      right: buildVoicings(_resolved.rightNotes, _resolved.rightRoot),
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rawScale?.id, root, modeStep])

  const voicingList =
    voicingSide === 'left' ? chordVoicings.left : chordVoicings.right
  const currentVoicing = voicingList[voicingIndex] ?? voicingList[0] ?? null
  const voicingMeta =
    voicingSide === 'left'
      ? { rootPc: _resolved?.leftRoot, label: _pair?.left }
      : { rootPc: _resolved?.rightRoot, label: _pair?.right }
  // Families that actually produced playable voicings for this chord.
  const voicingFamilies = FAMILIES.filter((f) =>
    voicingList.some((v) => v.type === f.type)
  )
  // String sets available for the current family (for the selector chips).
  const voicingSetsForType = currentVoicing
    ? [
        ...new Set(
          voicingList
            .filter((v) => v.type === currentVoicing.type)
            .map((v) => v.stringSetLabel)
        ),
      ]
    : []
  const stepVoicing = (d) => {
    const n = voicingList.length
    if (!n) return
    setVoicingIndex((i) => (i + d + n) % n)
  }
  const pickVoicing = ({ type, stringSetLabel, inversion }) => {
    if (!currentVoicing) return
    const t = type ?? currentVoicing.type
    const s = stringSetLabel ?? currentVoicing.stringSetLabel
    const inv = inversion ?? currentVoicing.inversion
    const find = (pt, ps, pi) =>
      voicingList.findIndex(
        (v) =>
          v.type === pt &&
          (ps == null || v.stringSetLabel === ps) &&
          (pi == null || v.inversion === pi)
      )
    let idx = find(t, s, inv)
    if (idx < 0) idx = find(t, s, null)
    if (idx < 0) idx = find(t, null, inv)
    if (idx < 0) idx = find(t, null, null)
    if (idx >= 0) setVoicingIndex(idx)
  }
  const openChordVoicing = () => {
    setVoicingSide('left')
    setVoicingIndex(0)
    setChordVoicingOpen(true)
  }
  // Strum the current voicing whenever it changes while the viewer is open.
  useEffect(() => {
    if (!chordVoicingOpen || !currentVoicing) return
    strumVoicing(currentVoicing.midis)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chordVoicingOpen, voicingSide, voicingIndex])

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
    tracks: tracks.map((t) => ({ ...t, notes: new Map(t.notes) })),
    activeTrackId,
  })

  const restoreSnapshot = (snap) => {
    setTracks(snap.tracks.map((t) => ({ ...t, notes: new Map(t.notes) })))
    if (snap.activeTrackId) setActiveTrackId(snap.activeTrackId)
    setSelectedKeys(new Set())
  }

  const pushHistory = (snapshot) => {
    historyRef.current.push(snapshot ?? snapshotState())
    if (historyRef.current.length > 200) historyRef.current.shift()
    futureRef.current = []
  }

  const undo = () => {
    if (historyRef.current.length === 0) {
      // Notes stack is empty — fall through to App-level song history so
      // Ctrl+Z still undoes tab creation / deletion / group moves.
      onFallbackUndo?.()
      return
    }
    const prev = historyRef.current.pop()
    futureRef.current.push(snapshotState())
    if (futureRef.current.length > 200) futureRef.current.shift()
    restoreSnapshot(prev)
  }

  const redo = () => {
    if (futureRef.current.length === 0) {
      onFallbackRedo?.()
      return
    }
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


  // Apply a template at a specific anchor point (beat + midi). The template's
  // earliest note becomes the rhythmic anchor; the anchor midi becomes the
  // pitch base. Every other note shifts by the same beat delta and the same
  // scale-step delta, so the template's musical shape is preserved against
  // the current scale + root. Adds the template's notes on top of existing
  // ones; doesn't clear the grid first.
  const commitTemplateAt = (tpl, anchorBeat, anchorMidi) => {
    if (!scale || !tpl || tpl.notes.length === 0) return
    const baseRoot = 60 + root
    let minBeat = Infinity
    let firstItem = null
    for (const item of tpl.notes) {
      if (item.beat < minBeat) {
        minBeat = item.beat
        firstItem = item
      }
    }
    if (!firstItem) return
    if (firstItem.degree < 0 || firstItem.degree >= scale.notes.length) return
    const firstMidi =
      baseRoot + scale.notes[firstItem.degree] + firstItem.octave * 12
    const firstStep = midiToScaleStep(firstMidi)
    const snappedAnchor = nearestScaleMidi(anchorMidi)
    const anchorStep = midiToScaleStep(snappedAnchor)
    if (firstStep == null || anchorStep == null) return
    const stepShift = anchorStep - firstStep
    const beatShift = anchorBeat - minBeat
    pushHistory()
    const addedKeys = new Set()
    setNotes((prev) => {
      const next = new Map(prev)
      for (const item of tpl.notes) {
        if (item.degree < 0 || item.degree >= scale.notes.length) continue
        const origMidi =
          baseRoot + scale.notes[item.degree] + item.octave * 12
        const origStep = midiToScaleStep(origMidi)
        if (origStep == null) continue
        const newStep = origStep + stepShift
        // `semis` carries any chromatic (out-of-scale) offset above the degree
        // so those notes ride along with the scale rather than being dropped.
        const newMidi = scaleStepToMidi(newStep) + (item.semis || 0)
        const newBeat = item.beat + beatShift
        if (newBeat < 0 || newBeat >= totalBeats) continue
        if (newMidi < MIDI_LOW || newMidi > MIDI_HIGH) continue
        const key = `${newBeat}-${newMidi}`
        next.set(key, item.length ?? 1)
        addedKeys.add(key)
      }
      return next
    })
    setSelectedKeys(addedKeys)
  }

  // Click handler for a template entry: enter "placement mode" — the next
  // click on the grid commits the template at that cursor position. Click
  // the same template again (or press Esc) to cancel. Arming also dismisses any
  // multi-selection, the mirror of shift-click clearing the placement arm.
  const handleTemplateClick = (tpl) => {
    if (selectedTemplateIds.size > 0) setSelectedTemplateIds(new Set())
    setPendingTemplate((cur) => (cur && cur.id === tpl.id ? null : tpl))
  }

  // Given a template + anchor point, return the set of (beat, midi, length)
  // triples the template would drop onto the grid — same math as
  // commitTemplateAt but pure. Used to render the ghost preview while the
  // user is hovering the grid with a pending template.
  const computeTemplatePlacement = (tpl, anchorBeat, anchorMidi) => {
    if (!scale || !tpl || tpl.notes.length === 0) return []
    const baseRoot = 60 + root
    let minBeat = Infinity
    let firstItem = null
    for (const item of tpl.notes) {
      if (item.beat < minBeat) {
        minBeat = item.beat
        firstItem = item
      }
    }
    if (!firstItem) return []
    if (firstItem.degree < 0 || firstItem.degree >= scale.notes.length) return []
    const firstMidi =
      baseRoot + scale.notes[firstItem.degree] + firstItem.octave * 12
    const firstStep = midiToScaleStep(firstMidi)
    const snappedAnchor = nearestScaleMidi(anchorMidi)
    const anchorStep = midiToScaleStep(snappedAnchor)
    if (firstStep == null || anchorStep == null) return []
    const stepShift = anchorStep - firstStep
    const beatShift = anchorBeat - minBeat
    const out = []
    for (const item of tpl.notes) {
      if (item.degree < 0 || item.degree >= scale.notes.length) continue
      const origMidi =
        baseRoot + scale.notes[item.degree] + item.octave * 12
      const origStep = midiToScaleStep(origMidi)
      if (origStep == null) continue
      const newStep = origStep + stepShift
      const newMidi = scaleStepToMidi(newStep) + (item.semis || 0)
      const newBeat = item.beat + beatShift
      if (newBeat < 0 || newBeat >= totalBeats) continue
      if (newMidi < MIDI_LOW || newMidi > MIDI_HIGH) continue
      out.push({ beat: newBeat, midi: newMidi, length: item.length ?? 1 })
    }
    return out
  }
  const templatePreview = useMemo(() => {
    if (!pendingTemplate || !templateHover) return null
    const placements = computeTemplatePlacement(
      pendingTemplate,
      templateHover.beat,
      templateHover.midi
    )
    // Group by midi so each grid row can pull its own preview notes just
    // like it does for real notes via notesByMidi.
    const byMidi = new Map()
    for (const p of placements) {
      const arr = byMidi.get(p.midi) || []
      arr.push(p)
      byMidi.set(p.midi, arr)
    }
    return byMidi
  }, [pendingTemplate, templateHover, scale, root, totalBeats])

  // Transform a pending template's notes IN PLACE (template-local coords) so the
  // ghost can be flipped / stretched before it's ever committed — the same
  // operations the selection transforms apply to placed notes, but on the armed
  // template so you can shape a variation, then click to stamp it.
  const transformTemplateNotes = (notes, op) => {
    if (!notes || !notes.length) return notes
    if (op === 'flipH') {
      // Mirror in time around the pattern's own span.
      let minB = Infinity
      let maxEnd = -Infinity
      for (const n of notes) {
        const len = n.length ?? 1
        if (n.beat < minB) minB = n.beat
        if (n.beat + len > maxEnd) maxEnd = n.beat + len
      }
      return notes.map((n) => ({
        ...n,
        beat: minB + maxEnd - (n.beat + (n.length ?? 1)),
      }))
    }
    if (op === 'flipV') {
      // Mirror in pitch across the pattern's span in scale-step space
      // (octave + degree combined); any chromatic offset rides along.
      const L = scale.notes.length
      const pos = (n) => n.octave * L + n.degree
      let minP = Infinity
      let maxP = -Infinity
      for (const n of notes) {
        const p = pos(n)
        if (p < minP) minP = p
        if (p > maxP) maxP = p
      }
      const sum = minP + maxP
      return notes.map((n) => {
        const np = sum - pos(n)
        return {
          ...n,
          octave: Math.floor(np / L),
          degree: ((np % L) + L) % L,
        }
      })
    }
    if (op === 'grow' || op === 'shrink') {
      // Proportional augmentation / diminution — same math as stretchSelection:
      // the shortest note changes by one rhythm-selector unit, everything else
      // scales by that factor, so the internal rhythm is preserved.
      const dir = op === 'grow' ? 1 : -1
      const FLOOR = 1 / 32
      const stepCells = rhythmLength > 0 ? rhythmLength : 1
      const round = (x) => Math.round(x * 1e6) / 1e6
      let anchor = Infinity
      let minLen = Infinity
      for (const n of notes) {
        const len = n.length ?? 1
        if (n.beat < anchor) anchor = n.beat
        if (len < minLen) minLen = len
      }
      if (!(minLen > 0)) return notes
      const targetMin = Math.max(FLOOR, minLen + dir * stepCells)
      const factor = targetMin / minLen
      return notes.map((n) => ({
        ...n,
        beat: round(anchor + (n.beat - anchor) * factor),
        length: Math.max(FLOOR, round((n.length ?? 1) * factor)),
      }))
    }
    return notes
  }
  const transformPendingTemplate = (op) =>
    setPendingTemplate((cur) =>
      cur ? { ...cur, notes: transformTemplateNotes(cur.notes, op) } : cur
    )

  // ── Template sharing (copy / paste / import / export) ──────────────────
  // (state hooks live up near tabMenu/groupMenu so the close-menu effect can
  // reference templateMenu without a temporal-dead-zone crash.)
  const newTemplateId = () =>
    `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const flashExport = (msg) => {
    setExportFeedback(msg)
    setTimeout(() => setExportFeedback(''), 1600)
  }
  const templatesToJSON = (tpls) =>
    JSON.stringify(tpls.length === 1 ? tpls[0] : tpls, null, 2)
  const copyText = async (text) => {
    try {
      await navigator.clipboard.writeText(text)
      return true
    } catch {
      const ta = document.createElement('textarea')
      ta.value = text
      document.body.appendChild(ta)
      ta.select()
      let ok = false
      try {
        ok = document.execCommand('copy')
      } catch {}
      document.body.removeChild(ta)
      return ok
    }
  }
  // Accept a raw template object, an array of them, or the "export const
  // templates = [...]" code form. Returns fresh templates (new ids) or null.
  const parseTemplates = (text) => {
    let s = (text || '').trim()
    if (!s) return null
    const i = s.search(/[[{]/)
    if (i > 0) s = s.slice(i)
    s = s.replace(/;\s*$/, '')
    let data
    try {
      data = JSON.parse(s)
    } catch {
      return null
    }
    const arr = Array.isArray(data) ? data : [data]
    // Keep templates (need a notes array) and folders (type 'folder').
    const valid = arr.filter(
      (t) => t && (t.type === 'folder' || Array.isArray(t.notes))
    )
    if (!valid.length) return null
    // Fresh ids, but remap parentId through the same map so a folder keeps its
    // children; parents outside this payload collapse to root (parentId null).
    const idMap = new Map()
    for (const t of valid) idMap.set(t.id, newTemplateId())
    return valid.map((t) => {
      const parentId =
        t.parentId != null && idMap.has(t.parentId)
          ? idMap.get(t.parentId)
          : null
      if (t.type === 'folder') {
        return {
          id: idMap.get(t.id),
          type: 'folder',
          name: typeof t.name === 'string' ? t.name : 'Folder',
          parentId,
          collapsed: !!t.collapsed,
        }
      }
      return {
        id: idMap.get(t.id),
        type: 'template',
        name: typeof t.name === 'string' ? t.name : 'Imported',
        parentId,
        capturedFrom: t.capturedFrom || { scaleId: scale.id, root },
        notes: t.notes,
      }
    })
  }
  const deleteTemplate = (id) => {
    if (!setTemplates) return
    setTemplates(templates.filter((t) => t.id !== id))
  }
  const deleteTemplates = (ids) => {
    if (!setTemplates) return
    setTemplates(templates.filter((t) => !ids.has(t.id)))
    setSelectedTemplateIds(new Set())
  }
  const renameTemplate = (id, name) => {
    if (!setTemplates) return
    const n = (name || '').trim()
    if (!n) return
    setTemplates(templates.map((t) => (t.id === id ? { ...t, name: n } : t)))
  }
  const copyTemplates = async (tpls) => {
    if (!tpls.length) return
    flashExport((await copyText(templatesToJSON(tpls))) ? 'Copied' : 'Failed')
  }
  const downloadTemplates = (tpls) => {
    if (!tpls.length) return
    // Name the file after a single item or the folder at the head of a subtree.
    const first = tpls[0]
    const base =
      tpls.length === 1 || first.type === 'folder' ? first.name : 'templates'
    const name = `${(base || 'templates').replace(/[^\w-]+/g, '_') || 'templates'}.json`
    requestSave(templatesToJSON(tpls), name)
  }
  // Export as real files on disk: one .json per template, folders recreated as
  // subdirectories. `rootName` nests everything in a new directory of that name
  // (a folder export); without it the items land straight in the chosen folder
  // (a multi-selection export). Where there's no directory picker (Firefox /
  // Safari) the same tree arrives as a .zip. Bulk-export-all lives in Settings.
  const exportTemplateTree = async (nodes, rootName) => {
    if (!nodes.length) return
    const res = await requestSaveTree(
      nodes,
      (node) => JSON.stringify(node, null, 2),
      rootName
    )
    if (res.ok)
      flashExport(`Exported ${res.count}${res.zipped ? ' (zip)' : ''}`)
  }
  const exactKey = (t) =>
    `${(t.name || '').toLowerCase()}|${JSON.stringify(t.notes || [])}`

  // All descendants (templates + nested folders) of a node within a flat list.
  const collectSubtree = (nodes, rootId) => {
    const byParent = new Map()
    nodes.forEach((n) => {
      const p = n.parentId ?? null
      if (!byParent.has(p)) byParent.set(p, [])
      byParent.get(p).push(n)
    })
    const out = []
    const walk = (id) => {
      for (const child of byParent.get(id) || []) {
        out.push(child)
        if (isFolder(child)) walk(child.id)
      }
    }
    walk(rootId)
    return out
  }
  // Name-agnostic content fingerprint of a folder: the sorted multiset of its
  // descendant template signatures. Two folders with the same templates (in any
  // order, at any depth) share a content sig.
  const folderContentSig = (nodes, folderId) =>
    JSON.stringify(
      collectSubtree(nodes, folderId)
        .filter((n) => !isFolder(n))
        .map((n) => templateSignature(n.notes || []))
        .sort()
    )

  // Classify each TOP-LEVEL import unit against the existing library so the
  // dialog can explain conflicts. A unit is a root-level template or a root-level
  // folder (which carries its whole subtree). Templates: CONTENT duplicate =
  // matches an existing one by signature or exact name+notes; NAME clash = same
  // name, different notes. Folders: CONTENT duplicate = an existing folder shares
  // its name AND its contents; NAME clash = same folder name, different contents.
  // A folder's children ride with the folder's decision — skipping a duplicate
  // folder drops its subtree too.
  const classifyImport = (incoming) => {
    const roots = incoming.filter((n) => (n.parentId ?? null) === null)

    const existingTpls = templates.filter((t) => !isFolder(t))
    const sigToName = new Map()
    const exactToName = new Map()
    existingTpls.forEach((t) => {
      const s = templateSignature(t.notes || [])
      if (!sigToName.has(s)) sigToName.set(s, t.name || 'Template')
      exactToName.set(exactKey(t), t.name || 'Template')
    })
    const tplNames = new Set(existingTpls.map((t) => (t.name || '').toLowerCase()))

    // Existing folders: name -> set of content sigs sharing that name.
    const folderContentByName = new Map()
    templates.filter(isFolder).forEach((f) => {
      const key = (f.name || '').toLowerCase()
      if (!folderContentByName.has(key)) folderContentByName.set(key, new Set())
      folderContentByName.get(key).add(folderContentSig(templates, f.id))
    })

    return roots.map((node) => {
      if (isFolder(node)) {
        const subtree = collectSubtree(incoming, node.id)
        const childCount = subtree.filter((n) => !isFolder(n)).length
        const key = (node.name || '').toLowerCase()
        const base = { node, subtree, kind: 'folder', childCount }
        if (folderContentByName.has(key)) {
          const sameContent = folderContentByName
            .get(key)
            .has(folderContentSig(incoming, node.id))
          return {
            ...base,
            status: sameContent ? 'content-dup' : 'name-clash',
            matchName: node.name,
          }
        }
        return { ...base, status: 'new' }
      }
      const sig = templateSignature(node.notes || [])
      const ek = exactKey(node)
      const base = { node, subtree: [], kind: 'template' }
      if (sigToName.has(sig) || exactToName.has(ek)) {
        return {
          ...base,
          status: 'content-dup',
          matchName: sigToName.get(sig) || exactToName.get(ek),
        }
      }
      if (tplNames.has((node.name || '').toLowerCase())) {
        return { ...base, status: 'name-clash', matchName: node.name }
      }
      return { ...base, status: 'new' }
    })
  }

  // Write the resolved import. `units` are classified top-level units carrying a
  // `choice` ('skip' drops the unit and — for a folder — its whole subtree).
  // Names stay unique per kind: a kept template/folder whose name collides is
  // suffixed "(2)", "(3)"…; a folder's inner names are left untouched.
  const commitImport = (units) => {
    if (!setTemplates) return { added: 0, skipped: 0 }
    const kept = units.filter((u) => u.choice !== 'skip')
    const tplNames = new Set(
      templates.filter((t) => !isFolder(t)).map((t) => (t.name || '').toLowerCase())
    )
    const folderNames = new Set(
      templates.filter(isFolder).map((f) => (f.name || '').toLowerCase())
    )
    const uniqueName = (name, taken, fallback) => {
      let out = name || fallback
      if (taken.has(out.toLowerCase())) {
        let n = 2
        while (taken.has(`${out} (${n})`.toLowerCase())) n++
        out = `${out} (${n})`
      }
      taken.add(out.toLowerCase())
      return out
    }
    const additions = []
    for (const u of kept) {
      if (u.kind === 'folder') {
        const name = uniqueName(u.node.name, folderNames, 'Folder')
        additions.push({ ...u.node, name })
        // Subtree ids are already fresh and internally consistent — append as-is.
        additions.push(...u.subtree)
      } else {
        const name = uniqueName(u.node.name, tplNames, 'Template')
        additions.push({ ...u.node, name })
      }
    }
    if (additions.length) setTemplates([...templates, ...additions])
    return { added: kept.length, skipped: units.length - kept.length }
  }

  // Entry point for every import path. If nothing conflicts, it imports
  // silently with a flash; otherwise it opens the conflict dialog so the user
  // decides per item before anything is written.
  const beginImport = (incoming) => {
    if (!incoming || !incoming.length) {
      flashExport('No template')
      return
    }
    const classified = classifyImport(incoming)
    const conflicts = classified.filter((c) => c.status !== 'new')
    if (!conflicts.length) {
      const { added, skipped } = commitImport(
        classified.map((c) => ({ ...c, choice: 'import' }))
      )
      importFeedback(added, skipped)
      return
    }
    setImportConflicts(classified)
  }

  const resolveImport = (resolved) => {
    setImportConflicts(null)
    const { added, skipped } = commitImport(resolved)
    importFeedback(added, skipped)
  }

  const importFeedback = (added, skipped) =>
    flashExport(
      added
        ? skipped
          ? `+${added} · ${skipped} skipped`
          : `+${added}`
        : skipped
        ? `${skipped} skipped`
        : 'No template'
    )
  const pasteTemplates = async () => {
    let text = ''
    try {
      text = await navigator.clipboard.readText()
    } catch {
      flashExport('Clipboard blocked')
      return
    }
    const parsed = parseTemplates(text)
    if (!parsed || !parsed.length) {
      flashExport('No template')
      return
    }
    beginImport(parsed)
  }
  const importTemplateFiles = async (files) => {
    const all = []
    for (const file of files) {
      const parsed = parseTemplates(await file.text())
      if (parsed) all.push(...parsed)
    }
    beginImport(all)
  }
  // Templates a menu/action targets: the multi-selection if the clicked one is
  // part of it, otherwise just the clicked template.
  const templateTargets = (id) => {
    if (selectedTemplateIds.has(id) && selectedTemplateIds.size > 1) {
      return templates.filter((t) => selectedTemplateIds.has(t.id))
    }
    const t = templates.find((x) => x.id === id)
    return t ? [t] : []
  }
  // Expand a set of node ids to include every descendant, returned in template
  // order (parents before children) so a folder travels with its full contents.
  const withDescendants = (ids) => {
    const roots = Array.isArray(ids) ? ids : [ids]
    const wanted = new Set()
    const add = (id) => {
      if (wanted.has(id)) return
      wanted.add(id)
      for (const child of templates)
        if (child.parentId === id) add(child.id)
    }
    roots.forEach(add)
    return templates.filter((t) => wanted.has(t.id))
  }

  // ── Folders + creation + drag-reorder ─────────────────────────────────
  const isFolder = (n) => n && n.type === 'folder'
  // Create an empty folder at the root and immediately rename it inline.
  const createFolder = () => {
    if (!setTemplates) return
    const id = newTemplateId()
    setTemplates([
      ...templates,
      { id, type: 'folder', name: 'New folder', parentId: null },
    ])
    setRenameValue('New folder')
    setRenamingTemplateId(id)
    setNewMenu(null)
  }
  // Open the editor for a brand-new template, or to edit an existing one.
  const openTemplateEditor = (node = null) => {
    setEditingTemplateId(node ? node.id : null)
    setTemplateEditorOpen(true)
    setNewMenu(null)
    setTemplateMenu(null)
  }
  // Find an existing template whose musical shape matches `items` (same scalar
  // contour + same relative rhythm). Skips folders and the one being edited.
  const findDuplicateTemplate = (items, excludeId) => {
    const sig = templateSignature(items)
    if (!sig) return null
    for (const t of templates) {
      if (isFolder(t) || (excludeId && t.id === excludeId)) continue
      if (templateSignature(t.notes) === sig) return t
    }
    return null
  }
  // Save from the editor. Stores scale-relative records so it replays on any
  // scale. Updates the existing template when editing, else appends a new one.
  const saveNewTemplate = (name, items, tags = []) => {
    if (!setTemplates || !items.length) {
      setTemplateEditorOpen(false)
      setEditingTemplateId(null)
      return
    }
    if (editingTemplateId) {
      setTemplates(
        templates.map((t) =>
          t.id === editingTemplateId
            ? {
                ...t,
                name: name || t.name,
                capturedFrom: { scaleId: scale.id, root },
                notes: items,
                tags,
              }
            : t
        )
      )
    } else {
      const count = templates.filter((t) => !isFolder(t)).length + 1
      setTemplates([
        ...templates,
        {
          id: newTemplateId(),
          type: 'template',
          name: name || `Template ${count}`,
          parentId: null,
          capturedFrom: { scaleId: scale.id, root },
          notes: items,
          tags,
        },
      ])
    }
    // Any brand-new tag names join the library registry.
    if (tags.length) registerTags(tags)
    setTemplateEditorOpen(false)
    setEditingTemplateId(null)
  }
  const toggleFolder = (id) => {
    setTemplates(
      templates.map((n) =>
        n.id === id ? { ...n, collapsed: !n.collapsed } : n
      )
    )
  }
  // Delete every node in a selection (mixed folders + templates). Any child of
  // a deleted folder that isn't itself deleted is reparented to the root.
  const deleteSelection = (ids) => {
    if (!setTemplates) return
    const idSet = new Set(ids)
    setTemplates(
      templates
        .filter((n) => !idSet.has(n.id))
        .map((n) => (idSet.has(n.parentId) ? { ...n, parentId: null } : n))
    )
    setSelectedTemplateIds(new Set())
  }
  // Delete a folder but keep its contents — its children move up to the
  // folder's own parent.
  const deleteFolder = (id) => {
    const folder = templates.find((n) => n.id === id)
    const pid = folder ? folder.parentId ?? null : null
    setTemplates(
      templates
        .filter((n) => n.id !== id)
        .map((n) => (n.parentId === id ? { ...n, parentId: pid } : n))
    )
  }
  // Move a node (and, for a folder, its whole subtree since children keep
  // their parentId) relative to a target: before/after a sibling, inside a
  // folder, or to the end of the root. Called live during a drag, so it works
  // purely off the freshest array (`prev`) and no-ops when nothing changes.
  const moveNode = (dragId, targetId, pos) => {
    if (!setTemplates || !dragId || dragId === targetId) return
    setTemplates((prev) => {
      // Cycle guard on the fresh tree: can't drop a folder into its own subtree.
      const isDesc = (ancestorId, nodeId) => {
        let cur = prev.find((n) => n.id === nodeId)
        const seen = new Set()
        while (cur && cur.parentId != null && !seen.has(cur.id)) {
          seen.add(cur.id)
          if (cur.parentId === ancestorId) return true
          cur = prev.find((n) => n.id === cur.parentId)
        }
        return false
      }
      if (targetId && isDesc(dragId, targetId)) return prev
      const arr = prev.slice()
      const di = arr.findIndex((n) => n.id === dragId)
      if (di < 0) return prev
      const [node] = arr.splice(di, 1)
      let parentId
      let insertAt
      if (pos === 'root' || targetId == null) {
        parentId = null
        insertAt = arr.length
      } else {
        const ti = arr.findIndex((n) => n.id === targetId)
        if (ti < 0) return prev
        parentId = pos === 'inside' ? targetId : arr[ti].parentId ?? null
        insertAt = pos === 'before' ? ti : ti + 1
      }
      const moved = { ...node, parentId }
      // Don't force the target folder open — dropping into a folder leaves it
      // in whatever open/closed state it was (less jarring).
      arr.splice(insertAt, 0, moved)
      return arr
    })
  }
  // Move several nodes together (a shift-selection) to a target — e.g. drop a
  // group of templates into a folder. Their relative order is preserved; items
  // whose parent is also being moved stay nested under it.
  const moveNodes = (ids, targetId, pos) => {
    if (!setTemplates || !ids || !ids.length) return
    setTemplates((prev) => {
      const idSet = new Set(ids)
      if (targetId != null && idSet.has(targetId)) return prev
      const isDesc = (ancestorId, nodeId) => {
        let cur = prev.find((n) => n.id === nodeId)
        const seen = new Set()
        while (cur && cur.parentId != null && !seen.has(cur.id)) {
          seen.add(cur.id)
          if (cur.parentId === ancestorId) return true
          cur = prev.find((n) => n.id === cur.parentId)
        }
        return false
      }
      if (targetId != null && [...idSet].some((id) => isDesc(id, targetId)))
        return prev
      const moving = prev.filter((n) => idSet.has(n.id)) // keeps current order
      const rest = prev.filter((n) => !idSet.has(n.id))
      let parentId
      let insertAt
      if (pos === 'root' || targetId == null) {
        parentId = null
        insertAt = rest.length
      } else {
        const ti = rest.findIndex((n) => n.id === targetId)
        if (ti < 0) return prev
        parentId = pos === 'inside' ? targetId : rest[ti].parentId ?? null
        insertAt = pos === 'before' ? ti : ti + 1
      }
      const moved = moving.map((n) =>
        idSet.has(n.parentId) ? n : { ...n, parentId }
      )
      rest.splice(insertAt, 0, ...moved)
      return rest
    })
    setSelectedTemplateIds(new Set())
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
      // Forward rotation: the earliest-beat pitch wraps to the latest beat,
      // landing just above the note it now follows (the original last pitch).
      const first = midis[0]
      const newLast = midis[n - 1]
      const neighbourStep = midiToScaleStep(newLast)
      let bumped
      if (first % 12 === newLast % 12 && neighbourStep != null) {
        // The wrapped pitch shares its neighbour's pitch class — a scale run
        // that spans a full octave (e.g. Scale Up: G#…G# an octave up). A
        // flat +12 would stack ANOTHER G# an octave higher; instead continue
        // the scale by one DEGREE (→ the A# above) so it stays a clean
        // staircase.
        bumped = scaleStepToMidi(neighbourStep + 1)
      } else {
        // Otherwise keep the wrapped note's pitch class, lifted by whole
        // octaves until it clears the new last pitch. With a flat +12 the
        // wrap could fall inside the range — e.g. [60,70,80] → 60+12=72 sits
        // below 80 — so this is the right behaviour for arpeggios/leaps.
        bumped = first
        while (bumped <= newLast) bumped += 12
      }
      newMidis = [...midis.slice(1), bumped]
      newLengths = [...lengths.slice(1), lengths[0]]
    } else {
      // Backward rotation: the latest-beat pitch wraps to the earliest beat,
      // landing just below the note it now precedes (the original first).
      const last = midis[n - 1]
      const newFirst = midis[0]
      const neighbourStep = midiToScaleStep(newFirst)
      let bumped
      if (last % 12 === newFirst % 12 && neighbourStep != null) {
        // Octave-spanning scale run (e.g. G#…G#): drop by one DEGREE to the
        // G below, not by a flat 12 to another G# an octave lower.
        bumped = scaleStepToMidi(neighbourStep - 1)
      } else {
        bumped = last
        while (bumped >= newFirst) bumped -= 12
      }
      newMidis = [bumped, ...midis.slice(0, n - 1)]
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

  // Shift a midi by `stepDelta` scale steps (or semitones out-of-scale),
  // clamped to the MIDI range. Shared by on-screen and off-screen nudges.
  const nudgeMidi = (oldMidi, stepDelta) => {
    if (stepDelta === 0) return oldMidi
    let nm
    if (allowOutOfScale) {
      nm = oldMidi + stepDelta
    } else {
      const gStep = midiToScaleStep(oldMidi)
      nm =
        gStep != null
          ? scaleStepToMidi(gStep + stepDelta)
          : nearestScaleMidi(oldMidi + stepDelta)
    }
    return Math.max(MIDI_LOW, Math.min(MIDI_HIGH, nm))
  }

  // Keyboard nudge for the selection. `beatDelta` shifts horizontally on the
  // grid; `stepDelta` shifts vertically by scale steps. The selection moves
  // as a rigid group. Notes pushed left of beat 0 go to the off-screen store
  // (still selected, not rendered); nudging right brings them back — exactly
  // like the mouse drag. On the right the group clamps at totalBeats.
  const nudgeSelection = (beatDelta, stepDelta) => {
    if (selectedKeys.size === 0 && offscreenNotesRef.current.length === 0) return
    pushHistory()
    const cur = notesRef.current
    const items = []
    for (const k of selectedKeys) {
      const [bStr, midiStr] = k.split('-')
      items.push({
        key: k,
        beat: Number(bStr),
        midi: Number(midiStr),
        len: cur.get(k) ?? 1,
      })
    }
    // Right clamp uses the on-screen notes' furthest end so the group stops
    // at the timeline edge as a unit. Left nudges are never clamped.
    let beatDeltaEff = beatDelta
    if (beatDelta > 0 && items.length) {
      let maxEnd = -Infinity
      for (const it of items) if (it.beat + it.len > maxEnd) maxEnd = it.beat + it.len
      beatDeltaEff = Math.min(totalBeats - maxEnd, beatDeltaEff)
    }
    const newSel = new Set()
    const newOffscreen = []
    const toDelete = []
    const toSet = []
    // On-screen notes: those crossing left of 0 move to the off-screen store.
    for (const it of items) {
      toDelete.push(it.key)
      const nb = it.beat + beatDeltaEff
      const nm = nudgeMidi(it.midi, stepDelta)
      if (nb < 0) {
        newOffscreen.push({ beat: nb, midi: nm, len: it.len })
      } else {
        const nk = `${nb}-${nm}`
        toSet.push([nk, it.len])
        newSel.add(nk)
      }
    }
    // Off-screen notes: those reaching >= 0 come back on-screen.
    for (const off of offscreenNotesRef.current) {
      const nb = off.beat + beatDeltaEff
      const nm = nudgeMidi(off.midi, stepDelta)
      if (nb >= 0) {
        const nk = `${nb}-${nm}`
        toSet.push([nk, off.len])
        newSel.add(nk)
      } else {
        newOffscreen.push({ beat: nb, midi: nm, len: off.len })
      }
    }
    setNotes((prev) => {
      const next = new Map(prev)
      for (const k of toDelete) next.delete(k)
      for (const [k, l] of toSet) next.set(k, l)
      return next
    })
    offscreenNotesRef.current = newOffscreen
    nudgeJustRanRef.current = true
    setSelectedKeys(newSel)
  }

  // Proportional stretch / compress of the selection — augmentation and
  // diminution. dir = +1 grows the shortest note by one rhythm-selector unit,
  // -1 shrinks it; every other note (and every gap) scales by the same factor.
  // The internal rhythm (the ratios between note values and gaps) is preserved
  // and notes never overlap: when a note grows, the ones after it slide along
  // so the next starts where it left off.
  const stretchSelection = (dir) => {
    if (selectedKeys.size === 0) return
    const FLOOR = 1 / 32 // finest note length in cells
    const stepCells = rhythmLength > 0 ? rhythmLength : 1
    const round = (x) => Math.round(x * 1e6) / 1e6
    const cur = notesRef.current
    const items = []
    let anchor = Infinity
    let minLen = Infinity
    for (const key of selectedKeys) {
      const [bStr, midiStr] = key.split('-')
      const beat = Number(bStr)
      const len = cur.get(key) ?? 1
      items.push({ key, beat, midi: Number(midiStr), len })
      if (beat < anchor) anchor = beat
      if (len < minLen) minLen = len
    }
    if (!(minLen > 0)) return
    // The shortest note changes by exactly one rhythm-selector unit; derive the
    // scale factor from that so every note grows in proportion. Compression is
    // clamped so the shortest note can't collapse below the finest length.
    const targetMin = Math.max(FLOOR, minLen + dir * stepCells)
    const factor = targetMin / minLen
    const scaled = items.map((it) => ({
      midi: it.midi,
      beat: round(anchor + (it.beat - anchor) * factor),
      len: Math.max(FLOOR, round(it.len * factor)),
    }))
    // Grow the timeline (Ableton-style) if the stretched phrase reaches past it.
    let maxEnd = 0
    for (const s of scaled) if (s.beat + s.len > maxEnd) maxEnd = s.beat + s.len
    const effectiveTotal = growBeatsForEnd(maxEnd)
    const newSel = new Set()
    setNotes((prev) => {
      const next = new Map(prev)
      for (const it of items) next.delete(it.key)
      for (const s of scaled) {
        const beat = Math.min(s.beat, effectiveTotal - FLOOR)
        const len = Math.min(s.len, effectiveTotal - beat)
        const nk = `${beat}-${s.midi}`
        next.set(nk, len)
        newSel.add(nk)
      }
      return next
    })
    setSelectedKeys(newSel)
  }
  const growSelection = () => {
    if (selectedKeys.size === 0) return
    pushHistory()
    stretchSelection(1)
  }
  const shrinkSelection = () => {
    if (selectedKeys.size === 0) return
    pushHistory()
    stretchSelection(-1)
  }

  // ── MIDI regions / "runes" (R key) ─────────────────────────────────────
  // A detached staircase clip built in SCALE-STEP space (only in-scale notes).
  // The pattern's RHYTHM (times + lengths) is fixed and loops; its PITCHES flow
  // up the staircase. The clip shows notes k in [startK, endK) — note k sits in
  // rhythm slot k%N (rep floor(k/N)) at an ABSOLUTE time anchored on anchorBeat,
  // and takes staircase step (pitchShift+k). startK/endK trim/extend ONE NOTE at
  // a time from either edge (k can go negative). Off-keyboard notes drop.
  const regionSlotBeat = (r, k) => {
    const N = r.pattern.length
    const slot = ((k % N) + N) % N
    return r.anchorBeat + Math.floor(k / N) * r.patternLen + r.pattern[slot].dt
  }
  const regionSlotLen = (r, k) => {
    const N = r.pattern.length
    return r.pattern[((k % N) + N) % N].len
  }
  const regionStepMidi = (r, k) => {
    const N = r.pattern.length
    const m = r.pitchShift + k
    const li = ((m % N) + N) % N
    return scaleStepToMidi(
      r.baseStep + r.pattern[li].dstep + Math.floor(m / N) * r.periodSteps
    )
  }
  const regionNotes = (r) => {
    if (!r) return []
    const out = []
    for (let k = r.startK; k < r.endK; k++) {
      const soundMidi = regionStepMidi(r, k)
      if (soundMidi < MIDI_LOW || soundMidi > MIDI_HIGH) continue
      out.push({
        beat: regionSlotBeat(r, k),
        midi: soundMidi,
        soundMidi,
        len: regionSlotLen(r, k),
      })
    }
    return out
  }
  // Drawn time bounds [left, right] of the clip (its first/last shown notes).
  const regionBounds = (r) => {
    let left = Infinity
    let right = -Infinity
    for (let k = r.startK; k < r.endK; k++) {
      const b = regionSlotBeat(r, k)
      if (b < left) left = b
      if (b + regionSlotLen(r, k) > right) right = b + regionSlotLen(r, k)
    }
    if (!Number.isFinite(left)) {
      left = regionSlotBeat(r, r.startK)
      right = left
    }
    return { left, right }
  }
  // Pitch span over the shown notes — used to clamp the climb to the keyboard.
  const regionPitchRange = (r, w) => {
    const test = w === undefined ? r : { ...r, pitchShift: w }
    let lo = Infinity
    let hi = -Infinity
    for (let k = test.startK; k < test.endK; k++) {
      const midi = regionStepMidi(test, k)
      if (midi < lo) lo = midi
      if (midi > hi) hi = midi
    }
    return { lo, hi }
  }
  const updateRegion = (id, changes) =>
    setMidiRegions((prev) =>
      prev.map((r) => (r.id === id ? { ...r, ...changes } : r))
    )
  const createRegionFromSelection = () => {
    if (selectedKeys.size === 0) return
    const cur = notesRef.current
    let minBeat = Infinity
    let maxEnd = -Infinity
    const raw = []
    for (const key of selectedKeys) {
      const sep = key.indexOf('-')
      const beat = Number(key.slice(0, sep))
      const midi = Number(key.slice(sep + 1))
      const len = cur.get(key) ?? 1
      raw.push({ beat, midi, len })
      if (beat < minBeat) minBeat = beat
      if (beat + len > maxEnd) maxEnd = beat + len
    }
    const patternLen = maxEnd - minBeat
    if (patternLen <= 0) return
    const stepped = raw.map((n) => {
      let st = midiToScaleStep(n.midi)
      if (st == null) st = midiToScaleStep(nearestScaleMidi(n.midi)) ?? 0
      return { dt: n.beat - minBeat, step: st, len: n.len }
    })
    const baseStep = Math.min(...stepped.map((s) => s.step))
    const maxStep = Math.max(...stepped.map((s) => s.step))
    const periodSteps = Math.max(1, maxStep - baseStep + 1)
    const pattern = stepped
      .map((s) => ({ dt: s.dt, dstep: s.step - baseStep, len: s.len }))
      .sort((a, b) => a.dt - b.dt || a.dstep - b.dstep)
    pushHistory()
    // Detach: lift the selected notes out of the real note map.
    setNotes((prev) => {
      const next = new Map(prev)
      for (const k of selectedKeys) next.delete(k)
      return next
    })
    runeCounterRef.current += 1
    const label = runeCounterRef.current
    const id = `rune-${label}`
    const region = {
      id,
      label,
      anchorBeat: minBeat,
      patternLen,
      startK: 0,
      endK: pattern.length, // one pattern's worth of notes to start
      baseStep,
      periodSteps,
      pattern,
      pitchShift: 0,
    }
    setMidiRegions((prev) => [...prev, region])
    setSelectedRegionId(id)
    setSelectedKeys(new Set())
  }
  // Delete a region, baking its current window notes onto the timeline.
  const bakeRegion = (id) => {
    const r = midiRegionsRef.current.find((x) => x.id === id)
    if (!r) return
    pushHistory()
    const notes = regionNotes(r)
    setNotes((prev) => {
      const next = new Map(prev)
      for (const n of notes) {
        let beat = n.beat
        if (!freeMode) beat = Math.round(beat)
        next.set(`${beat}-${n.soundMidi}`, n.len)
      }
      return next
    })
    setMidiRegions((prev) => prev.filter((x) => x.id !== id))
    if (selectedRegionIdRef.current === id) setSelectedRegionId(null)
  }
  // Drag the box body → climb the staircase pitch (whole-note snap, select).
  const handleRegionBodyDown = (e, region) => {
    if (e.button !== 0) return
    e.stopPropagation()
    e.preventDefault()
    setSelectedRegionId(region.id)
    const startX = e.clientX
    const shift0 = region.pitchShift
    const STEP_PX = 16
    let pushed = false
    const move = (mv) => {
      const dx = mv.clientX - startX
      const w = shift0 + Math.round(dx / STEP_PX)
      if (w === region.pitchShift) return
      const { lo, hi } = regionPitchRange(region, w)
      if (lo < MIDI_LOW || hi > MIDI_HIGH) return
      if (!pushed) {
        pushHistory()
        pushed = true
      }
      updateRegion(region.id, { pitchShift: w })
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
  // Drag the label bar → move the whole clip along the timeline.
  const handleRegionLabelDown = (e, region) => {
    if (e.button !== 0) return
    e.stopPropagation()
    e.preventDefault()
    setSelectedRegionId(region.id)
    const startX = e.clientX
    const anchor0 = region.anchorBeat
    const { left, right } = regionBounds(region)
    const leadIn = left - anchor0 // gap between anchor and drawn left edge
    const span = right - left
    let pushed = false
    const move = (mv) => {
      const dx = mv.clientX - startX
      let na = shiftBeatByPx(anchor0, dx)
      if (!freeMode) na = Math.round(na)
      // Keep the drawn box within the timeline.
      na = Math.max(-leadIn, Math.min(totalBeats - span - leadIn, na))
      if (na === region.anchorBeat) return
      if (!pushed) {
        pushHistory()
        pushed = true
      }
      updateRegion(region.id, { anchorBeat: na })
    }
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', up)
      document.body.style.cursor = ''
    }
    document.body.style.cursor = 'grabbing'
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', up)
  }
  // Drag an edge → add/remove notes ONE AT A TIME. side 'right' moves endK,
  // side 'left' moves startK (can go negative → notes before the anchor). The
  // notes stay anchored in time, so trimming the front doesn't shift the rest.
  const handleRegionEdgeDown = (e, region, side) => {
    if (e.button !== 0) return
    e.stopPropagation()
    e.preventDefault()
    setSelectedRegionId(region.id)
    const startX = e.clientX
    const edge0 = side === 'right' ? regionBounds(region).right : regionBounds(region).left
    let pushed = false
    const move = (mv) => {
      const dx = mv.clientX - startX
      const target = shiftBeatByPx(edge0, dx)
      if (side === 'right') {
        // endK = count of notes whose start is before the edge (min 1 past start).
        let endK = region.startK + 1
        for (let k = region.startK; k < region.startK + 8192; k++) {
          if (regionSlotBeat(region, k) < target - 1e-6) endK = k + 1
          else break
        }
        if (endK <= region.startK) endK = region.startK + 1
        if (endK === region.endK) return
        if (!pushed) {
          pushHistory()
          pushed = true
        }
        growBeatsForEnd(regionBounds({ ...region, endK }).right)
        updateRegion(region.id, { endK })
      } else {
        // startK = the note whose start is nearest the edge (can go negative).
        let bestK = region.startK
        let bestD = Infinity
        for (let k = region.endK - 1; k >= region.endK - 1 - 8192; k--) {
          const b = regionSlotBeat(region, k)
          const d = Math.abs(b - target)
          if (d < bestD) {
            bestD = d
            bestK = k
          } else if (b < target) break // past the target going down — stop
        }
        const startK = Math.min(region.endK - 1, bestK)
        if (startK === region.startK) return
        if (!pushed) {
          pushHistory()
          pushed = true
        }
        updateRegion(region.id, { startK })
      }
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
  // Precompute each region's notes + bounds once per region/scale change (NOT
  // every playhead frame) so rendering stays smooth.
  const renderedRegions = useMemo(
    () =>
      midiRegions.map((region) => {
        const notes = regionNotes(region)
        let lo = Infinity
        let hi = -Infinity
        for (const n of notes) {
          if (n.soundMidi < lo) lo = n.soundMidi
          if (n.soundMidi > hi) hi = n.soundMidi
        }
        return { region, notes, lo, hi, bounds: regionBounds(region) }
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [midiRegions, scale, root]
  )

  // MIDI pitches SOUNDING at the current playhead (placed notes + region notes),
  // so the fretboard plays along in time with the timeline. Empty when the
  // playhead isn't set.
  const fretboardPitches = useMemo(() => {
    const s = new Set()
    const p = playheadBeat
    if (p == null) return s
    const EPS = 1e-6
    for (const [key, len] of notes) {
      const sep = key.indexOf('-')
      const beat = Number(key.slice(0, sep))
      if (beat <= p + EPS && p < beat + len - EPS) {
        s.add(Number(key.slice(sep + 1)))
      }
    }
    for (const { notes: rn } of renderedRegions) {
      for (const n of rn) {
        if (n.beat <= p + EPS && p < n.beat + n.len - EPS) s.add(n.soundMidi)
      }
    }
    return s
  }, [notes, renderedRegions, playheadBeat])

  const pasteNotes = () => {
    const clip = clipboardRef.current
    if (!clip || !clip.items || clip.items.length === 0) return
    // Paste at the playhead if it's set — that's the primary "drop here"
    // signal. Otherwise fall back to the source's original start beat so
    // cross-song / cross-track pastes land at the same beat they were
    // copied from (in-place, same position). A plain in-track Ctrl+C →
    // Ctrl+V will stack over the original in that case; use the playhead
    // if you want a separate landing spot.
    const target =
      playheadBeat != null ? playheadBeat : clip.sourceMinBeat
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
    // Notes propagate their own pointerdown as stopped, so we don't need to
    // gate on target vs currentTarget — if a note handler ran first, this
    // one won't fire at all. Reaching here means the click / drag started
    // on empty grid space (in-scale or out-of-scale), so always proceed.
    // Ctrl at mousedown momentarily inverts the "allow out of scale" mode
    // for this gesture — see the note-place path below.
    const ctrlHeld = e.ctrlKey || e.metaKey
    // Right-click on the grid: shift+right starts a delete-marquee; plain
    // right-click without shift just suppresses the browser context menu
    // and does nothing.
    const isRightClick = e.pointerType === 'mouse' && e.button === 2
    if (isRightClick) e.preventDefault()

    // If a template is queued for placement, commit it at the click
    // position (beat from cursor X, scale-step anchor from the clicked
    // row's midi) and exit. Right-click cancels placement instead.
    if (pendingTemplate && !isRightClick) {
      e.preventDefault()
      e.stopPropagation()
      const trackRect = e.currentTarget.getBoundingClientRect()
      let clickBeat = xToBeat(e.clientX - trackRect.left)
      if (!freeMode) clickBeat = Math.floor(clickBeat)
      clickBeat = Math.max(0, Math.min(totalBeats - 1, clickBeat))
      commitTemplateAt(pendingTemplate, clickBeat, midi)
      // Alt-click keeps the template armed (ghost + panel highlight stay) so it
      // can be stamped repeatedly; a plain click places once and disarms.
      if (!e.altKey) setPendingTemplate(null)
      return
    }
    if (pendingTemplate && isRightClick) {
      setPendingTemplate(null)
      return
    }

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
      let startBeat = xToBeat(e.clientX - trackRect.left)
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
        let curBeat = xToBeat(mv.clientX - trackRect.left)
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
        if (finalLength != null) setDefaultNoteLength(finalLength)
        auditionNote(midi, 0.3, 0.3)
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
    const trackEl = e.currentTarget
    const trackRect = trackEl.getBoundingClientRect()
    const rowIdx = MIDI_HIGH - midi
    const startContentX = e.clientX - trackRect.left
    const startContentY = rowIdx * ROW_HEIGHT + (e.clientY - trackRect.top)
    const initialX = e.clientX
    const initialY = e.clientY
    const pointerId = e.pointerId
    // Capture the pointer on the beats-track. This has two effects that
    // together fix the "marquee only works once or twice" bug we were seeing
    // on out-of-scale rows: (1) subsequent pointer events go to this
    // element even if the pointer leaves it — no more lost drags when the
    // pointer wanders off the row's narrow 21 px strip; (2) the browser
    // fires a guaranteed pointerup / pointercancel on the same target so
    // our cleanup always runs even if the user releases off-screen or the
    // browser cancels for any reason.
    try {
      trackEl.setPointerCapture?.(pointerId)
    } catch {}

    // Snap the click to the rhythm's division grid (tuplets included) so
    // placed notes tile cleanly. Free mode leaves it continuous.
    let beat = snapPlacementBeat(xToBeat(startContentX))
    let moved = false
    // Track scroll offset the container was at when the drag started, so
    // that if the container scrolls mid-drag the marquee's rectangle grows
    // with the newly-visible content instead of detaching from the pointer.
    const scrollContainer = scrollRef.current
    const initialScrollLeft = scrollContainer ? scrollContainer.scrollLeft : 0
    const initialScrollTop = scrollContainer ? scrollContainer.scrollTop : 0
    // Gentle edge auto-scroll. 1 px per frame at the outer edge, ramps down
    // linearly to 0 at the inner edge of a 24 px band. At 60fps that's a
    // 60 px/sec crawl — slow enough to see every note the marquee crosses,
    // fast enough to reach the end of a long passage without lifting the
    // pointer. Only ticks when the pointer sits inside the band.
    const EDGE_BAND = 24
    const MAX_EDGE_PX = 1
    let lastPointer = { clientX: e.clientX, clientY: e.clientY }
    let scrollAf = null

    const updateMarquee = () => {
      const dx = lastPointer.clientX - initialX
      const dy = lastPointer.clientY - initialY
      // Very small threshold so the marquee visualises on the first frame
      // of any drag — the user gets immediate confirmation the row accepted
      // the gesture, especially on out-of-scale rows where nothing else
      // (cursor swap aside) changes on mousedown.
      if (!moved && Math.abs(dx) < 1 && Math.abs(dy) < 1) return
      moved = true
      const scrollDx = scrollContainer
        ? scrollContainer.scrollLeft - initialScrollLeft
        : 0
      const scrollDy = scrollContainer
        ? scrollContainer.scrollTop - initialScrollTop
        : 0
      const curX = startContentX + dx + scrollDx
      const curY = startContentY + dy + scrollDy
      const m = {
        x1: Math.max(0, Math.min(startContentX, curX)),
        y1: Math.max(0, Math.min(startContentY, curY)),
        x2: Math.max(startContentX, curX),
        y2: Math.max(startContentY, curY),
      }
      marqueeRef.current = m
      setMarquee(m)
    }

    const stepScroll = () => {
      scrollAf = null
      if (!scrollContainer) return
      const rect = scrollContainer.getBoundingClientRect()
      const px = lastPointer.clientX
      const py = lastPointer.clientY
      let dx = 0
      let dy = 0
      if (px < rect.left + EDGE_BAND) {
        const t = Math.min(1, (rect.left + EDGE_BAND - px) / EDGE_BAND)
        dx = -MAX_EDGE_PX * t
      } else if (px > rect.right - EDGE_BAND) {
        const t = Math.min(1, (px - (rect.right - EDGE_BAND)) / EDGE_BAND)
        dx = MAX_EDGE_PX * t
      }
      if (py < rect.top + EDGE_BAND) {
        const t = Math.min(1, (rect.top + EDGE_BAND - py) / EDGE_BAND)
        dy = -MAX_EDGE_PX * t
      } else if (py > rect.bottom - EDGE_BAND) {
        const t = Math.min(1, (py - (rect.bottom - EDGE_BAND)) / EDGE_BAND)
        dy = MAX_EDGE_PX * t
      }
      if (dx === 0 && dy === 0) return
      scrollContainer.scrollLeft = Math.max(
        0,
        Math.min(
          scrollContainer.scrollWidth - scrollContainer.clientWidth,
          scrollContainer.scrollLeft + dx
        )
      )
      scrollContainer.scrollTop = Math.max(
        0,
        Math.min(
          scrollContainer.scrollHeight - scrollContainer.clientHeight,
          scrollContainer.scrollTop + dy
        )
      )
      updateMarquee()
      scrollAf = requestAnimationFrame(stepScroll)
    }

    const move = (mv) => {
      if (mv.pointerId !== pointerId) return
      lastPointer = { clientX: mv.clientX, clientY: mv.clientY }
      updateMarquee()
      if (!scrollContainer || scrollAf != null) return
      const rect = scrollContainer.getBoundingClientRect()
      const nearEdge =
        mv.clientX < rect.left + EDGE_BAND ||
        mv.clientX > rect.right - EDGE_BAND ||
        mv.clientY < rect.top + EDGE_BAND ||
        mv.clientY > rect.bottom - EDGE_BAND
      if (nearEdge) scrollAf = requestAnimationFrame(stepScroll)
    }

    const up = (uv) => {
      if (uv && uv.pointerId !== pointerId) return
      if (scrollAf != null) {
        cancelAnimationFrame(scrollAf)
        scrollAf = null
      }
      trackEl.removeEventListener('pointermove', move)
      trackEl.removeEventListener('pointerup', up)
      trackEl.removeEventListener('pointercancel', up)
      try {
        trackEl.releasePointerCapture?.(pointerId)
      } catch {}
      if (!moved) {
        // Right-click without drag — do nothing (and never place a note).
        if (isRightClick) return
        // Shift+click on empty space: preserve the current selection so the
        // user can keep building it across separate gestures.
        if (additive) return
        // Click on empty space → add note. Whether out-of-scale rows are
        // allowed = the Settings toggle XOR whether Ctrl was held on the
        // click. Snap-on + Ctrl → allow this chromatic placement.
        // Snap-off + Ctrl → block this chromatic placement (i.e. force
        // scale-snap for just this click). If blocked, the note lands on
        // the nearest in-scale row so the click always produces something
        // — matches where the hover indicator was sitting.
        const effectiveAllowOOS = allowOutOfScale ? !ctrlHeld : ctrlHeld
        const placeMidi =
          !effectiveAllowOOS && !inScale(midi % 12)
            ? nearestScaleMidi(midi)
            : midi
        // Start on empty space, never inside a note on this row (matches the
        // hover box). No overlaps allowed.
        const placeBeat = avoidLeftOverlap(beat, placeMidi)
        const key = `${placeBeat}-${placeMidi}`
        pushHistory()
        const newLength = defaultNoteLengthRef.current
        setNotes((prev) => {
          const next = new Map(prev)
          next.set(key, newLength)
          return next
        })
        auditionNote(placeMidi, 0.3, 0.3)
        // The fretboard position stays where the user set it (P + number); a
        // note outside the 5-fret span just renders at its real fret outside it.
        setSelectedKeys(new Set())
      } else {
        const m = marqueeRef.current
        const inMarquee = (key) => {
          const [beatStr, midiStr] = key.split('-')
          const noteBeat = Number(beatStr)
          const noteMidi = Number(midiStr)
          // Use the note's actual length so long notes (or short free-mode
          // ones) intersect the marquee at their true horizontal extent.
          // Falls back to 1 beat for entries whose length isn't tracked.
          const noteLen = notes.get(key) ?? 1
          // Hit-test against the note's on-screen rect, which is warped in swung
          // display, so the marquee catches what the user actually sees.
          const nx1 = beatToX(noteBeat)
          const nx2 = beatToX(noteBeat + noteLen)
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

    trackEl.addEventListener('pointermove', move)
    trackEl.addEventListener('pointerup', up)
    trackEl.addEventListener('pointercancel', up)
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

    // Shift on a note is dual-purpose: a bare click toggles the note in the
    // selection (build-up mode), while a shift-DRAG hands off to the row's
    // marquee handler so the user can sweep additional notes starting from
    // one they're already hovering. This is the "drag from a note to select
    // more" gesture — otherwise the note's move handler swallows the drag.
    if (e.shiftKey) {
      const initX = e.clientX
      const initY = e.clientY
      const rowTrack = e.currentTarget.parentElement
      let handedOff = false
      const detect = (mv) => {
        if (handedOff) return
        if (Math.abs(mv.clientX - initX) < 3 && Math.abs(mv.clientY - initY) < 3) return
        handedOff = true
        window.removeEventListener('pointermove', detect)
        window.removeEventListener('pointerup', end)
        window.removeEventListener('pointercancel', end)
        // Re-dispatch the original mousedown onto the parent beats-track so
        // handleRowMouseDown fires with shift held → additive marquee starts
        // from the same on-screen point. We use the current pointer position
        // so the marquee's origin lines up with where the user actually is.
        if (!rowTrack) return
        handleRowMouseDown(
          {
            target: rowTrack,
            currentTarget: rowTrack,
            clientX: initX,
            clientY: initY,
            pointerId: e.pointerId,
            pointerType: e.pointerType,
            button: 0,
            shiftKey: true,
            altKey: false,
            preventDefault: () => {},
            stopPropagation: () => {},
          },
          midi
        )
      }
      const end = () => {
        window.removeEventListener('pointermove', detect)
        window.removeEventListener('pointerup', end)
        window.removeEventListener('pointercancel', end)
        if (handedOff) return
        // Plain shift+click on the note — toggle selection.
        setSelectedKeys((prev) => {
          const next = new Set(prev)
          if (next.has(key)) next.delete(key)
          else next.add(key)
          return next
        })
      }
      window.addEventListener('pointermove', detect)
      window.addEventListener('pointerup', end)
      window.addEventListener('pointercancel', end)
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
      // Allow the anchor (and thus the delta) to go negative — notes that
      // cross beat 0 disappear off the left edge instead of stacking on
      // beat 0. Top bound still clamps so notes can't run past totalBeats.
      let newAnchorBeat = shiftBeatByPx(drag.originalBeat, dx)
      newAnchorBeat = snapDragBeat(newAnchorBeat)
      // Ableton-style: dragging toward the end grows the timeline rather than
      // clamping. Grow to fit the furthest note end in the group, then clamp
      // the anchor to whatever length we ended up with (MAX_BEATS ceiling).
      const rawDelta = newAnchorBeat - drag.originalBeat
      let groupMaxEnd = -Infinity
      for (const g of drag.group) {
        const e = g.originalBeat + rawDelta + g.length
        if (e > groupMaxEnd) groupMaxEnd = e
      }
      const curTotal = growBeatsForEnd(groupMaxEnd)
      newAnchorBeat = Math.min(curTotal - 0.001, newAnchorBeat)
      const beatDelta = newAnchorBeat - drag.originalBeat

      // Vertical step:
      //  - In scale mode, average 12 / scale.notes.length semitones per
      //    step, so each scale degree spans rowsPerStep rows.
      //  - When the "allow notes outside the scale" setting is on, drag
      //    moves freely in semitones (one row per semitone), no snapping.
      //  - Special case: if ANY note in the drag group already sits on an
      //    out-of-scale pitch (e.g. left over from when allow-out-of-scale
      //    was toggled on), fall back to chromatic movement for the group
      //    so it can be dragged freely rather than being snapped to an
      //    unrelated in-scale pitch that jumps.
      // Ctrl inverts the current snap mode for the whole drag: snap-on +
      // Ctrl drags chromatically, snap-off + Ctrl re-snaps to scale.
      const effectiveAllowOOS = allowOutOfScale ? !mv.ctrlKey : mv.ctrlKey
      const groupHasOutOfScale =
        !effectiveAllowOOS &&
        drag.group.some((g) => midiToScaleStep(g.originalMidi) == null)
      const chromatic = effectiveAllowOOS || groupHasOutOfScale
      const rowsPerStep = chromatic
        ? 1
        : scale.notes.length > 0
        ? 12 / scale.notes.length
        : 1
      const stepDelta = -Math.round(dy / (ROW_HEIGHT * rowsPerStep))

      const newPositions = drag.group.map((g) => {
        let nb = g.originalBeat + beatDelta
        // Snap each note to the current subdivision grid, not just the drag
        // delta. Notes placed off-grid (free mode, or a different subdivision)
        // otherwise keep their original fractional offset because only the
        // anchor gets snapped — this pulls every note onto the live grid.
        // On-grid notes snap to themselves, so group intervals are preserved.
        nb = snapDragBeat(nb)
        const offscreen = nb < 0
        if (!offscreen) nb = Math.min(curTotal - 0.001, nb)
        let nm
        if (chromatic) {
          nm = g.originalMidi + stepDelta
        } else {
          const gStep = midiToScaleStep(g.originalMidi)
          nm =
            gStep != null
              ? scaleStepToMidi(gStep + stepDelta)
              : nearestScaleMidi(g.originalMidi + stepDelta)
        }
        nm = Math.max(MIDI_LOW, Math.min(MIDI_HIGH, nm))
        return {
          newBeat: nb,
          newMidi: nm,
          newKey: offscreen ? null : `${nb}-${nm}`,
          length: g.length,
          offscreen,
        }
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
      // on top. Off-screen entries (newKey === null) are simply omitted —
      // they reappear automatically the moment the cursor moves right
      // enough that they cross beat 0 again, because the snapshot still
      // holds their original beat/midi.
      const next = new Map(drag.snapshot)
      for (const ok of drag.originalKeys) next.delete(ok)
      for (const np of newPositions) {
        if (np.newKey != null) next.set(np.newKey, np.length)
      }
      setNotes(next)

      if (drag.isGroup) {
        setSelectedKeys(
          new Set(
            newPositions
              .map((np) => np.newKey)
              .filter((k) => k != null)
          )
        )
      }

      if (newAnchorMidi !== drag.lastMidi) {
        auditionNote(newAnchorMidi, 0.2, 0.2)
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
        auditionNote(midi, 0.3, 0.3)
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
    // The resize increment follows the rhythm selector's subdivision, frozen
    // at drag start. So a note grows/shrinks in steps of the current value
    // (a 16th, an 8th, a triplet, …) added to its ORIGINAL length — you start
    // wherever the note ends and increment by the selector's unit, even when
    // that start isn't itself on the subdivision grid.
    const step = !freeMode && rhythmBaseCells > 0 ? rhythmBaseCells : 1
    const move = (mv) => {
      const dx = mv.clientX - startX
      if (!snapshotPushed && Math.abs(dx) < 2) return
      if (!snapshotPushed) {
        pushHistory()
        snapshotPushed = true
      }
      // Derive the length change from where the dragged note's RIGHT edge moves
      // on screen, unwarped — so in swung display a resize still tracks the
      // pointer across a pair boundary. Straight mode is just dx/BW.
      let lengthDelta = swingViewActive
        ? xToBeat(beatToX(beat + currentLength) + dx) - (beat + currentLength)
        : dx / BEAT_WIDTH
      if (!freeMode) lengthDelta = Math.round(lengthDelta / step) * step
      // Ableton-style: lengthening a note past the end grows the timeline.
      let resizeMaxEnd = -Infinity
      for (const g of group) {
        const e = g.beat + Math.max(0.25, g.originalLength + lengthDelta)
        if (e > resizeMaxEnd) resizeMaxEnd = e
      }
      const curTotal = growBeatsForEnd(resizeMaxEnd)
      setNotes((prev) => {
        const next = new Map(prev)
        for (const g of group) {
          const minLen = freeMode
            ? 0.25
            : Math.max(0.25, Math.min(step, g.originalLength))
          let newLength = g.originalLength + lengthDelta
          newLength = Math.max(
            minLen,
            Math.min(curTotal - g.beat, newLength)
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
      if (snapshotPushed) setDefaultNoteLength(lastDraggedLength)
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
      // Left edge follows the pointer in screen space, unwarped (swung display).
      let beatDelta = swingViewActive
        ? xToBeat(beatToX(beat) + dx) - beat
        : dx / BEAT_WIDTH
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
      if (snapshotPushed) setDefaultNoteLength(lastDraggedLength)
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
    const hasAnyNotes = tracksRef.current.some((t) => t.notes.size > 0)
    if (!hasAnyNotes && !metronome && midiRegionsRef.current.length === 0) return
    stopPlayback(false)
    const ctx = getAudioContext()
    const cellDur = beatDurForBpm(bpm)
    const startBase = ctx.currentTime + 0.05
    const swing = swingPct
    const swingUnit = SWING_GRID_CELLS
    const activeLoop = loopRef.current
    if (activeLoop && (startBeat < activeLoop.start || startBeat >= activeLoop.end)) {
      startBeat = activeLoop.start
    }
    // Remember where this playback began so Enter can return the playhead here.
    lastPlayStartBeatRef.current = startBeat
    // Schedule every melody note (and metronome click, if on) whose beat
    // falls in [rangeStart, rangeEnd), relative to scheduleStartTime as
    // t=rangeStart. Reads notes / metronome / swing from live refs at call
    // time so loop iterations scheduled AFTER an edit reflect the new
    // state without needing to restart playback.
    const scheduleRange = (rangeStart, rangeEnd, scheduleStartTime) => {
      const liveSwing = swingPctRef.current
      const liveUnit = SWING_GRID_CELLS
      const swungRangeStart = applySwingBeat(rangeStart, liveSwing, liveUnit)
      // Iterate every track. Mute/solo gating: if any track is soloed,
      // only soloed tracks play; otherwise every non-muted track plays.
      // Per-track volume scales the base peak gain.
      const liveTracks = tracksRef.current
      const anySolo = liveTracks.some((t) => t.soloed)
      const BASE_GAIN = 0.22
      for (const track of liveTracks) {
        if (track.muted) continue
        if (anySolo && !track.soloed) continue
        const peak = BASE_GAIN * track.volume
        if (peak <= 0.001) continue
        const synth = track.synth || 'triangle'
        const voice = {
          attackMs: track.attackMs,
          releaseMs: track.releaseMs,
          detuneCents: track.detuneCents,
        }
        for (const [key, length] of track.notes) {
          const [beatStr, midiStr] = key.split('-')
          const beat = Number(beatStr)
          const midi = Number(midiStr)
          if (beat >= rangeStart && beat < rangeEnd) {
            const swungNoteStart = applySwingBeat(beat, liveSwing, liveUnit)
            const swungNoteEnd = applySwingBeat(beat + length, liveSwing, liveUnit)
            const noteTime =
              scheduleStartTime + (swungNoteStart - swungRangeStart) * cellDur
            const noteDur = Math.max(
              0.06,
              (swungNoteEnd - swungNoteStart) * cellDur
            )
            playOneNote(midi, noteTime, noteDur, peak, synth, voice)
          }
        }
      }
      // Region ("rune") notes are a DETACHED overlay — not in any track's note
      // map — so schedule them here with the active track's voice, gated by the
      // same mute/solo rules. Read live so dragging a region during loop
      // playback updates what sounds.
      const regions = midiRegionsRef.current
      if (regions.length) {
        const at =
          liveTracks.find((t) => t.id === activeTrackId) ?? liveTracks[0]
        if (at && !at.muted && (!anySolo || at.soloed)) {
          const peak = BASE_GAIN * at.volume
          if (peak > 0.001) {
            const synth = at.synth || 'triangle'
            const voice = {
              attackMs: at.attackMs,
              releaseMs: at.releaseMs,
              detuneCents: at.detuneCents,
            }
            for (const region of regions) {
              for (const m of regionNotes(region)) {
                if (m.beat >= rangeStart && m.beat < rangeEnd) {
                  const swungNoteStart = applySwingBeat(m.beat, liveSwing, liveUnit)
                  const swungNoteEnd = applySwingBeat(
                    m.beat + m.len,
                    liveSwing,
                    liveUnit
                  )
                  const noteTime =
                    scheduleStartTime +
                    (swungNoteStart - swungRangeStart) * cellDur
                  const noteDur = Math.max(
                    0.06,
                    (swungNoteEnd - swungNoteStart) * cellDur
                  )
                  playOneNote(m.soundMidi, noteTime, noteDur, peak, synth, voice)
                }
              }
            }
          }
        }
      }
      if (metronomeRef.current) {
        // Click on every beat of the current time signature, accenting the
        // downbeat. Iterate by beat index so odd/non-dyadic denominators
        // (fractional cells per beat) still line up.
        const cpb = cellsPerBeat
        let k = Math.ceil(rangeStart / cpb - 1e-9)
        for (; k * cpb < rangeEnd; k++) {
          const b = k * cpb
          if (b < rangeStart - 1e-9) continue
          const clickTime = scheduleStartTime + (b - rangeStart) * cellDur
          playClick(clickTime, k % timeSig.num === 0)
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
      const swungStart = applySwingBeat(startBeat, swing, swingUnit)
      const swungLoopStart = applySwingBeat(loopStart, swing, swingUnit)
      const swungLoopEnd = applySwingBeat(loopEnd, swing, swingUnit)
      const firstIterDur = (swungLoopEnd - swungStart) * cellDur
      const iterationDur = (swungLoopEnd - swungLoopStart) * cellDur
      const firstIterEndTime = startBase + firstIterDur
      scheduleRange(startBeat, loopEnd, startBase)
      playStateRef.current = {
        mode: 'loop',
        startTime: startBase,
        cellDur,
        swing,
        swingUnit,
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
      // One-shot mode: schedule once, end at the latest note's right edge
      // across all tracks.
      let lastBeat = 0
      let anyNotes = false
      for (const track of tracksRef.current) {
        for (const [key, length] of track.notes) {
          anyNotes = true
          const [beatStr] = key.split('-')
          const beat = Number(beatStr)
          const noteEndBeat = beat + length
          if (noteEndBeat > lastBeat) lastBeat = noteEndBeat
        }
      }
      const endBeat = anyNotes ? lastBeat : totalBeats
      scheduleRange(startBeat, endBeat, startBase)
      const swungStart = applySwingBeat(startBeat, swing, swingUnit)
      playStateRef.current = {
        mode: 'oneshot',
        startTime: startBase,
        cellDur,
        swing,
        swingUnit,
        swungStart,
        swungEnd: applySwingBeat(endBeat, swing, swingUnit),
        endBeat,
        offsetBeat: startBeat,
        // Store scheduleRange so a live edit during one-shot playback can
        // re-schedule the remainder from the current playhead, matching the
        // loop-mode behaviour.
        scheduleRange,
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
      const musicalBeat = unswingTimeBeat(currentSwungBeat, state.swing, state.swingUnit)
      const current = Math.max(0, musicalBeat)
      setPlayheadBeat(current)
      const sc = scrollRef.current
      if (sc) {
        const playheadX = beatToX(current) + 52
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

  // Current musical beat of the running playback (null when stopped). Mirrors
  // the tick's clock math so we can re-schedule from the exact live position.
  const currentPlaybackBeat = () => {
    const st = playStateRef.current
    const ctx = audioCtxRef.current
    if (!st || !ctx) return null
    const elapsed = ctx.currentTime - st.startTime
    let swungBeat
    if (st.mode === 'loop') {
      if (elapsed < st.firstIterEndTime - st.startTime) {
        swungBeat = st.swungStart + elapsed / st.cellDur
      } else {
        const t =
          (elapsed - (st.firstIterEndTime - st.startTime)) % st.iterationDur
        swungBeat = st.swungLoopStart + t / st.cellDur
      }
    } else {
      swungBeat = st.swungStart + elapsed / st.cellDur
    }
    return Math.max(0, unswingTimeBeat(swungBeat, st.swing, st.swingUnit))
  }

  // Tempo / swing / loop edits take effect DURING playback: Web Audio events are
  // queued at absolute times, so what's already scheduled can't be retuned in
  // place — instead re-lay the timeline from the live playhead with the new
  // values (playFromBeat re-reads bpm/swing/loop). Debounced so a tempo scrub or
  // a loop-region drag re-schedules once it settles, not on every pixel.
  const rescheduleTimerRef = useRef(null)
  useEffect(() => {
    if (playStateRef.current == null) return
    if (rescheduleTimerRef.current) clearTimeout(rescheduleTimerRef.current)
    rescheduleTimerRef.current = setTimeout(() => {
      const beat = currentPlaybackBeat()
      if (beat != null) playFromBeat(beat)
    }, 90)
    return () => {
      if (rescheduleTimerRef.current) clearTimeout(rescheduleTimerRef.current)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bpm, swingPct, loop])

  const addTrack = () => {
    pushHistory()
    const id = makeTrackId()
    const trackNumber = tracks.length + 1
    // Generic "Track N" name + the default triangle synth (the original
    // patch). User can switch synth + tweak parameters in the sidebar.
    const name = `Track ${trackNumber}`
    setTracks((prev) => [
      ...prev,
      buildDefaultTrack({ id, name, synth: 'triangle' }),
    ])
    setActiveTrackId(id)
    setSelectedKeys(new Set())
  }

  const removeTrack = (id) => {
    const track = tracks.find((t) => t.id === id)
    if (!track) return
    if (tracks.length <= 1) return // never delete the last track
    if (track.notes.size > 0) {
      const ok = window.confirm(
        `Delete track "${track.name}"? It has ${track.notes.size} note${
          track.notes.size === 1 ? '' : 's'
        }; this can't be undone with Ctrl+Z if you keep editing.`
      )
      if (!ok) return
    }
    pushHistory()
    const remaining = tracks.filter((t) => t.id !== id)
    setTracks(remaining)
    if (activeTrackId === id) {
      setActiveTrackId(remaining[0].id)
      setSelectedKeys(new Set())
    }
  }

  const updateTrack = (id, patch) => {
    setTracks((prev) =>
      prev.map((t) => (t.id === id ? { ...t, ...patch } : t))
    )
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

  // Live re-schedule while playing: kill queued voices and re-schedule the
  // remainder of the current iteration (loop) or range (one-shot) starting
  // at the playhead. Handles BOTH modes so a live edit (flip selection,
  // note move, delete, etc.) is heard immediately rather than at the next
  // loop boundary or — worse — never in one-shot playback.
  const liveReschedule = () => {
    const st = playStateRef.current
    if (!st || !st.scheduleRange) return
    const ctx = audioCtxRef.current
    if (!ctx) return
    const now = ctx.currentTime
    if (st.mode === 'loop') {
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
      const currentMusicalBeat = unswingTimeBeat(currentSwungBeat, st.swing, st.swingUnit)
      st.scheduleRange(currentMusicalBeat, st.loopEnd, now)
      st.nextIterStartTime = iterEndTime
    } else if (st.mode === 'oneshot') {
      const elapsed = now - st.startTime
      const currentSwungBeat = st.swungStart + elapsed / st.cellDur
      // Guard against re-schedules past the end of the range — nothing to
      // do there. Also cap at endBeat so we don't schedule silence.
      if (currentSwungBeat >= st.swungEnd) return
      killScheduledVoices()
      const currentMusicalBeat = unswingTimeBeat(currentSwungBeat, st.swing, st.swingUnit)
      st.scheduleRange(currentMusicalBeat, st.endBeat, now)
    }
  }

  // Debounced trigger: on ANY track change while playing — notes moved /
  // added / deleted, synth swapped, volume / mute / solo flipped, attack /
  // release / detune tweaked — wait a beat for rapid changes to settle,
  // then reschedule from the current playhead so the audio reflects the
  // edit immediately (both loop and one-shot playback). Depending on the
  // whole tracks array catches every field the scheduler reads through
  // tracksRef, not just the active track's notes.
  useEffect(() => {
    const st = playStateRef.current
    if (!st) return
    const id = setTimeout(() => liveReschedule(), 60)
    return () => clearTimeout(id)
  }, [tracks])

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
      Math.min(totalBeats, snapBeat(xToBeat(startX)))
    )

    const currentLoop = loopRef.current
    const EDGE_PX = 10
    let mode = 'create'
    let initialLoopSnap = null
    if (currentLoop) {
      const loopStartX = beatToX(currentLoop.start)
      const loopEndX = beatToX(currentLoop.end)
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
      const beat = Math.max(0, Math.min(totalBeats, snapBeat(xToBeat(x))))

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
      className={`roll-view ${allowOutOfScale ? 'allow-oos' : ''} ${pendingTemplate ? 'placing-template' : ''}`}
      onContextMenu={(e) => e.preventDefault()}
    >
      {topCollapsed ? (
        <div className="roll-top-collapsed">
          <button
            className="play roll-play"
            onClick={togglePlay}
            aria-label="play roll"
            title="Space: play/pause · Enter: play from start"
          >
            <PlayIcon />
          </button>
          <button
            type="button"
            className="roll-top-expand"
            onClick={() => setTopCollapsed(false)}
            title="Expand controls"
            aria-label="Expand controls"
          >
            <ChevronDown size={18} strokeWidth={2.2} />
          </button>
          <span className="roll-top-bpm" title="Tempo (BPM)">
            {bpm}
            <span className="roll-top-bpm-unit">BPM</span>
          </span>
          <div className="roll-mini-tabs" role="tablist" aria-label="songs">
            {songs.map((s) => {
              const m = s.name.match(/^.*?(\d+)\s*$/)
              return (
                <div
                  key={s.id}
                  role="tab"
                  aria-selected={s.id === activeSongId}
                  className={`song-tab ${s.id === activeSongId ? 'active' : ''}`}
                  onClick={() => onSelectSong?.(s.id)}
                  title={s.name}
                >
                  <span className="song-tab-name">{m ? m[1] : s.name}</span>
                  {songs.length > 1 && onRemoveSong && (
                    <button
                      type="button"
                      className="song-tab-close"
                      onPointerDown={(e) => e.stopPropagation()}
                      onClick={(e) => {
                        e.stopPropagation()
                        onRemoveSong(s.id)
                      }}
                      aria-label={`Close ${s.name}`}
                      title="Close song"
                    >
                      ×
                    </button>
                  )}
                </div>
              )
            })}
            {onAddSong && (
              <button
                type="button"
                className="song-tab-add"
                onClick={onAddSong}
                title="New song"
                aria-label="New song"
              >
                +
              </button>
            )}
          </div>
        </div>
      ) : (
        <>
      <header className={`roll-header ${mobileMenuOpen ? 'menu-open' : ''}`}>
        <button className="back-btn" onClick={onBack} aria-label="back to matrix">
          <BackIcon />
          <span>back</span>
        </button>
        <div className="roll-title">
          <span className="roll-number">
            {scale.kind === 'custom' ? scale.name : padId(scale.id)}
          </span>
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
        {/* Frequently-used controls live inline; everything else is in the
            Roll settings modal (M key or the ⋯ button). */}
        <NumberField
          label="BPM"
          value={bpm}
          min={MIN_BPM}
          max={MAX_BPM}
          sensitivity={0.5}
          onCommit={setBpm}
        />
        <NumberField
          label="Swing"
          value={Math.round(ratioToAmount(swingPct / 100) * 100)}
          min={-100}
          max={100}
          sensitivity={0.5}
          onCommit={(amt) => setSwingPct(amountToRatio(amt / 100) * 100)}
        />
        <button
          type="button"
          className={`mode-toggle icon-toggle ${chordVoicingOpen ? 'on' : ''}`}
          onClick={openChordVoicing}
          aria-label="chord voicings"
          aria-pressed={chordVoicingOpen}
          title="See the scale's chords as guitar voicings"
        >
          <Guitar size={16} strokeWidth={1.8} />
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
        <div
          className="rhythm-cluster"
          title={
            'Rhythm — pick the unit (beat or bar), then type a number to divide it exactly (÷1 = whole unit, ÷2 = half, ÷3 = triplet, ÷6 = six per unit, …). Type digits quickly for multi-digit values (1 2 → ÷12). Press X then a number to set a multiplier.'
          }
        >
          <button
            type="button"
            className="rhythm-unit-box"
            onClick={() =>
              setRhythmUnit((u) => (u === 'beat' ? 'bar' : 'beat'))
            }
            title="Toggle whether the division refers to a beat or a bar"
          >
            {rhythmUnit === 'bar' ? 'BAR' : 'BEAT'}
          </button>
          <div className="rhythm-box">
            <span className="rhythm-box-div">÷{rhythmDenominator}</span>
            <span className="rhythm-box-name">{rhythmNoteName}</span>
          </div>
          <div className="rhythm-note-icon">
            <NoteGlyph value={rhythmGlyphValue} size={18} />
            {rhythmTuplet && (
              <span className="rhythm-note-tuplet">{rhythmTuplet}</span>
            )}
          </div>
          <div
            className={`rhythm-mult-box ${
              rhythmAwaitingMultiplier ? 'awaiting' : ''
            }`}
          >
            ×{rhythmAwaitingMultiplier ? '?' : rhythmMult}
          </div>
        </div>
        {/* Opens the full Roll settings modal (same as the M key). */}
        <button
          type="button"
          className={`roll-overflow-btn ${paramsOpen ? 'on' : ''}`}
          onClick={() => setParamsOpen((v) => !v)}
          title="Roll settings — all options (M)"
          aria-label="roll settings"
          aria-haspopup="dialog"
        >
          <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
            <circle cx="3" cy="8" r="1.4" fill="currentColor" />
            <circle cx="8" cy="8" r="1.4" fill="currentColor" />
            <circle cx="13" cy="8" r="1.4" fill="currentColor" />
          </svg>
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
        <button
          type="button"
          className="roll-top-collapse"
          onClick={() => setTopCollapsed(true)}
          title="Collapse controls to a summary row"
          aria-label="Collapse controls"
        >
          <ChevronUp size={18} strokeWidth={2.2} />
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

        {/* Song tabs — inline with the scale spelling; each tab is its own
            piano-roll workspace, optionally grouped under a coloured strip. */}
        <span className="roll-scale-tag">Tabs</span>
        <div
          className={`song-tabs tabs-${tabStyle}`}
          role="tablist"
          aria-label="songs"
        >
        {/* The baseline lives on .song-tabs-list so it only spans the
            actual tabs, not the trailing + button or padding. */}
        <div
          ref={songTabsListRef}
          className={`song-tabs-list ${
            tabDrag.draggingId ? 'dragging-active' : ''
          } ${tabSettling ? 'settling' : ''}`}
          onDragOver={(e) => {
            // Group-pill drags still use HTML5 DnD; targeting is computed
            // from stable layout positions here. (Song tabs use a pointer
            // drag — see handleTabPointerDown.)
            if (tabDrag.kind !== 'group' || !tabDrag.draggingId) return
            e.preventDefault()
            e.dataTransfer.dropEffect = 'move'
            const list = e.currentTarget
            const cx = e.clientX - list.getBoundingClientRect().left
            let beforeId = '__tail'
            for (const el of list.querySelectorAll('.song-tab')) {
              const id = el.dataset.songId
              const mid = el.offsetLeft + el.offsetWidth / 2
              if (cx < mid) {
                beforeId = id
                break
              }
            }
            if (tabDrag.overBeforeId !== beforeId) {
              setTabDrag((s) => ({ ...s, overBeforeId: beforeId }))
            }
          }}
          onDrop={(e) => {
            if (tabDrag.kind !== 'group' || !tabDrag.draggingId) return
            e.preventDefault()
            const target =
              tabDrag.overBeforeId === '__tail' ? null : tabDrag.overBeforeId
            handleDropBefore(target)
          }}
        >
          {(() => {
            // Walk songs in order. Whenever we enter a new group, drop an
            // inline pill before its members. Collapsed groups render only
            // the pill (with a member-count badge) and skip their tabs. All
            // tabs and pills live in the same flex row.
            //
            // Chrome-style live sliding: while a tab is dragged, the other
            // tabs translate by the dragged tab's width to open a gap at the
            // drop target, animated via a CSS transform transition. The
            // dragged tab itself goes invisible in place. `shiftForIndex`
            // returns the px offset for each song index.
            const dragMeta = (() => {
              if (tabDrag.kind !== 'tab' || !tabDrag.draggingId) return null
              const di = songs.findIndex((s) => s.id === tabDrag.draggingId)
              if (di === -1) return null
              let ti
              if (tabDrag.overBeforeId == null) ti = null
              else if (tabDrag.overBeforeId === '__tail') ti = songs.length
              else ti = songs.findIndex((s) => s.id === tabDrag.overBeforeId)
              return { di, ti, width: tabDrag.width || 0 }
            })()
            const shiftForIndex = (i) => {
              if (!dragMeta || dragMeta.ti == null || i === dragMeta.di) return 0
              const { di, ti, width } = dragMeta
              if (di < ti) {
                if (i > di && i < ti) return -width
              } else if (i >= ti && i < di) {
                return width
              }
              return 0
            }
            const nodes = []
            let prevGroupId = null
            for (let i = 0; i < songs.length; i++) {
              const song = songs[i]
              const gid = song.groupId ?? null
              const group = gid
                ? songGroups.find((g) => g.id === gid)
                : null
              if (gid && gid !== prevGroupId) {
                const memberCount = songs.filter((s) => s.groupId === gid).length
                const isRenaming = renamingGroup?.id === gid
                const collapsed = !!group?.collapsed
                const isDraggingThisGroup =
                  tabDrag.kind === 'group' && tabDrag.draggingId === gid
                const indicatorBefore =
                  tabDrag.draggingId && tabDrag.overBeforeId === `pill-${gid}`
                // First member of this group — used to translate the pill's
                // "drop before this pill" into the corresponding song-level
                // reference (moveSong / moveGroup both target song ids).
                const firstMemberId = songs.find((s) => s.groupId === gid)?.id
                nodes.push(
                  <div
                    key={`pill-${gid}`}
                    className={`song-group-pill ${collapsed ? 'collapsed' : ''} ${
                      isRenaming ? 'renaming' : ''
                    } ${isDraggingThisGroup ? 'dragging' : ''} ${
                      indicatorBefore ? 'drop-before' : ''
                    }`}
                    style={{ '--group-colour': group?.colour ?? '#4f8cff' }}
                    draggable={!isRenaming}
                    onDragStart={(e) => {
                      e.dataTransfer.effectAllowed = 'move'
                      try { e.dataTransfer.setData('text/plain', `group:${gid}`) } catch {}
                      setTabDrag({
                        draggingId: gid,
                        kind: 'group',
                        overBeforeId: null,
                      })
                    }}
                    onDragEnd={() =>
                      setTabDrag({ draggingId: null, kind: null, overBeforeId: null })
                    }
                    onClick={() => {
                      if (isRenaming) return
                      onToggleGroupCollapsed?.(gid)
                    }}
                    onDoubleClick={(e) => {
                      e.stopPropagation()
                      setRenamingGroup({ id: gid, draft: group?.name ?? '' })
                    }}
                    onContextMenu={(e) => {
                      e.preventDefault()
                      setGroupMenu({ groupId: gid, x: e.clientX, y: e.clientY })
                    }}
                    onDragOver={(e) => {
                      if (!tabDrag.draggingId) return
                      // Dropping the SAME group on its own pill is a no-op —
                      // don't paint a drop indicator or accept the drop.
                      if (tabDrag.kind === 'group' && tabDrag.draggingId === gid) return
                      e.preventDefault()
                      e.dataTransfer.dropEffect = 'move'
                      if (tabDrag.kind === 'group') {
                        // Group-on-pill: show the "insert here" indicator on
                        // the pill itself. The drop translates to "before the
                        // first member of this group".
                        const key = `pill-${gid}`
                        if (tabDrag.overBeforeId !== key) {
                          setTabDrag((s) => ({ ...s, overBeforeId: key }))
                        }
                      }
                    }}
                    onDrop={(e) => {
                      if (!tabDrag.draggingId) return
                      e.preventDefault()
                      e.stopPropagation()
                      if (tabDrag.kind === 'group') {
                        // Ignore self-drops; otherwise reposition the whole
                        // dragged group to sit before this group's first
                        // song, then clear drag state.
                        if (tabDrag.draggingId !== gid && firstMemberId) {
                          onMoveGroup?.(tabDrag.draggingId, firstMemberId)
                        }
                      } else {
                        // Song tab dropped on the pill → join this group.
                        onAssignSongToGroup?.(tabDrag.draggingId, gid)
                      }
                      setTabDrag({ draggingId: null, kind: null, overBeforeId: null })
                    }}
                    title={
                      isRenaming
                        ? ''
                        : `${group?.name ?? 'Group'} · click to ${
                            collapsed ? 'expand' : 'collapse'
                          }, drag to reorder, double-click to rename, right-click for options`
                    }
                  >
                    <span className="song-group-pill-dot" />
                    {isRenaming ? (
                      <input
                        className="song-group-pill-input"
                        value={renamingGroup.draft}
                        autoFocus
                        onClick={(e) => e.stopPropagation()}
                        onChange={(e) =>
                          setRenamingGroup((r) => ({ ...r, draft: e.target.value }))
                        }
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') {
                            e.currentTarget.blur()
                          } else if (e.key === 'Escape') {
                            setRenamingGroup(null)
                          }
                        }}
                        onBlur={() => {
                          const next = (renamingGroup?.draft ?? '').trim()
                          if (next && next !== group?.name) {
                            onRenameGroup?.(gid, next)
                          }
                          setRenamingGroup(null)
                        }}
                      />
                    ) : (
                      <>
                        <span className="song-group-pill-name">
                          {group?.name ?? 'Group'}
                        </span>
                        {collapsed && (
                          <span className="song-group-pill-count">
                            {memberCount}
                          </span>
                        )}
                      </>
                    )}
                  </div>
                )
              }
              // Skip member tabs entirely when their group is collapsed —
              // only the pill (with count badge) represents the group.
              if (group?.collapsed) {
                prevGroupId = gid
                continue
              }
              nodes.push(
                <SongTab
                  key={song.id}
                  song={song}
                  isActive={song.id === activeSongId}
                  canClose={songs.length > 1}
                  onRename={onRenameSong}
                  onRemove={onRemoveSong}
                  onContextMenu={setTabMenu}
                  isDragging={
                    tabDrag.kind === 'tab' && tabDrag.draggingId === song.id
                  }
                  dx={
                    tabDrag.kind === 'tab' && tabDrag.draggingId === song.id
                      ? tabDrag.dx
                      : 0
                  }
                  shift={shiftForIndex(i)}
                  onPointerDownTab={handleTabPointerDown}
                  groupColour={group?.colour ?? null}
                />
              )
              prevGroupId = gid
            }
            // Trailing drop zone so the user can drop a tab at the very end
            // of the list (past every existing tab / group).
            nodes.push(
              <div
                key="__tail"
                className={`song-tab-drop-tail ${
                  tabDrag.draggingId && tabDrag.overBeforeId === '__tail'
                    ? 'active'
                    : ''
                }`}
                onDragOver={(e) => {
                  if (!tabDrag.draggingId) return
                  e.preventDefault()
                  e.dataTransfer.dropEffect = 'move'
                  if (tabDrag.overBeforeId !== '__tail') {
                    setTabDrag((s) => ({ ...s, overBeforeId: '__tail' }))
                  }
                }}
                onDrop={(e) => {
                  if (!tabDrag.draggingId) return
                  e.preventDefault()
                  handleDropBefore(null)
                }}
              />
            )
            return nodes
          })()}
        </div>
        {onAddSong && (
          <button
            type="button"
            className="song-tab-add"
            onClick={onAddSong}
            title="New song"
            aria-label="New song"
          >
            +
          </button>
        )}
        </div>
      </div>
        </>
      )}
      {newMenu && (
        <div
          className="template-new-menu"
          style={{ left: newMenu.x, top: newMenu.y }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          <button
            type="button"
            className="tab-context-menu-item"
            onClick={() => openTemplateEditor(null)}
          >
            <FilePlus size={14} /> New template
          </button>
          <button
            type="button"
            className="tab-context-menu-item"
            onClick={createFolder}
          >
            <FolderPlus size={14} /> New folder
          </button>
        </div>
      )}
      {templateMenu && (() => {
        const node = templates.find((n) => n.id === templateMenu.id)
        const close = () => setTemplateMenu(null)
        // Multi-selection management (shift-selected several rows): bulk copy /
        // export the templates in the selection, or delete everything selected.
        if (
          selectedTemplateIds.has(templateMenu.id) &&
          selectedTemplateIds.size > 1
        ) {
          const sel = templates.filter((t) => selectedTemplateIds.has(t.id))
          // Include the contents of any selected folder, structure preserved.
          const exportSet = withDescendants(sel.map((t) => t.id))
          const tplCount = exportSet.filter((t) => !isFolder(t)).length
          const tplLabel = tplCount
            ? `${tplCount} template${tplCount > 1 ? 's' : ''}`
            : 'selection'
          return (
            <ContextMenu
              x={templateMenu.x}
              y={templateMenu.y}
              onMouseDown={(e) => e.stopPropagation()}
            >
              <div className="tab-context-menu-title">
                {sel.length} selected
              </div>
              {exportSet.length > 0 && (
                <button
                  type="button"
                  className="tab-context-menu-item"
                  onClick={() => {
                    copyTemplates(exportSet)
                    close()
                  }}
                >
                  Copy {tplLabel}
                </button>
              )}
              {exportSet.length > 0 && (
                <button
                  type="button"
                  className="tab-context-menu-item"
                  onClick={() => {
                    // Multi-selection: each template saved as its own file.
                    exportTemplateTree(exportSet)
                    setSelectedTemplateIds(new Set())
                    close()
                  }}
                >
                  Export {tplLabel}
                </button>
              )}
              <div className="tab-context-menu-divider" />
              <button
                type="button"
                className="tab-context-menu-item danger"
                onClick={() => {
                  deleteSelection(sel.map((t) => t.id))
                  close()
                }}
              >
                Delete {sel.length} item{sel.length > 1 ? 's' : ''}
              </button>
            </ContextMenu>
          )
        }
        // Folder menu: rename, copy/export the whole subtree, delete.
        if (isFolder(node)) {
          const sub = withDescendants(node.id)
          const tplCount = sub.filter((t) => !isFolder(t)).length
          return (
            <ContextMenu
              x={templateMenu.x}
              y={templateMenu.y}
              onMouseDown={(e) => e.stopPropagation()}
            >
              <button
                type="button"
                className="tab-context-menu-item"
                onClick={() => {
                  setRenameValue(node.name)
                  setRenamingTemplateId(node.id)
                  close()
                }}
              >
                Rename folder
              </button>
              <button
                type="button"
                className="tab-context-menu-item"
                onClick={() => {
                  copyTemplates(sub)
                  close()
                }}
              >
                Copy folder{tplCount ? ` (${tplCount})` : ''}
              </button>
              <button
                type="button"
                className="tab-context-menu-item"
                onClick={() => {
                  // Folder: a real directory of individual template files,
                  // subfolders preserved as subdirectories. The folder node
                  // itself is dropped — its name already becomes the directory,
                  // so keeping it would nest Chords/Chords/…
                  exportTemplateTree(
                    sub.filter((t) => t.id !== node.id),
                    node.name
                  )
                  close()
                }}
              >
                Export folder{tplCount ? ` (${tplCount})` : ''}
              </button>
              <div className="tab-context-menu-divider" />
              <button
                type="button"
                className="tab-context-menu-item danger"
                onClick={() => {
                  deleteFolder(node.id)
                  close()
                }}
              >
                Delete folder (keep contents)
              </button>
            </ContextMenu>
          )
        }
        const targets = templateTargets(templateMenu.id)
        if (!targets.length) return null
        const many = targets.length > 1
        return (
          <ContextMenu
            x={templateMenu.x}
            y={templateMenu.y}
            onMouseDown={(e) => e.stopPropagation()}
          >
            {!many && (
              <button
                type="button"
                className="tab-context-menu-item"
                onClick={() => openTemplateEditor(targets[0])}
              >
                Edit
              </button>
            )}
            <button
              type="button"
              className="tab-context-menu-item"
              onClick={() => {
                copyTemplates(targets)
                close()
              }}
            >
              Copy{many ? ` (${targets.length})` : ''}
            </button>
            <button
              type="button"
              className="tab-context-menu-item"
              onClick={() => {
                // One template → a single file picker; several → individual
                // files in a chosen directory.
                if (many) exportTemplateTree(targets)
                else downloadTemplates(targets)
                setSelectedTemplateIds(new Set())
                close()
              }}
            >
              Export{many ? ` (${targets.length})` : ''}
            </button>
            {!many && (
              <button
                type="button"
                className="tab-context-menu-item"
                onClick={() => {
                  setRenameValue(targets[0].name)
                  setRenamingTemplateId(targets[0].id)
                  close()
                }}
              >
                Rename
              </button>
            )}
            <div className="tab-context-menu-divider" />
            <button
              type="button"
              className="tab-context-menu-item danger"
              onClick={() => {
                deleteTemplates(new Set(targets.map((t) => t.id)))
                close()
              }}
            >
              Delete{many ? ` (${targets.length})` : ''}
            </button>
          </ContextMenu>
        )
      })()}
      {tabMenu && (() => {
        const song = songs.find((s) => s.id === tabMenu.songId)
        if (!song) return null
        const currentGroup = song.groupId
          ? songGroups.find((g) => g.id === song.groupId)
          : null
        return (
          <div
            className="tab-context-menu"
            style={{ left: tabMenu.x, top: tabMenu.y }}
            onMouseDown={(e) => e.stopPropagation()}
          >
            <div className="tab-context-menu-title">{song.name}</div>
            <button
              type="button"
              className="tab-context-menu-item"
              onClick={() => {
                if (!onAddGroup || !onAssignSongToGroup) {
                  setTabMenu(null)
                  return
                }
                const id = onAddGroup()
                onAssignSongToGroup(song.id, id)
                setTabMenu(null)
              }}
            >
              New group with this tab
            </button>
            {songGroups.length > 0 && (
              <>
                <div className="tab-context-menu-divider" />
                <div className="tab-context-menu-label">Add to group</div>
                {songGroups.map((g) => (
                  <button
                    key={g.id}
                    type="button"
                    className={`tab-context-menu-item ${
                      currentGroup?.id === g.id ? 'checked' : ''
                    }`}
                    onClick={() => {
                      onAssignSongToGroup?.(song.id, g.id)
                      setTabMenu(null)
                    }}
                  >
                    <span
                      className="tab-context-menu-swatch"
                      style={{ background: g.colour }}
                    />
                    {g.name}
                  </button>
                ))}
              </>
            )}
            {currentGroup && (
              <>
                <div className="tab-context-menu-divider" />
                <button
                  type="button"
                  className="tab-context-menu-item"
                  onClick={() => {
                    onAssignSongToGroup?.(song.id, null)
                    setTabMenu(null)
                  }}
                >
                  Remove from group
                </button>
              </>
            )}
          </div>
        )
      })()}
      {groupMenu && (() => {
        const group = songGroups.find((g) => g.id === groupMenu.groupId)
        if (!group) return null
        return (
          <div
            className="tab-context-menu"
            style={{ left: groupMenu.x, top: groupMenu.y }}
            onMouseDown={(e) => e.stopPropagation()}
          >
            <div className="tab-context-menu-title">{group.name}</div>
            <button
              type="button"
              className="tab-context-menu-item"
              onClick={() => {
                setRenamingGroup({ id: group.id, draft: group.name })
                setGroupMenu(null)
              }}
            >
              Rename group
            </button>
            <button
              type="button"
              className="tab-context-menu-item"
              onClick={() => {
                onToggleGroupCollapsed?.(group.id)
                setGroupMenu(null)
              }}
            >
              {group.collapsed ? 'Expand group' : 'Collapse group'}
            </button>
            <div className="tab-context-menu-divider" />
            <label className="tab-context-menu-colour-picker">
              <span className="tab-context-menu-label">Colour</span>
              <span
                className="tab-context-menu-colour-swatch"
                style={{ background: group.colour }}
              />
              <span className="tab-context-menu-colour-hex">
                {group.colour}
              </span>
              <input
                type="color"
                value={group.colour}
                onChange={(e) => onSetGroupColour?.(group.id, e.target.value)}
                onMouseDown={(e) => e.stopPropagation()}
                aria-label="Pick group colour"
              />
            </label>
            <div className="tab-context-menu-divider" />
            <button
              type="button"
              className="tab-context-menu-item danger"
              onClick={() => {
                onRemoveGroup?.(group.id)
                setGroupMenu(null)
              }}
            >
              Delete group (keep songs)
            </button>
          </div>
        )
      })()}

      <div className="roll-body" ref={rollBodyRef}>
        <aside
          className={`variation-panel resizable ${
            dragState?.key === 'templates' ? 'reordering' : ''
          } ${panelCollapsed.templates ? 'collapsed' : ''} ${
            // The Tags modal veils the app but deliberately spares this panel,
            // so the template list stays sharp and usable while you filter.
            tagsModalOpen ? 'above-veil' : ''
          }`}
          data-panel="templates"
          style={panelStyle('templates')}
        >
          <button
            type="button"
            className="panel-collapsed-view"
            onClick={() => toggleCollapse('templates')}
            title="Expand panel"
            aria-label="Expand panel"
          >
            <ChevronLeft size={15} />
            <span className="panel-collapsed-name">
              {fretboardView === 'vertical' ? 'Fretboard' : 'Templates'}
            </span>
          </button>
          <button
            type="button"
            className="panel-collapse-btn"
            onClick={() => toggleCollapse('templates')}
            title="Collapse panel"
            aria-label="Collapse panel"
          >
            <ChevronLeft size={15} />
          </button>
          <button
            type="button"
            className="panel-anchor"
            onPointerDown={startReorder('templates')}
            title="Drag to reorder this panel"
            aria-label="Reorder panel"
          >
            <AnchorGripIcon />
          </button>
          <div
            className="panel-resize-y top"
            onPointerDown={startHeightResize('templates', 'top')}
            onDoubleClick={() => setPanelHeight('templates', null)}
            title="Drag to resize height · double-click to reset"
          />
          <div className="templates-header">
            <div className="panel-view-toggle">
              <button
                type="button"
                className={fretboardView !== 'vertical' ? 'on' : ''}
                onClick={() => setFretboardView('off')}
              >
                Templates
              </button>
              <button
                type="button"
                className={fretboardView === 'vertical' ? 'on' : ''}
                onClick={() => setFretboardView('vertical')}
                title="Show the fretboard here"
              >
                Fretboard
              </button>
            </div>
            {fretboardView !== 'off' && (
              <button
                type="button"
                className="panel-swap-btn"
                onClick={() =>
                  setFretboardView(
                    fretboardView === 'vertical' ? 'horizontal' : 'vertical'
                  )
                }
                title={
                  fretboardView === 'vertical'
                    ? 'Switch to a horizontal neck over the roll'
                    : 'Switch to a vertical neck in the sidebar'
                }
                aria-label="Toggle fretboard orientation"
              >
                <FretDiagramIcon orientation={fretboardView} />
              </button>
            )}
          </div>
          {fretboardView !== 'vertical' && (
            // Action icons live on their own scrollable row so more can be
            // added over time without crowding the Templates/Fretboard toggle.
            <div className="templates-toolbar">
              {exportFeedback && (
                <span className="templates-feedback">{exportFeedback}</span>
              )}
              <button
                type="button"
                className={`template-icon-btn ${newMenu ? 'on' : ''}`}
                onMouseDown={(e) => e.stopPropagation()}
                onClick={(e) => {
                  const r = e.currentTarget.getBoundingClientRect()
                  setNewMenu((m) => (m ? null : { x: r.left, y: r.bottom + 4 }))
                }}
                title="New template or folder"
                aria-haspopup="true"
                aria-expanded={!!newMenu}
              >
                <Plus size={15} strokeWidth={1.8} />
              </button>
              <button
                type="button"
                className="template-icon-btn"
                onClick={pasteTemplates}
                title="Paste a template from the clipboard"
              >
                <ClipboardPaste size={14} strokeWidth={1.8} />
              </button>
              <button
                type="button"
                className="template-icon-btn"
                onClick={() => templateFileInputRef.current?.click()}
                title="Import template(s) from a file"
              >
                <Upload size={14} strokeWidth={1.8} />
              </button>
              <button
                ref={searchBtnRef}
                type="button"
                className={`template-icon-btn ${searchOpen ? 'on' : ''}`}
                onClick={() => {
                  setPendingTemplate(null)
                  searchOpen ? closeSearch() : setSearchOpen(true)
                }}
                title="Search templates"
                aria-expanded={searchOpen}
              >
                <Search size={14} strokeWidth={1.8} />
              </button>
              <button
                type="button"
                className={`template-icon-btn ${tagsModalOpen ? 'on' : ''}`}
                onClick={() => {
                  setPendingTemplate(null)
                  setTagsModalOpen(true)
                }}
                title="Manage tags"
              >
                <Tags size={14} strokeWidth={1.8} />
              </button>
              <input
                ref={templateFileInputRef}
                type="file"
                accept="application/json,.json"
                multiple
                style={{ display: 'none' }}
                onChange={(e) => {
                  importTemplateFiles([...e.target.files])
                  e.target.value = ''
                }}
              />
            </div>
          )}
          {fretboardView !== 'vertical' && searchOpen && (
            <div className="templates-search" ref={searchWrapRef}>
              <Search size={13} className="templates-search-icon" />
              <input
                className="templates-search-input"
                placeholder="Search templates…"
                value={templateSearch}
                autoFocus
                onChange={(e) => setTemplateSearch(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') closeSearch()
                }}
              />
              {templateSearch && (
                <button
                  type="button"
                  className="templates-search-clear"
                  onClick={() => setTemplateSearch('')}
                  title="Clear"
                  aria-label="Clear search"
                >
                  <X size={12} />
                </button>
              )}
            </div>
          )}
          {tagFilterActive && (
            <div className="templates-filter-banner">
              <span className="templates-filter-tags">
                {appliedTagFilter.include.length > 0 && (
                  <>with {appliedTagFilter.include.join(', ')}</>
                )}
                {appliedTagFilter.include.length > 0 &&
                  appliedTagFilter.exclude.length > 0 &&
                  ' · '}
                {appliedTagFilter.exclude.length > 0 && (
                  <>without {appliedTagFilter.exclude.join(', ')}</>
                )}
              </span>
              <button
                type="button"
                className="templates-filter-clear"
                onClick={() => setAppliedTagFilter(EMPTY_TAG_FILTER)}
                title="Clear tag filter"
                aria-label="Clear tag filter"
              >
                <X size={12} />
              </button>
            </div>
          )}
          {fretboardView === 'vertical' ? (
            <Fretboard
              orientation="vertical"
              notePitches={fretboardPitches}
                  position={fretPosition}
                  priming={fretPosPriming}
              useFlats={useFlats}
              chordClassFor={chordClassFor}
            />
          ) : templates.length === 0 ? (
            <div className="hint">
              Use + to create a template or a folder.
            </div>
          ) : (
            <TemplateTree
              templates={templates}
              searchQuery={templateSearch}
              tagFilter={appliedTagFilter}
              onReveal={revealTemplate}
              flashId={flashTemplateId}
              onMove={moveNode}
              onMoveMany={moveNodes}
              selectedTemplateIds={selectedTemplateIds}
              onToggleSelect={(id) => {
                // Starting a multi-select drops any "regular selection" — the
                // template armed for placement — so the two don't coexist.
                setPendingTemplate(null)
                setSelectedTemplateIds((prev) => {
                  const next = new Set(prev)
                  next.has(id) ? next.delete(id) : next.add(id)
                  return next
                })
              }}
              renamingTemplateId={renamingTemplateId}
              renameValue={renameValue}
              setRenameValue={setRenameValue}
              commitRename={(id) => {
                renameTemplate(id, renameValue)
                setRenamingTemplateId(null)
              }}
              cancelRename={() => setRenamingTemplateId(null)}
              pendingTemplate={pendingTemplate}
              onPlace={handleTemplateClick}
              onToggleFolder={toggleFolder}
              onContextMenu={(e, id) => {
                // Right-clicking to open the menu also drops the placement arm.
                setPendingTemplate(null)
                setTemplateMenu({ x: e.clientX, y: e.clientY, id })
              }}
            />
          )}
        </aside>
        <div
          className="panel-resize-x"
          style={{ order: 1 }}
          onPointerDown={startColResize(0)}
          onDoubleClick={() => resetColWidth(0)}
          title="Drag to resize width · double-click to reset"
        />
        <div
          className={`roll-stage resizable ${
            dragState?.key === 'roll' ? 'reordering' : ''
          } ${fretboardView === 'horizontal' ? 'showing-fretboard' : ''}`}
          data-panel="roll"
          style={panelStyle('roll')}
        >
          <button
            type="button"
            className="panel-anchor"
            onPointerDown={startReorder('roll')}
            title="Drag to reorder this panel"
            aria-label="Reorder panel"
          >
            <AnchorGripIcon />
          </button>
          <div className="stage-view-bar">
            <div className="panel-view-toggle">
              <button
                type="button"
                className={fretboardView === 'horizontal' ? '' : 'on'}
                onClick={() =>
                  setFretboardView((v) => (v === 'horizontal' ? 'off' : v))
                }
              >
                Piano roll
              </button>
            </div>
          </div>
          {fretboardView === 'horizontal' && (
            <div className="fretboard-stage">
              <div className="fretboard-stage-body">
                <Fretboard
                  orientation="horizontal"
                  notePitches={fretboardPitches}
                  position={fretPosition}
                  priming={fretPosPriming}
                  useFlats={useFlats}
                  chordClassFor={chordClassFor}
                />
              </div>
            </div>
          )}
          <div
            className="roll-scroll"
            ref={scrollRef}
            onScroll={(e) => {
              // Ableton-style: reaching the right edge reveals more bars. Grow
              // one measure at a time — but ONLY when the user actively scrolls
              // rightward into the edge on an already-overflowing timeline.
              // Just seeing the end (e.g. after zooming out) must not add beats,
              // so the full timeline stays visible.
              const sc = e.currentTarget
              const scrolledRight = sc.scrollLeft > lastScrollLeftRef.current + 0.5
              const overflows = sc.scrollWidth - sc.clientWidth > 1
              const atRightEdge =
                sc.scrollLeft + sc.clientWidth >= sc.scrollWidth - BEAT_WIDTH * 4
              lastScrollLeftRef.current = sc.scrollLeft
              // Dragging the scrollbar itself must never grow the timeline.
              if (
                !hbarInteractingRef.current &&
                scrolledRight &&
                overflows &&
                atRightEdge
              ) {
                setTotalBeats((prev) => Math.min(MAX_BEATS, prev + cellsPerMeasure))
              }
              updateHBar()
            }}
          >
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
                      left: `${beatToX(loop.start)}px`,
                      width: `${beatToX(loop.end) - beatToX(loop.start)}px`,
                    }}
                  />
                )}
                {(() => {
                  // Iterate by beat INDEX (not integer cells) so odd / non-
                  // dyadic denominators — where a beat spans a fractional
                  // number of cells — still place ticks correctly. A labelled
                  // measure tick lands on every `num`-th beat (the downbeat).
                  const ticks = []
                  const beatCount = Math.ceil(totalBeats / cellsPerBeat)
                  for (let k = 0; k < beatCount; k++) {
                    const cell = k * cellsPerBeat
                    if (cell >= totalBeats) break
                    const isMeasure = k % timeSig.num === 0
                    ticks.push(
                      <div
                        key={k}
                        className={`timeline-tick ${
                          isMeasure ? 'measure' : 'beat'
                        }`}
                        style={{ left: `${cell * BEAT_WIDTH}px` }}
                      >
                        {isMeasure ? Math.floor(k / timeSig.num) + 1 : ''}
                      </div>
                    )
                  }
                  return ticks
                })()}
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
              <div
                className="grid-area"
                ref={gridAreaRef}
                onMouseLeave={() => {
                  setHoveredCell(null)
                  if (pendingTemplate) setTemplateHover(null)
                }}
              >
                {/* Swung-display gridlines: the per-row CSS lines are hidden
                    (.beats-track.swung) and replaced by these warped verticals,
                    so the offbeat columns shift and notes sit on the grid. */}
                {swingViewActive && (
                  <div className="grid-swing-lines" aria-hidden="true">
                    {(() => {
                      const sub = rhythmBaseCells > 0 ? rhythmBaseCells : 1
                      const lines = []
                      for (let k = 1; k * sub < totalBeats; k++) {
                        const cell = k * sub
                        const isBeat =
                          Math.abs(cell % cellsPerBeat) < 1e-6 ||
                          Math.abs((cell % cellsPerBeat) - cellsPerBeat) < 1e-6
                        lines.push(
                          <div
                            key={k}
                            className={`grid-swing-line ${isBeat ? 'beat' : ''}`}
                            style={{ left: `${beatToX(cell)}px` }}
                          />
                        )
                      }
                      return lines
                    })()}
                  </div>
                )}
                {loop && (
                  <div
                    className="grid-loop"
                    style={{
                      left: `${beatToX(loop.start)}px`,
                      width: `${beatToX(loop.end) - beatToX(loop.start)}px`,
                    }}
                  />
                )}
                {hoveredCell && !marquee && (
                  <div
                    className="grid-hover-cell"
                    style={{
                      left: `${beatToX(hoveredCell.beat)}px`,
                      top: `${
                        (MIDI_HIGH - hoveredCell.midi) * ROW_HEIGHT
                      }px`,
                      // Mirror the length a click would produce:
                      // defaultNoteLengthRef, the last length the user inputted
                      // (from picking a rhythm OR resizing). Deliberately
                      // DETACHED from the rhythm selector, which resizing never
                      // rewrites. (Hidden entirely while over a placed note.)
                      width: `${spanToX(
                        hoveredCell.beat,
                        defaultNoteLen ?? 1
                      )}px`,
                      height: `${ROW_HEIGHT}px`,
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
                      transform: `translateX(${beatToX(playheadBeat)}px)`,
                    }}
                  />
                )}
                {renderedRegions.map(({ region, notes, lo: bottomMidi, hi: topMidi, bounds }) => {
                  if (!Number.isFinite(bottomMidi)) return null
                  const selected = region.id === selectedRegionId
                  return (
                    <div key={region.id} className="region-group">
                      {notes.map((m, i) => (
                        <div
                          key={`rn-${i}`}
                          className="region-note"
                          style={{
                            left: `${beatToX(m.beat)}px`,
                            top: `${(MIDI_HIGH - m.midi) * ROW_HEIGHT}px`,
                            width: `${spanToX(m.beat, m.len)}px`,
                            height: `${ROW_HEIGHT}px`,
                          }}
                        />
                      ))}
                      <div
                        className={`midi-region ${selected ? 'selected' : ''}`}
                        onPointerDown={(e) => handleRegionBodyDown(e, region)}
                        title="Drag to climb the pattern through the scale · click to select · Delete to bake"
                        style={{
                          left: `${beatToX(bounds.left)}px`,
                          top: `${(MIDI_HIGH - topMidi) * ROW_HEIGHT}px`,
                          width: `${beatToX(bounds.right) - beatToX(bounds.left)}px`,
                          height: `${(topMidi - bottomMidi + 1) * ROW_HEIGHT}px`,
                        }}
                      >
                        <div
                          className="region-label"
                          onPointerDown={(e) => handleRegionLabelDown(e, region)}
                          title="Drag to move along the timeline"
                        >
                          Rune {region.label}
                        </div>
                        <div
                          className="region-resize left"
                          onPointerDown={(e) => handleRegionEdgeDown(e, region, 'left')}
                          title="Drag to add/remove notes at the start"
                        />
                        <div
                          className="region-resize right"
                          onPointerDown={(e) => handleRegionEdgeDown(e, region, 'right')}
                          title="Drag to add/remove notes at the end"
                        />
                      </div>
                    </div>
                  )
                })}
                {pitches.map((midi) => {
                  const pc = midi % 12
                  const isWhite = WHITE_PCS.has(pc)
                  const isOctave = pc === 0
                  const isIn = inScale(pc)
                  const isRoot = pc === root
                  const rowNotes = notesByMidi.get(midi) ?? []
                  const rowPreview = templatePreview
                    ? templatePreview.get(midi) ?? []
                    : []
                  return (
                    <div
                      key={midi}
                      className={`grid-row ${isWhite ? 'white' : 'black'} ${
                        isOctave ? 'octave' : ''
                      } ${isIn ? 'in' : ''} ${isRoot ? 'is-root' : ''} ${chordClassFor(pc)}`}
                      style={{ height: ROW_HEIGHT }}
                    >
                      <div
                        className={`beats-track ${freeMode ? 'free' : ''} ${
                          swingViewActive ? 'swung' : ''
                        }`}
                        style={{
                          width: totalBeats * BEAT_WIDTH,
                          // Grid lines scale with the horizontal zoom and the
                          // time signature: a light line per SUBDIVISION (the
                          // current rhythm's base division, in cells) and a
                          // heavier one per beat, so the grid matches the chosen
                          // subdiv and stays aligned with the notes + ticks.
                          backgroundSize: `${
                            BEAT_WIDTH * rhythmBaseCells
                          }px 100%, ${BEAT_WIDTH * cellsPerBeat}px 100%`,
                        }}
                        onPointerDown={(e) => handleRowMouseDown(e, midi)}
                        onMouseMove={(e) => {
                          // Compute the beat under the cursor once and feed
                          // it into both the general hover indicator and the
                          // template preview anchor (when a template is
                          // queued). Snaps to whole beats unless free mode.
                          const rect = e.currentTarget.getBoundingClientRect()
                          const rawBeat = xToBeat(e.clientX - rect.left)
                          // Snap to the rhythm division grid so the hover
                          // box lands exactly where a click would place the
                          // note (tuplets included).
                          const beat = snapPlacementBeat(rawBeat)
                          // Ctrl held inverts the current snap mode for
                          // the hover indicator too, so its position always
                          // matches where a click will actually land.
                          const effectiveAllowOOS = allowOutOfScale
                            ? !(e.ctrlKey || e.metaKey)
                            : e.ctrlKey || e.metaKey
                          // On an out-of-scale row with scale-snap on, a click
                          // won't place a note here — so show no hover border
                          // at all (instead of snapping the box to a different
                          // in-scale row, which looked broken).
                          if (!effectiveAllowOOS && !inScale(midi % 12)) {
                            setHoveredCell(null)
                            if (pendingTemplate) setTemplateHover({ beat, midi })
                            return
                          }
                          const hoverMidi = midi
                          // If the cursor is over an existing note on THIS row,
                          // hide the hover box entirely — no border over placed
                          // notes. It returns as soon as the cursor moves back
                          // over empty space. (No overlaps allowed, so a click
                          // there wouldn't place a note anyway.)
                          for (const [k, len] of notesRef.current) {
                            const sep = k.indexOf('-')
                            if (Number(k.slice(sep + 1)) !== midi) continue
                            const b = Number(k.slice(0, sep))
                            if (rawBeat >= b && rawBeat < b + len) {
                              setHoveredCell(null)
                              if (pendingTemplate) setTemplateHover({ beat, midi })
                              return
                            }
                          }
                          const cellBeat = avoidLeftOverlap(beat, hoverMidi)
                          const cellMidi = hoverMidi
                          setHoveredCell((cur) =>
                            cur &&
                            cur.beat === cellBeat &&
                            cur.midi === cellMidi
                              ? cur
                              : { beat: cellBeat, midi: cellMidi }
                          )
                          if (pendingTemplate) {
                            setTemplateHover((cur) =>
                              cur && cur.beat === beat && cur.midi === midi
                                ? cur
                                : { beat, midi }
                            )
                          }
                        }}
                      >
                        {rowPreview.map((p, idx) => (
                          <div
                            key={`preview-${idx}`}
                            className={`row-note preview ${chordClassFor(midi % 12)}`}
                            style={{
                              left: `${beatToX(p.beat)}px`,
                              width: `${spanToX(p.beat, p.length)}px`,
                            }}
                          />
                        ))}
                        {rowNotes.map(({ key, beat, length }) => (
                          <div
                            key={key}
                            className={`row-note ${
                              selectedKeys.has(key) ? 'selected' : ''
                            } ${chordClassFor(midi % 12)}`}
                            style={{
                              left: `${beatToX(beat)}px`,
                              width: `${spanToX(beat, length)}px`,
                            }}
                            onPointerDown={(e) =>
                              handleNoteMouseDown(e, key, beat, midi, length)
                            }
                            onMouseEnter={(e) =>
                              setNotePitchTip({
                                label: midiPitchLabel(midi),
                                x: e.clientX,
                                y: e.clientY,
                                key,
                              })
                            }
                            onMouseMove={(e) =>
                              setNotePitchTip({
                                label: midiPitchLabel(midi),
                                x: e.clientX,
                                y: e.clientY,
                                key,
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
          {/* Custom horizontal scrollbar with end grips: drag the middle to
              scroll, drag either end to zoom (anchoring the opposite edge). */}
          <div className="roll-hscroll" ref={hbarTrackRef}>
            <div
              className="roll-hscroll-thumb"
              style={{
                left: `${hbar.pos * 100}%`,
                width: `${hbar.size * 100}%`,
              }}
              onPointerDown={handleHbarThumbDown}
            >
              <div
                className="roll-hscroll-grip left"
                onPointerDown={handleHbarGripDown('left')}
                title="Drag to zoom"
              />
              <div
                className="roll-hscroll-grip right"
                onPointerDown={handleHbarGripDown('right')}
                title="Drag to zoom"
              />
            </div>
          </div>
        </div>
        <div
          className="panel-resize-x"
          style={{ order: 3 }}
          onPointerDown={startColResize(1)}
          onDoubleClick={() => resetColWidth(1)}
          title="Drag to resize width · double-click to reset"
        />

        {/* Right-side track sidebar: vertical tabs sticking out the left
            edge (like folder tabs), with the active one merging into the
            sidebar's control panel on its right. */}
        <aside
          className={`track-sidebar resizable ${
            dragState?.key === 'synth' ? 'reordering' : ''
          } ${panelCollapsed.synth ? 'collapsed' : ''}`}
          data-panel="synth"
          style={panelStyle('synth')}
        >
          <button
            type="button"
            className="panel-collapsed-view"
            onClick={() => toggleCollapse('synth')}
            title="Expand panel"
            aria-label="Expand panel"
          >
            <ChevronLeft size={15} />
            <span className="panel-collapsed-name">Synth</span>
          </button>
          <button
            type="button"
            className="panel-collapse-btn synth"
            onClick={() => toggleCollapse('synth')}
            title="Collapse panel"
            aria-label="Collapse panel"
          >
            <ChevronRight size={15} />
          </button>
          <button
            type="button"
            className="panel-anchor"
            onPointerDown={startReorder('synth')}
            title="Drag to reorder this panel"
            aria-label="Reorder panel"
          >
            <AnchorGripIcon />
          </button>
          <div className="track-rail" role="tablist" aria-label="tracks">
            {tracks.map((t) => {
              const isActive = activeTrack && t.id === activeTrack.id
              return (
                <button
                  type="button"
                  key={t.id}
                  role="tab"
                  aria-selected={isActive}
                  className={`track-rail-tab ${isActive ? 'active' : ''} ${
                    t.muted ? 'is-muted' : ''
                  } ${t.soloed ? 'is-soloed' : ''}`}
                  onClick={() => {
                    if (!isActive) {
                      setActiveTrackId(t.id)
                      setSelectedKeys(new Set())
                    }
                  }}
                  title={`${t.name} · ${t.notes.size} note${
                    t.notes.size === 1 ? '' : 's'
                  }`}
                >
                  <span className="track-rail-name">{t.name}</span>
                </button>
              )
            })}
            <button
              type="button"
              className="track-rail-add"
              onClick={addTrack}
              title="Add a new track"
              aria-label="Add track"
            >
              +
            </button>
          </div>

          {activeTrack && (
            <div className="track-controls">
              <input
                type="text"
                className="track-controls-name"
                value={activeTrack.name}
                onChange={(e) =>
                  updateTrack(activeTrack.id, { name: e.target.value })
                }
                aria-label="Track name"
              />
              <div className="track-controls-buttons">
                <button
                  type="button"
                  className={`track-btn track-mute ${
                    activeTrack.muted ? 'on' : ''
                  }`}
                  onClick={() =>
                    updateTrack(activeTrack.id, { muted: !activeTrack.muted })
                  }
                  title={activeTrack.muted ? 'Un-mute' : 'Mute'}
                  aria-pressed={activeTrack.muted}
                >
                  M
                </button>
                <button
                  type="button"
                  className={`track-btn track-solo ${
                    activeTrack.soloed ? 'on' : ''
                  }`}
                  onClick={() =>
                    updateTrack(activeTrack.id, {
                      soloed: !activeTrack.soloed,
                    })
                  }
                  title={activeTrack.soloed ? 'Un-solo' : 'Solo'}
                  aria-pressed={activeTrack.soloed}
                >
                  S
                </button>
                {tracks.length > 1 && (
                  <button
                    type="button"
                    className="track-btn track-delete"
                    onClick={() => removeTrack(activeTrack.id)}
                    title="Delete this track"
                    aria-label="Delete this track"
                  >
                    ×
                  </button>
                )}
              </div>
              <div className="track-controls-volume">
                <span className="track-controls-label">Volume</span>
                <input
                  type="range"
                  min="0"
                  max="1"
                  step="0.01"
                  value={activeTrack.volume}
                  onChange={(e) =>
                    updateTrack(activeTrack.id, {
                      volume: Number(e.target.value),
                    })
                  }
                  className="track-volume"
                  aria-label="Track volume"
                  title={`Volume ${Math.round(activeTrack.volume * 100)}%`}
                />
                <span className="track-controls-value">
                  {Math.round(activeTrack.volume * 100)}
                </span>
              </div>
              <div className="track-controls-synth">
                <span className="track-controls-label">Synth</span>
                <div className="synth-picker" role="radiogroup" aria-label="Synth type">
                  {SYNTH_TYPES.map((s) => {
                    const checked = (activeTrack.synth || 'triangle') === s.id
                    return (
                      <button
                        type="button"
                        key={s.id}
                        role="radio"
                        aria-checked={checked}
                        className={`synth-picker-option ${checked ? 'on' : ''}`}
                        onClick={() =>
                          updateTrack(activeTrack.id, { synth: s.id })
                        }
                        title={`${s.label} oscillator`}
                      >
                        {s.label}
                      </button>
                    )
                  })}
                </div>
              </div>

              {[
                {
                  key: 'attackMs',
                  label: 'Attack',
                  min: 0.5,
                  max: 80,
                  step: 0.5,
                  value: activeTrack.attackMs ?? 15,
                  formatter: (v) => `${v.toFixed(1)} ms`,
                },
                {
                  key: 'releaseMs',
                  label: 'Release',
                  min: 5,
                  max: 800,
                  step: 5,
                  value: activeTrack.releaseMs ?? 220,
                  formatter: (v) => `${Math.round(v)} ms`,
                },
                {
                  key: 'detuneCents',
                  label: 'Detune',
                  min: -100,
                  max: 100,
                  step: 1,
                  value: activeTrack.detuneCents ?? 0,
                  formatter: (v) => `${v > 0 ? '+' : ''}${Math.round(v)}¢`,
                },
              ].map((param) => (
                <div key={param.key} className="track-controls-param">
                  <span className="track-controls-label">{param.label}</span>
                  <input
                    type="range"
                    min={param.min}
                    max={param.max}
                    step={param.step}
                    value={param.value}
                    onChange={(e) =>
                      updateTrack(activeTrack.id, {
                        [param.key]: Number(e.target.value),
                      })
                    }
                    className="track-volume"
                    aria-label={`Track ${param.label.toLowerCase()}`}
                    title={`${param.label}: ${param.formatter(param.value)}`}
                  />
                  <span className="track-controls-value">
                    {param.formatter(param.value)}
                  </span>
                </div>
              ))}
            </div>
          )}
          <div
            className="panel-resize-y top"
            onPointerDown={startHeightResize('synth', 'top')}
            onDoubleClick={() => setPanelHeight('synth', null)}
            title="Drag to resize height · double-click to reset"
          />
        </aside>
      </div>

      {paramsOpen && (
        <div
          className="modal-backdrop"
          onClick={() => setParamsOpen(false)}
          onPointerDown={(e) => e.stopPropagation()}
        >
          <div
            className="modal roll-params-modal"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="settings-modal-header">
              <h3>Roll settings</h3>
              <button
                type="button"
                className="finder-modal-close"
                onClick={() => setParamsOpen(false)}
                aria-label="close roll settings"
              >
                ×
              </button>
            </div>

            <div className="roll-params-grid">
              {/* Timing */}
              <section className="roll-params-section">
                <div className="roll-params-section-title">Timing</div>
                <div className="roll-params-fields">
                  <NumberField
                    label="BPM"
                    value={bpm}
                    min={MIN_BPM}
                    max={MAX_BPM}
                    sensitivity={0.5}
                    onCommit={setBpm}
                  />
                  <NumberField
                    label="Swing"
                    value={Math.round(ratioToAmount(swingPct / 100) * 100)}
                    min={-100}
                    max={100}
                    sensitivity={0.5}
                    onCommit={(amt) => setSwingPct(amountToRatio(amt / 100) * 100)}
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
                  <div
                    className="time-sig"
                    title="Time signature — type beats per measure / beat value"
                  >
                    <span className="time-sig-label">Time</span>
                    <div className="time-sig-fields">
                      <TimeSigInput
                        value={timeSig.num}
                        min={1}
                        max={32}
                        ariaLabel="beats per measure"
                        onCommit={(n) =>
                          setTimeSig((t) => ({ ...t, num: n }))
                        }
                      />
                      <span className="time-sig-slash">/</span>
                      <TimeSigInput
                        value={timeSig.den}
                        min={1}
                        max={32}
                        ariaLabel="beat note value"
                        onCommit={(d) =>
                          setTimeSig((t) => ({ ...t, den: d }))
                        }
                      />
                    </div>
                  </div>
                </div>
              </section>

              {/* Grid & input */}
              <section className="roll-params-section">
                <div className="roll-params-section-title">Grid & input</div>
                <div className="settings-row">
                  <div className="settings-row-text">
                    <div className="settings-row-label">Snap to grid</div>
                    <div className="settings-row-sub">
                      Notes snap to the rhythm grid. Off = free placement.
                    </div>
                  </div>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={!freeMode}
                    className={`settings-switch ${!freeMode ? 'on' : ''}`}
                    onClick={() => setFreeMode((v) => !v)}
                  >
                    <span className="settings-switch-knob" />
                  </button>
                </div>
                <div className="settings-row">
                  <div className="settings-row-text">
                    <div className="settings-row-label">Swung grid display</div>
                    <div className="settings-row-sub">
                      Draw notes and gridlines at their swung positions so notes
                      sit on the grid and you see where they fire. Off = notes on
                      the straight grid, swing heard only in playback.
                    </div>
                  </div>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={swungDisplay}
                    className={`settings-switch ${swungDisplay ? 'on' : ''}`}
                    onClick={() => setSwungDisplay((v) => !v)}
                  >
                    <span className="settings-switch-knob" />
                  </button>
                </div>
                <div className="roll-params-rhythm">
                  <div className="settings-row-label">Rhythm</div>
                  <div className="roll-params-rhythm-readout">
                    <button
                      type="button"
                      className="rhythm-unit-box"
                      onClick={() =>
                        setRhythmUnit((u) => (u === 'beat' ? 'bar' : 'beat'))
                      }
                      title="Toggle whether the division refers to a beat or a bar"
                    >
                      {rhythmUnit === 'bar' ? 'BAR' : 'BEAT'}
                    </button>
                    <span className="roll-params-rhythm-value">
                      ÷{rhythmDenominator} {rhythmNoteName}
                      {rhythmMult > 1 ? ` ×${rhythmMult}` : ''}
                    </span>
                    <NoteGlyph value={rhythmGlyphValue} size={18} />
                  </div>
                  <div className="settings-row-sub">
                    Type a number to divide the unit; X then a number for a
                    multiplier.
                  </div>
                </div>
              </section>

              {/* Playback */}
              <section className="roll-params-section">
                <div className="roll-params-section-title">Playback</div>
                <div className="settings-row">
                  <div className="settings-row-text">
                    <div className="settings-row-label">Metronome</div>
                    <div className="settings-row-sub">
                      Click on each beat, accenting the downbeat.
                    </div>
                  </div>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={metronome}
                    className={`settings-switch ${metronome ? 'on' : ''}`}
                    onClick={() => setMetronome((v) => !v)}
                  >
                    <span className="settings-switch-knob" />
                  </button>
                </div>
                <div className="settings-row">
                  <div className="settings-row-text">
                    <div className="settings-row-label">Loop</div>
                    <div className="settings-row-sub">
                      Drag on the timeline to set a region.
                    </div>
                  </div>
                  <button
                    type="button"
                    className="settings-action"
                    disabled={!loop && !lastLoopRef.current}
                    onClick={() => {
                      if (loop) {
                        setLoop(null)
                        if (playStateRef.current?.mode === 'loop')
                          stopPlayback(false)
                      } else if (lastLoopRef.current) {
                        setLoop(lastLoopRef.current)
                      }
                    }}
                  >
                    {loop ? 'Clear' : 'Restore'}
                  </button>
                </div>
              </section>

              {/* Tools */}
              <section className="roll-params-section">
                <div className="roll-params-section-title">Tools</div>
                <div className="roll-params-actions">
                  <button
                    type="button"
                    className="settings-action"
                    onClick={() => {
                      setParamsOpen(false)
                      setChordModalOpen(true)
                    }}
                  >
                    Chords palette
                  </button>
                </div>
              </section>
            </div>
          </div>
        </div>
      )}

      {templateEditorOpen &&
        (() => {
          const editing = editingTemplateId
            ? templates.find((t) => t.id === editingTemplateId)
            : null
          return (
            <TemplateEditorModal
              scale={scale}
              root={root}
              bpm={bpm}
              NOTE_DISPLAY={NOTE_DISPLAY}
              inScale={inScale}
              chordClassFor={chordClassFor}
              onAudition={(midi) => auditionNote(midi)}
              getAudioContext={getAudioContext}
              playNote={(midi, startAt, durSec) => {
                const t =
                  tracksRef.current.find((tk) => tk.id === activeTrackId) ??
                  tracksRef.current[0]
                playOneNote(midi, startAt, durSec, 0.22, t?.synth ?? 'triangle', {
                  attackMs: t?.attackMs,
                  releaseMs: t?.releaseMs,
                  detuneCents: t?.detuneCents,
                })
              }}
              stopAudio={killScheduledVoices}
              findDuplicate={(items) =>
                findDuplicateTemplate(items, editingTemplateId)
              }
              rhythm={{
                length: rhythmLength,
                subdivision: rhythmBaseCells,
                unit: rhythmUnit,
                denominator: rhythmDenominator,
                mult: rhythmMult,
                awaiting: rhythmAwaitingMultiplier,
                noteName: rhythmNoteName,
                glyphValue: rhythmGlyphValue,
                tuplet: rhythmTuplet,
                NoteGlyph,
                toggleUnit: () =>
                  setRhythmUnit((u) => (u === 'beat' ? 'bar' : 'beat')),
                feedDigit: feedRhythmDigit,
                primeMultiplier: () => {
                  setRhythmAwaitingMultiplier(true)
                  rhythmPendingKindRef.current = 'mult'
                  rhythmBufRef.current = { kind: null, str: '', t: 0 }
                },
              }}
              onSave={saveNewTemplate}
              onClose={() => {
                setTemplateEditorOpen(false)
                setEditingTemplateId(null)
              }}
              initialName={editing ? editing.name : ''}
              initialNotes={editing ? editing.notes : null}
              initialTags={editing ? editing.tags || [] : []}
              getPasteNotes={() => clipboardRef.current}
            />
          )
        })()}
      {tagsModalOpen && (
        <TagsModal
          allTags={allTags}
          tagFilter={tagFilter}
          setTagFilter={setTagFilter}
          onApply={() => setAppliedTagFilter(tagFilter)}
          onClearFilter={() => setAppliedTagFilter(EMPTY_TAG_FILTER)}
          filtering={tagFilterActive}
          onNewTag={(name) => registerTags([name])}
          onDeleteTag={deleteTagEverywhere}
          onRenameTag={renameTagEverywhere}
          onClose={() => setTagsModalOpen(false)}
        />
      )}

      {importConflicts && (
        <ImportConflictsModal
          items={importConflicts}
          onConfirm={resolveImport}
          onCancel={() => setImportConflicts(null)}
        />
      )}


      {chordModalOpen && (
        <div className="chord-palette-modal">
          <div className="chord-palette-header">
            <span className="label">
              Chords — {scale.kind === 'custom' ? scale.name : padId(scale.id)} ·{' '}
              {NOTE_DISPLAY[root]}
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

      {chordVoicingOpen && (
        <div
          className="modal-backdrop"
          onClick={() => setChordVoicingOpen(false)}
        >
          <div
            className="modal chord-voicing-modal"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="settings-modal-header">
              <h3>
                Chord voicings —{' '}
                {scale.kind === 'custom' ? scale.name : padId(scale.id)} ·{' '}
                {NOTE_DISPLAY[root]}
              </h3>
              <button
                type="button"
                className="finder-modal-close"
                onClick={() => setChordVoicingOpen(false)}
                aria-label="close chord voicings"
              >
                ×
              </button>
            </div>
            {!currentVoicing ? (
              <p className="modal-sub">No chord data for this scale yet.</p>
            ) : (
              <>
                <div className="voicing-sides">
                  <button
                    type="button"
                    className={`voicing-side-btn left ${
                      voicingSide === 'left' ? 'on' : ''
                    }`}
                    onClick={() => {
                      setVoicingSide('left')
                      setVoicingIndex(0)
                    }}
                  >
                    {_resolved ? pcName(_resolved.leftRoot, useFlats) : ''}{' '}
                    {_pair?.left}
                  </button>
                  <button
                    type="button"
                    className={`voicing-side-btn right ${
                      voicingSide === 'right' ? 'on' : ''
                    }`}
                    onClick={() => {
                      setVoicingSide('right')
                      setVoicingIndex(0)
                    }}
                  >
                    {_resolved ? pcName(_resolved.rightRoot, useFlats) : ''}{' '}
                    {_pair?.right}
                  </button>
                </div>

                <div className="voicing-stage">
                  <button
                    type="button"
                    className="voicing-nav"
                    onClick={() => stepVoicing(-1)}
                    aria-label="previous voicing"
                  >
                    ‹
                  </button>
                  <ChordDiagram
                    voicing={currentVoicing}
                    useFlats={useFlats}
                    side={voicingSide}
                    onStrum={() => strumVoicing(currentVoicing.midis)}
                  />
                  <button
                    type="button"
                    className="voicing-nav"
                    onClick={() => stepVoicing(1)}
                    aria-label="next voicing"
                  >
                    ›
                  </button>
                </div>

                <div className="voicing-caption">
                  <span className="voicing-caption-name">
                    {pcName(voicingMeta.rootPc, useFlats)} {voicingMeta.label}
                  </span>
                  <span className="voicing-caption-detail">
                    {currentVoicing.typeLabel} · {currentVoicing.invLabel} ·
                    strings {currentVoicing.stringSetLabel}
                  </span>
                  {currentVoicing.stretch && (
                    <span className="voicing-caption-stretch">wide stretch</span>
                  )}
                </div>

                <div className="voicing-controls">
                  <div className="voicing-chip-row">
                    {voicingFamilies.map((f) => (
                      <button
                        key={f.type}
                        type="button"
                        className={`voicing-chip ${
                          currentVoicing.type === f.type ? 'on' : ''
                        }`}
                        onClick={() => pickVoicing({ type: f.type })}
                      >
                        {f.label}
                      </button>
                    ))}
                  </div>
                  <div className="voicing-chip-row">
                    {voicingSetsForType.map((lbl) => (
                      <button
                        key={lbl}
                        type="button"
                        className={`voicing-chip ${
                          currentVoicing.stringSetLabel === lbl ? 'on' : ''
                        }`}
                        onClick={() => pickVoicing({ stringSetLabel: lbl })}
                      >
                        {lbl}
                      </button>
                    ))}
                  </div>
                  <div className="voicing-chip-row">
                    {['root', '1st inv', '2nd inv', '3rd inv'].map(
                      (lbl, inv) => (
                        <button
                          key={inv}
                          type="button"
                          className={`voicing-chip ${
                            currentVoicing.inversion === inv ? 'on' : ''
                          }`}
                          onClick={() => pickVoicing({ inversion: inv })}
                        >
                          {lbl}
                        </button>
                      )
                    )}
                  </div>
                </div>
              </>
            )}
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
