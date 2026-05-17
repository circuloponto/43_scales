// 48 possible 8-note scales in 12-TET.
// Each entry: id (1..48) and notes — an array of 8 integers in [0..11]
// representing pitch classes (0 = C, 1 = C#, ..., 11 = B).
// Scales 44..48 not yet drawn in the source SVG; fill in when ready.

export const SCALE_COUNT = 48;
export const NOTES_PER_SCALE = 8;
export const PITCH_CLASSES = 12;

export const scales = [
  { id:  1, notes: [0,1,3,4,6,7,9,10] },
  { id:  2, notes: [0,1,2,4,5,7,8,10] },
  { id:  3, notes: [0,1,2,4,5,8,9,10] },
  { id:  4, notes: [0,1,2,4,6,7,8,10] },
  { id:  5, notes: [0,1,2,5,6,7,9,10] },
  { id:  6, notes: [0,1,2,4,6,8,9,10] },
  { id:  7, notes: [0,1,2,4,5,7,9,10] },
  { id:  8, notes: [0,1,2,4,5,6,9,10] },
  { id:  9, notes: [0,1,2,4,6,7,9,10] },
  { id: 10, notes: [0,1,2,3,5,6,8,9] },
  { id: 11, notes: [0,1,2,3,5,8,9,10] },
  { id: 12, notes: [0,1,2,3,5,6,8,10] },
  { id: 13, notes: [0,1,2,3,5,6,7,9] },
  { id: 14, notes: [0,1,2,3,5,7,8,9] },
  { id: 15, notes: [0,1,2,3,5,7,8,10] },
  { id: 16, notes: [0,1,2,3,6,7,8,9] },
  { id: 17, notes: [0,1,2,3,5,6,9,10] },
  { id: 18, notes: [0,1,2,3,5,6,7,8] },
  { id: 19, notes: [0,1,2,3,6,7,8,10] },
  { id: 20, notes: [0,1,2,3,6,8,9,10] },
  { id: 21, notes: [0,1,2,3,5,7,9,10] },
  { id: 22, notes: [0,1,2,3,5,6,7,10] },
  { id: 23, notes: [0,1,2,3,6,7,9,10] },
  { id: 24, notes: [0,1,2,3,4,6,7,9] },
  { id: 25, notes: [0,1,2,3,4,6,7,8] },
  { id: 26, notes: [0,1,2,3,4,6,7,10] },
  { id: 27, notes: [0,1,2,3,4,6,8,9] },
  { id: 28, notes: [0,1,2,3,4,6,8,10] },
  { id: 29, notes: [0,1,2,3,4,7,8,9] },
  { id: 30, notes: [0,1,2,3,4,7,8,10] },
  { id: 31, notes: [0,1,2,3,4,6,9,10] },
  { id: 32, notes: [0,1,2,3,4,8,9,10] },
  { id: 33, notes: [0,1,2,3,4,7,9,10] },
  { id: 34, notes: [0,1,2,3,4,5,7,8] },
  { id: 35, notes: [0,1,2,3,4,5,7,9] },
  { id: 36, notes: [0,1,2,3,4,5,8,9] },
  { id: 37, notes: [0,1,2,3,4,5,7,10] },
  { id: 38, notes: [0,1,2,3,4,5,8,10] },
  { id: 39, notes: [0,1,2,3,4,5,9,10] },
  { id: 40, notes: [0,1,2,3,4,5,6,8] },
  { id: 41, notes: [0,1,2,3,4,5,6,9] },
  { id: 42, notes: [0,1,2,3,4,5,6,10] },
  { id: 43, notes: [0,1,2,3,4,5,6,7] },
  { id: 44, notes: [] },
  { id: 45, notes: [] },
  { id: 46, notes: [] },
  { id: 47, notes: [] },
  { id: 48, notes: [] },
];

export default scales;
