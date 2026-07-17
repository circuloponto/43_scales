import { useRef, useState } from 'react'
import {
  DndContext,
  PointerSensor,
  useSensor,
  useSensors,
  useDraggable,
  useDroppable,
  pointerWithin,
} from '@dnd-kit/core'
import { Folder, ChevronRight, ChevronDown } from 'lucide-react'

const isFolder = (n) => n && n.type === 'folder'

// Flatten the tree into the visible, ordered list (collapsed folders hide their
// children), tagging each node with its depth for indentation.
function flatten(templates) {
  const byParent = new Map()
  for (const n of templates) {
    const pid = n.parentId ?? null
    if (!byParent.has(pid)) byParent.set(pid, [])
    byParent.get(pid).push(n)
  }
  const out = []
  const walk = (pid, depth) => {
    for (const n of byParent.get(pid) || []) {
      out.push({ node: n, depth })
      if (isFolder(n) && !n.collapsed) walk(n.id, depth + 1)
    }
  }
  walk(null, 0)
  return out
}

// One row is both draggable (to move it) and a droppable (to detect the cursor
// over it). Rows DON'T move during a drag, so the drop target is rock-steady.
function Row({ item, ctx }) {
  const { node, depth } = item
  const renaming = ctx.renamingTemplateId === node.id
  const drag = useDraggable({ id: node.id, disabled: renaming })
  const drop = useDroppable({ id: node.id })
  const setRef = (el) => {
    drag.setNodeRef(el)
    drop.setNodeRef(el)
  }
  const isDragging = ctx.activeId === node.id
  const dropCls =
    ctx.overInfo && ctx.overInfo.id === node.id ? `drop-${ctx.overInfo.pos}` : ''

  const stop = (e) => e.stopPropagation()
  const renameInput = (
    <input
      className="template-rename"
      autoFocus
      value={ctx.renameValue}
      onChange={(e) => ctx.setRenameValue(e.target.value)}
      onClick={stop}
      onPointerDown={stop}
      onBlur={() => ctx.commitRename(node.id)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur()
        else if (e.key === 'Escape') ctx.cancelRename()
      }}
    />
  )

  const common = {
    ref: setRef,
    style: { paddingLeft: 12 + depth * 14 },
    ...drag.attributes,
    ...drag.listeners,
  }

  if (isFolder(node)) {
    return (
      <li className="template-tree-item" {...common}>
        <div
          className={`folder-row ${isDragging ? 'dragging' : ''} ${dropCls}`}
          onClick={() => ctx.onToggleFolder(node.id)}
          onContextMenu={(e) => {
            e.preventDefault()
            ctx.onContextMenu(e, node.id)
          }}
          title="Click to open/close · drag to move · right-click for options"
        >
          <button
            type="button"
            className="folder-toggle"
            onClick={(e) => {
              e.stopPropagation()
              ctx.onToggleFolder(node.id)
            }}
            onPointerDown={stop}
            aria-label={node.collapsed ? 'expand folder' : 'collapse folder'}
          >
            {node.collapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
          </button>
          <Folder size={14} className="folder-icon" />
          {renaming ? renameInput : <span className="folder-name">{node.name}</span>}
        </div>
      </li>
    )
  }

  return (
    <li className="template-tree-item" {...common}>
      <div
        className={`template-row ${
          ctx.pendingTemplate && ctx.pendingTemplate.id === node.id
            ? 'pending'
            : ''
        } ${ctx.selectedTemplateIds.has(node.id) ? 'checked' : ''} ${
          isDragging ? 'dragging' : ''
        } ${dropCls}`}
        onClick={() => ctx.onPlace(node)}
        onContextMenu={(e) => {
          e.preventDefault()
          ctx.onContextMenu(e, node.id)
        }}
        title="Click to place · tick to select · drag to move · right-click for options"
      >
        <input
          type="checkbox"
          className="template-check"
          checked={ctx.selectedTemplateIds.has(node.id)}
          onClick={stop}
          onPointerDown={stop}
          onChange={() => ctx.onToggleSelect(node.id)}
          title="Select for copy / export / delete"
          aria-label={`Select ${node.name}`}
        />
        {renaming ? renameInput : <span className="template-name">{node.name}</span>}
      </div>
    </li>
  )
}

export default function TemplateTree({
  templates,
  onMove,
  selectedTemplateIds,
  onToggleSelect,
  renamingTemplateId,
  renameValue,
  setRenameValue,
  commitRename,
  cancelRename,
  pendingTemplate,
  onPlace,
  onToggleFolder,
  onContextMenu,
}) {
  const [activeId, setActiveId] = useState(null)
  const [overInfo, setOverInfo] = useState(null)
  const overRef = useRef(null)
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } })
  )

  const flat = flatten(templates)

  // Rows are stable, so over.rect is accurate. Folder = before / inside / after
  // by cursor band; template = before / after by the halfway line.
  const computeOver = ({ active, over, activatorEvent, delta }) => {
    if (!over || active.id === over.id) return null
    const overNode = templates.find((n) => n.id === over.id)
    const rect = over.rect
    const py =
      (activatorEvent ? activatorEvent.clientY : 0) + (delta ? delta.y : 0)
    const rel = rect ? (py - rect.top) / rect.height : 0.5
    let pos
    if (isFolder(overNode)) {
      pos = rel < 0.2 ? 'before' : rel > 0.8 ? 'after' : 'inside'
    } else {
      pos = rel < 0.5 ? 'before' : 'after'
    }
    return { id: over.id, pos }
  }

  const ctx = {
    activeId,
    overInfo,
    selectedTemplateIds,
    onToggleSelect,
    renamingTemplateId,
    renameValue,
    setRenameValue,
    commitRename,
    cancelRename,
    pendingTemplate,
    onPlace,
    onToggleFolder,
    onContextMenu,
  }

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={pointerWithin}
      onDragStart={(e) => setActiveId(e.active.id)}
      onDragMove={(e) => {
        const info = computeOver(e)
        overRef.current = info
        setOverInfo(info)
      }}
      onDragOver={(e) => {
        const info = computeOver(e)
        overRef.current = info
        setOverInfo(info)
      }}
      onDragEnd={(e) => {
        const info = overRef.current
        if (info && e.active.id !== info.id) onMove(e.active.id, info.id, info.pos)
        setActiveId(null)
        setOverInfo(null)
        overRef.current = null
      }}
      onDragCancel={() => {
        setActiveId(null)
        setOverInfo(null)
        overRef.current = null
      }}
    >
      <ul className={`templates-list root ${activeId ? 'is-dnd-active' : ''}`}>
        {flat.map((item) => (
          <Row key={item.node.id} item={item} ctx={ctx} />
        ))}
      </ul>
    </DndContext>
  )
}
