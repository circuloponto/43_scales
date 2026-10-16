import { useMemo } from 'react'
import { parseBlocks } from './noteParse'
import { resolveNoteList, resolveWiki } from './notes'
import { makeScaleContext } from './scaleContext'
import { pcName } from './chordVocab'
import ChordCard from './ChordCard'
import FretDiagram from './FretDiagram'
import { pitchesOf } from './fretShape'

// Draws a note's Markdown as React elements (never as HTML strings, so nothing
// typed into a note can inject markup). ctx comes from NotesView:
//   scales, scaleNameIndex, templates   to resolve [[scale ..]] / [[template ..]]
//   notesByTitle                        to tell real note links from ghosts
//   useFlats                            note-name spelling
//   onOpenNote(title)  onOpenScale({ scaleId, root, modeStep })  onTag(tag)

const pad = (id) => String(id).padStart(2, '0')

function scaleHead(scale, root, useFlats) {
  const id = scale.kind === 'custom' ? `★ ${scale.name}` : pad(scale.id)
  return `${id} · ${pcName(root, useFlats)}`
}
function scaleNoteNames(scale, root, modeStep, useFlats) {
  const c = makeScaleContext(scale, root, modeStep)
  return c.scale.notes.map((n) => pcName((n + c.root) % 12, useFlats)).join(' ')
}

// A scale reference: "04 · D   D E F G♭ A♭ B♭ B", click to open it in the roll.
function ScaleChip({ scale, root, modeStep, ctx, children }) {
  return (
    <button
      type="button"
      className="note-chip scale"
      title="Open this scale in the roll"
      onClick={() => ctx.onOpenScale({ scaleId: scale.id, root, modeStep })}
    >
      <b>{scaleHead(scale, root, ctx.useFlats)}</b>
      <span className="note-chip-notes">
        {scaleNoteNames(scale, root, modeStep, ctx.useFlats)}
      </span>
      {children}
      <span className="note-chip-go" aria-hidden="true">↗</span>
    </button>
  )
}

// {{D E F G A B C}}: the typed notes, and the scale they turn out to be.
function NotesToken({ raw, ctx }) {
  const { pcs, bad, matches } = resolveNoteList(raw, ctx.scales)
  if (bad.length || !pcs.length) {
    return <span className="note-chip muted" title="Not a list of note names">{`{{${raw}}}`}</span>
  }
  const typed = pcs.map((pc) => pcName(pc, ctx.useFlats)).join(' ')
  if (!matches.length) {
    return (
      <span className="note-chip muted" title="No scale in the app has exactly these notes">
        {typed} <i>· no matching scale</i>
      </span>
    )
  }
  const first = matches[0]
  const scale = ctx.scales.find((s) => s.id === first.scaleId)
  return (
    <ScaleChip scale={scale} root={first.root} modeStep={first.modeStep} ctx={ctx}>
      {matches.length > 1 && (
        <span className="note-chip-more" title={`${matches.length} matches (other modes / symmetric scales)`}>
          +{matches.length - 1}
        </span>
      )}
    </ScaleChip>
  )
}

