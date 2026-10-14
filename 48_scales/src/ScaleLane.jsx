import { useRef, useState } from 'react'
import { moveLimits } from './scaleZones'

// The lane above the measure ruler where scale zones live.
//   click empty space   -> a zone over that whole measure
//   drag empty space    -> a zone over the dragged cells, snapped to the chosen
//                          rhythm SUBDIVISION (so a measure can hold several
//                          scales); hold Shift to snap to whole measures
//   click a zone        -> select it and pick its scale (Ctrl/Cmd/Shift-click
//                          adds it to the selection instead)
//   drag a zone's body  -> MOVE it, or the whole selection if it is part of it;
//                          snapped the same way, and it cannot pass other zones
//   drag a zone's edge  -> resize, snapped the same way (Shift = measures)
//   right-click a zone  -> menu; right-click empty space -> paste / select all
// snapCells is the subdivision in cells (it can be fractional: a triplet is 4/3);
// 0 means free mode, where nothing snaps.
//
// All positions are in 16th-cells. Pointer x <-> cell goes through the roll's
// own beatToX / xToBeat so zooming and swing view line up with the grid.
export const LANE_H = 24
const EDGE_PX = 7

export default function ScaleLane({
  zones,
  activeZoneId,
  selectedIds,
  totalCells,
  cellsPerMeasure,
  snapCells,
  barWidth,
  beatToX,
  xToBeat,
  labelFor,
  titleFor,
  missingIds,
  onCreate,
  onResize,
  onMoveZones,
  onSelect,
  onHome,
  onContextMenu,
  onBarContextMenu,
}) {
  const barRef = useRef(null)
  // Live preview while dragging: { kind: 'create' | 'resize' | 'move', ... }
  const [drag, setDrag] = useState(null)

  const cellAt = (e) => {
    const rect = barRef.current.getBoundingClientRect()
    return xToBeat(e.clientX - rect.left)
  }
  const measureOf = (cell) => Math.max(0, Math.floor(cell / cellsPerMeasure))
  // Snap size while dragging: the chosen subdivision, or a whole measure with
  // Shift held. 0 = no snapping (free mode).
  const unitOf = (ev) => (ev.shiftKey ? cellsPerMeasure : snapCells)
  // Float noise from fractional subdivisions (triplets) must not leak into zones.
  const clean = (v) => Math.round(v * 1e6) / 1e6
  // The narrowest a zone can be: one subdivision (a quarter cell when free).
  const minWidth = snapCells > 0 ? snapCells : 0.25
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
        // dragged: cover every subdivision (or measure, with Shift) from the
        // press to the pointer
        const unit = unitOf(ev)
        const here = cellAt(ev)
        if (unit > 0) {
          const u0 = Math.max(0, Math.floor(d.c0 / unit + 1e-9))
          const u1 = Math.max(0, Math.floor(here / unit + 1e-9))
          return {
            ...d,
            moved,
            start: clean(Math.min(u0, u1) * unit),
            end: clean((Math.max(u0, u1) + 1) * unit),
          }
        }
        const lo = Math.max(0, Math.min(d.c0, here))
        return { ...d, moved, start: clean(lo), end: clean(Math.max(d.c0, here, lo + minWidth)) }
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
        const raw = cellAt(ev)
        const snapped = clean(unit > 0 ? Math.round(raw / unit) * unit : raw)
        // a zone is never narrower than one subdivision
        if (edge === 'left') {
          return { ...d, start: clean(Math.max(0, Math.min(snapped, d.end - minWidth))) }
        }
        return { ...d, end: clean(Math.max(snapped, d.start + minWidth)) }
      },
      (d) => onResize(d.id, d.start, d.end)
    )
  }

  // Move: grab a zone's body. A click (barely any movement) selects it; a drag
  // moves it, or the whole selection when the grabbed zone is part of it.
  const startMove = (e, zone) => {
    if (e.button !== 0) return
    e.stopPropagation()
    e.preventDefault()
    const additive = e.ctrlKey || e.metaKey || e.shiftKey
    const rect = e.currentTarget.getBoundingClientRect()
    const ids = selectedIds.has(zone.id) ? [...selectedIds] : [zone.id]
    const { minDelta, maxDelta } = moveLimits(zones, ids)
    beginDrag(
      e,
      {
        kind: 'move',
        id: zone.id,
        ids,
        rect,
        additive,
        c0: cellAt(e),
        x0: e.clientX,
        moved: false,
        delta: 0,
        minDelta,
        maxDelta,
        anchorStart: zone.start,
      },
      (d, ev) => {
        const moved = d.moved || Math.abs(ev.clientX - d.x0) >= DRAG_PX
        if (!moved) return d
        // snap where the grabbed zone would start, then keep the group inside
        // the room it has (it cannot pass an unselected zone or cell 0)
        const unit = unitOf(ev)
        const raw = d.anchorStart + (cellAt(ev) - d.c0)
        const start = clean(unit > 0 ? Math.round(raw / unit) * unit : raw)
        const delta = clean(Math.max(d.minDelta, Math.min(d.maxDelta, start - d.anchorStart)))
        return { ...d, moved, delta }
      },
      (d) => {
        if (!d.moved) onSelect(d.id, d.rect, d.additive)
        else if (Math.abs(d.delta) > 1e-6) onMoveZones(d.ids, d.delta)
      }
    )
  }

  const shown = zones.map((z) => {
    if (drag && drag.kind === 'resize' && drag.id === z.id) {
      return { ...z, start: drag.start, end: drag.end }
    }
    if (drag && drag.kind === 'move' && drag.moved && drag.ids.includes(z.id)) {
      return { ...z, start: z.start + drag.delta, end: z.end + drag.delta }
    }
    return z
  })

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
        onContextMenu={(e) => {
          e.preventDefault()
          onBarContextMenu(e, cellAt(e))
        }}
        title="Click for a whole measure, or drag to give part of a measure its own scale (snaps to the chosen subdivision). Hold Shift while dragging to snap to whole measures."
      >
        {shown.map((z) => {
          const left = beatToX(z.start)
          const width = beatToX(z.end) - left
          return (
            <div
              key={z.id}
              className={`scale-zone ${z.id === activeZoneId ? 'active' : ''} ${
                selectedIds.has(z.id) ? 'selected' : ''
              } ${missingIds?.has(z.id) ? 'missing' : ''} ${
                drag && drag.kind === 'move' && drag.moved && drag.ids.includes(z.id)
                  ? 'moving'
                  : ''
              }`}
              style={{ left, width }}
              title={titleFor(z)}
              onPointerDown={(e) => startMove(e, z)}
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
            click a measure, or drag across a part of one, to assign a scale
          </span>
        )}
      </div>
    </div>
  )
}
