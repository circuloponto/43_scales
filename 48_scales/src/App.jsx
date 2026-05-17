import { useState } from 'react'
import { scales, PITCH_CLASSES } from './scales'
import { glyphs, GLYPH_VIEWBOX } from './glyphs'
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

function GlyphRow({ rowIndex, accent }) {
  const strokes = glyphs[rowIndex]
  if (!strokes) return <svg className="glyph" viewBox={`0 0 ${GLYPH_VIEWBOX.w} ${GLYPH_VIEWBOX.h}`} />
  return (
    <svg
      className="glyph"
      viewBox={`0 0 ${GLYPH_VIEWBOX.w} ${GLYPH_VIEWBOX.h}`}
      preserveAspectRatio="xMidYMid meet"
    >
      {strokes.map((s, i) => {
        const isAccent = s.color === ORIGINAL_PURPLE
        const color = isAccent ? accent : s.color
        return (
          <g key={i} transform={`translate(${s.x} ${s.y}) rotate(0 ${s.rx} ${s.ry})`}>
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

function App() {
  const [root, setRoot] = useState(0)
  const [selectedId, setSelectedId] = useState(null)
  const [hoverRow, setHoverRow] = useState(null)
  const [hoverPos, setHoverPos] = useState({ x: 0, y: 0 })
  const [accent, setAccent] = useState(ORIGINAL_PURPLE)

  const scale = selectedId !== null ? scales.find((s) => s.id === selectedId) : null
  const concrete = scale ? scale.notes.map((n) => (n + root) % 12) : []
  const visibleScales = scales.filter((s) => s.notes.length > 0)

  const playScale = () => {
    if (!scale || scale.notes.length === 0) return
    const Ctx = window.AudioContext || window.webkitAudioContext
    const ctx = new Ctx()
    const dur = 0.28
    scale.notes.forEach((n, i) => {
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
    })
  }

  return (
    <div className="app" style={{ '--accent': accent }}>
      <div className="frame">
        <div className="theme-picker" title="accent color">
          <span className="theme-label">Accent</span>
          <label className="theme-swatch-wrap">
            <input
              type="color"
              value={accent}
              onChange={(e) => setAccent(e.target.value)}
            />
            <span className="theme-swatch" style={{ background: accent }} />
          </label>
        </div>

        <div className={`matrix ${selectedId !== null ? 'has-selection' : ''}`}>
          {visibleScales.map((s) => {
            const set = new Set(s.notes)
            const isSel = s.id === selectedId
            return (
              <div
                key={s.id}
                className={`row ${isSel ? 'selected' : ''}`}
                onClick={() => setSelectedId(s.id)}
                onMouseEnter={(e) => {
                  const r = e.currentTarget.getBoundingClientRect()
                  setHoverRow(s.id - 1)
                  setHoverPos({ x: r.right + 16, y: r.top + r.height / 2 })
                }}
                onMouseLeave={() => setHoverRow(null)}
              >
                <div className="glyph-cell">
                  <GlyphRow rowIndex={s.id - 1} accent={accent} />
                </div>
                <div
                  className="row-cells"
                  style={{ gridTemplateColumns: `repeat(${PITCH_CLASSES}, var(--cell))` }}
                >
                  {Array.from({ length: PITCH_CLASSES }, (_, pc) => (
                    <div
                      key={pc}
                      className={`cell ${set.has(pc) ? 'on' : 'off'}`}
                    />
                  ))}
                </div>
              </div>
            )
          })}
        </div>

        <aside className="panel">
          <div className="section">
            <div className="roots">
              {NOTE_DISPLAY.map((name, i) => (
                <button
                  key={i}
                  className={`root ${root === i ? 'active' : ''}`}
                  onClick={() => setRoot(i)}
                >
                  {name}
                </button>
              ))}
            </div>
          </div>

          {scale && (
            <div className="section">
              <div className="pattern">
                {Array.from({ length: 12 }, (_, pc) => {
                  const inScale = scale.notes.some((n) => (n + root) % 12 === pc)
                  return (
                    <div
                      key={pc}
                      className={`pattern-cell ${inScale ? 'on' : 'off'}`}
                    />
                  )
                })}
              </div>
              <div className="pattern-labels">
                {Array.from({ length: 12 }, (_, pc) => (
                  <div key={pc} className="pattern-label">
                    {pc}
                  </div>
                ))}
              </div>
            </div>
          )}

          {scale ? (
            <>
              <div className="section">
                <div className="hero">
                  <div className="hero-number">{padId(scale.id)}</div>
                  <div className="hero-caption">rooted in {NOTE_DISPLAY[root]}</div>
                  <div className="hero-line">
                    <button
                      className="play"
                      onClick={playScale}
                      disabled={concrete.length === 0}
                      aria-label="play scale"
                    >
                      <PlayIcon />
                    </button>
                    <div className="hero-notes">
                      {concrete.map((pc, i) => (
                        <span key={i} className="note">
                          {NOTE_DISPLAY[pc]}
                        </span>
                      ))}
                    </div>
                  </div>
                </div>
              </div>

              <div className="section">
                <div className="label">Chords</div>
              </div>
            </>
          ) : (
            <div className="section">
              <div className="hint">Choose a scale.</div>
            </div>
          )}
        </aside>
      </div>

      {hoverRow !== null && (
        <div
          className="glyph-popup"
          style={{ left: hoverPos.x, top: hoverPos.y }}
        >
          <GlyphRow rowIndex={hoverRow} accent={accent} />
          <div className="glyph-popup-caption">Scale {padId(hoverRow + 1)}</div>
        </div>
      )}
    </div>
  )
}

export default App