function renderInline(nodes, ctx, keyBase = 'i') {
  return nodes.map((n, i) => {
    const key = `${keyBase}-${i}`
    switch (n.t) {
      case 'text':
        return n.v
      case 'br':
        return <br key={key} />
      case 'bold':
        return <strong key={key}>{renderInline(n.c, ctx, key)}</strong>
      case 'italic':
        return <em key={key}>{renderInline(n.c, ctx, key)}</em>
      case 'code':
        return <code key={key}>{n.v}</code>
      case 'link':
        return (
          <a key={key} href={n.href} target="_blank" rel="noopener noreferrer" className="note-ext">
            {renderInline(n.c, ctx, key)}
          </a>
        )
      case 'tag':
        return (
          <button key={key} type="button" className="note-tag" onClick={() => ctx.onTag(n.v.toLowerCase())}>
            #{n.v}
          </button>
        )
      case 'notes':
        return <NotesToken key={key} raw={n.raw} ctx={ctx} />
      case 'wiki': {
        const r = resolveWiki(n.raw, ctx)
        if (r.kind === 'scale') {
          return <ScaleChip key={key} scale={r.scale} root={r.root} modeStep={r.modeStep} ctx={ctx} />
        }
        if (r.kind === 'chord') {
          return (
            <ChordCard key={key} rootPc={r.rootPc} quality={r.quality} voicing={r.voicing} useFlats={ctx.useFlats} />
          )
        }
        if (r.kind === 'frets') {
          // A hand-drawn shape. A span (not a div) so it may sit inside a paragraph.
          return (
            <span key={key} className="fret-card">
              {r.label && <span className="fret-card-title">{r.label}</span>}
              <FretDiagram frets={r.frets} useFlats={ctx.useFlats} size="sm" />
              <span className="fret-card-notes">
                {pitchesOf(r.frets).map((p) => pcName(p.pc, ctx.useFlats)).join(' ')}
              </span>
              {ctx.onEditFrets && (
                <button
                  type="button"
                  className="fret-card-edit"
                  title="Edit this diagram"
                  aria-label="Edit diagram"
                  onClick={(e) =>
                    ctx.onEditFrets({
                      raw: r.raw,
                      frets: r.frets,
                      label: r.label,
                      rect: e.currentTarget.getBoundingClientRect(),
                    })
                  }
                >
                  ✎
                </button>
              )}
            </span>
          )
        }
        if (r.kind === 'template') {
          const from = r.template && r.template.capturedFrom
          return (
            <button
              key={key}
              type="button"
              className={`note-chip template ${r.template ? '' : 'muted'}`}
              disabled={!from}
              title={
                r.template
                  ? from
                    ? 'Open the scale this template was captured on, in the roll'
                    : 'Saved template'
                  : 'No template with this name'
              }
              onClick={() => from && ctx.onOpenScale({ scaleId: from.scaleId, root: from.root ?? 0, modeStep: null })}
            >
              <b>template</b> {r.name}
            </button>
          )
        }
        return (
          <a
            key={key}
            href="#"
            className={`note-link ${r.noteId ? '' : 'ghost'}`}
            title={r.noteId ? `Open “${r.title}”` : `“${r.title}” does not exist yet: click to create it`}
            onClick={(e) => {
              e.preventDefault()
              ctx.onOpenNote(r.title)
            }}
          >
            {r.alias || r.title}
          </a>
        )
      }
      default:
        return null
    }
  })
}

function renderBlock(b, ctx, key) {
  switch (b.t) {
    case 'h': {
      const Tag = `h${Math.min(6, Math.max(1, b.level))}`
      return <Tag key={key}>{renderInline(b.c, ctx, key)}</Tag>
    }
    case 'p': {
      // A chord diagram is a block (a div), which may not sit inside a <p>.
      const blocky = b.c.some((n) => n.t === 'wiki' && /^\s*chord\s/i.test(n.raw))
      return blocky ? (
        <div key={key} className="note-para">
          {renderInline(b.c, ctx, key)}
        </div>
      ) : (
        <p key={key}>{renderInline(b.c, ctx, key)}</p>
      )
    }
    case 'ul':
    case 'ol': {
      const List = b.t
      return (
        <List key={key} className="note-list">
          {b.items.map((it, i) => (
            <li key={i} style={{ marginLeft: it.depth * 18 }} className={it.checked !== null ? 'task' : ''}>
              {it.checked !== null && <input type="checkbox" checked={it.checked} readOnly />}
              {renderInline(it.c, ctx, `${key}-${i}`)}
            </li>
          ))}
        </List>
      )
    }
    case 'quote':
      return <blockquote key={key}>{b.c.map((x, i) => renderBlock(x, ctx, `${key}-${i}`))}</blockquote>
    case 'code':
      return (
        <pre key={key}>
          <code>{b.v}</code>
        </pre>
      )
    case 'hr':
      return <hr key={key} />
    default:
      return null
  }
}

export default function NoteRender({ body, ctx }) {
  const blocks = useMemo(() => parseBlocks(body), [body])
  if (!blocks.length) return <div className="note-render empty">Nothing here yet. Switch to Edit and start writing.</div>
  return <div className="note-render">{blocks.map((b, i) => renderBlock(b, ctx, `b${i}`))}</div>
}
