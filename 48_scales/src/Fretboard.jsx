import { pcName } from './chordVocab'

// Standard 6-string guitar tuning, top row = high E down to low E.
const TUNING = [64, 59, 55, 50, 45, 40]
const FRETS = 24
const INLAYS = new Set([3, 5, 7, 9, 15, 17, 19, 21])

// Minimalist, read-only fretboard preview. Mirrors the notes currently in the
// piano roll: a dot lights up on every fret whose exact pitch is present in
// `notePitches` (a Set of MIDI numbers). `orientation` flips it between a wide
// horizontal neck (for the roll area) and a tall vertical one (for the sidebar).
export default function Fretboard({
  orientation = 'horizontal',
  notePitches,
  useFlats = false,
  chordClassFor,
  maxFret = 5, // for now, notes are only placed on the first few frets
}) {
  const frets = Array.from({ length: FRETS + 1 }, (_, f) => f)
  const pitches = notePitches || new Set()
  // Choose exactly ONE position per sounding pitch (lowest fret within range),
  // so a note never lights two frets. Keyed "string-fret".
  const chosen = new Set()
  for (const midi of pitches) {
    let best = null
    for (let s = 0; s < TUNING.length; s++) {
      const fret = midi - TUNING[s]
      if (fret >= 0 && fret <= maxFret && (best === null || fret < best.fret)) {
        best = { s, fret }
      }
    }
    if (best) chosen.add(`${best.s}-${best.fret}`)
  }
  return (
    <div className={`fretboard ${orientation}`}>
      <div className="fret-grid">
        {TUNING.map((open, s) => (
          <div key={s} className="fret-string">
            {frets.map((f) => {
              const midi = open + f
              const pc = midi % 12
              const on = chosen.has(`${s}-${f}`)
              return (
                <div
                  key={f}
                  className={`fret-cell ${f === 0 ? 'open' : ''} ${
                    INLAYS.has(f) ? 'inlay' : ''
                  } ${f === 12 || f === 24 ? 'octave' : ''}`}
                >
                  {on && (
                    <span
                      className={`fret-dot ${
                        chordClassFor ? chordClassFor(pc) : ''
                      }`}
                    >
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
