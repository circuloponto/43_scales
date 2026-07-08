import { useEffect, useMemo, useRef, useState } from 'react'
import { Magnet, Camera, Repeat, Metronome } from 'lucide-react'
import { rootSteps } from './scales'
import { chordPairs } from './chordPairs'
import { resolveChordPair, pcName } from './chordVocab'

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
      onPointerDown={(e) => onPointerDownTab?.(e, song)}
      onDoubleClick={() => {
        if (!onRename) return
        const next = window.prompt('Rename song', song.name)
        if (next != null) onRename(song.id, next)
      }}
      onContextMenu={(e) => {
        e.preventDefault()
        onContextMenu?.({ songId: song.id, x: e.clientX, y: e.clientY })
      }}
      title={`${song.name}${isActive ? ' · double-click to rename · right-click for groups' : ''}`}
    >
      <span className="song-tab-name">{song.name}</span>
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

// One grid cell is a 16th note; a measure ("compass") is 16 cells (4/4).
// The rhythm system divides the measure, so a whole note = one measure =
// CELLS_PER_MEASURE cells.
const CELLS_PER_MEASURE = 16

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
  onPersistPlayback,
  tabSwitchPlayback = 'stop',
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
      //  (none)             → native vertical scroll
      if (!meta && !e.shiftKey) return
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
  const [selectedKeys, setSelectedKeys] = useState(() => new Set())
  // Template waiting to be placed by the user's next grid click. Carries
  // the full template object so the placement handler can compute the
  // beat + scale-step shift from the click position.
  const [pendingTemplate, setPendingTemplate] = useState(null)
  const [marquee, setMarquee] = useState(null)
  const [loop, setLoop] = useState(initialLoop ?? null)
  const [captureOpen, setCaptureOpen] = useState(false)
  const [captureName, setCaptureName] = useState('')
  const [exportFeedback, setExportFeedback] = useState('')
  const [chordModalOpen, setChordModalOpen] = useState(false)
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
  useEffect(() => {
    if (!tabMenu && !groupMenu) return
    const close = () => {
      setTabMenu(null)
      setGroupMenu(null)
    }
    // Close on next click anywhere and on Escape — matches OS convention.
    window.addEventListener('mousedown', close)
    window.addEventListener('keydown', (e) => e.key === 'Escape' && close())
    return () => {
      window.removeEventListener('mousedown', close)
      window.removeEventListener('keydown', close)
    }
  }, [tabMenu, groupMenu])
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
  const rhythmUnitCells = rhythmUnit === 'bar' ? CELLS_PER_MEASURE : 4
  const rhythmBaseCells = rhythmUnitCells / rhythmDenominator
  const rhythmLength = rhythmBaseCells * rhythmMult
  useEffect(() => {
    defaultNoteLengthRef.current = rhythmLength
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
  const rhythmNoteDenom = CELLS_PER_MEASURE / rhythmBaseCells // 1=whole, 2=half…
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
    const step = rhythmBaseCells > 0 ? rhythmBaseCells : 1
    return clamp(Math.round(raw / step) * step)
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
    persistPlaybackRef.current?.({ bpm, swing: swingPct, loop, totalBeats })
  }, [bpm, swingPct, loop, totalBeats])

  // Latest playhead + play-state, mirrored into a ref so the unmount
  // cleanup can read them without stale-closure issues. Updated every
  // render from the current values.
  const playheadBeatRef = useRef(0)
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
        if (pendingTemplate) setPendingTemplate(null)
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
        const newMidi = scaleStepToMidi(newStep)
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
  // the same template again (or press Esc) to cancel.
  const handleTemplateClick = (tpl) => {
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
      const newMidi = scaleStepToMidi(newStep)
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
      // Forward rotation: the earliest-beat pitch wraps to the latest
      // beat. Bump it up by whole octaves until it sits above the new
      // last pitch (which was the original second-to-last). With a flat
      // +12 the wrap could fall inside the existing range — e.g.,
      // [60, 70, 80] would land 60+12=72 below 80 and break the contour.
      const first = midis[0]
      const newLast = midis[n - 1]
      let bumped = first
      while (bumped <= newLast) bumped += 12
      newMidis = [...midis.slice(1), bumped]
      newLengths = [...lengths.slice(1), lengths[0]]
    } else {
      // Backward rotation: the latest-beat pitch wraps to the earliest
      // beat. Drop it by whole octaves until it sits below the new
      // first pitch (which was the original second).
      const last = midis[n - 1]
      const newFirst = midis[0]
      let bumped = last
      while (bumped >= newFirst) bumped -= 12
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
      // Horizontal nudge moves the whole selection as a rigid group. On the
      // RIGHT we clamp the delta so the group stops at totalBeats as a unit
      // (no stacking). On the LEFT we allow notes to cross beat 0 — anything
      // whose start goes negative disappears off-screen, matching the mouse
      // drag. (pushHistory above makes it Ctrl+Z-undoable.)
      let beatDeltaEff = beatDelta
      if (beatDelta > 0) {
        let maxEnd = -Infinity
        for (const k of selectedKeys) {
          const [bStr] = k.split('-')
          const len = prev.get(k) ?? 1
          if (Number(bStr) + len > maxEnd) maxEnd = Number(bStr) + len
        }
        beatDeltaEff = Math.min(totalBeats - maxEnd, beatDeltaEff)
      }
      const moves = []
      for (const k of selectedKeys) {
        const [bStr, midiStr] = k.split('-')
        const oldBeat = Number(bStr)
        const oldMidi = Number(midiStr)
        const len = prev.get(k) ?? 1
        const newBeat = oldBeat + beatDeltaEff
        let newMidi = oldMidi
        if (stepDelta !== 0) {
          if (allowOutOfScale) {
            // Free chromatic movement when the user has opted out of the
            // scale constraint — Arrow keys nudge by one semitone.
            newMidi = oldMidi + stepDelta
          } else {
            const gStep = midiToScaleStep(oldMidi)
            newMidi =
              gStep != null
                ? scaleStepToMidi(gStep + stepDelta)
                : nearestScaleMidi(oldMidi + stepDelta)
          }
        }
        newMidi = Math.max(MIDI_LOW, Math.min(MIDI_HIGH, newMidi))
        // A note whose start crosses left of beat 0 disappears off-screen —
        // drop it from the map and the selection (no newKey).
        const gone = newBeat < 0
        moves.push({
          oldKey: k,
          newKey: gone ? null : `${newBeat}-${newMidi}`,
          length: len,
        })
      }
      for (const m of moves) next.delete(m.oldKey)
      for (const m of moves) {
        if (m.newKey == null) continue
        next.set(m.newKey, m.length)
        newSel.add(m.newKey)
      }
      return next
    })
    setSelectedKeys(newSel)
  }

  // Proportional time-stretch of the selection about its earliest onset.
  // Every note's start-offset from the anchor AND its length scale by the
  // same factor, so the gaps between notes scale right along with the note
  // lengths — the musical shape is preserved, nothing overlaps or stacks,
  // and the whole thing can shrink toward tiny blips or grow indefinitely.
  // dir = +1 grows (×FACTOR), -1 shrinks (÷FACTOR).
  const stretchSelection = (dir) => {
    if (selectedKeys.size === 0) return
    // Factor 2 → each press doubles / halves both lengths and gaps, so the
    // note values track the rhythm selector's musical durations (…16th, 8th,
    // quarter, half, whole…) while the whole pattern scales proportionally.
    const FACTOR = 2
    const FLOOR = 1 / 32 // finest note length in cells
    const factor = dir > 0 ? FACTOR : 1 / FACTOR
    const cur = notesRef.current
    const items = []
    for (const key of selectedKeys) {
      const [bStr, midiStr] = key.split('-')
      items.push({
        key,
        beat: Number(bStr),
        midi: Number(midiStr),
        len: cur.get(key) ?? 1,
      })
    }
    const anchor = Math.min(...items.map((it) => it.beat))
    // First pass: compute the stretched notes and the furthest end beat.
    const results = []
    let maxEnd = 0
    for (const it of items) {
      let newBeat = anchor + (it.beat - anchor) * factor
      const newLen = Math.max(FLOOR, it.len * factor)
      if (newBeat < 0) newBeat = 0
      results.push({ oldKey: it.key, newBeat, newLen, midi: it.midi })
      if (newBeat + newLen > maxEnd) maxEnd = newBeat + newLen
    }
    // If the selection grew past the timeline, extend it (rounded up to a
    // whole measure, capped at MAX_BEATS) so every note stays visible.
    let effectiveTotal = totalBeats
    if (maxEnd > totalBeats) {
      effectiveTotal = Math.min(MAX_BEATS, Math.ceil(maxEnd / 16) * 16)
      if (effectiveTotal !== totalBeats) setTotalBeats(effectiveTotal)
    }
    const newSel = new Set()
    setNotes((prev) => {
      const next = new Map(prev)
      for (const it of items) next.delete(it.key)
      for (const r of results) {
        let nb = r.newBeat
        let nl = r.newLen
        // Only clamp if we hit the hard MAX_BEATS ceiling.
        if (nb + nl > effectiveTotal) nl = Math.max(FLOOR, effectiveTotal - nb)
        const nk = `${nb}-${r.midi}`
        next.set(nk, nl)
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
      let clickBeat = (e.clientX - trackRect.left) / BEAT_WIDTH
      if (!freeMode) clickBeat = Math.floor(clickBeat)
      clickBeat = Math.max(0, Math.min(totalBeats - 1, clickBeat))
      commitTemplateAt(pendingTemplate, clickBeat, midi)
      setPendingTemplate(null)
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
    let beat = snapPlacementBeat(startContentX / BEAT_WIDTH)
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
        const key = `${beat}-${placeMidi}`
        pushHistory()
        const newLength = defaultNoteLengthRef.current
        setNotes((prev) => {
          const next = new Map(prev)
          next.set(key, newLength)
          return next
        })
        auditionNote(placeMidi, 0.3, 0.3)
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
          const nx1 = noteBeat * BEAT_WIDTH
          const nx2 = nx1 + noteLen * BEAT_WIDTH
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
      let newAnchorBeat = drag.originalBeat + dx / BEAT_WIDTH
      if (!freeMode) newAnchorBeat = Math.round(newAnchorBeat)
      newAnchorBeat = Math.min(totalBeats - 0.001, newAnchorBeat)
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
        const offscreen = nb < 0
        if (!offscreen) nb = Math.min(totalBeats - 0.001, nb)
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
    const hasAnyNotes = tracksRef.current.some((t) => t.notes.size > 0)
    if (!hasAnyNotes && !metronome) return
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
            const swungNoteStart = applySwingBeat(beat, liveSwing)
            const swungNoteEnd = applySwingBeat(beat + length, liveSwing)
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
      const currentMusicalBeat = unswingTimeBeat(currentSwungBeat, st.swing)
      st.scheduleRange(currentMusicalBeat, st.loopEnd, now)
      st.nextIterStartTime = iterEndTime
    } else if (st.mode === 'oneshot') {
      const elapsed = now - st.startTime
      const currentSwungBeat = st.swungStart + elapsed / st.cellDur
      // Guard against re-schedules past the end of the range — nothing to
      // do there. Also cap at endBeat so we don't schedule silence.
      if (currentSwungBeat >= st.swungEnd) return
      killScheduledVoices()
      const currentMusicalBeat = unswingTimeBeat(currentSwungBeat, st.swing)
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
      className={`roll-view ${allowOutOfScale ? 'allow-oos' : ''} ${pendingTemplate ? 'placing-template' : ''}`}
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

      {/* Chrome-style song tabs — each tab is its own piano-roll workspace,
          optionally grouped under a coloured strip. Tabs are HTML5-draggable
          for reorder and cross-group moves; right-click opens a group menu. */}
      <div className="song-tabs" role="tablist" aria-label="songs">
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
                  className={`template-row ${
                    pendingTemplate && pendingTemplate.id === tpl.id
                      ? 'pending'
                      : ''
                  }`}
                  onClick={() => handleTemplateClick(tpl)}
                  title={
                    pendingTemplate && pendingTemplate.id === tpl.id
                      ? 'Click on the grid to place this template — Esc to cancel'
                      : `Click then click on the grid to place this template at that beat + scale degree (${tpl.notes.length} notes, captured from scale ${padId(tpl.capturedFrom.scaleId)})`
                  }
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
              <div
                className="grid-area"
                ref={gridAreaRef}
                onMouseLeave={() => {
                  setHoveredCell(null)
                  if (pendingTemplate) setTemplateHover(null)
                }}
              >
                {loop && (
                  <div
                    className="grid-loop"
                    style={{
                      left: `${loop.start * BEAT_WIDTH}px`,
                      width: `${(loop.end - loop.start) * BEAT_WIDTH}px`,
                    }}
                  />
                )}
                {hoveredCell && !marquee && (
                  <div
                    className="grid-hover-cell"
                    style={{
                      left: `${hoveredCell.beat * BEAT_WIDTH}px`,
                      top: `${
                        (MIDI_HIGH - hoveredCell.midi) * ROW_HEIGHT
                      }px`,
                      // Mirror the length a click would actually produce
                      // exactly — no snap-mode clamp. Click-place writes
                      // rhythmLength straight into the notes map, so the
                      // hover width must follow the same value or the two
                      // won't line up (an 8th-note hover would render as a
                      // full-beat box in snap mode otherwise).
                      width: `${(rhythmLength ?? 1) * BEAT_WIDTH}px`,
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
                        className={`beats-track ${freeMode ? 'free' : ''}`}
                        style={{
                          width: totalBeats * BEAT_WIDTH,
                          // Grid lines must scale with the horizontal zoom
                          // so cell / beat lines stay aligned with the notes
                          // and the timeline ticks. One line per cell
                          // (BEAT_WIDTH) and a heavier one per beat (4 cells).
                          backgroundSize: `${BEAT_WIDTH}px 100%, ${BEAT_WIDTH * 4}px 100%`,
                        }}
                        onPointerDown={(e) => handleRowMouseDown(e, midi)}
                        onMouseMove={(e) => {
                          // Compute the beat under the cursor once and feed
                          // it into both the general hover indicator and the
                          // template preview anchor (when a template is
                          // queued). Snaps to whole beats unless free mode.
                          // When scale-snap is on (allowOutOfScale=false),
                          // the hover row also snaps to the nearest in-scale
                          // midi so the indicator visibly "skips" past the
                          // out-of-scale rows that a click there would
                          // refuse to place a note on anyway.
                          const rect = e.currentTarget.getBoundingClientRect()
                          // Snap to the rhythm division grid so the hover
                          // box lands exactly where a click would place the
                          // note (tuplets included).
                          const beat = snapPlacementBeat(
                            (e.clientX - rect.left) / BEAT_WIDTH
                          )
                          // Ctrl held inverts the current snap mode for
                          // the hover indicator too, so its position always
                          // matches where a click will actually land.
                          const effectiveAllowOOS = allowOutOfScale
                            ? !(e.ctrlKey || e.metaKey)
                            : e.ctrlKey || e.metaKey
                          const hoverMidi = effectiveAllowOOS
                            ? midi
                            : nearestScaleMidi(midi)
                          setHoveredCell((cur) =>
                            cur &&
                            cur.beat === beat &&
                            cur.midi === hoverMidi
                              ? cur
                              : { beat, midi: hoverMidi }
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
                              left: `${p.beat * BEAT_WIDTH}px`,
                              width: `${p.length * BEAT_WIDTH}px`,
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
        </div>

        {/* Right-side track sidebar: vertical tabs sticking out the left
            edge (like folder tabs), with the active one merging into the
            sidebar's control panel on its right. */}
        <aside className="track-sidebar">
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
        </aside>
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
