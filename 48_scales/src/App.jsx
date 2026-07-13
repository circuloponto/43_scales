import { useState, useEffect, useRef } from 'react'
import { scales, PITCH_CLASSES, rootSteps } from './scales'
import { glyphs, GLYPH_VIEWBOX } from './glyphs'
import { glyphsRight } from './glyphsRight'
import { templates as defaultTemplates } from './templates'
import { chordPairs } from './chordPairs'
import { resolveChordPair, pcName } from './chordVocab'
import PianoRoll from './PianoRoll'
import './App.css'

const ORIGINAL_PURPLE = '#9c36b5'

const NOTE_NAMES_SHARP = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B']
const NOTE_NAMES_FLAT  = ['C', 'D♭', 'D', 'E♭', 'E', 'F', 'G♭', 'G', 'A♭', 'A', 'B♭', 'B']

// Ten 4-of-8 chord shape patterns. Each is a list of 1-indexed scale-degree
// positions inside an 8-note scale.
const CHORD_SHAPES = [
  [1, 3, 5, 7],
  [1, 2, 4, 6],
  [1, 2, 3, 5],
  [1, 2, 3, 7],
  [1, 2, 5, 7],
  [1, 2, 4, 7],
  [1, 2, 3, 6],
  [1, 2, 5, 6],
  [1, 2, 4, 5],
  [1, 2, 3, 4],
  
]
const BORROWING_ORDER = [0, 5, 7, 9, 1, 4, 2, 3, 6, 8]
// Display orders for the ten chord shapes, as index lists into CHORD_SHAPES.
// 'Opposites' is the canonical list reversed (last → first). 'Borrowing' is
// the order shown in the reference image (top → bottom).
const OPPOSITES_ORDER = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]
// TODO(borrowing): confirm this matches the image row-by-row. Each number is
// an index into CHORD_SHAPES above. Edit this single array to fix the order.

const CHORD_ORDERS = {
  borrowing: BORROWING_ORDER,
  opposites: OPPOSITES_ORDER,
}

// Visual grouping within each order — how many rows are in each cluster, top
// to bottom, mirroring the boxed groups in the reference image. The section
// renders extra vertical space between groups. Sizes must sum to 10.
//   Borrowing (left column):  4 singles, then three pairs.
//   Opposites (right column): a single, a triple, a pair, then a quad.
const CHORD_GROUP_SIZES = {
  borrowing: [4, 2, 2, 2],
  opposites: [1, 4, 5],
}
// Partition a flat order (index list) into groups per the given sizes. Any
// leftover rows (if sizes don't sum to the length) become a final group.
function partitionChordOrder(order, sizes) {
  const groups = []
  let pos = 0
  for (const n of sizes) {
    groups.push(order.slice(pos, pos + n))
    pos += n
  }
  if (pos < order.length) groups.push(order.slice(pos))
  return groups
}

function midiToFreq(midi) {
  return 440 * Math.pow(2, (midi - 69) / 12)
}

function padId(id) {
  return String(id).padStart(2, '0')
}

// Delta groups partition the 48 scales into two families. Everything below
// / above these lists follows the user's canonical spec; unassigned scales
// (44..48 placeholders) return null.
const DELTA_ALPHA_IDS = new Set([
  1, 2, 3, 4, 5, 6, 7, 8, 9, 10,
  12,
  14, 15, 16, 17, 18, 19,
  21, 23,
  27, 28, 29, 30, 31,
  36,
])
const DELTA_BETA_IDS = new Set([
  11, 13,
  20, 22, 24, 25, 26,
  32, 33, 34, 35,
  37, 38, 39, 40, 41, 42, 43,
])
function deltaGroupOf(scaleId) {
  if (DELTA_ALPHA_IDS.has(scaleId)) {
    return { key: 'alpha', symbol: '∝', label: 'Alpha' }
  }
  if (DELTA_BETA_IDS.has(scaleId)) {
    return { key: 'beta', symbol: 'β', label: 'Beta' }
  }
  return null
}

// Each glyph in the original SVG is actually two sub-symbols separated by ~25
// viewBox units of empty space. We close that gap at render time: anything past
// SPLIT_X gets pulled leftward by SHIFT, and the viewBox is trimmed by the same.
const GLYPH_SPLIT_X = 30
const GLYPH_SHIFT = -22

function GlyphRow({ rowIndex, accent }) {
  const strokes = glyphs[rowIndex]
  const w = GLYPH_VIEWBOX.w + GLYPH_SHIFT
  if (!strokes) return <svg className="glyph" viewBox={`0 0 ${w} ${GLYPH_VIEWBOX.h}`} />
  return (
    <svg
      className="glyph"
      viewBox={`0 0 ${w} ${GLYPH_VIEWBOX.h}`}
      preserveAspectRatio="xMidYMid meet"
    >
      {strokes.map((s, i) => {
        const isAccent = s.color === ORIGINAL_PURPLE
        const color = isAccent ? accent : s.color
        const dx = s.x >= GLYPH_SPLIT_X ? GLYPH_SHIFT : 0
        const rot = s.rot ?? 0
        return (
          <g
            key={i}
            transform={`translate(${s.x + dx} ${s.y}) rotate(${rot} ${s.rx} ${s.ry})`}
          >
            {s.kind === 'fill' ? (
              <path d={s.d} fill={color} stroke="none" />
            ) : (
              <path
                d={s.d}
                stroke={color}
                strokeWidth={isAccent ? 1.3 : 1}
                fill="none"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            )}
          </g>
        )
      })}
    </svg>
  )
}

// Render a single isolated right-side glyph at any size. Pulls the
// pre-extracted strokes + tight viewBox from glyphsRight, so each glyph
// renders edge-to-edge regardless of where it originally sat in the wide
// 60-unit row viewBox.
function GlyphRight({ rowIndex, accent }) {
  const entry = glyphsRight[rowIndex]
  if (!entry) return null
  const { strokes, viewBox } = entry
  return (
    <svg
      className="glyph glyph-right"
      viewBox={`0 0 ${viewBox.w} ${viewBox.h}`}
      preserveAspectRatio="xMidYMid meet"
    >
      {strokes.map((s, i) => {
        const isAccent = s.color === ORIGINAL_PURPLE
        const color = isAccent ? accent : s.color
        const rot = s.rot ?? 0
        return (
          <g
            key={i}
            transform={`translate(${s.x} ${s.y}) rotate(${rot} ${s.rx} ${s.ry})`}
          >
            {s.kind === 'fill' ? (
              <path d={s.d} fill={color} stroke="none" />
            ) : (
              <path
                d={s.d}
                stroke={color}
                strokeWidth={isAccent ? 1.3 : 1}
                fill="none"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            )}
          </g>
        )
      })}
    </svg>
  )
}

function PlayIcon() {
  return (
    <svg width="12" height="14" viewBox="0 0 12 14" aria-hidden="true">
      <path d="M2 1 L11 7 L2 13 Z" fill="currentColor" />
    </svg>
  )
}

function StopIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
      <rect x="2" y="2" width="8" height="8" fill="currentColor" />
    </svg>
  )
}

function cellPulseDelay(scaleId, pitchClass) {
  return ((scaleId * 0.07 + pitchClass * 0.12) % 2.4).toFixed(2)
}

// Cyclic interval signature of a chord — the gaps between consecutive sorted
// pitch classes including the wrap back to the first, so the 4 gaps sum to
// 12. Inversions of the same chord produce rotations of this array.
function chordCyclicIntervals(pcs) {
  const sorted = [...new Set(pcs.map((p) => ((p % 12) + 12) % 12))].sort(
    (a, b) => a - b
  )
  if (sorted.length === 0) return []
  return sorted.map((pc, i) => {
    const next = sorted[(i + 1) % sorted.length]
    const gap = (next - pc + 12) % 12
    return gap === 0 ? 12 : gap
  })
}

// True if `a` is some rotation of `b` (both must be the same length).
function isRotationOf(a, b) {
  if (!a || !b || a.length !== b.length) return false
  const n = a.length
  for (let r = 0; r < n; r++) {
    let match = true
    for (let i = 0; i < n; i++) {
      if (a[(i + r) % n] !== b[i]) { match = false; break }
    }
    if (match) return true
  }
  return false
}

// Index the 43 glyphs by their cyclic-interval signature so chord cards can
// look up a matching glyph in O(43) at render time. Returns the row index of
// a glyph whose interval signature matches (under rotation), or null.
function findGlyphForCyclic(cyc) {
  if (!cyc || cyc.length === 0) return null
  for (const [id, entry] of Object.entries(glyphsRight)) {
    if (isRotationOf(entry.cyclicIntervals, cyc)) return Number(id)
  }
  return null
}

