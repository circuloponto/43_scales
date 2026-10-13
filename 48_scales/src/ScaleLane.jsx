import { useRef, useState } from 'react'

// The lane above the measure ruler where scale zones live.
//   click empty space   -> a zone over that whole measure
//   drag empty space    -> a zone over the dragged BEATS (so a measure can hold
//                          two or more scales); hold Shift to snap to measures
//   click a zone        -> select it and pick its scale
//   drag a zone's edge  -> resize, snapped to beats (Shift = measures)
//   right-click a zone  -> menu
//
// All positions are in 16th-cells. Pointer x <-> cell goes through the roll's
// own beatToX / xToBeat so zooming and swing view line up with the grid.
export const LANE_H = 24
const EDGE_PX = 7

export default function ScaleLane({
  zones,
  activeZoneId,
  totalCells,
  cellsPerMeasure,
  cellsPerBeat,
  barWidth,
  beatToX,
  xToBeat,
  labelFor,
  titleFor,
  missingIds,
  onCreate,
  onResize,
  onSelect,
  onHome,
  onContextMenu,
}) {
  const barRef = useRef(null)
  // Live preview while dragging: { kind: 'create' | 'resize', start, end, id? }
  const [drag, setDrag] = useState(null)

  const cellAt = (e) => {
    const rect = barRef.current.getBoundingClientRect()
    return xToBeat(e.clientX - rect.left)
  }
  const measureOf = (cell) => Math.max(0, Math.floor(cell / cellsPerMeasure))
  // Snap size while dragging: a beat, or a whole measure with Shift held.
  const unitOf = (ev) => (ev.shiftKey ? cellsPerMeasure : cellsPerBeat)
  const DRAG_PX = 4 // moving less than this is a click, not a drag

  // Pointer capture on the bar so a drag keeps tracking outside the lane.
  // The live drag is kept in a ref (and mirrored to state only for drawing) so
  // onEnd runs exactly once, outside any state updater: React's dev mode runs
  // updaters twice, which would otherwise create / resize a zone twice.
  const dragRef = useRef(null)
  const beginDrag = (e, init, onMove, onEnd) => {
    const bar = barRef.current
    const pointerId = e.pointerId
    bar.setPointerCapture?.(pointerId)
    dragRef.current = init
    setDrag(init)
    const move = (ev) => {
      if (!dragRef.current) return
      dragRef.current = onMove(dragRef.current, ev)
      setDrag(dragRef.current)
    }
    const up = (ev) => {
      bar.removeEventListener('pointermove', move)
      bar.removeEventListener('pointerup', up)
      bar.removeEventListener('pointercancel', up)
      try {
        bar.releasePointerCapture?.(pointerId)
      } catch {
        /* capture already gone */
      }
      const finished = dragRef.current
      dragRef.current = null
      setDrag(null)
      if (finished) onEnd(finished, ev)
    }
    bar.addEventListener('pointermove', move)
    bar.addEventListener('pointerup', up)
    bar.addEventListener('pointercancel', up)
  }

  const startCreate = (e) => {
    if (e.button !== 0) return
    e.preventDefault()
    const c0 = cellAt(e)
    const m0 = measureOf(c0)
    beginDrag(
      e,
      {
        kind: 'create',
        c0,
        x0: e.clientX,
        moved: false,
        // a plain click makes the whole measure under the pointer
        start: m0 * cellsPerMeasure,
        end: (m0 + 1) * cellsPerMeasure,
      },
      (d, ev) => {
        const moved = d.moved || Math.abs(ev.clientX - d.x0) >= DRAG_PX
        if (!moved) return d
        // dragged: cover every beat (or measure, with Shift) from press to pointer
        const unit = unitOf(ev)
        const u0 = Math.max(0, Math.floor(d.c0 / unit))
        const u1 = Math.max(0, Math.floor(cellAt(ev) / unit))
        return {
          ...d,
          moved,
          start: Math.min(u0, u1) * unit,
          end: (Math.max(u0, u1) + 1) * unit,
        }
      },
      (d, ev) => onCreate(d.start, d.end, ev)
    )
  }

  const startResize = (e, zone, edge) => {
    if (e.button !== 0) return
    e.preventDefault()
    e.stopPropagation()
    beginDrag(
      e,
      { kind: 'resize', id: zone.id, edge, start: zone.start, end: zone.end },
      (d, ev) => {
        const unit = unitOf(ev)
        const snapped = Math.round(cellAt(ev) / unit) * unit
        // a zone is never narrower than one beat
        if (edge === 'left') {
          return { ...d, start: Math.max(0, Math.min(snapped, d.end - cellsPerBeat)) }
        }
        return { ...d, end: Math.max(snapped, d.start + cellsPerBeat) }
      },
      (d) => onResize(d.id, d.start, d.end)
    )
  }

  const shown = zones.map((z) =>
    drag && drag.kind === 'resize' && drag.id === z.id
      ? { ...z, start: drag.start, end: drag.end }
      : z
  )

  return (
    <div className="scale-lane" style={{ height: LANE_H }}>
      <div className="scale-lane-corner">
        <button
          type="button"
          className={`scale-lane-home ${activeZoneId == null ? 'on' : ''}`}
          onClick={onHome}
          title="Home scale: the scale picked in the matrix. Used wherever no zone is set."
        >
          home
        </button>
      </div>
      <div
        className="scale-lane-bar"
        ref={barRef}
        style={{ width: barWidth }}
        onPointerDown={startCreate}
        title="Click for a whole measure, or drag across beats to give them their own scale. Hold Shift while dragging to snap to whole measures."
      >
        {shown.map((z) => {
          const left = beatToX(z.start)
          const width = beatToX(z.end) - left
          return (
            <div
              key={z.id}
              className={`scale-zone ${z.id === activeZoneId ? 'active' : ''} ${
                missingIds?.has(z.id) ? 'missing' : ''
              }`}
              style={{ left, width }}
              title={titleFor(z)}
              onPointerDown={(e) => {
                e.stopPropagation()
                if (e.button === 0) onSelect(z.id, e.currentTarget.getBoundingClientRect())
              }}
              onContextMenu={(e) => {
                e.preventDefault()
                e.stopPropagation()
                onContextMenu(e, z.id)
              }}
            >
              <span
                className="scale-zone-edge left"
                style={{ width: EDGE_PX }}
                onPointerDown={(e) => startResize(e, z, 'left')}
              />
              {(() => {
                // head = "04 · C", notes = the scale's notes from the root
                const { head, notes } = labelFor(z)
                return (
                  <span className="scale-zone-label">
                    <b>{head}</b>
                    {notes && <span className="scale-zone-notes">{notes}</span>}
                  </span>
                )
              })()}
              <span
                className="scale-zone-edge right"
                style={{ width: EDGE_PX }}
                onPointerDown={(e) => startResize(e, z, 'right')}
              />
            </div>
          )
        })}
        {drag && drag.kind === 'create' && (
          <div
            className="scale-zone preview"
            style={{
              left: beatToX(drag.start),
              width: beatToX(drag.end) - beatToX(drag.start),
            }}
          />
        )}
        {zones.length === 0 && !drag && (
          <span className="scale-lane-hint" style={{ maxWidth: totalCells }}>
            click a measure, or drag across beats, to assign a scale
          </span>
        )}
      </div>
    </div>
  )
}
