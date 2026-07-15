import { chromium } from 'playwright-core'
const b = await chromium.launch(); const p = await b.newPage()
await p.setViewportSize({ width: 1300, height: 900 })
const errs = []; p.on('pageerror', e => errs.push(e.message))
await p.goto('http://localhost:5199/', { waitUntil: 'networkidle' }); await p.waitForTimeout(400)
const c = await p.$('[data-scale-id]'); if (c) { await c.click(); await p.waitForTimeout(250) }
const o = await p.$('.open-roll'); if (o && !(await o.isDisabled())) { await o.click(); await p.waitForTimeout(600) }

const order = () => p.$$eval('.templates-list.root .template-name, .templates-list.root .folder-name', els => els.map(e => e.textContent))
console.log('start order:', await order())

// grab the grip of "Scale Up" and drag it above "Chord up"
const row = p.locator('.template-row', { hasText: 'Scale Up' })
const grip = row.locator('.tree-grip')
const gb = await grip.boundingBox()
const chord = p.locator('.template-row', { hasText: 'Chord up' }).first()
const cb = await chord.boundingBox()

await p.mouse.move(gb.x + gb.width / 2, gb.y + gb.height / 2)
await p.mouse.down()
await p.waitForTimeout(50)
console.log('ghost visible after down+move?', null)
// move upward in steps, sampling order mid-drag (before releasing)
await p.mouse.move(cb.x + 40, cb.y + 4, { steps: 6 })
await p.waitForTimeout(120)
const midOrder = await order()
const ghost = await p.$('.template-drag-ghost')
console.log('MID-DRAG order (before release):', midOrder)
console.log('ghost element present mid-drag:', !!ghost)
await p.mouse.up()
await p.waitForTimeout(150)
console.log('after release order:', await order())
console.log('ghost gone after release:', !(await p.$('.template-drag-ghost')))
console.log('errors:', errs.length ? errs : '(none)')
await b.close()
