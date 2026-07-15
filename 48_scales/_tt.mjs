import { chromium } from 'playwright-core'
const b = await chromium.launch(); const p = await b.newPage()
await p.setViewportSize({ width: 1300, height: 900 })
const errs = []; p.on('pageerror', e => errs.push(e.message))
await p.goto('http://localhost:5199/', { waitUntil: 'networkidle' }); await p.waitForTimeout(400)
const c = await p.$('[data-scale-id]'); if (c) { await c.click(); await p.waitForTimeout(250) }
const o = await p.$('.open-roll'); if (o && !(await o.isDisabled())) { await o.click(); await p.waitForTimeout(600) }
console.log('roll:', !!(await p.$('.roll-view')))

// + dropdown
const plus = await p.$('button[aria-label="New template or folder"], .template-new-wrap button')
await plus.click(); await p.waitForTimeout(200)
console.log('dropdown:', !!(await p.$('.template-new-menu')))
const items = await p.$$eval('.template-new-menu .tab-context-menu-item', els => els.map(e => e.textContent.trim()))
console.log('menu items:', items)

// New folder
const folderBtn = (await p.$$('.template-new-menu .tab-context-menu-item'))[1]
await folderBtn.click(); await p.waitForTimeout(300)
console.log('folder rows:', (await p.$$('.folder-row')).length)
// commit folder rename
await p.keyboard.press('Enter'); await p.waitForTimeout(200)

// New template -> editor
await plus.click(); await p.waitForTimeout(150)
const tmplBtn = (await p.$$('.template-new-menu .tab-context-menu-item'))[0]
await tmplBtn.click(); await p.waitForTimeout(300)
console.log('editor modal:', !!(await p.$('.template-editor-modal')))
console.log('editor rows:', (await p.$$('.template-editor-grid .te-row')).length)
// add a couple notes by clicking cells
const cells = await p.$$('.te-row .te-cell')
if (cells.length > 20) { await cells[3].click(); await cells[20].click(); await p.waitForTimeout(150) }
console.log('notes placed:', (await p.$$('.te-note')).length)
await p.fill('.template-editor-name', 'My Pattern')
const saveBtn = await p.$('.template-editor-modal .modal-actions .primary')
console.log('save disabled:', await saveBtn.isDisabled())
await saveBtn.click(); await p.waitForTimeout(300)
console.log('editor closed:', !(await p.$('.template-editor-modal')))
const names = await p.$$eval('.template-name', els => els.map(e => e.textContent))
console.log('template names:', names)
console.log('total template rows:', (await p.$$('.template-row')).length)

await p.$('.variation-panel').then(m => m.screenshot({ path: '_tt.png' }))
console.log('errors:', errs.length ? errs : '(none)')
await b.close()
