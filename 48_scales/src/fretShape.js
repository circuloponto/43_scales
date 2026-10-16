// Hand-drawn chord shapes — pure, no React.
//
// A shape is an array of 6 values, LOW string to HIGH string (E A D G B e):
//   null   the string is muted (x)
//   0      open string
//   n >= 1 fretted at fret n
// It is written in a note as  [[frets x 3 2 0 1 0]]  (optionally  | C major
// for a title), and it carries real positions, not just a chord name, so it
// can later drive the fretboard: pitchesOf() gives the MIDI notes it sounds.

import { CHORD_INTERVALS } from './chordVocab'
import { CHORD_QUALITY_CHOICES } from './noteParse'
import { TUNING, STRING_LABELS } from './voicings'
import { STRING_COUNT, MAX_FRET, parseFrets, formatFrets } from './fretParse'

export { STRING_COUNT, MAX_FRET, parseFrets, formatFrets }
export const OPEN_LABELS = STRING_LABELS // ['E','A','D','G','B','e']
export const WINDOW = 5 // frets shown at once unless the shape needs more

export const emptyShape = () => Array(STRING_COUNT).fill(null)

// Pitch class of a string at a fret.
export const fretPc = (stringIndex, fret) => (TUNING[stringIndex] + fret) % 12

// Every sounding note: [{ stringIndex, fret, midi, pc }], low string first.
export function pitchesOf(frets) {
  const out = []
  frets.forEach((f, stringIndex) => {
    if (f == null) return
    const midi = TUNING[stringIndex] + f
    out.push({ stringIndex, fret: f, midi, pc: midi % 12 })
  })
  return out
}

const fretted = (frets) => frets.filter((f) => f != null && f >= 1)

// First fret shown. Shapes that fit in the first 5 frets start at the nut (1);
// higher shapes start at their lowest fretted note.
export function windowStart(frets) {
  const f = fretted(frets)
  if (!f.length) return 1
  return Math.max(...f) <= WINDOW ? 1 : Math.min(...f)
}

// How many fret rows to draw from `start` so every dot is inside.
export function rowCount(frets, start) {
  const f = fretted(frets)
  if (!f.length) return WINDOW
  return Math.max(WINDOW, Math.max(...f) - start + 1)
}

// The start frets the editor may use without hiding a dot: from the one that
// still shows the highest dot, up to the lowest dot (or the far end if none).
export function startRange(frets, rows = WINDOW) {
  const f = fretted(frets)
  if (!f.length) return { min: 1, max: MAX_FRET - rows + 1 }
  return { min: Math.max(1, Math.max(...f) - rows + 1), max: Math.min(Math.min(...f), MAX_FRET - rows + 1) }
}

// Click a fret cell: put the string's dot there; click the same dot again to mute.
export function toggleFret(frets, stringIndex, fret) {
  const next = [...frets]
  next[stringIndex] = next[stringIndex] === fret ? null : fret
  return next
}

// Click above the nut: an unfretted string alternates open <-> muted.
export function toggleOpen(frets, stringIndex) {
  const next = [...frets]
  const cur = next[stringIndex]
  if (cur != null && cur >= 1) return next // fretted: the marker row does nothing
  next[stringIndex] = cur === 0 ? null : 0
  return next
}

// Which chord (from the app's vocabulary) the sounding notes spell, if any:
// [{ rootPc, quality }]. Only the 4-note chords the app knows; the lowest note
// is listed first because it is the likeliest root.
export function nameChord(frets) {
  const played = pitchesOf(frets)
  if (!played.length) return []
  const pcs = new Set(played.map((p) => p.pc))
  const bassPc = played[0].pc
  const out = []
  for (const quality of CHORD_QUALITY_CHOICES) {
    const iv = CHORD_INTERVALS[quality]
    if (iv.length !== pcs.size) continue
    for (let root = 0; root < 12; root++) {
      if (iv.every((i) => pcs.has((root + i) % 12))) out.push({ rootPc: root, quality })
    }
  }
  return out.sort((a, b) => (a.rootPc === bassPc ? 0 : 1) - (b.rootPc === bassPc ? 0 : 1))
}
