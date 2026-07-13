import { pcName } from './chordVocab'

// Standard 6-string guitar tuning, top row = high E down to low E.
export const TUNING = [64, 59, 55, 50, 45, 40]
const FRETS = 24
const SPAN = 4 // a "position" covers 5 frets: [pos, pos+SPAN]
const INLAYS = new Set([3, 5, 7, 9, 15, 17, 19, 21])

// Frets (0..FRETS) at which `midi` can be fretted on any string.
function fretsForMidi(midi) {
  const out = []
  for (const open of TUNING) {
    const f = midi - open
    if (f >= 0 && f <= FRETS) out.push(f)
  }
  return out
}

// New position (lower fret of the 5-fret span) needed to fit `midi`, per the
// rules: if it already fits [pos, pos+SPAN] keep it; if too HIGH make the note's
// lowest fret the upper boundary; if too LOW make its highest fret the lower one.
export function adjustFretPosition(pos, midi) {
  const frets = fretsForMidi(midi)
  if (!frets.length) return pos
  if (frets.some((f) => f >= pos && f <= pos + SPAN)) return pos
  const lo = Math.min(...frets)
  const hi = Math.max(...frets)
  const clamp = (p) => Math.max(0, Math.min(FRETS - SPAN, p))
  return lo > pos + SPAN ? clamp(lo - SPAN) : clamp(hi) // too high : too low
}

// Minimalist, read-only fretboard preview. Mirrors the notes currently in the
// piano roll: a dot lights up on every fret whose exact pitch is present in
// `notePitches` (a Set of MIDI numbers). `orientation` flips it between a wide
// horizontal neck (for the roll area) and a tall vertical one (for the sidebar).
export default function Fretboard({
  orientation = 'horizontal',
  notePitches,
  useFlats = false,
  chordClassFor,
  position = 0, // lower fret of the current 5-fret span [position, position+SPAN]
  priming = false, // P pressed, waiting for the position number
}) {
  const frets = Array.from({ length: FRETS + 1 }, (_, f) => f)
  const pitches = notePitches || new Set()
  const lo = position
  const hi = position + SPAN
  // Choose exactly ONE fret per sounding pitch, within the current position
  // (lowest fret in the span), so a note never lights two frets. Keyed "s-f".
  const chosen = new Set()
  for (const midi of pitches) {
    let best = null
    for (let s = 0; s < TUNING.length; s++) {
      const fret = midi - TUNING[s]
      if (fret >= lo && fret <= hi && (best === null || fret < best.fret)) {
        best = { s, fret }
      }
    }
    if (best) chosen.add(`${best.s}-${best.fret}`)
  }
  return (
    <div className={`fretboard ${orientation}`}>
      <div className={`fret-position ${priming ? 'priming' : ''}`}>
        Pos {priming ? `${position}_` : position}
        <span className="fret-position-hint"> · P + number</span>
      </div>
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
                  } ${f === 12 || f === 24 ? 'octave' : ''} ${
                    f >= lo && f <= hi ? 'in-position' : ''
                  }`}
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
