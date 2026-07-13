import { pcName } from './chordVocab'
import { STRING_LABELS, FRETS } from './voicings'

const INLAYS = new Set([3, 5, 7, 9, 15, 17, 19, 21])
// Display rows: high e (top) → low E (bottom). Values are TUNING low→high
// indices (5 = high e … 0 = low E) so we can match a placement's stringIndex.
const DISPLAY_ROWS = [5, 4, 3, 2, 1, 0]

// One voicing drawn on a full 24-fret horizontal neck (high e on top). Every
// note is a coloured dot at its exact (string, fret) — open notes sit in the
// fret-0 column, muted strings show a ✕ there. `side` picks the chord colour
// (left → --chord1, right → --chord2); the chord root uses the accent colour.
export default function ChordDiagram({
  voicing,
  useFlats = false,
  side = 'left',
  onStrum,
}) {
  if (!voicing) return null
  const { placements, mutedStrings } = voicing
  const byString = {}
  for (const p of placements) byString[p.stringIndex] = p
  const muted = new Set(mutedStrings)
  const frets = Array.from({ length: FRETS + 1 }, (_, f) => f)
  const dotClass = (p) =>
    p.isRoot ? 'root' : side === 'left' ? 'chord-left' : 'chord-right'

  return (
    <div
      className={`chord-neck ${voicing.stretch ? 'stretch' : ''}`}
      onClick={onStrum}
      title="Click to hear this voicing"
    >
      <div className="chord-neck-strings">
        {DISPLAY_ROWS.map((si) => (
          <span key={si} className="chord-neck-string-label">
            {STRING_LABELS[si]}
          </span>
        ))}
      </div>
      <div className="chord-neck-frets">
        <div className="fretboard horizontal">
          <div className="fret-grid">
            {DISPLAY_ROWS.map((si) => (
              <div key={si} className="fret-string">
                {frets.map((f) => {
                  const p = byString[si]
                  const on = p && p.fret === f
                  const isMuteCell = f === 0 && muted.has(si)
                  return (
                    <div
                      key={f}
                      className={`fret-cell ${f === 0 ? 'open' : ''} ${
                        INLAYS.has(f) ? 'inlay' : ''
                      } ${f === 12 || f === 24 ? 'octave' : ''}`}
                    >
                      {on && (
                        <span className={`fret-dot ${dotClass(p)}`}>
                          {pcName(p.pc, useFlats)}
                        </span>
                      )}
                      {isMuteCell && <span className="fret-mute">✕</span>}
                    </div>
                  )
                })}
              </div>
            ))}
          </div>
          <div className="fret-nums">
            {frets.map((f) => {
              const mark = INLAYS.has(f) || f === 12 || f === 24
              return (
                <span key={f} className={`fret-num ${mark ? 'mark' : ''}`}>
                  {mark ? f : ''}
                </span>
              )
            })}
          </div>
        </div>
      </div>
    </div>
  )
}