function App() {
  const [root, setRoot] = useState(0)
  const [selectedId, setSelectedId] = useState(null)
  const [hoverRow, setHoverRow] = useState(null)
  const [hoverPos, setHoverPos] = useState({ x: 0, y: 0 })
  const loadColor = (key, fallback) => {
    try {
      const v = localStorage.getItem(key)
      return v && /^#[0-9a-f]{6}$/i.test(v) ? v : fallback
    } catch {
      return fallback
    }
  }
  const DEFAULT_SETTINGS = {
    allowOutOfScale: false,
    useFlats: false,
    // When true, tempo / swing / loop / beat count are shared across every
    // song tab instead of persisting per-song. Toggling on adopts whatever
    // the currently-active song has as the new global values.
    universalPlayback: false,
    // What happens to audio when the user switches song tabs:
    // 'stop'     — playback stops when the tab changes (current default).
    // 'continue' — playback resumes on the new tab at the same beat.
    tabSwitchPlayback: 'stop',
  }
  const loadSettings = () => {
    try {
      const v = localStorage.getItem('eightFold.settings')
      if (!v) return DEFAULT_SETTINGS
      const parsed = JSON.parse(v)
      return { ...DEFAULT_SETTINGS, ...parsed }
    } catch {
      return DEFAULT_SETTINGS
    }
  }
  const [settings, setSettings] = useState(loadSettings)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [shortcutsOpen, setShortcutsOpen] = useState(false)
  useEffect(() => {
    if (!shortcutsOpen) return
    const onKey = (e) => {
      if (e.key === 'Escape') setShortcutsOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [shortcutsOpen])
  // Per-component note name array + helper, derived from the active accidental
  // preference. All places that used the old module-level NOTE_DISPLAY[pc] or
  // pcName(pc) now go through these so the toggle flips every note label in
  // the panel instantly.
  const NOTE_DISPLAY = settings.useFlats ? NOTE_NAMES_FLAT : NOTE_NAMES_SHARP
  const noteName = (pc) => pcName(pc, settings.useFlats)
  useEffect(() => {
    try {
      localStorage.setItem('eightFold.settings', JSON.stringify(settings))
    } catch {}
  }, [settings])
  useEffect(() => {
    if (!settingsOpen) return
    const onKey = (e) => {
      if (e.key === 'Escape') setSettingsOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [settingsOpen])

  const [accent, setAccent] = useState(() =>
    loadColor('eightFold.accent', ORIGINAL_PURPLE)
  )
  const [chord1Color, setChord1Color] = useState(() =>
    loadColor('eightFold.chord1', '#e8a87c')
  )
  const [chord2Color, setChord2Color] = useState(() =>
    loadColor('eightFold.chord2', '#7891c4')
  )
  const [electronColor, setElectronColor] = useState(() =>
    loadColor('eightFold.electron', '#6b6b70')
  )
  const [view, setView] = useState('matrix')

  // Songs: top-level Chrome-style tabs. Each song owns its own track list,
  // so switching tabs preserves the per-song tracks. `tracks: null` is the
  // sentinel for "needs initial pattern" — PianoRoll seeds it on mount.
  const makeSongId = () =>
    `sg-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
  const [songs, setSongs] = useState(() => [
    { id: makeSongId(), name: 'Song 1', tracks: null, activeTrackId: null },
  ])
  const [activeSongId, setActiveSongId] = useState(() => songs[0].id)
  // Universal playback (shared tempo / swing / loop / beat count across
  // every song) — only consulted when settings.universalPlayback is on.
  // Null fields fall through to the module defaults on first render.
  const [universalPlayback, setUniversalPlayback] = useState({
    bpm: null,
    swing: null,
    loop: null,
    totalBeats: null,
    timeSig: null,
  })
  // Cross-tab playback resume lives at module scope inside PianoRoll
  // itself — a plain module variable that survives the unmount → mount
  // seam without going through React's render cycle. See
  // `pendingResumeBeat` in PianoRoll.jsx.
  const activeSong = songs.find((s) => s.id === activeSongId) ?? songs[0]
  // Ref-tracked activeSongId so `updateActiveSong` always writes to the
  // currently-active song even if the closure was captured on a previous
  // render (e.g. inside a PianoRoll useEffect that runs later).
  const activeSongIdRef = useRef(activeSongId)
  activeSongIdRef.current = activeSongId
  const updateActiveSong = (patch) => {
    const targetId = activeSongIdRef.current
    setSongs((prev) =>
      prev.map((s) =>
        s.id === targetId
          ? { ...s, ...(typeof patch === 'function' ? patch(s) : patch) }
          : s
      )
    )
  }
  // Song-level undo/redo. Any tab CRUD or group operation pushes a snapshot
  // of (songs, songGroups, activeSongId) onto historyRef before mutating.
  // Ctrl+Z in matrix view drains this stack; in roll view PianoRoll drains
  // its own notes history first and then falls through here via onFallback*.
  const SONG_HISTORY_LIMIT = 100
  const songHistoryRef = useRef([])
  const songFutureRef = useRef([])
  const snapshotSongState = () => ({
    songs: songs.map((s) => ({ ...s })),
    songGroups: songGroups.map((g) => ({ ...g })),
    activeSongId,
  })
  const pushSongHistory = () => {
    songHistoryRef.current.push(snapshotSongState())
    if (songHistoryRef.current.length > SONG_HISTORY_LIMIT) {
      songHistoryRef.current.shift()
    }
    songFutureRef.current = []
  }
  const applySongSnap = (snap) => {
    setSongs(snap.songs)
    setSongGroups(snap.songGroups)
    setActiveSongId(snap.activeSongId)
  }
  const undoSongState = () => {
    const hist = songHistoryRef.current
    if (hist.length === 0) return false
    songFutureRef.current.push(snapshotSongState())
    applySongSnap(hist.pop())
    return true
  }
  const redoSongState = () => {
    const fut = songFutureRef.current
    if (fut.length === 0) return false
    songHistoryRef.current.push(snapshotSongState())
    applySongSnap(fut.pop())
    return true
  }
  const addSong = () => {
    pushSongHistory()
    const id = makeSongId()
    const name = `Song ${songs.length + 1}`
    // Inherit playback settings (tempo, swing, loop region, beat count) from
    // whatever tab is currently active — a new song should pick up where you
    // left off rather than resetting to the module defaults.
    const src = songs.find((s) => s.id === activeSongIdRef.current)
    setSongs((prev) => [
      ...prev,
      {
        id,
        name,
        tracks: null,
        activeTrackId: null,
        bpm: src?.bpm,
        swing: src?.swing,
        loop: src?.loop,
        totalBeats: src?.totalBeats,
        timeSig: src?.timeSig,
      },
    ])
    setActiveSongId(id)
  }
  const removeSong = (id) => {
    if (songs.length <= 1) return
    const target = songs.find((s) => s.id === id)
    if (!target) return
    const hasNotes =
      target.tracks && target.tracks.some((t) => t.notes && t.notes.size > 0)
    if (hasNotes) {
      const ok = window.confirm(
        `Close "${target.name}"? Its tracks won't be saved.`
      )
      if (!ok) return
    }
    pushSongHistory()
    const remaining = songs.filter((s) => s.id !== id)
    setSongs(remaining)
    if (activeSongId === id) setActiveSongId(remaining[0].id)
  }
  const renameSong = (id, name) => {
    const trimmed = (name || '').trim()
    if (!trimmed) return
    const current = songs.find((s) => s.id === id)
    if (!current || current.name === trimmed) return
    pushSongHistory()
    setSongs((prev) => prev.map((s) => (s.id === id ? { ...s, name: trimmed } : s)))
  }

  // Chrome-style song-tab groups. Each group has an id, name, and colour;
  // songs opt in by carrying a `groupId`. Rendering keeps same-group songs
  // contiguous (drag-drop enforces this) so grouped tabs sit under a shared
  // coloured strip. Ungrouped songs are freestanding.
  const GROUP_COLOURS = ['#4f8cff', '#ff6b9a', '#3ecf8e', '#f5a623', '#9d5cff', '#ff5c5c', '#00c2c7']
  const makeGroupId = () =>
    `gr-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
  const [songGroups, setSongGroups] = useState([])
  const addGroup = (opts = {}) => {
    const id = opts.id || makeGroupId()
    const name = opts.name || `Group ${songGroups.length + 1}`
    const colour = opts.colour || GROUP_COLOURS[songGroups.length % GROUP_COLOURS.length]
    pushSongHistory()
    setSongGroups((prev) => [...prev, { id, name, colour, collapsed: false }])
    return id
  }
  // Toggling a group's collapse state. If the active song lives inside a
  // group that's about to collapse, we switch active to the first song
  // outside that group so the roll doesn't strand the user on a hidden tab.
  // Silently no-ops if every song belongs to the group being collapsed.
  const toggleGroupCollapsed = (id) => {
    const group = songGroups.find((g) => g.id === id)
    if (!group) return
    const willCollapse = !group.collapsed
    if (willCollapse) {
      const activeSong = songs.find((s) => s.id === activeSongId)
      if (activeSong && activeSong.groupId === id) {
        const outside = songs.find((s) => s.groupId !== id)
        if (!outside) return
        setActiveSongId(outside.id)
      }
    }
    setSongGroups((prev) =>
      prev.map((g) => (g.id === id ? { ...g, collapsed: willCollapse } : g))
    )
  }
  const removeGroup = (id) => {
    if (!songGroups.some((g) => g.id === id)) return
    pushSongHistory()
    setSongGroups((prev) => prev.filter((g) => g.id !== id))
    setSongs((prev) =>
      prev.map((s) => (s.groupId === id ? { ...s, groupId: null } : s))
    )
  }
  const renameGroup = (id, name) => {
    const trimmed = (name || '').trim()
    if (!trimmed) return
    const current = songGroups.find((g) => g.id === id)
    if (!current || current.name === trimmed) return
    pushSongHistory()
    setSongGroups((prev) =>
      prev.map((g) => (g.id === id ? { ...g, name: trimmed } : g))
    )
  }
  // Group colour tweaks fire continuously while the user drags inside the
  // native colour picker — coalesce them by only pushing history when the
  // colour actually changes from the last committed value. This keeps the
  // undo stack from ballooning with per-pixel intermediate colours.
  const setGroupColour = (id, colour) => {
    const current = songGroups.find((g) => g.id === id)
    if (!current || current.colour === colour) return
    pushSongHistory()
    setSongGroups((prev) =>
      prev.map((g) => (g.id === id ? { ...g, colour } : g))
    )
  }
  // Reorder + optionally re-group a song in one atomic step. `beforeId` is
  // the id of the tab the dragged song should land in front of; null means
  // "drop at the end". `targetGroupId` overrides the song's group; when
  // omitted, we adopt whatever group the destination neighbours are in so
  // grouped tabs stay contiguous.
  const moveSong = (draggedId, beforeId, targetGroupId) => {
    if (draggedId === beforeId) return
    pushSongHistory()
    setSongs((prev) => {
      const dragged = prev.find((s) => s.id === draggedId)
      if (!dragged) return prev
      const without = prev.filter((s) => s.id !== draggedId)
      let insertIdx =
        beforeId == null ? without.length : without.findIndex((s) => s.id === beforeId)
      if (insertIdx === -1) insertIdx = without.length
      let resolvedGroup = targetGroupId
      if (resolvedGroup === undefined) {
        // Inherit only from unambiguous neighbours. Between two grouped tabs
        // of the same group → join. At a boundary that touches the dragged
        // song's current group → stay. Otherwise → ungroup, so tail drops
        // and mismatched-boundary drops cleanly leave the previous group.
        const before = without[insertIdx - 1]?.groupId ?? null
        const after = without[insertIdx]?.groupId ?? null
        if (before && before === after) resolvedGroup = before
        else if (
          dragged.groupId &&
          (before === dragged.groupId || after === dragged.groupId)
        ) resolvedGroup = dragged.groupId
        else resolvedGroup = null
      }
      const updated = { ...dragged, groupId: resolvedGroup ?? null }
      return [...without.slice(0, insertIdx), updated, ...without.slice(insertIdx)]
    })
  }
  // Move an entire group (its member songs, as a contiguous block) to sit
  // just before `beforeSongId`. `beforeSongId=null` parks the group at the
  // very end. Members keep their relative order — only the block's position
  // in the tab strip changes.
  const moveGroup = (groupId, beforeSongId) => {
    pushSongHistory()
    setSongs((prev) => {
      const members = prev.filter((s) => s.groupId === groupId)
      if (members.length === 0) return prev
      const rest = prev.filter((s) => s.groupId !== groupId)
      let insertIdx =
        beforeSongId == null
          ? rest.length
          : rest.findIndex((s) => s.id === beforeSongId)
      if (insertIdx === -1) insertIdx = rest.length
      // If the requested insert index lands inside another group's
      // contiguous run, snap left to that run's start — otherwise the
      // dropped group would split the neighbour in two.
      if (insertIdx > 0 && insertIdx < rest.length) {
        const beforeG = rest[insertIdx - 1].groupId
        const afterG = rest[insertIdx].groupId
        if (beforeG && beforeG === afterG) {
          while (insertIdx > 0 && rest[insertIdx - 1].groupId === beforeG) {
            insertIdx--
          }
        }
      }
      return [...rest.slice(0, insertIdx), ...members, ...rest.slice(insertIdx)]
    })
  }
  const assignSongToGroup = (songId, groupId) => {
    const current = songs.find((s) => s.id === songId)
    if (!current) return
    if ((current.groupId ?? null) === (groupId ?? null)) return
    pushSongHistory()
    setSongs((prev) => {
      const target = prev.find((s) => s.id === songId)
      if (!target) return prev
      const without = prev.filter((s) => s.id !== songId)
      const updated = { ...target, groupId: groupId ?? null }
      if (!groupId) {
        // Ungroup: park the song at the end of its previous group's run so
        // it detaches cleanly and doesn't split a group in two.
        return [...without, updated]
      }
      // Find the last song already in `groupId` and slot after it. If none
      // exists yet (first member), append.
      let lastIdx = -1
      for (let i = 0; i < without.length; i++) {
        if (without[i].groupId === groupId) lastIdx = i
      }
      const insertIdx = lastIdx === -1 ? without.length : lastIdx + 1
      return [...without.slice(0, insertIdx), updated, ...without.slice(insertIdx)]
    })
  }
  // Templates are seeded from src/templates.js on first load (production
  // still exports there via the export button), then any user-created or
  // deleted templates persist to localStorage so they survive refreshes.
  // Once the built-in library is stable we can drop the seed + export path
  // entirely and read exclusively from storage.
  const [templates, setTemplates] = useState(() => {
    try {
      const raw = localStorage.getItem('eightFold.templates')
      if (raw) {
        const parsed = JSON.parse(raw)
        if (Array.isArray(parsed)) return parsed
      }
    } catch {}
    return defaultTemplates
  })
  useEffect(() => {
    try {
      localStorage.setItem('eightFold.templates', JSON.stringify(templates))
    } catch {}
  }, [templates])

  // Session export / import. Everything the app tracks about a user's
  // project — songs (with tracks + notes), song groups, templates, scale
  // aliases, colour theme, current view, selected scale + root + mode —
  // rolls into one JSON blob. Import replaces the current session after a
  // confirm. A `version` field lets us evolve the schema later without
  // breaking older exports (we only accept v1 for now).
  const SESSION_VERSION = 1
  const exportSession = () => {
    const session = {
      version: SESSION_VERSION,
      songs,
      songGroups,
      activeSongId,
      templates,
      scaleNames,
      settings,
      accent,
      chord1Color,
      chord2Color,
      electronColor,
      selectedId,
      root,
      modeStep,
      view,
    }
    try {
      const json = JSON.stringify(session, null, 2)
      const blob = new Blob([json], { type: 'application/json' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      const stamp = new Date().toISOString().slice(0, 10)
      a.download = `8fold-session-${stamp}.json`
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      URL.revokeObjectURL(url)
    } catch (err) {
      window.alert('Could not export session: ' + err.message)
    }
  }
  const importSession = (file) => {
    const reader = new FileReader()
    reader.onload = (e) => {
      let data
      try {
        data = JSON.parse(e.target.result)
      } catch {
        window.alert('That file is not a valid session (JSON parse failed).')
        return
      }
      if (!data || typeof data !== 'object') {
        window.alert('That file is not a valid session.')
        return
      }
      if (data.version && data.version !== SESSION_VERSION) {
        const proceed = window.confirm(
          `Session was exported from a different version (${data.version} vs ${SESSION_VERSION}). Import anyway?`
        )
        if (!proceed) return
      }
      const proceed = window.confirm(
        'Importing will replace your current session. Continue?'
      )
      if (!proceed) return
      if (Array.isArray(data.songs) && data.songs.length > 0) setSongs(data.songs)
      if (Array.isArray(data.songGroups)) setSongGroups(data.songGroups)
      if (data.activeSongId) setActiveSongId(data.activeSongId)
      if (Array.isArray(data.templates)) setTemplates(data.templates)
      if (data.scaleNames && typeof data.scaleNames === 'object') setScaleNames(data.scaleNames)
      if (data.settings && typeof data.settings === 'object') setSettings(data.settings)
      if (typeof data.accent === 'string') setAccent(data.accent)
      if (typeof data.chord1Color === 'string') setChord1Color(data.chord1Color)
      if (typeof data.chord2Color === 'string') setChord2Color(data.chord2Color)
      if (typeof data.electronColor === 'string') setElectronColor(data.electronColor)
      if (typeof data.selectedId === 'number' || data.selectedId === null)
        setSelectedId(data.selectedId)
      if (typeof data.root === 'number') setRoot(data.root)
      if (data.modeStep == null || typeof data.modeStep === 'number')
        setModeStep(data.modeStep ?? null)
      if (data.view === 'matrix' || data.view === 'roll') setView(data.view)
      setSettingsOpen(false)
    }
    reader.onerror = () => window.alert('Could not read the file.')
    reader.readAsText(file)
  }
  // scaleNames stores per-scale naming metadata. Each scale can carry multiple
  // aliases, one per "viewpoint" (which scale degree acts as root). We migrate
  // the older `{ [id]: "Name" }` string format into the richer shape on load.
  const [scaleNames, setScaleNames] = useState(() => {
    try {
      const raw = JSON.parse(localStorage.getItem('eightFold.scaleNames') || '{}')
      const out = {}
      for (const [id, val] of Object.entries(raw)) {
        if (typeof val === 'string') {
          const eid = `e-${id}-default`
          out[id] = {
            entries: [{ id: eid, name: val, modeStep: null }],
            selectedId: eid,
            defaultId: eid,
          }
        } else if (val && Array.isArray(val.entries) && val.entries.length > 0) {
          out[id] = val
        }
      }
      return out
    } catch {
      return {}
    }
  })

  useEffect(() => {
    try {
      localStorage.setItem('eightFold.scaleNames', JSON.stringify(scaleNames))
    } catch {}
  }, [scaleNames])

  useEffect(() => {
    try { localStorage.setItem('eightFold.accent', accent) } catch {}
  }, [accent])
  useEffect(() => {
    try { localStorage.setItem('eightFold.chord1', chord1Color) } catch {}
  }, [chord1Color])
  useEffect(() => {
    try { localStorage.setItem('eightFold.chord2', chord2Color) } catch {}
  }, [chord2Color])
  useEffect(() => {
    try { localStorage.setItem('eightFold.electron', electronColor) } catch {}
  }, [electronColor])

  // On mobile portrait the right panel stacks below the matrix; when the
  // user picks a scale we scroll the panel into view so they see the chord
  // pair / chromatic / hero info update. No-op on desktop (panel is already
  // in the viewport).
  const panelRef = useRef(null)
  useEffect(() => {
    if (selectedId === null) return
    if (window.matchMedia('(max-width: 480px)').matches && panelRef.current) {
      panelRef.current.scrollIntoView({ behavior: 'smooth', block: 'start' })
    }
  }, [selectedId])

  // Keep the selected matrix row visible when navigating with arrow keys.
  useEffect(() => {
    if (selectedId === null) return
    const row = document.querySelector(`[data-scale-id="${selectedId}"]`)
    if (row) row.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
  }, [selectedId])

  // Which scale ids the user has hidden from the matrix. Persisted so a
  // curated shortlist (e.g. only pentatonic scales) survives reloads. Kept
  // near the top of the state block because the matrix-view keyboard nav
  // effect below reads it in its filter.
  const [hiddenScaleIds, setHiddenScaleIds] = useState(() => {
    try {
      const raw = localStorage.getItem('eightFold.hiddenScaleIds')
      if (raw) {
        const parsed = JSON.parse(raw)
        if (Array.isArray(parsed)) return new Set(parsed.map(Number))
      }
    } catch {}
    return new Set()
  })
  useEffect(() => {
    try {
      localStorage.setItem(
        'eightFold.hiddenScaleIds',
        JSON.stringify([...hiddenScaleIds])
      )
    } catch {}
  }, [hiddenScaleIds])

  // Matrix-view keyboard navigation. Arrow keys step through the scales,
  // Home/End jump to the first / last, Esc clears. Skips when focus is on
  // an editable element so renaming a scale doesn't hijack the keys.
  useEffect(() => {
    if (view !== 'matrix') return
    const onKey = (e) => {
      const tag = e.target.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || e.target.isContentEditable) return
      // Only navigate through scales the user actually has on-screen — anything
      // hidden via the Scales picker is skipped by arrow / Home / End.
      const visible = scales.filter(
        (s) => s.notes && s.notes.length > 0 && !hiddenScaleIds.has(s.id)
      )
      if (visible.length === 0) return
      if (e.code === 'Escape') {
        if (selectedId !== null) setSelectedId(null)
      } else if (e.code === 'ArrowDown' || e.code === 'ArrowRight') {
        e.preventDefault()
        const idx = visible.findIndex((s) => s.id === selectedId)
        const next = idx === -1 ? visible[0] : visible[Math.min(idx + 1, visible.length - 1)]
        setSelectedId(next.id)
      } else if (e.code === 'ArrowUp' || e.code === 'ArrowLeft') {
        e.preventDefault()
        const idx = visible.findIndex((s) => s.id === selectedId)
        const next = idx === -1 ? visible[visible.length - 1] : visible[Math.max(idx - 1, 0)]
        setSelectedId(next.id)
      } else if (e.code === 'Home') {
        e.preventDefault()
        setSelectedId(visible[0].id)
      } else if (e.code === 'End') {
        e.preventDefault()
        setSelectedId(visible[visible.length - 1].id)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [view, selectedId, hiddenScaleIds])

  // Ctrl/Cmd + Z / Y for song-level undo/redo when in matrix view (where
  // PianoRoll isn't mounted). In roll view PianoRoll owns the shortcut and
  // routes overflow back here via onFallbackUndo / onFallbackRedo props.
  useEffect(() => {
    if (view !== 'matrix') return
    const onKey = (e) => {
      const tag = e.target.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || e.target.isContentEditable) return
      const meta = e.ctrlKey || e.metaKey
      if (meta && (e.code === 'KeyZ' || (e.key || '').toLowerCase() === 'z')) {
        e.preventDefault()
        if (e.shiftKey) redoSongState()
        else undoSongState()
      } else if (
        meta &&
        (e.code === 'KeyY' || (e.key || '').toLowerCase() === 'y')
      ) {
        e.preventDefault()
        redoSongState()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [view, songs, songGroups, activeSongId])

  const scaleNameEntryOf = (id) => {
    const data = scaleNames[id]
    if (!data) return null
    return data.entries.find((e) => e.id === data.selectedId) ?? data.entries[0] ?? null
  }
  const scaleNameOf = (id) => scaleNameEntryOf(id)?.name ?? `Scale ${id}`
  // Rename the DEFAULT entry — this is what the hero input edits so the
  // pre-existing single-name UX keeps working. Alternative aliases are added
  // through the scale-settings modal.
  const renameScale = (id, name) => {
    setScaleNames((prev) => {
      const trimmed = (name || '').trim()
      const data = prev[id]
      if (data) {
        const targetId = data.defaultId ?? data.entries[0]?.id
        if (!targetId) return prev
        // Erase the whole record if the user emptied it and it was never
        // customised beyond the default entry.
        if (!trimmed && data.entries.length === 1) {
          const next = { ...prev }
          delete next[id]
          return next
        }
        if (!trimmed) return prev
        return {
          ...prev,
          [id]: {
            ...data,
            entries: data.entries.map((e) =>
              e.id === targetId ? { ...e, name: trimmed } : e
            ),
          },
        }
      }
      if (!trimmed || trimmed === `Scale ${id}`) return prev
      const eid = `e-${id}-default`
      return {
        ...prev,
        [id]: {
          entries: [{ id: eid, name: trimmed, modeStep: null }],
          selectedId: eid,
          defaultId: eid,
        },
      }
    })
  }
  const selectScaleName = (scaleId, entryId) => {
    setScaleNames((prev) => {
      const data = prev[scaleId]
      if (!data) return prev
      return { ...prev, [scaleId]: { ...data, selectedId: entryId } }
    })
    const entry = scaleNames[scaleId]?.entries.find((e) => e.id === entryId)
    setModeStep(entry?.modeStep ?? null)
  }
  const addScaleName = (scaleId, name, modeStep) => {
    const trimmed = (name || '').trim()
    if (!trimmed) return
    const eid = `e-${scaleId}-${Math.floor(Math.random() * 1e9).toString(36)}`
    setScaleNames((prev) => {
      const existing = prev[scaleId]
      if (existing) {
        return {
          ...prev,
          [scaleId]: {
            ...existing,
            entries: [
              ...existing.entries,
              { id: eid, name: trimmed, modeStep: modeStep ?? null },
            ],
            selectedId: eid,
          },
        }
      }
      const defId = `e-${scaleId}-default`
      return {
        ...prev,
        [scaleId]: {
          entries: [
            { id: defId, name: `Scale ${scaleId}`, modeStep: null },
            { id: eid, name: trimmed, modeStep: modeStep ?? null },
          ],
          selectedId: eid,
          defaultId: defId,
        },
      }
    })
    setModeStep(modeStep ?? null)
  }
  const removeScaleName = (scaleId, entryId) => {
    setScaleNames((prev) => {
      const data = prev[scaleId]
      if (!data) return prev
      if (entryId === data.defaultId) return prev
      const newEntries = data.entries.filter((e) => e.id !== entryId)
      if (newEntries.length === 0) {
        const next = { ...prev }
        delete next[scaleId]
        return next
      }
      let selectedId = data.selectedId
      if (selectedId === entryId) selectedId = data.defaultId ?? newEntries[0].id
      return { ...prev, [scaleId]: { ...data, entries: newEntries, selectedId } }
    })
  }

  // Scale-settings modal (per-scale name aliases + which alias is displayed).
  const [scaleSettingsOpen, setScaleSettingsOpen] = useState(false)
  const [newAliasText, setNewAliasText] = useState('')
  const [newAliasStep, setNewAliasStep] = useState(null)
  const [addingAlias, setAddingAlias] = useState(false)
  useEffect(() => {
    if (!scaleSettingsOpen) return
    const onKey = (e) => {
      if (e.key === 'Escape') setScaleSettingsOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [scaleSettingsOpen])
  useEffect(() => {
    // Reset the inline "add" form whenever the modal closes or the scale
    // changes underneath it, so a stale name doesn't reappear next open.
    setAddingAlias(false)
    setNewAliasText('')
    setNewAliasStep(null)
  }, [scaleSettingsOpen, selectedId])

  // Scale finder: the user toggles pitch classes in `finderPcs`; we list
  // every (scaleId, root) pair where those pcs are a subset of the scale.
  // Finder lives behind a button in the panel — opens as a modal on demand
  // so it doesn't crowd the right panel by default.
  const [finderPcs, setFinderPcs] = useState(() => new Set())
  const [finderOpen, setFinderOpen] = useState(false)
  useEffect(() => {
    if (!finderOpen) return
    const onKey = (e) => {
      if (e.key === 'Escape') setFinderOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [finderOpen])
  // Mode override (1-indexed scale degree). null = use the scale's default
  // intrinsic root from rootSteps. Resets when the user picks a new scale.
  const [modeStep, setModeStep] = useState(null)
  useEffect(() => {
    if (selectedId == null) {
      setModeStep(null)
      return
    }
    const entry = scaleNameEntryOf(selectedId)
    setModeStep(entry?.modeStep ?? null)
    // Intentionally not depending on scaleNames — we only want the mode reset
    // when the user selects a new scale, not each time an alias is renamed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId])
  // Chord-shapes section: false → show the original 4 filled positions of
  // each pattern; true → show the inverse (the 4 unfilled positions).
  const [chordsInverted, setChordsInverted] = useState(false)
  // Ordering of the ten chord shapes in the section. 'borrowing' (default) =
  // the order from the reference image; 'opposites' = the canonical list
  // reversed. See BORROWING_ORDER / OPPOSITES_ORDER (module scope).
  const [chordOrder, setChordOrder] = useState('borrowing')
  // Scale degree the user is hovering on a bottom mode-dot. Used to preview
  // which note would become the matrix tile-strip's highlighted root if they
  // clicked it. Null when not hovering.
  const [hoveredModeStep, setHoveredModeStep] = useState(null)
  // Sliding modes-row carousel: a monotonically-increasing counter so the
  // track always advances right-to-left, even when the user picks a "lower"
  // root. After a full cycle of 12, an onTransitionEnd handler snaps the
  // counter back modulo 12 with the transition briefly disabled — visually
  // seamless because the cells repeat every 12 indices.
  const [slideOffset, setSlideOffset] = useState(0)
  const [slideSnapping, setSlideSnapping] = useState(false)
  // Which pitch class should sit at step 1 of the strip. Default: the user's
  // root (Mode #1). When a mode is picked, the mode's chosen note takes
  // step 1; the root travels off step 1 but its top-dot highlight follows.
  // modeStep is a 1-indexed position in the SORTED rooted scale.
  const leadPc = (() => {
    const s = selectedId !== null
      ? scales.find((sc) => sc.id === selectedId)
      : null
    if (!s) return root
    const rsDef = rootSteps[s.id - 1]
    const cOff = rsDef && s.notes[rsDef - 1] != null ? s.notes[rsDef - 1] : 0
    const localRooted = s.notes.map((n) => ((n - cOff) % 12 + 12) % 12)
    const localSorted = [...localRooted].sort((a, b) => a - b)
    const rsEff = modeStep ?? 1
    const rootedOffset = localSorted[rsEff - 1] ?? 0
    return (root + rootedOffset) % 12
  })()
  const prevLeadPcRef = useRef(leadPc)
  useEffect(() => {
    const prev = prevLeadPcRef.current
    prevLeadPcRef.current = leadPc
    const delta = ((leadPc - prev) % 12 + 12) % 12
    if (delta === 0) return
    setSlideOffset((o) => o + delta)
  }, [leadPc])
  const handleSlideEnd = (e) => {
    if (e.propertyName !== 'transform') return
    if (slideOffset < 12) return
    setSlideSnapping(true)
    setSlideOffset((o) => ((o % 12) + 12) % 12)
    requestAnimationFrame(() => {
      requestAnimationFrame(() => setSlideSnapping(false))
    })
  }
  // Which chord card is currently hovered, so the left-side dot pattern
  // can light up that rotation's positions (with note labels above) instead
  // of the canonical shape.
  const [hoveredChord, setHoveredChord] = useState(null)
  const [paletteOpen, setPaletteOpen] = useState(false)
  const paletteRef = useRef(null)
  useEffect(() => {
    if (!paletteOpen) return
    const onDocDown = (e) => {
      if (paletteRef.current && !paletteRef.current.contains(e.target)) {
        setPaletteOpen(false)
      }
    }
    document.addEventListener('pointerdown', onDocDown)
    return () => document.removeEventListener('pointerdown', onDocDown)
  }, [paletteOpen])
  const toggleFinderPc = (pc) => {
    setFinderPcs((prev) => {
      const next = new Set(prev)
      if (next.has(pc)) next.delete(pc)
      else next.add(pc)
      return next
    })
  }
  const clearFinder = () => setFinderPcs(new Set())
  const finderMatches = (() => {
    if (finderPcs.size === 0) return []
    const arr = [...finderPcs]
    const out = []
    for (const s of scales) {
      if (!s.notes || s.notes.length === 0) continue
      // Match against the rooted view: each root r means "circle-degree
      // lands on pc r", so we subtract the scale's canonical circleOff
      // before shifting by r — same rule the panel uses to build concrete.
      const rsDef = rootSteps[s.id - 1]
      const cOff = rsDef && s.notes[rsDef - 1] != null ? s.notes[rsDef - 1] : 0
      for (let r = 0; r < 12; r++) {
        const set = new Set(
          s.notes.map((n) => ((n - cOff + r) % 12 + 12) % 12)
        )
        if (arr.every((pc) => set.has(pc))) {
          out.push({ scaleId: s.id, root: r })
        }
      }
    }
    return out
  })()

  const scale = selectedId !== null ? scales.find((s) => s.id === selectedId) : null
  // Each scale has a canonical "circle-degree" (rootSteps[id-1]) — the degree
  // of scale.notes that acts as the scale's intrinsic root. When the user
  // picks a root, we want THAT degree to land on the chosen note, not the
  // first entry of scale.notes. So we shift scale.notes by -circleOff first,
  // making PC 0 = circle-degree; adding `root` then puts the circle on the
  // user's root. Everywhere the app combines scale.notes with `root`, it
  // should go through rootedNotes.
  const scaleCircleOff = scale && rootSteps[scale.id - 1] != null
    ? scale.notes[rootSteps[scale.id - 1] - 1] ?? 0
    : 0
  const rootedNotes = scale
    ? scale.notes.map((n) => ((n - scaleCircleOff) % 12 + 12) % 12)
    : []
  // Ascending-sorted rooted scale. Its position IS the mode number: index 0
  // (= root, offset 0) is Mode #1, ascending up through Mode #8. Every place
  // that maps between a modeStep and a pitch offset goes through this array.
  const sortedRooted = scale
    ? [...rootedNotes].sort((a, b) => a - b)
    : []
  const concrete = scale
    ? rootedNotes.map((n) => (n + root) % 12)
    : []
  const [scalePickerOpen, setScalePickerOpen] = useState(false)
  useEffect(() => {
    if (!scalePickerOpen) return
    const onKey = (e) => {
      if (e.key === 'Escape') setScalePickerOpen(false)
    }
    // Any pointerdown outside the popover / its trigger closes it. The
    // popover's own onClick stopPropagation keeps clicks inside from
    // bubbling here.
    const onDown = (e) => {
      const t = e.target
      if (
        !t.closest('.scale-picker-popover') &&
        !t.closest('.scale-picker-trigger')
      ) {
        setScalePickerOpen(false)
      }
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener('pointerdown', onDown)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('pointerdown', onDown)
    }
  }, [scalePickerOpen])
  // Whether the matrix column is collapsed off-screen so the info panel can
  // take the full width. Also persisted.
  const [matrixCollapsed, setMatrixCollapsed] = useState(() => {
    try {
      return localStorage.getItem('eightFold.matrixCollapsed') === '1'
    } catch {
      return false
    }
  })
  useEffect(() => {
    try {
      localStorage.setItem(
        'eightFold.matrixCollapsed',
        matrixCollapsed ? '1' : '0'
      )
    } catch {}
  }, [matrixCollapsed])
  const visibleScales = scales.filter(
    (s) => s.notes.length > 0 && !hiddenScaleIds.has(s.id)
  )

  const playbackRef = useRef(null)
  const [isPlaying, setIsPlaying] = useState(false)

  const stopScale = () => {
    const pb = playbackRef.current
    if (!pb) return
    playbackRef.current = null
    if (pb.endTimer) clearTimeout(pb.endTimer)
    const now = pb.ctx.currentTime
    for (const { osc, gain } of pb.voices) {
      try {
        gain.gain.cancelScheduledValues(now)
        gain.gain.setValueAtTime(gain.gain.value, now)
        gain.gain.linearRampToValueAtTime(0, now + 0.02)
      } catch {}
      try { osc.stop(now + 0.03) } catch {}
      try { osc.disconnect() } catch {}
      try { gain.disconnect() } catch {}
    }
    try { pb.ctx.close() } catch {}
    setIsPlaying(false)
  }

  useEffect(() => {
    return () => {
      const pb = playbackRef.current
      if (!pb) return
      playbackRef.current = null
      if (pb.endTimer) clearTimeout(pb.endTimer)
      for (const { osc, gain } of pb.voices) {
        try { osc.stop() } catch {}
        try { osc.disconnect() } catch {}
        try { gain.disconnect() } catch {}
      }
      try { pb.ctx.close() } catch {}
    }
  }, [selectedId, root])

  const playScale = () => {
    if (playbackRef.current) {
      stopScale()
      return
    }
    if (!scale || scale.notes.length === 0) return
    const Ctx = window.AudioContext || window.webkitAudioContext
    const ctx = new Ctx()
    const dur = 0.28
    const sorted = [...rootedNotes].sort((a, b) => a - b)
    const sequence = [...sorted, sorted[0] + 12]
    const voices = []
    sequence.forEach((n, i) => {
      const midi = 60 + root + n
      const osc = ctx.createOscillator()
      const gain = ctx.createGain()
      osc.type = 'triangle'
      osc.frequency.value = midiToFreq(midi)
      osc.connect(gain)
      gain.connect(ctx.destination)
      const start = ctx.currentTime + i * dur
      const end = start + dur
      gain.gain.setValueAtTime(0, start)
      gain.gain.linearRampToValueAtTime(0.25, start + 0.015)
      gain.gain.exponentialRampToValueAtTime(0.001, end)
      osc.start(start)
      osc.stop(end + 0.02)
      voices.push({ osc, gain })
    })
    const totalMs = sequence.length * dur * 1000 + 60
    const endTimer = setTimeout(() => {
      if (playbackRef.current && playbackRef.current.ctx === ctx) {
        playbackRef.current = null
        try { ctx.close() } catch {}
        setIsPlaying(false)
      }
    }, totalMs)
    playbackRef.current = { ctx, endTimer, voices }
    setIsPlaying(true)
  }

  return (
    <div
      className="app"
      style={{
        '--accent': accent,
        '--chord1': chord1Color,
        '--chord2': chord2Color,
        '--electron': electronColor,
      }}
    >
      <div className={`frame ${matrixCollapsed ? 'matrix-collapsed' : ''}`}>
        <button
          type="button"
          className="shortcuts-trigger"
          onClick={() => setShortcutsOpen(true)}
          aria-label="keyboard shortcuts"
          title="Keyboard shortcuts"
        >
          ?
        </button>
        <button
          type="button"
          className="settings-trigger"
          onClick={() => setSettingsOpen(true)}
          aria-label="open settings"
          title="Settings"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h0a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51h0a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v0a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
          </svg>
        </button>
        <div className="theme-picker" title="accent color" ref={paletteRef}>
          <span className="theme-label">Accent</span>
          <label className="theme-swatch-wrap">
            <input
              type="color"
              value={accent}
              onChange={(e) => setAccent(e.target.value)}
            />
            <span className="theme-swatch" style={{ background: accent }} />
          </label>
          <button
            type="button"
            className={`theme-more ${paletteOpen ? 'on' : ''}`}
            onClick={() => setPaletteOpen((v) => !v)}
            aria-label="more palette options"
            aria-expanded={paletteOpen}
            title="Chord & electron colors"
          >
            <span className="theme-more-dot" style={{ background: chord1Color }} />
            <span className="theme-more-dot" style={{ background: chord2Color }} />
            <span className="theme-more-dot" style={{ background: electronColor }} />
          </button>
          {paletteOpen && (
            <div className="theme-palette" role="dialog">
              <div className="theme-palette-row">
                <span className="theme-label">Chord 1</span>
                <label className="theme-swatch-wrap">
                  <input
                    type="color"
                    value={chord1Color}
                    onChange={(e) => setChord1Color(e.target.value)}
                  />
                  <span className="theme-swatch" style={{ background: chord1Color }} />
                </label>
              </div>
              <div className="theme-palette-row">
                <span className="theme-label">Chord 2</span>
                <label className="theme-swatch-wrap">
                  <input
                    type="color"
                    value={chord2Color}
                    onChange={(e) => setChord2Color(e.target.value)}
                  />
                  <span className="theme-swatch" style={{ background: chord2Color }} />
                </label>
              </div>
              <div className="theme-palette-row">
                <span className="theme-label">Electrons</span>
                <label className="theme-swatch-wrap">
                  <input
                    type="color"
                    value={electronColor}
                    onChange={(e) => setElectronColor(e.target.value)}
                  />
                  <span className="theme-swatch" style={{ background: electronColor }} />
                </label>
              </div>
            </div>
          )}
        </div>

        {view === 'roll' && scale ? (
          <PianoRoll
            key={activeSongId}
            scale={scale}
            root={root}
            accent={accent}
            onBack={() => setView('matrix')}
            onPlay={playScale}
            templates={templates}
            setTemplates={setTemplates}
            modeStep={modeStep}
            settings={settings}
            songs={songs}
            activeSongId={activeSongId}
            onSelectSong={setActiveSongId}
            onAddSong={addSong}
            onRemoveSong={removeSong}
            onRenameSong={renameSong}
            songGroups={songGroups}
            onAddGroup={addGroup}
            onRemoveGroup={removeGroup}
            onRenameGroup={renameGroup}
            onSetGroupColour={setGroupColour}
            onToggleGroupCollapsed={toggleGroupCollapsed}
            onMoveSong={moveSong}
            onMoveGroup={moveGroup}
            onAssignSongToGroup={assignSongToGroup}
            onFallbackUndo={undoSongState}
            onFallbackRedo={redoSongState}
            initialTracks={activeSong?.tracks}
            initialActiveTrackId={activeSong?.activeTrackId}
            onPersistTracks={(tracks, activeTrackId) =>
              updateActiveSong({ tracks, activeTrackId })
            }
            initialBpm={
              settings.universalPlayback
                ? universalPlayback.bpm ?? activeSong?.bpm
                : activeSong?.bpm
            }
            initialSwing={
              settings.universalPlayback
                ? universalPlayback.swing ?? activeSong?.swing
                : activeSong?.swing
            }
            initialLoop={
              settings.universalPlayback
                ? universalPlayback.loop ?? activeSong?.loop
                : activeSong?.loop
            }
            initialTotalBeats={
              settings.universalPlayback
                ? universalPlayback.totalBeats ?? activeSong?.totalBeats
                : activeSong?.totalBeats
            }
            initialTimeSig={
              settings.universalPlayback
                ? universalPlayback.timeSig ?? activeSong?.timeSig
                : activeSong?.timeSig
            }
            onPersistPlayback={(patch) => {
              if (settings.universalPlayback) {
                setUniversalPlayback((cur) => ({ ...cur, ...patch }))
              } else {
                updateActiveSong(patch)
              }
            }}
            tabSwitchPlayback={settings.tabSwitchPlayback}
          />
        ) : (
        <>
        <div className={`matrix ${selectedId !== null ? 'has-selection' : ''}`}>
          {visibleScales.map((s) => {
            const set = new Set(s.notes)
            const isSel = s.id === selectedId
            const rsDefault = rootSteps[s.id - 1]
            // Matrix stays canonical — the circle always sits on the scale's
            // intrinsic root regardless of the user's mode pick. Mode picking
            // is a panel-side view thing; the matrix is a reference chart.
            const rs = rsDefault
            const intrinsicPc = rs ? s.notes[rs - 1] : null
            // For the selected row, compute the chord-pair pcs in this row's
            // unrotated scale-pc space so we can tint each cell by which
            // chord it belongs to. Off-rows stay neutral.
            let rowLeftSet = null
            let rowRightSet = null
            if (isSel) {
              const pair = chordPairs.find((p) => p.scaleId === s.id)
              const resolved = pair
                ? resolveChordPair(pair, s.notes, 0, rs)
                : null
              if (resolved) {
                rowLeftSet = new Set(
                  resolved.leftNotes.map((p) => (p + intrinsicPc) % 12)
                )
                rowRightSet = new Set(
                  resolved.rightNotes.map((p) => (p + intrinsicPc) % 12)
                )
              }
            }
            // Column index (0..11) for the scale-root cell, so the indicator
            // knows which slot to slide to. The CSS transition on transform
            // visualises the rotation of the scale around different roots.
            const rootColumn = intrinsicPc ?? 0
            const rowChordClass = (pc) => {
              if (!isSel) return ''
              const inL = rowLeftSet && rowLeftSet.has(pc)
              const inR = rowRightSet && rowRightSet.has(pc)
              if (inL && inR) return 'chord-both'
              if (inL) return 'chord-left'
              if (inR) return 'chord-right'
              return ''
            }
            return (
              <div
                key={s.id}
                className={`row ${isSel ? 'selected' : ''}`}
                onClick={() => setSelectedId((cur) => (cur === s.id ? null : s.id))}
                data-scale-id={s.id}
                onMouseEnter={(e) => {
                  // Pin the zoom popup to the left edge of the viewport so it
                  // doesn't overlay the row's scale-pattern cells.
                  const glyph = e.currentTarget.querySelector('.glyph-slot')
                  const r = (glyph ?? e.currentTarget).getBoundingClientRect()
                  setHoverRow(s.id - 1)
                  setHoverPos({ x: 0, y: r.bottom + 8 })
                }}
                onMouseLeave={() => setHoverRow(null)}
              >
                <div className="glyph-zone left">
                  <div className="glyph-slot">
                    <GlyphRow rowIndex={s.id - 1} accent={electronColor} />
                  </div>
                  <div className="connector" />
                </div>
                <div className="row-number">{padId(s.id)}</div>
                <div
                  className="row-cells"
                  style={{ gridTemplateColumns: `repeat(${PITCH_CLASSES}, var(--cell))` }}
                >
                  {Array.from({ length: PITCH_CLASSES }, (_, pc) => {
                    const isOn = set.has(pc)
                    const isRoot = pc === intrinsicPc
                    return (
                      <div
                        key={pc}
                        className={`cell ${isOn ? 'on' : 'off'} ${
                          isRoot ? 'is-scale-root' : ''
                        } ${rowChordClass(pc)}`}
                        style={
                          isOn
                            ? { animationDelay: `${cellPulseDelay(s.id, pc)}s` }
                            : undefined
                        }
                      />
                    )
                  })}
                </div>
              </div>
            )
          })}
        </div>

        <div className="matrix-toolbar">
          <button
            type="button"
            className="matrix-collapse-toggle"
            onClick={() => setMatrixCollapsed((v) => !v)}
            aria-label={
              matrixCollapsed ? 'show scale matrix' : 'hide scale matrix'
            }
            title={
              matrixCollapsed
                ? 'Show the scale matrix'
                : 'Hide the scale matrix (focus on the info panel)'
            }
          >
            <svg
              width="12"
              height="12"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.4"
              strokeLinecap="round"
              strokeLinejoin="round"
              style={{
                transform: matrixCollapsed ? 'rotate(180deg)' : 'none',
                transition: 'transform 0.2s var(--ease)',
              }}
            >
              <polyline points="15 18 9 12 15 6" />
            </svg>
          </button>
          <button
            type="button"
            className="scale-picker-trigger"
            onClick={() => setScalePickerOpen((v) => !v)}
            aria-label="pick which scales to show"
            title="Choose which scales appear in the matrix"
          >
            Scales
          </button>
          {scalePickerOpen && (
            <div
              className="scale-picker-popover"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="scale-picker-header">
                <span className="scale-picker-title">Show scales</span>
                <div className="scale-picker-actions">
                  <button
                    type="button"
                    className="scale-picker-action"
                    onClick={() => setHiddenScaleIds(new Set())}
                  >
                    Select all
                  </button>
                  <button
                    type="button"
                    className="scale-picker-action"
                    onClick={() =>
                      setHiddenScaleIds(
                        new Set(
                          scales.filter((s) => s.notes.length > 0).map((s) => s.id)
                        )
                      )
                    }
                  >
                    Deselect all
                  </button>
                  <button
                    type="button"
                    className="scale-picker-close"
                    onClick={() => setScalePickerOpen(false)}
                    aria-label="close"
                  >
                    ×
                  </button>
                </div>
              </div>
              <ul className="scale-picker-list">
                {scales
                  .filter((s) => s.notes.length > 0)
                  .map((s) => {
                    const checked = !hiddenScaleIds.has(s.id)
                    return (
                      <li key={s.id} className="scale-picker-row">
                        <label>
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={(e) => {
                              setHiddenScaleIds((prev) => {
                                const next = new Set(prev)
                                if (e.target.checked) next.delete(s.id)
                                else next.add(s.id)
                                return next
                              })
                            }}
                          />
                          <span className="scale-picker-row-id">
                            {padId(s.id)}
                          </span>
                          <span className="scale-picker-row-name">
                            {scaleNameOf(s.id)}
                          </span>
                        </label>
                      </li>
                    )
                  })}
              </ul>
            </div>
          )}
        </div>

        <aside className="panel" ref={panelRef}>
          <div className="app-masthead">
            <span className="app-mark">8</span>
            <span className="app-name">Fold Way</span>
          </div>

          <div className="section finder-trigger-section">
            <button
              type="button"
              className="finder-trigger"
              onClick={() => setFinderOpen(true)}
            >
              <span className="finder-trigger-label">Scale finder</span>
              <span className="finder-trigger-sub">
                {finderPcs.size === 0
                  ? 'find scales by notes'
                  : `${finderPcs.size} note${finderPcs.size === 1 ? '' : 's'} · ${finderMatches.length} match${
                      finderMatches.length === 1 ? '' : 'es'
                    }`}
              </span>
            </button>
          </div>

          {(() => {
            // Mode is a 1-indexed position in the sorted rooted scale, with
            // Mode #1 = the user's root and Mode #N ascending by pitch. When
            // no mode is picked, we default to Mode #1 (canonical root view).
            const rs = scale ? modeStep ?? 1 : null
            const inScaleOffset = (c) => !scale || sortedRooted.includes(c)
            const stepOf = (c) => {
              if (!scale) return 0
              const idx = sortedRooted.indexOf(c)
              return idx === -1 ? 0 : idx + 1
            }
            const pair = scale
              ? chordPairs.find((p) => p.scaleId === scale.id)
              : null
            // Colour the strip cells with the EXACT same chord-pair
            // resolution shown in the "Chord pair" section below (raw scale
            // notes + the scale's intrinsic root step), so the strip colours
            // always match that pair instead of drifting with the mode pick.
            const resolved = pair
              ? resolveChordPair(pair, scale.notes, root, rootSteps[scale.id - 1])
              : null
            const leftSet = new Set(resolved ? resolved.leftNotes : [])
            const rightSet = new Set(resolved ? resolved.rightNotes : [])
            const chordClass = (pc) => {
              const inL = leftSet.has(pc)
              const inR = rightSet.has(pc)
              if (inL && inR) return 'chord-both'
              if (inL) return 'chord-left'
              if (inR) return 'chord-right'
              return ''
            }
            return (
              <div className="section">
                <div className="roots-hint top">pick root</div>
                <div className="roots-frame">
                  <div
                    className={`roots ${slideSnapping ? 'snapping' : ''}`}
                    style={{ '--slide': slideOffset }}
                    onTransitionEnd={handleSlideEnd}
                  >
                    {Array.from({ length: 36 }, (_, idx) => {
                      // Render three full chromatic copies so the strip can
                      // translate continuously right-to-left without empty
                      // gaps — handles a few rapid clicks while a transition
                      // is still in progress.
                      const pc = idx % 12
                      const c = ((idx - root) % 12 + 12) % 12
                      const isRootActive = c === 0
                      const inScale = inScaleOffset(c)
                      const step = stepOf(c)
                      const isModeActive = step !== 0 && step === rs
                      const dim = !isRootActive && !inScale
                      const isDuplicate = idx >= 12
                      return (
                        <div
                          key={idx}
                          className={`root-cell ${inScale ? 'in' : 'out'} ${
                            dim ? 'dim' : ''
                          } ${chordClass(pc)}`}
                          aria-hidden={isDuplicate ? 'true' : undefined}
                        >
                          <button
                            type="button"
                            className={`root-dot top ${isRootActive ? 'on' : ''}`}
                            onClick={() => setRoot(pc)}
                            aria-label={`Set root to ${NOTE_DISPLAY[pc]}`}
                            title={`Set root to ${NOTE_DISPLAY[pc]}`}
                            tabIndex={isDuplicate ? -1 : 0}
                          />
                          <button
                            type="button"
                            className={`root-label ${isRootActive ? 'active' : ''}`}
                            onClick={() => setRoot(pc)}
                            tabIndex={isDuplicate ? -1 : 0}
                          >
                            {NOTE_DISPLAY[pc]}
                          </button>
                          <button
                            type="button"
                            className={`root-dot bottom ${isModeActive ? 'on' : ''}`}
                            onClick={inScale ? () => setModeStep(step) : undefined}
                            onMouseEnter={
                              inScale
                                ? () => setHoveredModeStep(step)
                                : undefined
                            }
                            onMouseLeave={
                              inScale
                                ? () => setHoveredModeStep(null)
                                : undefined
                            }
                            disabled={!inScale}
                            aria-label={inScale ? `Mode #${step}` : ''}
                            title={inScale ? `Mode #${step}` : ''}
                            tabIndex={isDuplicate ? -1 : 0}
                          />
                        </div>
                      )
                    })}
                  </div>
                </div>
                <div className="roots-hint bottom">
                  pick mode
                  {scale && (() => {
                    // The bottom dot picks which note the scale sequence
                    // *starts* on — the root itself (top dot / hero) stays
                    // put. Caption shows the concrete pitch of that starting
                    // note in the rooted scale (rootedNotes has PC 0 at the
                    // circle-degree, i.e., the user's root).
                    const previewStep = hoveredModeStep ?? rs
                    if (!previewStep) return null
                    const offset = sortedRooted[previewStep - 1]
                    if (offset == null) return null
                    const startPc = (offset + root) % 12
                    return (
                      <span
                        className={`roots-hint-root ${
                          hoveredModeStep != null ? 'preview' : ''
                        }`}
                      >
                        {' '}· starts on {noteName(startPc)}
                      </span>
                    )
                  })()}
                </div>
              </div>
            )
          })()}

          {scale ? (
            <>
              <div className="section">
                <div className="hero">
                  <div className="hero-name-row">
                    <input
                      type="text"
                      className="hero-number hero-name-input"
                      value={scaleNameOf(scale.id)}
                      onChange={(e) => renameScale(scale.id, e.target.value)}
                      onFocus={(e) => e.target.select()}
                      aria-label={`Name for scale ${scale.id}`}
                    />
                    <span className="hero-caption">
                      Scale #{padId(scale.id)}
                      {(() => {
                        // Longest run of chromatic-consecutive notes in the
                        // scale — length of the longest sequence n, n+1,
                        // n+2, … all present (mod 12, so the 11 → 0 wrap
                        // counts). For each scale note, walk forward
                        // through the pc set until it breaks; take the max.
                        const set = new Set(scale.notes)
                        let maxRun = 0
                        for (const start of scale.notes) {
                          let len = 0
                          while (
                            set.has((start + len) % 12) &&
                            len < scale.notes.length
                          ) len++
                          if (len > maxRun) maxRun = len
                        }
                        return (
                          <>
                            {' · Chromatic '}
                            {maxRun}
                          </>
                        )
                      })()}
                      {(() => {
                        const dg = deltaGroupOf(scale.id)
                        return dg ? (
                          <>
                            {' · '}
                            <span
                              className={`hero-delta hero-delta-${dg.key}`}
                              title={`Delta group ${dg.label} (${dg.symbol})`}
                            >
                              Δ {dg.label} ({dg.symbol})
                            </span>
                          </>
                        ) : null
                      })()}
                      {' · rooted in '}
                      {NOTE_DISPLAY[root]}
                    </span>
                  </div>
                  <div className="hero-controls">
                    <button
                      type="button"
                      className="hero-settings"
                      onClick={() => setScaleSettingsOpen(true)}
                      aria-label="scale settings"
                      title="Scale settings — manage alternative names"
                    >
                      <svg
                        width="13"
                        height="13"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        aria-hidden="true"
                      >
                        <circle cx="12" cy="12" r="3" />
                        <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
                      </svg>
                      <span className="hero-settings-label">scale settings</span>
                    </button>
                    <button
                      type="button"
                      className="hero-clear"
                      onClick={() => setSelectedId(null)}
                      aria-label="clear scale selection"
                      title="Clear selection (Esc)"
                    >
                      ×
                    </button>
                  </div>
                  <div className="hero-actions">
                    <button
                      className="open-roll"
                      onClick={() => setView('roll')}
                      disabled={concrete.length === 0}
                    >
                      open roll
                    </button>
                    <button
                      className={`play${isPlaying ? ' is-playing' : ''}`}
                      onClick={playScale}
                      disabled={concrete.length === 0}
                      aria-label={isPlaying ? 'stop scale' : 'play scale'}
                    >
                      {isPlaying ? <StopIcon /> : <PlayIcon />}
                    </button>
                  </div>
                </div>
              </div>

              <div className="section">
                <div className="label">Chord pair</div>
                {(() => {
                  const pair = chordPairs.find((p) => p.scaleId === scale.id)
                  if (!pair) {
                    return <div className="hint">No chord-pair entry for this scale.</div>
                  }
                  const rs = rootSteps[scale.id - 1]
                  const resolved = resolveChordPair(pair, scale.notes, root, rs)
                  if (!resolved) {
                    return (
                      <div className="chord-pair">
                        <div className="chord-pair-row">
                          <span className="chord-pair-name">{pair.left}</span>
                          <span className="chord-pair-distance">{pair.distance}</span>
                          <span className="chord-pair-name">{pair.right}</span>
                        </div>
                        <div className="hint">No root in this scale fits both chord shapes — check chord intervals in src/chordVocab.js or the pair in src/chordPairs.js.</div>
                      </div>
                    )
                  }
                  return (
                    <div className="chord-pair">
                      <div className="chord-pair-row">
                        <div className="chord-pair-side chord-left">
                          <div className="chord-pair-name">
                            {noteName(resolved.leftRoot)} {pair.left}
                          </div>
                        </div>
                        <div className="chord-pair-distance">{pair.distance}</div>
                        <div className="chord-pair-side chord-right">
                          <div className="chord-pair-name">
                            {noteName(resolved.rightRoot)} {pair.right}
                          </div>
                        </div>
                      </div>
                    </div>
                  )
                })()}
              </div>

              <div className="section">
                <div className="label">Electrons</div>
                <div className="electrons">
                  {Array.from({ length: 12 }, (_, c) => {
                    if (rootedNotes.includes(c)) return null
                    const pc = (root + c) % 12
                    return (
                      <span key={c} className="electron-note">
                        {NOTE_DISPLAY[pc]}
                      </span>
                    )
                  })}
                </div>
              </div>

              {(() => {
                // Reorder (don't shift) the rooted scale so degree 1 is the
                // active mode's tonic. Mode #1 = root (default) puts PC 0
                // first; other modes rotate around their pitch offset.
                const rsActive = modeStep ?? 1
                const intrinsicPc = sortedRooted[rsActive - 1] ?? 0
                const sortedNotes = sortedRooted
                const startIdx = Math.max(0, sortedNotes.indexOf(intrinsicPc))
                const rotatedScale = [
                  ...sortedNotes.slice(startIdx),
                  ...sortedNotes.slice(0, startIdx),
                ]
                const invertShape = (shape) => {
                  const set = new Set(shape)
                  const out = []
                  for (let i = 1; i <= 8; i++) if (!set.has(i)) out.push(i)
                  return out
                }
                return (
                  <div className="section chord-patterns-section">
                    <div className="chord-patterns-header">
                      <span className="label">Chords</span>
                      <div className="chord-order-toggle">
                        <button
                          type="button"
                          className={`chord-order-btn ${chordOrder === 'borrowing' ? 'on' : ''}`}
                          onClick={() => setChordOrder('borrowing')}
                          aria-pressed={chordOrder === 'borrowing'}
                          title="Order the chord shapes by the borrowing sequence"
                        >
                          Borrowing
                        </button>
                        <button
                          type="button"
                          className={`chord-order-btn ${chordOrder === 'opposites' ? 'on' : ''}`}
                          onClick={() => setChordOrder('opposites')}
                          aria-pressed={chordOrder === 'opposites'}
                          title="Order the chord shapes by opposites (reversed)"
                        >
                          Opposites
                        </button>
                      </div>
                      <button
                        type="button"
                        className={`chord-invert ${chordsInverted ? 'on' : ''}`}
                        onClick={() => setChordsInverted((v) => !v)}
                        aria-pressed={chordsInverted}
                        aria-label="Invert chord patterns"
                        title={
                          chordsInverted
                            ? 'Show original chord patterns (the filled notes)'
                            : 'Show inverse chord patterns (the blank notes)'
                        }
                      >
                        <svg
                          width="13"
                          height="13"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="2"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          aria-hidden="true"
                        >
                          <path d="M4 7h12" />
                          <path d="M14 4l3 3-3 3" />
                          <path d="M20 17H8" />
                          <path d="M10 20l-3-3 3-3" />
                        </svg>
                      </button>
                    </div>
                    {(() => {
                      const order = CHORD_ORDERS[chordOrder] ?? BORROWING_ORDER
                      const groups = partitionChordOrder(
                        order,
                        CHORD_GROUP_SIZES[chordOrder] ?? [order.length]
                      )
                      let running = 0
                      return groups.map((group, groupIdx) => (
                        <div key={groupIdx} className="chord-pattern-group">
                          {group.map((shapeIdx) => {
                            const idx = running++
                            const shape = CHORD_SHAPES[shapeIdx]
                            const useShape = chordsInverted
                              ? invertShape(shape)
                              : shape
                      const canonicalSet = new Set(useShape)
                      // All 8 rotations of the pattern within the 8-note
                      // scale, deduped by POSITION SET (not chord PCs).
                      // Only a pattern with internal rotational symmetry —
                      // like [1,3,5,7] which is invariant under a 2-degree
                      // shift — collapses below 8 cards; every other shape
                      // has 8 distinct position sets and thus 8 cards.
                      const perms = []
                      const seenPositions = new Set()
                      for (let r = 0; r < 8; r++) {
                        const positions = useShape.map(
                          (p) => ((p - 1 + r) % 8) + 1
                        )
                        const posKey = [...positions]
                          .sort((a, b) => a - b)
                          .join(',')
                        if (seenPositions.has(posKey)) continue
                        seenPositions.add(posKey)
                        const pcs = positions.map(
                          (p) => (rotatedScale[p - 1] + root) % 12
                        )
                        perms.push({ positions, pcs })
                      }
                      // If a chord card in this row is hovered, the dot
                      // pattern follows that rotation. Otherwise it shows
                      // the canonical pattern from the image.
                      const hovered =
                        hoveredChord && hoveredChord.rowIdx === idx
                          ? perms[hoveredChord.permIdx]
                          : null
                      const activeSet = hovered
                        ? new Set(hovered.positions)
                        : canonicalSet
                      const hoveredSpelling = hovered
                        ? hovered.pcs.map((pc) => noteName(pc)).join(' ')
                        : ''
                      return (
                        <div key={idx} className="chord-pattern-row">
                          <div className="chord-pattern-dots">
                            {Array.from({ length: 8 }, (_, i) => (
                              <span
                                key={i}
                                className={`chord-pattern-dot ${
                                  activeSet.has(i + 1) ? 'on' : 'off'
                                }`}
                              />
                            ))}
                          </div>
                          <div className="chord-pattern-spelling">
                            {hoveredSpelling}
                          </div>
                          <div className="chord-pattern-list">
                            {perms.map((perm, j) => {
                              const spelling = perm.pcs
                                .map((pc) => noteName(pc))
                                .join(' ')
                              const cyc = chordCyclicIntervals(perm.pcs)
                                const glyphId = findGlyphForCyclic(cyc)
                              const titleScale =
                                glyphId !== null
                                  ? ` · matches scale ${glyphsRight[glyphId].scaleId}`
                                  : ' · no glyph match'
                              return (
                                <div
                                  key={j}
                                  className="chord-pattern-card"
                                  title={`degrees ${perm.positions.join('·')} → ${spelling}${titleScale}`}
                                  onMouseEnter={() =>
                                    setHoveredChord({ rowIdx: idx, permIdx: j })
                                  }
                                  onMouseLeave={() => setHoveredChord(null)}
                                >
                                  {glyphId !== null ? (
                                    <>
                                      <GlyphRight
                                        rowIndex={glyphId}
                                        accent={accent}
                                      />
                                      <span className="chord-pattern-card-label">
                                        glyph {glyphsRight[glyphId].scaleId}
                                      </span>
                                    </>
                                  ) : (
                                    <span className="chord-pattern-card-empty">·</span>
                                  )}
                                </div>
                              )
                            })}
                          </div>
                        </div>
                      )
                          })}
                        </div>
                      ))
                    })()}
                  </div>
                )
              })()}
            </>
          ) : (
            <div className="section">
              <div className="hint">Choose a scale.</div>
            </div>
          )}
        </aside>
        </>
        )}
      </div>

      {hoverRow !== null && view === 'matrix' && (
        <div
          className="glyph-popup"
          style={{ left: hoverPos.x, top: hoverPos.y }}
        >
          <GlyphRow rowIndex={hoverRow} accent={electronColor} />
          <div className="glyph-popup-caption">Scale {padId(hoverRow + 1)}</div>
        </div>
      )}

      {finderOpen && (
        <div className="modal-backdrop" onClick={() => setFinderOpen(false)}>
          <div
            className="modal finder-modal"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="finder-modal-header">
              <h3>Scale finder</h3>
              <button
                type="button"
                className="finder-modal-close"
                onClick={() => setFinderOpen(false)}
                aria-label="close scale finder"
              >
                ×
              </button>
            </div>
            <p className="modal-sub">
              Tap notes to find every scale + root they fit.
            </p>
            <div className="finder-row">
              {Array.from({ length: 12 }, (_, pc) => {
                const isOn = finderPcs.has(pc)
                return (
                  <button
                    key={pc}
                    type="button"
                    className={`finder-cell ${isOn ? 'on' : 'off'}`}
                    onClick={() => toggleFinderPc(pc)}
                  >
                    {NOTE_DISPLAY[pc]}
                  </button>
                )
              })}
            </div>
            {finderPcs.size === 0 ? (
              <div className="hint">No notes selected yet.</div>
            ) : finderMatches.length === 0 ? (
              <div className="hint">No scale contains all of these notes.</div>
            ) : (
              <div className="finder-results">
                <div className="finder-count">
                  {finderMatches.length} match{finderMatches.length === 1 ? '' : 'es'}
                </div>
                <ul className="finder-list">
                  {finderMatches.map(({ scaleId, root: r }) => (
                    <li
                      key={`${scaleId}-${r}`}
                      className="finder-match"
                      onClick={() => {
                        setSelectedId(scaleId)
                        setRoot(r)
                        setFinderOpen(false)
                      }}
                    >
                      <span className="finder-match-name">
                        {scaleNameOf(scaleId)}
                      </span>
                      <span className="finder-match-root">
                        rooted in {NOTE_DISPLAY[r]}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {finderPcs.size > 0 && (
              <div className="modal-actions">
                <button type="button" onClick={clearFinder}>
                  Clear
                </button>
                <button
                  type="button"
                  className="primary"
                  onClick={() => setFinderOpen(false)}
                >
                  Done
                </button>
              </div>
            )}
          </div>
        </div>
      )}

      {shortcutsOpen && (
        <div className="modal-backdrop" onClick={() => setShortcutsOpen(false)}>
          <div
            className="modal shortcuts-modal"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="settings-modal-header">
              <h3>Keyboard shortcuts</h3>
              <button
                type="button"
                className="finder-modal-close"
                onClick={() => setShortcutsOpen(false)}
                aria-label="close"
              >
                ×
              </button>
            </div>
            <p className="modal-sub">
              All shortcuts are active in the piano roll unless noted.
            </p>
            {[
              {
                title: 'Playback',
                items: [
                  ['Space', 'Play / pause'],
                  ['Enter', 'Return playhead to last start; press again for beat 0'],
                ],
              },
              {
                title: 'Edit',
                items: [
                  ['Ctrl / ⌘ + Z', 'Undo'],
                  ['Ctrl / ⌘ + Shift + Z, Ctrl + Y', 'Redo'],
                  ['Ctrl / ⌘ + A', 'Select all notes'],
                  ['Ctrl / ⌘ + C', 'Copy selection'],
                  ['Ctrl / ⌘ + V', 'Paste at playhead (or origin beat)'],
                  ['P + number', 'Set the fretboard position (lower fret of the 5-fret span)'],
                  ['R', 'Make a Rune from the selection (drag to climb; Delete to bake)'],
                  ['Delete / Backspace', 'Delete selected notes'],
                  ['Escape', 'Clear selection / cancel template / drop loop'],
                ],
              },
              {
                title: 'Transform selection',
                items: [
                  ['Shift + H', 'Flip horizontally (mirror in time)'],
                  ['Shift + V', 'Flip vertically (mirror in pitch)'],
                  ['] / [', 'Stretch / compress selection in time (lengths + gaps scale together)'],
                  ['T', 'Toggle Rotate mode (↑ / ↓ rotate pitches)'],
                  ['Arrow keys', 'Move selection by one step / beat'],
                  ['T + ↑ / ↓', 'Rotate the selection’s pitches'],
                ],
              },
              {
                title: 'Grid & placement',
                items: [
                  ['Alt + click + drag', 'Insert a note and drag its length'],
                  ['Right-click on note', 'Delete the note (or whole selection)'],
                  ['Long-press on touch', 'Delete a note'],
                  [
                    'Ctrl (held on click / drag)',
                    'Invert scale-snap mode momentarily',
                  ],
                  ['Shift + drag from note', 'Start a marquee from that note'],
                  ['Ctrl / ⌘ + wheel', 'Zoom horizontally'],
                  ['Ctrl / ⌘ + Shift + wheel', 'Zoom vertically'],
                  ['Shift + wheel', 'Scroll horizontally'],
                ],
              },
              {
                title: 'Rhythm entry',
                items: [
                  ['Type a number', 'Divide the unit (beat or bar): ÷1 = whole, ÷2 = half, ÷3 = triplet, ÷4 = quarter, ÷6 = six per unit…'],
                  ['Type digits fast', 'Multi-digit values: 1 2 in quick succession → ÷12'],
                  ['X, then a number', 'Set a multiplier for the note length'],
                  ['Rhythm unit box', 'Click BEAT/BAR to choose what the division refers to'],
                ],
              },
              {
                title: 'Matrix view',
                items: [
                  ['Arrow keys / Home / End', 'Navigate through visible scales'],
                  ['Escape', 'Clear scale selection'],
                ],
              },
            ].map((section) => (
              <div key={section.title} className="shortcuts-section">
                <div className="shortcuts-section-title">{section.title}</div>
                <ul className="shortcuts-list">
                  {section.items.map(([keys, desc]) => (
                    <li key={keys} className="shortcuts-row">
                      <span className="shortcuts-keys">{keys}</span>
                      <span className="shortcuts-desc">{desc}</span>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </div>
      )}

      {settingsOpen && (
        <div className="modal-backdrop" onClick={() => setSettingsOpen(false)}>
          <div
            className="modal settings-modal"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="settings-modal-header">
              <h3>Settings</h3>
              <button
                type="button"
                className="finder-modal-close"
                onClick={() => setSettingsOpen(false)}
                aria-label="close settings"
              >
                ×
              </button>
            </div>
            <div className="settings-row">
              <div className="settings-row-text">
                <div className="settings-row-label">
                  Allow notes outside the scale
                </div>
                <div className="settings-row-sub">
                  Place notes on any pitch in the piano roll, not just
                  in-scale rows. Useful for chromatic passing tones.
                </div>
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={settings.allowOutOfScale}
                className={`settings-switch ${
                  settings.allowOutOfScale ? 'on' : ''
                }`}
                onClick={() =>
                  setSettings((s) => ({
                    ...s,
                    allowOutOfScale: !s.allowOutOfScale,
                  }))
                }
              >
                <span className="settings-switch-knob" />
              </button>
            </div>

            <div className="settings-row">
              <div className="settings-row-text">
                <div className="settings-row-label">
                  Use flats instead of sharps
                </div>
                <div className="settings-row-sub">
                  Display black-key notes as D♭ / E♭ / G♭ / A♭ / B♭ instead
                  of C♯ / D♯ / F♯ / G♯ / A♯ across the app.
                </div>
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={settings.useFlats}
                className={`settings-switch ${settings.useFlats ? 'on' : ''}`}
                onClick={() =>
                  setSettings((s) => ({ ...s, useFlats: !s.useFlats }))
                }
              >
                <span className="settings-switch-knob" />
              </button>
            </div>

            <div className="settings-row">
              <div className="settings-row-text">
                <div className="settings-row-label">
                  Shared tempo / swing / loop across tabs
                </div>
                <div className="settings-row-sub">
                  When on, changing tempo, swing, the beat count, or the
                  loop region in one tab applies the same value to every
                  other tab. Off — each tab keeps its own settings.
                </div>
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={settings.universalPlayback}
                className={`settings-switch ${
                  settings.universalPlayback ? 'on' : ''
                }`}
                onClick={() =>
                  setSettings((s) => ({
                    ...s,
                    universalPlayback: !s.universalPlayback,
                  }))
                }
              >
                <span className="settings-switch-knob" />
              </button>
            </div>

            <div className="settings-row">
              <div className="settings-row-text">
                <div className="settings-row-label">
                  Playback on tab switch
                </div>
                <div className="settings-row-sub">
                  Stop — playback stops when you switch song tabs. Continue
                  — playback resumes on the new tab at the same beat.
                </div>
              </div>
              <div className="settings-segmented">
                <button
                  type="button"
                  className={`settings-segmented-btn ${
                    settings.tabSwitchPlayback === 'stop' ? 'on' : ''
                  }`}
                  onClick={() =>
                    setSettings((s) => ({ ...s, tabSwitchPlayback: 'stop' }))
                  }
                >
                  Stop
                </button>
                <button
                  type="button"
                  className={`settings-segmented-btn ${
                    settings.tabSwitchPlayback === 'continue' ? 'on' : ''
                  }`}
                  onClick={() =>
                    setSettings((s) => ({
                      ...s,
                      tabSwitchPlayback: 'continue',
                    }))
                  }
                >
                  Continue
                </button>
              </div>
            </div>

            <div className="settings-row settings-row-column">
              <div className="settings-row-text">
                <div className="settings-row-label">Project</div>
                <div className="settings-row-sub">
                  Download every song, track, group, template, and scale
                  setting as a single .json file — or load a file someone
                  else shared with you. Import replaces the current session.
                </div>
              </div>
              <div className="settings-actions">
                <button
                  type="button"
                  className="settings-action"
                  onClick={exportSession}
                >
                  Export session
                </button>
                <label className="settings-action">
                  Import session
                  <input
                    type="file"
                    accept="application/json,.json"
                    onChange={(e) => {
                      const file = e.target.files?.[0]
                      if (file) importSession(file)
                      // Reset so the same file can be picked again if the
                      // import failed or the user re-shares it.
                      e.target.value = ''
                    }}
                    style={{ display: 'none' }}
                  />
                </label>
              </div>
            </div>
          </div>
        </div>
      )}

      {scaleSettingsOpen && scale && (() => {
        const data = scaleNames[scale.id]
        const entries = data?.entries ?? []
        const selectedEntryId = data?.selectedId
        const defaultEntryId = data?.defaultId
        const sortedNotes = [...scale.notes].sort((a, b) => a - b)
        return (
          <div
            className="modal-backdrop"
            onClick={() => setScaleSettingsOpen(false)}
          >
            <div
              className="modal scale-settings-modal"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="settings-modal-header">
                <h3>Scale settings</h3>
                <button
                  type="button"
                  className="finder-modal-close"
                  onClick={() => setScaleSettingsOpen(false)}
                  aria-label="close scale settings"
                >
                  ×
                </button>
              </div>

              <div className="scale-settings-field">
                <div className="scale-settings-field-label">Selected name:</div>
                <select
                  className="scale-settings-select"
                  value={selectedEntryId ?? ''}
                  onChange={(e) => selectScaleName(scale.id, e.target.value)}
                  disabled={entries.length === 0}
                >
                  {entries.length === 0 && (
                    <option value="">{`Scale ${scale.id}`}</option>
                  )}
                  {entries.map((e) => (
                    <option key={e.id} value={e.id}>
                      {e.name}
                    </option>
                  ))}
                </select>
              </div>

              <div className="scale-settings-field-label">All Names:</div>
              {(() => {
                // When the scale has no persisted entries yet, synthesize a
                // virtual default one so the list — including its pattern
                // strip — renders from the very first open of the modal.
                // No state mutation: only cosmetic.
                const displayEntries =
                  entries.length === 0
                    ? [{ id: '__default', name: `Scale ${scale.id}`, modeStep: null }]
                    : entries
                const displayDefaultId =
                  entries.length === 0 ? '__default' : defaultEntryId
                const displaySelectedId =
                  entries.length === 0 ? '__default' : selectedEntryId
                return (
                <ul className="scale-settings-list">
                  {displayEntries.map((e) => {
                    const isDefault = e.id === displayDefaultId
                    const isSelected = e.id === displaySelectedId
                    const tags = []
                    if (isDefault) tags.push('Default')
                    if (isSelected) tags.push('selected')
                    // Root pc for this entry's modeStep (1-indexed position
                    // in sortedNotes). When the entry has no modeStep
                    // override — i.e. the default entry as it ships — fall
                    // back to the scale's canonical intrinsic root
                    // (rootSteps[id-1]) so the default line still shows
                    // *its* root visually rather than an unmarked strip.
                    const rsDefault = rootSteps[scale.id - 1]
                    const defaultRootPc =
                      rsDefault && scale.notes[rsDefault - 1] != null
                        ? scale.notes[rsDefault - 1]
                        : null
                    const entryRootPc =
                      e.modeStep && sortedNotes[e.modeStep - 1] != null
                        ? sortedNotes[e.modeStep - 1]
                        : defaultRootPc
                    return (
                      <li key={e.id} className="scale-settings-entry">
                        <div className="scale-settings-entry-head">
                          <span className="scale-settings-entry-name">
                            {e.name}
                            {tags.length > 0 && ` (${tags.join(', ')})`}
                          </span>
                          {!isDefault && (
                            <button
                              type="button"
                              className="scale-settings-remove"
                              onClick={() => removeScaleName(scale.id, e.id)}
                              aria-label={`remove ${e.name}`}
                              title="Remove this alias"
                            >
                              ×
                            </button>
                          )}
                        </div>
                        <div className="scale-settings-entry-pattern">
                          {Array.from({ length: 12 }, (_, c) => {
                            const inScale = scale.notes.includes(c)
                            const isRoot =
                              entryRootPc != null && entryRootPc === c
                            return (
                              <span
                                key={c}
                                className={`scale-settings-cell readonly ${
                                  inScale ? 'on' : 'off'
                                } ${isRoot ? 'picked' : ''}`}
                                title={
                                  isRoot
                                    ? 'Root for this name'
                                    : inScale
                                    ? 'In scale'
                                    : ''
                                }
                              />
                            )
                          })}
                        </div>
                      </li>
                    )
                  })}
                </ul>
                )
              })()}

              {addingAlias ? (
                <div className="scale-settings-form">
                  <div className="scale-settings-form-label">
                    Pick a root for this name:
                  </div>
                  <div className="scale-settings-pattern">
                    {Array.from({ length: 12 }, (_, c) => {
                      const inScale = scale.notes.includes(c)
                      const degree = inScale ? sortedNotes.indexOf(c) + 1 : 0
                      const isPicked = degree !== 0 && degree === newAliasStep
                      return (
                        <button
                          key={c}
                          type="button"
                          className={`scale-settings-cell ${
                            inScale ? 'on' : 'off'
                          } ${isPicked ? 'picked' : ''}`}
                          onClick={
                            inScale ? () => setNewAliasStep(degree) : undefined
                          }
                          disabled={!inScale}
                          aria-label={
                            inScale ? `Root at degree ${degree}` : 'not in scale'
                          }
                        />
                      )
                    })}
                  </div>
                  <input
                    type="text"
                    className="scale-settings-input"
                    value={newAliasText}
                    onChange={(e) => setNewAliasText(e.target.value)}
                    placeholder="Alternative name"
                    autoFocus
                  />
                  <div className="modal-actions">
                    <button
                      type="button"
                      onClick={() => {
                        setAddingAlias(false)
                        setNewAliasText('')
                        setNewAliasStep(null)
                      }}
                    >
                      Cancel
                    </button>
                    <button
                      type="button"
                      className="primary"
                      disabled={!newAliasText.trim() || newAliasStep == null}
                      onClick={() => {
                        addScaleName(scale.id, newAliasText, newAliasStep)
                        setAddingAlias(false)
                        setNewAliasText('')
                        setNewAliasStep(null)
                      }}
                    >
                      Save
                    </button>
                  </div>
                </div>
              ) : (
                <button
                  type="button"
                  className="scale-settings-add"
                  onClick={() => setAddingAlias(true)}
                  aria-label="Add another name"
                  title="Add another name"
                >
                  +
                </button>
              )}
            </div>
          </div>
        )
      })()}
    </div>
  )
}

export default App
