import { chromium } from 'playwright-core'
const b=await chromium.launch();const p=await b.newPage()
await p.setViewportSize({width:1300,height:820})
await p.goto('http://localhost:5199/',{waitUntil:'networkidle'});await p.waitForTimeout(400)
const c=await p.$('[data-scale-id]');if(c){await c.click();await p.waitForTimeout(250)}
const o=await p.$('.open-roll');if(o&&!(await o.isDisabled())){await o.click();await p.waitForTimeout(600)}
const src=p.locator('.template-row',{hasText:'Chord up'}).first()
const tgt=p.locator('.template-row',{hasText:'Chord up, Scale Down'})
const sb=await src.boundingBox(); await p.mouse.move(sb.x+sb.width/2,sb.y+sb.height/2);await p.mouse.down()
await p.mouse.move(sb.x+3,sb.y+15,{steps:4})
const tb=await tgt.boundingBox(); await p.mouse.move(tb.x+tb.width/2,tb.y+tb.height*0.8,{steps:12});await p.waitForTimeout(120)
await p.mouse.up()
// sample computed transforms over the next ~150ms
let maxNonIdentity=0
for(let i=0;i<10;i++){
  const n=await p.evaluate(()=>[...document.querySelectorAll('.templates-list.root [data-node-id]')].filter(li=>{const t=getComputedStyle(li).transform;return t&&t!=='none'&&t!=='matrix(1, 0, 0, 1, 0, 0)'}).length)
  maxNonIdentity=Math.max(maxNonIdentity,n)
  await p.waitForTimeout(20)
}
console.log('rows animating (non-identity transform observed):', maxNonIdentity)
await b.close()
