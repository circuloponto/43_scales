// Semitone offsets from the chord's root. Every chord here is a 4-note voicing.
//
// Edit by hand to add or refine voicings used in src/chordPairs.js.

export const CHORD_INTERVALS = {
  'Diminished':   [0, 3, 6, 9],   // fully diminished 7th
  'Dominant':     [0, 4, 7, 10],  // dom 7
  'Min 7':        [0, 3, 7, 10],
  'Min7b5':       [0, 3, 6, 10],  // half-diminished
  '7b5':          [0, 4, 6, 10],
  '7#5':          [0, 4, 8, 10],
  'Sus 2&4':      [0, 2, 5, 7],
  'Add 9':        [0, 2, 4, 7],
  'Major 7':      [0, 4, 7, 11],
  'Min add 11':   [0, 3, 5, 7],
  'Dom 9 no 5':   [0, 2, 4, 10],  // whole-tone cluster
  'Aug7sus2':     [0, 2, 4, 6],   // 0, 2, 3, #4 in scale-degree notation
  // Short-form aliases for the names used in your source list:
  'dim7':         [0, 3, 6, 9],
  'min7':         [0, 3, 7, 10],
  'min7b5':       [0, 3, 6, 10],
  'sus2&4':       [0, 2, 5, 7],
  'Add9':         [0, 2, 4, 7],
  'MinAdd11':     [0, 3, 5, 7],
  '7':            [0, 4, 7, 10],
}

// Distance column → semitones between left and right chord roots.
export const INTERVAL_SEMITONES = {
  'Half Step':    1,
  'Whole Step':   2,
  'Min 3rd':      3,
  'Maj 3rd':      4,
  'Tritone':      6,
  'Perfect 5th':  7,
  'Maj 6th':      9,
  'Min 7':        10,
  'minor 7th':    10,
  'Major7':       11,
}

const NOTE_NAMES = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B']

// Try every pitch class in `scaleNotes` as the left chord's root. Return the
// first assignment where ALL chord notes (left + right) lie inside the scale.
// `scaleNotes` is an array of pcs (0..11) of the scale, expressed relative
// to its scale root (= 0). `root` is the user-selected absolute root in pcs.
export function resolveChordPair(pair, scaleNotes, root) {
  const leftShape = CHORD_INTERVALS[pair.left]
  const rightShape = CHORD_INTERVALS[pair.right]
  const distance = INTERVAL_SEMITONES[pair.distance]
  if (!leftShape || !rightShape || distance == null) return null
  const scaleSet = new Set(scaleNotes)
  for (const candidate of scaleNotes) {
    const leftNotes = leftShape.map((o) => (candidate + o) % 12)
    const rightRoot = (candidate + distance) % 12
    const rightNotes = rightShape.map((o) => (rightRoot + o) % 12)
    // Subset check: every chord note must lie inside the scale. The two
    // chords may share notes (overlap is allowed); they don't have to tile
    // the full 8-note scale.
    if (![...leftNotes, ...rightNotes].every((pc) => scaleSet.has(pc))) continue
    return {
      leftRoot: (candidate + root) % 12,
      rightRoot: (rightRoot + root) % 12,
      leftNotes: leftNotes.map((pc) => (pc + root) % 12),
      rightNotes: rightNotes.map((pc) => (pc + root) % 12),
    }
  }
  return null
}

export function pcName(pc) {
  return NOTE_NAMES[((pc % 12) + 12) % 12]
}

// Step-based resolver: the user-picked `root` is treated as the scale's
// intrinsic root (the note at scale.notes[rootStep-1] of the unrotated
// scale). The LEFT chord roots at this pitch; the RIGHT chord sits
// `distance` semitones above. No search, no scale-fit check — we always
// return the computed pitches so the chord pair always renders.
export function resolveChordPairAtStep(pair, scaleNotes, rootStep, root) {
  const leftShape = CHORD_INTERVALS[pair.left]
  const rightShape = CHORD_INTERVALS[pair.right]
  const distance = INTERVAL_SEMITONES[pair.distance]
  if (!leftShape || !rightShape || distance == null) return null
  const leftRoot = ((root % 12) + 12) % 12
  const rightRoot = (leftRoot + distance) % 12
  return {
    leftRoot,
    rightRoot,
    leftNotes: leftShape.map((o) => (leftRoot + o) % 12),
    rightNotes: rightShape.map((o) => (rightRoot + o) % 12),
  }
}

// Pitch class (relative to scale root) of the scale's intrinsic root, given
// the scale.notes array and 1-indexed rootStep.
export function intrinsicRootPc(scaleNotes, rootStep) {
  if (!rootStep || rootStep < 1 || rootStep > scaleNotes.length) return null
  return scaleNotes[rootStep - 1]
}
