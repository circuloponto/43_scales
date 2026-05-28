// Chord catalog. Each entry is a CONCRETE chord — a specific (rootDegree,
// shape) pair — encoded by scale degree, so the same entry resolves to the
// right pitches against any of the 48 scales.
//
// Fields per entry:
//   id          unique string label for this chord
//   rootDegree  index into the active scale's notes array (0..7)
//   offsets     degree-step offsets above rootDegree that make up the chord.
//               Offsets that overflow the 8-note scale wrap into the next
//               octave automatically (see chordToMidiNotes).
//   suffix      short text appended to the Roman-numeral label
//
// Built-in shapes (extend by hand below):
//   Triad     = root, 3rd-up, 5th-up         → offsets [0, 2, 4]
//   6th chord = root, 3rd-up, 5th-up, 6th-up → offsets [0, 2, 4, 5]
//
// Roman-numeral case (I vs i) and the °/+ markers are auto-derived from the
// actual semitones for each chord against the active scale — not baked in.

const NOTE_NAMES = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B']
const ROMAN_UPPER = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII']
const ROMAN_LOWER = ['i', 'ii', 'iii', 'iv', 'v', 'vi', 'vii', 'viii']

export const chords = [
  { id: 'triad-1', rootDegree: 0, offsets: [0, 2, 4], suffix: '' },
  { id: 'triad-2', rootDegree: 1, offsets: [0, 2, 4], suffix: '' },
  { id: 'triad-3', rootDegree: 2, offsets: [0, 2, 4], suffix: '' },
  { id: 'triad-4', rootDegree: 3, offsets: [0, 2, 4], suffix: '' },
  { id: 'triad-5', rootDegree: 4, offsets: [0, 2, 4], suffix: '' },
  { id: 'triad-6', rootDegree: 5, offsets: [0, 2, 4], suffix: '' },
  { id: 'triad-7', rootDegree: 6, offsets: [0, 2, 4], suffix: '' },
  { id: 'triad-8', rootDegree: 7, offsets: [0, 2, 4], suffix: '' },
  { id: '6-1', rootDegree: 0, offsets: [0, 2, 4, 5], suffix: '6' },
  { id: '6-2', rootDegree: 1, offsets: [0, 2, 4, 5], suffix: '6' },
  { id: '6-3', rootDegree: 2, offsets: [0, 2, 4, 5], suffix: '6' },
  { id: '6-4', rootDegree: 3, offsets: [0, 2, 4, 5], suffix: '6' },
  { id: '6-5', rootDegree: 4, offsets: [0, 2, 4, 5], suffix: '6' },
  { id: '6-6', rootDegree: 5, offsets: [0, 2, 4, 5], suffix: '6' },
  { id: '6-7', rootDegree: 6, offsets: [0, 2, 4, 5], suffix: '6' },
  { id: '6-8', rootDegree: 7, offsets: [0, 2, 4, 5], suffix: '6' },
]

// Resolve a chord shape (rootDegree + offsets) against a scale + root to a
// list of MIDI notes. baseMidi anchors the lowest octave (default C4 = 60).
export function chordToMidiNotes(shape, scale, root, baseMidi = 60) {
  const n = scale.notes.length
  return shape.offsets.map((offset) => {
    const total = shape.rootDegree + offset
    const octaveBump = Math.floor(total / n)
    const degree = ((total % n) + n) % n
    return baseMidi + root + scale.notes[degree] + octaveBump * 12
  })
}

// Compute the chord's intervals (in semitones from its root) against the
// active scale. Used for quality detection.
function chordIntervals(shape, scale) {
  const n = scale.notes.length
  const rootPc = scale.notes[shape.rootDegree % n]
  return shape.offsets.map((offset) => {
    const total = shape.rootDegree + offset
    const octaveBump = Math.floor(total / n)
    const degree = ((total % n) + n) % n
    return scale.notes[degree] + octaveBump * 12 - rootPc
  })
}

// Detect triad quality from the first three intervals (root, "3rd", "5th").
// Returns 'major' | 'minor' | 'dim' | 'aug' | 'other'.
function triadQuality(intervals) {
  if (intervals.length < 3) return 'other'
  const third = intervals[1]
  const fifth = intervals[2]
  if (third === 4 && fifth === 7) return 'major'
  if (third === 3 && fifth === 7) return 'minor'
  if (third === 3 && fifth === 6) return 'dim'
  if (third === 4 && fifth === 8) return 'aug'
  return 'other'
}

// Roman-numeral label for a chord against the active scale.
// Case follows triad quality; °/+ mark dim/aug.
export function chordRomanLabel(shape, scale) {
  const intervals = chordIntervals(shape, scale)
  const q = triadQuality(intervals)
  const deg = shape.rootDegree % scale.notes.length
  const base = q === 'minor' || q === 'dim' ? ROMAN_LOWER[deg] : ROMAN_UPPER[deg]
  let mark = ''
  if (q === 'dim') mark = '°'
  else if (q === 'aug') mark = '+'
  return base + mark + (shape.suffix || '')
}

// Human-readable chord name (e.g. "Cmaj", "Dm6") using the actual root pitch.
export function chordDisplayName(shape, scale, root) {
  const rootPc = (root + scale.notes[shape.rootDegree % scale.notes.length]) % 12
  const intervals = chordIntervals(shape, scale)
  const q = triadQuality(intervals)
  const letter = NOTE_NAMES[rootPc]
  const qualityTag =
    q === 'minor' ? 'm' : q === 'dim' ? '°' : q === 'aug' ? '+' : ''
  return letter + qualityTag + (shape.suffix || '')
}
