'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const css=fs.readFileSync(path.join(__dirname,'../src/overlay/styles.css'),'utf8');
function rule(selector){const line=css.indexOf('\n'+selector+' {');assert.notEqual(line,-1,selector);const start=line+1;return css.slice(start+selector.length+2,css.indexOf('}',start));}
const px=(body,name)=>Number(body.match(new RegExp('(?:^|;)\\s*'+name+':(-?[\\d.]+)px(?:;|$)'))?.[1]);
test('the capsule has a32px target while its28px visible brand retains its original footprint and halo',()=>{
 const logo=rule('.capsule-logo'),svg=rule('.capsule-logo svg'),halo=rule('.capsule-logo::after'),w=px(logo,'width'),h=px(logo,'height'),margin=px(logo,'margin'),visible=px(svg,'width');
 assert.ok(w>=32&&h>=32);assert.equal(visible,28);assert.equal(px(svg,'height'),28);
 assert.equal(w+margin*2,28,'grid footprint stays28px');assert.equal(h+margin*2,28,'vertical footprint stays28px');
 assert.equal(margin+(w-visible)/2,0,'visible horizontal anchor stays fixed');assert.equal(margin+(h-visible)/2,0,'visible vertical anchor stays fixed');
 assert.equal(w-px(halo,'inset')*2,30,'halo remains1px around the visible28px circle');
 assert.doesNotMatch(logo,/\bbackground(?:-color)?:/u);assert.match(css,/ui-controls\.css/u);assert.match(halo,/pointer-events:none/u);
});
test('the topic disclosure reserves its own32px target without negative overlap margins',()=>{
 const summary=rule('.draft-topics summary'),min=px(summary,'min-height'),line=px(summary,'line-height'),padding=summary.match(/padding:(\d+)px 0/u);
 assert.ok(min>=32);assert.ok(padding);assert.ok(line+Number(padding[1])*2>=32);assert.doesNotMatch(summary,/margin:-/u);
 const content=rule('.card-content');assert.ok(px(content,'margin-top')>=40,'the disclosure starts below the expanded logo target');
});
