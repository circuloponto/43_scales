import { OPEN_LABELS, STRING_COUNT, WINDOW, pitchesOf, rowCount, toggleFret, toggleOpen, windowStart } from './fretShape'
import { pcName } from './chordVocab'

// A classic vertical chord box: six strings (low E on the left), fret rows with
// their NUMBER at the side, ✕ / ○ above the nut for muted / open strings, and
// every dot carrying the name of the note it sounds.
//
//   frets     the shape: 6 values, low string -> high, null = muted, 0 = open
//   onChange  when given the diagram is a drawing board: click a fret to put
//             that string's dot there (click it again to mute the string),
//             click above the nut to switch a string open / muted
//   start     first fret shown (default: chosen to fit the shape)
//   size      'lg' for the editor, 'sm' for inside a note
const SIZES = {
  lg: { gap: 32, fh: 34, padL: 38, padT: 38, padB: 24, r: 12.5, font: 11, num: 12 },
  sm: { gap: 21, fh: 24, padL: 24, padT: 24, padB: 17, r: 8.5, font: 8.5, num: 9.5 },
}

export default function FretDiagram({ frets, onChange, start: startProp, useFlats = false, size = 'sm' }) {
  const g = SIZES[size] ?? SIZES.sm
  const interactive = typeof onChange === 'function'
  const start = startProp ?? windowStart(frets)
  const rows = Math.max(WINDOW, rowCount(frets, start))
  const width = g.padL + (STRING_COUNT - 1) * g.gap + 16
  const height = g.padT + rows * g.fh + g.padB
  const sx = (i) => g.padL + i * g.gap
  const rowY = (r) => g.padT + r * g.fh
  const played = pitchesOf(frets)
  const markY = g.padT - g.gap * 0.45

  return (
    <svg
      className={`fret-diagram ${interactive ? 'interactive' : ''} ${size}`}
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      role={interactive ? 'group' : 'img'}
      aria-label={interactive ? 'Chord drawing board' : `Chord diagram: ${frets.map((f) => (f == null ? 'x' : f)).join(' ')}`}
    >
      {/* fret lines (the first is the nut when the shape starts at the nut) */}
      {Array.from({ length: rows + 1 }, (_, r) => (
        <line
          key={`h${r}`}
          x1={sx(0)}
          x2={sx(STRING_COUNT - 1)}
          y1={rowY(r)}
          y2={rowY(r)}
          className={r === 0 && start === 1 ? 'fd-nut' : 'fd-fret'}
        />
      ))}
      {/* strings */}
      {Array.from({ length: STRING_COUNT }, (_, i) => (
        <line key={`s${i}`} x1={sx(i)} x2={sx(i)} y1={rowY(0)} y2={rowY(rows)} className="fd-string" />
      ))}
      {/* fret numbers down the left side */}
      {Array.from({ length: rows }, (_, r) => (
        <text
          key={`n${r}`}
          x={g.padL - g.gap * 0.55}
          y={rowY(r) + g.fh / 2}
          className={`fd-fretnum ${r === 0 && start > 1 ? 'base' : ''}`}
          style={{ fontSize: g.num }}
          textAnchor="end"
          dominantBaseline="middle"
        >
          {start + r}
        </text>
      ))}
      {/* muted / open markers above the nut */}
      {frets.map((f, i) =>
        f == null ? (
          <text key={`m${i}`} x={sx(i)} y={markY} className="fd-mark mute" style={{ fontSize: g.num + 2 }} textAnchor="middle" dominantBaseline="middle">
            ✕
          </text>
        ) : f === 0 ? (
          <circle key={`m${i}`} cx={sx(i)} cy={markY} r={g.r * 0.5} className="fd-mark open" />
        ) : null
      )}
      {/* dots, each with its note name */}
      {played.map((p) => {
        if (p.fret < 1) return null
        const row = p.fret - start
        if (row < 0 || row >= rows) return null
        return (
          <g key={`d${p.stringIndex}`} className="fd-dot">
            <circle cx={sx(p.stringIndex)} cy={rowY(row) + g.fh / 2} r={g.r} />
            <text x={sx(p.stringIndex)} y={rowY(row) + g.fh / 2} style={{ fontSize: g.font }} textAnchor="middle" dominantBaseline="central">
              {pcName(p.pc, useFlats)}
            </text>
          </g>
        )
      })}
      {/* open strings also show their note, small, in the marker row */}
      {size === 'lg' &&
        played.map((p) =>
          p.fret === 0 ? (
            <text key={`o${p.stringIndex}`} x={sx(p.stringIndex)} y={markY - 13} className="fd-opennote" style={{ fontSize: 9.5 }} textAnchor="middle">
              {pcName(p.pc, useFlats)}
            </text>
          ) : null
        )}
      {/* string names underneath */}
      {OPEN_LABELS.map((n, i) => (
        <text key={`l${i}`} x={sx(i)} y={height - 5} className="fd-strname" style={{ fontSize: g.num - 1 }} textAnchor="middle">
          {n}
        </text>
      ))}
      {/* click targets */}
      {interactive &&
        Array.from({ length: STRING_COUNT }, (_, i) => (
          <g key={`c${i}`}>
            <rect
              className="fd-hit marker"
              x={sx(i) - g.gap / 2}
              y={0}
              width={g.gap}
              height={g.padT - 2}
              role="button"
              aria-label={`String ${i + 1} (${OPEN_LABELS[i]}): switch open or muted`}
              onClick={() => onChange(toggleOpen(frets, i))}
            />
            {Array.from({ length: rows }, (_, r) => (
              <g key={r} className="fd-cell">
                <circle cx={sx(i)} cy={rowY(r) + g.fh / 2} r={g.r} className="fd-ghost" />
                <rect
                  className="fd-hit"
                  x={sx(i) - g.gap / 2}
                  y={rowY(r)}
                  width={g.gap}
                  height={g.fh}
                  role="button"
                  aria-label={`String ${i + 1} (${OPEN_LABELS[i]}), fret ${start + r}`}
                  onClick={() => onChange(toggleFret(frets, i, start + r))}
                />
              </g>
            ))}
          </g>
        ))}
    </svg>
  )
}
