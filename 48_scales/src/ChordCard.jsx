import { useEffect, useMemo, useState } from 'react'
import ChordDiagram from './ChordDiagram'
import { CHORD_INTERVALS, pcName } from './chordVocab'
import { buildVoicings } from './voicings'

// A small chord diagram for a note: "D Min 7" drawn on the neck, with arrows to
// step through the playable voicings (the same set the roll's chord viewer
// builds). `voicing` is the voicing to start on (0-based); `onVoicing` reports
// the one being shown, so an "Insert chord" form can pin it with `#n`.
export default function ChordCard({ rootPc, quality, voicing = 0, useFlats = false, onVoicing }) {
  const intervals = CHORD_INTERVALS[quality]
  const voicings = useMemo(
    () => (intervals ? buildVoicings(intervals.map((i) => (rootPc + i) % 12), rootPc) : []),
    [intervals, rootPc]
  )
  const [shown, setShown] = useState(voicing)
  const count = voicings.length
  const idx = count ? ((shown % count) + count) % count : 0

  useEffect(() => {
    onVoicing?.(idx)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [idx])

  return (
    <div className="chord-card">
      <div className="chord-card-head">
        <span className="chord-card-name">
          {pcName(rootPc, useFlats)} {quality}
        </span>
        {count > 1 && (
          <span className="chord-card-nav">
            <button type="button" onClick={() => setShown(idx - 1)} aria-label="previous voicing">
              ‹
            </button>
            <span>
              {idx + 1} / {count}
            </span>
            <button type="button" onClick={() => setShown(idx + 1)} aria-label="next voicing">
              ›
            </button>
          </span>
        )}
      </div>
      {count ? (
        <ChordDiagram voicing={voicings[idx]} useFlats={useFlats} side="left" />
      ) : (
        <div className="chord-card-empty">No playable voicing for this chord.</div>
      )}
    </div>
  )
}
