import { useState, useEffect, useRef } from 'react'
import { scales, PITCH_CLASSES, rootSteps } from './scales'
import { glyphs, GLYPH_VIEWBOX } from './glyphs'
import { templates as defaultTemplates } from './templates'
import { chordPairs } from './chordPairs'
import { resolveChordPair, pcName } from './chordVocab'
import PianoRoll from './PianoRoll'
import './App.css'

const ORIGINAL_PURPLE = '#9c36b5'

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']
const NOTE_DISPLAY = NOTE_NAMES.map((n) => n.replace('#', '♯'))

function midiToFreq(midi) {
  return 440 * Math.pow(2, (midi - 69) / 12)
}

function padId(id) {
  return String(id).padStart(2, '0')
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
  const [templates, setTemplates] = useState(defaultTemplates)
  const [scaleNames, setScaleNames] = useState(() => {
    try {
      return JSON.parse(localStorage.getItem('eightFold.scaleNames') || '{}')
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

  // Matrix-view keyboard navigation. Arrow keys step through the scales,
  // Home/End jump to the first / last, Esc clears. Skips when focus is on
  // an editable element so renaming a scale doesn't hijack the keys.
  useEffect(() => {
    if (view !== 'matrix') return
    const onKey = (e) => {
      const tag = e.target.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || e.target.isContentEditable) return
      const visible = scales.filter((s) => s.notes && s.notes.length > 0)
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
  }, [view, selectedId])

  const scaleNameOf = (id) => scaleNames[id] ?? `Scale ${id}`
  const renameScale = (id, name) => {
    setScaleNames((prev) => {
      const trimmed = (name || '').trim()
      const next = { ...prev }
      if (!trimmed || trimmed === `Scale ${id}`) delete next[id]
      else next[id] = trimmed
      return next
    })
  }

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
    setModeStep(null)
  }, [selectedId])
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
      for (let r = 0; r < 12; r++) {
        const set = new Set(s.notes.map((n) => (n + r) % 12))
        if (arr.every((pc) => set.has(pc))) {
          out.push({ scaleId: s.id, root: r })
        }
      }
    }
    return out
  })()

  const scale = selectedId !== null ? scales.find((s) => s.id === selectedId) : null
  const concrete = scale ? scale.notes.map((n) => (n + root) % 12) : []
  const visibleScales = scales.filter((s) => s.notes.length > 0)

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
    const sorted = [...scale.notes].sort((a, b) => a - b)
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
      <div className="frame">
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
            scale={scale}
            root={root}
            accent={accent}
            onBack={() => setView('matrix')}
            onPlay={playScale}
            templates={templates}
            setTemplates={setTemplates}
            modeStep={modeStep}
          />
        ) : (
        <>
        <div className={`matrix ${selectedId !== null ? 'has-selection' : ''}`}>
          {visibleScales.map((s) => {
            const set = new Set(s.notes)
            const isSel = s.id === selectedId
            const rs = rootSteps[s.id - 1]
            const intrinsicPc = rs ? s.notes[rs - 1] : null
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
                        }`}
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
            const defaultRs = scale ? rootSteps[scale.id - 1] : null
            const rs = scale ? modeStep ?? defaultRs : null
            const intrinsicPc = scale && rs ? scale.notes[rs - 1] : 0
            const rotated = scale
              ? scale.notes.map((n) => (n - intrinsicPc + 12) % 12)
              : []
            const inRotated = (c) => !scale || rotated.includes(c)
            // For a chromatic offset c (0..11) relative to root, return its
            // 1-indexed scale degree, or 0 if it's not in the rotated scale.
            const degreeOf = (c) => {
              const idx = rotated.indexOf(c)
              return idx === -1 ? 0 : idx + 1
            }
            const pair = scale
              ? chordPairs.find((p) => p.scaleId === scale.id)
              : null
            const resolved = pair
              ? resolveChordPair(pair, scale.notes, root, rs)
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
                <div className="roots">
                  {Array.from({ length: 12 }, (_, c) => {
                    const pc = (root + c) % 12
                    const isRootActive = c === 0
                    const inScale = inRotated(c)
                    const degree = degreeOf(c)
                    const isModeActive = degree !== 0 && degree === rs
                    const dim = !isRootActive && !inScale
                    return (
                      <div
                        key={c}
                        className={`root-cell ${inScale ? 'in' : 'out'} ${
                          dim ? 'dim' : ''
                        } ${chordClass(pc)}`}
                      >
                        <button
                          type="button"
                          className={`root-dot top ${isRootActive ? 'on' : ''}`}
                          onClick={() => setRoot(pc)}
                          aria-label={`Set root to ${NOTE_DISPLAY[pc]}`}
                          title={`Set root to ${NOTE_DISPLAY[pc]}`}
                        />
                        <button
                          type="button"
                          className={`root-label ${isRootActive ? 'active' : ''}`}
                          onClick={() => setRoot(pc)}
                        >
                          {NOTE_DISPLAY[pc]}
                        </button>
                        <button
                          type="button"
                          className={`root-dot bottom ${isModeActive ? 'on' : ''}`}
                          onClick={inScale ? () => setModeStep(degree) : undefined}
                          disabled={!inScale}
                          aria-label={
                            inScale
                              ? `Start scale on degree ${degree} (${NOTE_DISPLAY[pc]})`
                              : ''
                          }
                          title={
                            inScale
                              ? `Start scale on degree ${degree}`
                              : ''
                          }
                        />
                      </div>
                    )
                  })}
                </div>
                <div className="roots-hint bottom">pick mode</div>
              </div>
            )
          })()}

          {scale ? (
            <>
              <div className="section">
                <div className="hero">
                  <input
                    type="text"
                    className="hero-number hero-name-input"
                    value={scaleNameOf(scale.id)}
                    onChange={(e) => renameScale(scale.id, e.target.value)}
                    onFocus={(e) => e.target.select()}
                    aria-label={`Name for scale ${scale.id}`}
                  />
                  <button
                    type="button"
                    className="hero-clear"
                    onClick={() => setSelectedId(null)}
                    aria-label="clear scale selection"
                    title="Clear selection (Esc)"
                  >
                    ×
                  </button>
                  <div className="hero-caption">rooted in {NOTE_DISPLAY[root]}</div>
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
                            {pcName(resolved.leftRoot)} {pair.left}
                          </div>
                          <div className="chord-pair-notes">
                            {resolved.leftNotes.map((pc) => pcName(pc)).join(' ')}
                          </div>
                        </div>
                        <div className="chord-pair-distance">{pair.distance}</div>
                        <div className="chord-pair-side chord-right">
                          <div className="chord-pair-name">
                            {pcName(resolved.rightRoot)} {pair.right}
                          </div>
                          <div className="chord-pair-notes">
                            {resolved.rightNotes.map((pc) => pcName(pc)).join(' ')}
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
                    if (scale.notes.includes(c)) return null
                    const pc = (root + c) % 12
                    return (
                      <span key={c} className="electron-note">
                        {NOTE_DISPLAY[pc]}
                      </span>
                    )
                  })}
                </div>
              </div>
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
    </div>
  )
}

export default App
