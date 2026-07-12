import { pcName } from './chordVocab'

// Standard 6-string guitar tuning, top row = high E down to low E.
const TUNING = [64, 59, 55, 50, 45, 40]
const FRETS = 24
const INLAYS = new Set([3, 5, 7, 9, 15, 17, 19, 21])

// Minimalist, read-only fretboard preview. Shows the current scale's notes as
// dots (root emphasised) over a standard-tuned neck. `orientation` flips it
// between a wide horizontal neck (for the roll area) and a tall vertical one
// (for the sidebar). Purely presentational for now.
export default function Fretboard({
  orientation = 'horizontal',
  inScale,
  rootPc,
  useFlats = false,
}) {
  const frets = Array.from({ length: FRETS + 1 }, (_, f) => f)
  return (
    <div className={`fretboard ${orientation}`}>
      <div className="fret-grid">
        {TUNING.map((open, s) => (
          <div key={s} className="fret-string">
            {frets.map((f) => {
              const pc = (open + f) % 12
              const on = inScale(pc)
              const isRoot = pc === rootPc
              return (
                <div
                  key={f}
                  className={`fret-cell ${f === 0 ? 'open' : ''} ${
                    INLAYS.has(f) ? 'inlay' : ''
                  } ${f === 12 || f === 24 ? 'octave' : ''}`}
                >
                  {on && (
                    <span className={`fret-dot ${isRoot ? 'root' : ''}`}>
                      {pcName(pc, useFlats)}
                    </span>
                  )}
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
  )
}
