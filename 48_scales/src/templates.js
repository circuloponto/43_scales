// Templates captured from the piano roll.
//
// Each template stores its notes by scale DEGREE, not by absolute MIDI, so
// the same shape can be re-applied to any scale + root combination. The
// fields are:
//   id              unique string (Date.now()-rand from the capture flow)
//   name            human-readable label shown in the variation panel
//   capturedFrom    { scaleId, root } — the scale + root used at capture
//                   time (purely informational; the apply logic ignores it)
//   notes           array of { beat, degree, octave, length }:
//                     beat    cell position on the timeline (0..)
//                     degree  index into the scale's notes array (0..7)
//                     octave  +/- octave offset from C4 + root
//                     length  duration in cells
//
// Workflow: design patterns in the piano roll, click Capture to add them
// to the in-app templates list, then hit Export to copy this whole block to
// the clipboard and paste it back here to ship them as defaults.

export const templates = []
