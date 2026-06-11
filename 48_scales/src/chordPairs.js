// Chord-pair breakdown of each 8-note scale, parsed row-by-row from the
// corrected "chordsNames_and_distance" SVG table.
//
// Each entry: { scaleId, left, distance, right }. Edit by hand to correct.
// The left/right chord ROOT pitch is auto-resolved at render time by trying
// each scale degree until both chord shapes fit (see resolveChordPair in
// src/chordVocab.js) — so you don't enter pitches here, only chord names
// + the interval between the two chord roots.

export const chordPairs = [
  { scaleId: 1,  left: 'Diminished', distance: 'Half Step',   right: 'Diminished' },
  { scaleId: 2,  left: 'Diminished', distance: 'Half Step',   right: 'Min7b5' },
  { scaleId: 3,  left: 'Dominant',   distance: 'Maj 3rd',     right: 'Min 7' },
  { scaleId: 4,  left: 'Diminished', distance: 'Half Step',   right: '7b5' },
  { scaleId: 5,  left: 'Min7b5',     distance: 'Perfect 5th',     right: 'Dominant' },
  { scaleId: 6,  left: 'Min7b5',     distance: 'Maj 3rd', right: 'Dominant' },
  { scaleId: 7,  left: 'Diminished', distance: 'Half Step',   right: 'Min 7' },
  { scaleId: 8,  left: 'Min 7',      distance: 'Maj 3rd',     right: 'Dominant' },
  { scaleId: 9,  left: 'Diminished', distance: 'Half Step',   right: 'Dominant' },
  { scaleId: 10, left: 'Min7b5',     distance: 'Half Step',   right: 'Min7b5' },
  { scaleId: 11, left: 'Min 7',      distance: 'Tritone',     right: 'Sus 2&4' },
  { scaleId: 12, left: 'Min7b5',     distance: 'Half Step',   right: 'Min 7' },
  { scaleId: 13, left: 'Min7b5',     distance: 'Maj 6th',     right: 'Sus 2&4' },
  { scaleId: 14, left: 'Min7b5',     distance: 'Half Step',   right: '7b5' },
  { scaleId: 15, left: 'Min7b5',     distance: 'Half Step',   right: 'Dominant' },
  { scaleId: 16, left: '7b5',        distance: 'Half Step',   right: '7b5' },
  { scaleId: 17, left: 'Min 7',      distance: 'Half Step',   right: 'Min 7' },
  { scaleId: 18, left: 'Sus 2&4',    distance: 'Half Step',   right: 'Sus 2&4' },
  { scaleId: 19, left: '7b5',        distance: 'Half Step',   right: 'Dominant' },
  { scaleId: 20, left: 'Dominant',   distance: 'Tritone',     right: 'Sus 2&4' },
  { scaleId: 21, left: 'Min 7',      distance: 'Half Step',   right: 'Dominant' },
  { scaleId: 22, left: 'Min 7',      distance: 'Maj 6th',     right: 'Sus 2&4' },
  { scaleId: 23, left: 'Dominant',   distance: 'Half Step',   right: 'Dominant' },
  { scaleId: 24, left: 'Min7b5',     distance: 'Maj 6th',      right: 'Add 9' },
  { scaleId: 25, left: 'Add 9',      distance: 'Half Step',   right: 'Sus 2&4' },
  { scaleId: 26, left: 'Add 9',      distance: 'Min 3rd',     right: 'Min 7' },
  { scaleId: 27, left: 'Min7b5',     distance: 'Half Step',   right: '7#5' },
  { scaleId: 28, left: 'Min 7',      distance: 'Half Step',   right: '7#5' },
  { scaleId: 29, left: '7b5',        distance: 'Half Step',   right: '7#5' },
  { scaleId: 30, left: 'Dominant',   distance: 'Half Step',   right: '7#5' },
  { scaleId: 31, left: 'Min add 11', distance: 'Tritone',     right: 'Min 7' },
  { scaleId: 32, left: 'Sus 2&4',    distance: 'Half Step',   right: 'Min add 11' },
  { scaleId: 33, left: 'Min add 11', distance: 'Tritone',     right: 'Dominant' },
  { scaleId: 34, left: 'Add 9',      distance: 'Half Step',   right: 'Add 9' },
  { scaleId: 35, left: '7#5',        distance: 'Perfect 5th', right: 'Add 9' },
  { scaleId: 36, left: '7#5',        distance: 'Half Step',   right: '7#5' },
  { scaleId: 37, left: 'Add 9',      distance: 'minor 7th',   right: 'Min add 11' },
  { scaleId: 38, left: 'Min add 11', distance: 'Tritone',     right: '7#5' },
  { scaleId: 39, left: 'Min add 11', distance: 'Half Step',   right: 'Min add 11' },
  { scaleId: 40, left: 'Dom 9 no 5',      distance: 'Major7',   right: 'Add 9' },
  { scaleId: 41, left: '7#5',        distance: 'Maj 6th', right: 'Dom 9 no 5' },
  { scaleId: 42, left: 'Min add 11', distance: 'Maj 3rd',  right: 'Dom 9 no 5' },
  { scaleId: 43, left: 'Dom 9 no 5', distance: 'Half Step',   right: 'Dom 9 no 5' },
]
