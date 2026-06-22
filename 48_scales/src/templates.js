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
// chordTemplates (below) follows the same idea for chord progressions —
// each block stores rootDegree + offsets + suffix so it re-resolves against
// whichever scale is active when it's applied.
//
// Workflow: design patterns in the piano roll, click Capture to add them
// to the in-app templates list, then hit Export to copy this whole block to
// the clipboard and paste it back here to ship them as defaults.

export const templates = [
  {
    "id": "1782163712933-6b3m3i",
    "name": "Chord up",
    "capturedFrom": {
      "scaleId": 4,
      "root": 2
    },
    "notes": [
      {
        "beat": 0,
        "degree": 0,
        "octave": 1,
        "length": 1
      },
      {
        "beat": 1,
        "degree": 2,
        "octave": 1,
        "length": 1
      },
      {
        "beat": 2,
        "degree": 4,
        "octave": 1,
        "length": 1
      },
      {
        "beat": 3,
        "degree": 6,
        "octave": 1,
        "length": 1
      }
    ]
  },
  {
    "id": "1782163779958-pafp9t",
    "name": "Scale Up",
    "capturedFrom": {
      "scaleId": 4,
      "root": 2
    },
    "notes": [
      {
        "beat": 0,
        "degree": 0,
        "octave": 1,
        "length": 1
      },
      {
        "beat": 1,
        "degree": 1,
        "octave": 1,
        "length": 1
      },
      {
        "beat": 2,
        "degree": 2,
        "octave": 1,
        "length": 1
      },
      {
        "beat": 3,
        "degree": 3,
        "octave": 1,
        "length": 1
      },
      {
        "beat": 4,
        "degree": 4,
        "octave": 1,
        "length": 1
      },
      {
        "beat": 5,
        "degree": 5,
        "octave": 1,
        "length": 1
      },
      {
        "beat": 6,
        "degree": 6,
        "octave": 1,
        "length": 1
      },
      {
        "beat": 7,
        "degree": 7,
        "octave": 1,
        "length": 1
      },
      {
        "beat": 8,
        "degree": 0,
        "octave": 2,
        "length": 1
      }
    ]
  },
  {
    "id": "1782163839275-ftf3yd",
    "name": "Scale & surround",
    "capturedFrom": {
      "scaleId": 4,
      "root": 2
    },
    "notes": [
      {
        "beat": 0,
        "degree": 0,
        "octave": 1,
        "length": 1
      },
      {
        "beat": 1,
        "degree": 1,
        "octave": 1,
        "length": 1
      },
      {
        "beat": 2,
        "degree": 2,
        "octave": 1,
        "length": 1
      },
      {
        "beat": 3,
        "degree": 3,
        "octave": 1,
        "length": 1
      },
      {
        "beat": 4,
        "degree": 4,
        "octave": 1,
        "length": 1
      },
      {
        "beat": 5,
        "degree": 5,
        "octave": 1,
        "length": 1
      },
      {
        "beat": 6,
        "degree": 6,
        "octave": 1,
        "length": 1
      },
      {
        "beat": 7,
        "degree": 0,
        "octave": 2,
        "length": 1
      },
      {
        "beat": 8,
        "degree": 7,
        "octave": 1,
        "length": 1
      }
    ]
  },
  {
    "id": "1782163917945-t61qn6",
    "name": "Chord up, Scale Down",
    "capturedFrom": {
      "scaleId": 4,
      "root": 2
    },
    "notes": [
      {
        "beat": 0,
        "degree": 0,
        "octave": 1,
        "length": 1
      },
      {
        "beat": 1,
        "degree": 2,
        "octave": 1,
        "length": 1
      },
      {
        "beat": 2,
        "degree": 4,
        "octave": 1,
        "length": 1
      },
      {
        "beat": 3,
        "degree": 6,
        "octave": 1,
        "length": 1
      },
      {
        "beat": 4,
        "degree": 5,
        "octave": 1,
        "length": 1
      },
      {
        "beat": 5,
        "degree": 4,
        "octave": 1,
        "length": 1
      },
      {
        "beat": 6,
        "degree": 3,
        "octave": 1,
        "length": 1
      },
      {
        "beat": 7,
        "degree": 2,
        "octave": 1,
        "length": 1
      },
      {
        "beat": 8,
        "degree": 1,
        "octave": 1,
        "length": 1
      }
    ]
  }
   
      
  ]
  
   /* {"id": "1779528744038-wyrt3d",
    "name": "start-end alternation",
    "capturedFrom": {
      "scaleId": 11,
      "root": 2
    },
    "notes": [
      {
        "beat": 0,
        "degree": 0,
        "octave": 0,
        "length": 1
      },
      {
        "beat": 1,
        "degree": 7,
        "octave": 0,
        "length": 1
      },
      {
        "beat": 3,
        "degree": 6,
        "octave": 0,
        "length": 1
      },
      {
        "beat": 2,
        "degree": 1,
        "octave": 0,
        "length": 1
      },
      {
        "beat": 4,
        "degree": 2,
        "octave": 0,
        "length": 1
      },
      {
        "beat": 5,
        "degree": 3,
        "octave": 0,
        "length": 1
      },
      {
        "beat": 6,
        "degree": 5,
        "octave": 0,
        "length": 1
      },
      {
        "beat": 7,
        "degree": 4,
        "octave": 0,
        "length": 1
      }
    ]
  },
  {
    "id": "1779529008257-dukieg",
    "name": "step-reverse alternation",
    "capturedFrom": {
      "scaleId": 20,
      "root": 1
    },
    "notes": [
      {
        "beat": 0,
        "degree": 0,
        "octave": 0,
        "length": 1
      },
      {
        "beat": 3,
        "degree": 6,
        "octave": 0,
        "length": 1
      },
      {
        "beat": 4,
        "degree": 2,
        "octave": 0,
        "length": 1
      },
      {
        "beat": 5,
        "degree": 3,
        "octave": 0,
        "length": 1
      },
      {
        "beat": 6,
        "degree": 5,
        "octave": 0,
        "length": 1
      },
      {
        "beat": 7,
        "degree": 4,
        "octave": 0,
        "length": 1
      },
      {
        "beat": 1,
        "degree": 1,
        "octave": 0,
        "length": 1
      },
      {
        "beat": 2,
        "degree": 7,
        "octave": 0,
        "length": 1
      }
    ]
  }*/
// Chord progression templates. Same scale-degree-relative idea as templates
// above. Each block carries the chord shape (offsets + suffix) so the chord
// quality and intervals come from the original entry in src/chords.js, not
// from the active scale's diatonic chord — that way a captured progression
// keeps its character when reapplied.
export const chordTemplates = []
