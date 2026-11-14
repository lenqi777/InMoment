'use strict';
const fs = require('node:fs');
const path = require('node:path');
const out = __dirname;
const cream = '#F5EDCF', gold = '#D9B57A';
const variants = [
  { name:'01 · 直柱', note:'圆点拉为圆头柱，尾钩展开为实心箭头。',
    pause:`<rect x="19" y="18" width="8" height="28" rx="4" fill="${gold}"/><rect x="36" y="18" width="9" height="28" rx="4.5" fill="${cream}"/>`,
    play:`<ellipse cx="43" cy="18" rx="5" ry="3" transform="rotate(-23 43 18)" fill="${gold}"/><path d="M23 18Q21 16 21 20V44Q21 48 25 45L46 33Q48 32 46 30L28 19Q25 17 23 18Z" fill="${cream}"/>` },
  { name:'02 · 斜笔', note:'延续 i 的斜度，用细尾钩围出播放轮廓。',
    pause:`<path d="M25 18Q27 18 26.5 21L22.5 43Q22 46 19 46H17Q14 46 14.5 43L18.5 21Q19 18 22 18Z" fill="${gold}"/><path d="M43 18Q46 18 45.5 21L41.5 43Q41 46 38 46H36Q33 46 33.5 43L37.5 21Q38 18 41 18Z" fill="${cream}"/>`,
    play:`<ellipse cx="43" cy="19" rx="5.2" ry="2.8" transform="rotate(-32 43 19)" fill="${gold}"/><path d="M25 19L21 43Q20 47 25 44L45 32L25 19M25 19L30 21" fill="none" stroke="${cream}" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/>` },
  { name:'03 · 长短笔', note:'保留字母的主次笔画，播放态留一个切口。',
    pause:`<rect x="19" y="21" width="8" height="24" rx="4" fill="${gold}"/><path d="M38 16Q44 15 44 21L40 42Q39 46 43 44L45 43V47Q39 51 34 47Q32 45 33 40L37 20L35 21V17Z" fill="${cream}"/>`,
    play:`<ellipse cx="43" cy="18" rx="5" ry="3" transform="rotate(-18 43 18)" fill="${gold}"/><path d="M23 17L46 31Q48 32 46 34L24 47Q20 49 21 44L25 28H30L27 40L39 32L23 23Z" fill="${cream}"/>` },
  { name:'04 · 连笔', note:'笔画收尾更圆润，尾钩连成柔和三角。',
    pause:`<path d="M24 18C28 18 29 20 28 24L24 42C23 46 21 47 18 46C15 45 15 43 16 40L20 22C20.5 19 21 18 24 18Z" fill="${gold}"/><path d="M40 17C44 17 46 19 45 23L41 41C40.5 44 42 44 44 43L45 46C40 50 34 49 33 45C32.5 43 33 41 34 38L38 21C38.5 18 38.5 17 40 17Z" fill="${cream}"/>`,
    play:`<ellipse cx="43" cy="19" rx="5.4" ry="3" transform="rotate(-27 43 19)" fill="${gold}"/><path d="M24 20C24 17 27 18 29 20L43 29C46 31 46 33 43 35L26 45C22 47 20 46 21 42L25 25M25 25L29 27" fill="none" stroke="${cream}" stroke-width="5.5" stroke-linecap="round" stroke-linejoin="round"/>` },
  { name:'05 · 极简', note:'细长金色点与轻量主笔，适合小尺寸。',
    pause:`<rect x="20" y="19" width="6" height="26" rx="3" fill="${gold}"/><path d="M39 18L35 42Q34 46 40 45" fill="none" stroke="${cream}" stroke-width="6" stroke-linecap="round"/>`,
    play:`<ellipse cx="43" cy="20" rx="4.6" ry="2.7" transform="rotate(-35 43 20)" fill="${gold}"/><path d="M25 19L21 43Q20 46 25 43L45 32L26 20" fill="none" stroke="${cream}" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/>` },
];
const svg = (shape, label) => `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64" role="img" aria-label="${label}"><circle cx="32" cy="32" r="32" fill="#324C36"/>${shape}</svg>`;
for (const [index, v] of variants.entries()) for (const state of ['pause','play']) fs.writeFileSync(path.join(out,`${index+1}-${state}.svg`),svg(v[state],`${v.name} ${state==='pause'?'暂停':'继续'}`));
const cards=variants.map((v,i)=>`<article><h2>${v.name}</h2><div class="pair"><figure><img src="${i+1}-pause.svg"><figcaption>点击暂停</figcaption></figure><figure><img src="${i+1}-play.svg"><figcaption>点击继续</figcaption></figure></div><p>${v.note}</p><div class="small"><img src="${i+1}-pause.svg"><img src="${i+1}-play.svg"><span>28 px</span></div></article>`).join('');
fs.writeFileSync(path.join(out,'index.html'),`<!doctype html><html lang="zh-CN"><meta charset="UTF-8"><title>InMoment · i 形变图标候选</title><style>*{box-sizing:border-box}body{margin:0;padding:32px;background:#fff;color:#171a1d;font:14px/1.7 'Segoe UI','Microsoft YaHei UI',sans-serif}h1{font-size:24px;margin:0 0 8px}header p{margin:0;color:#5d646d}.board{display:grid;grid-template-columns:repeat(5,1fr);gap:16px;margin-top:28px}article{padding:20px 16px;border:1px solid #dee2e6;border-radius:16px}h2{font-size:16px;margin:0 0 24px}.pair{display:flex;justify-content:space-between;gap:12px}figure{margin:0;text-align:center}figure img{display:block;width:72px;height:72px}figcaption{font-size:12px;color:#5d646d;margin-top:12px}article p{min-height:48px;margin:24px 0 20px;font-size:12px;color:#5d646d}.small{display:flex;align-items:center;gap:12px;padding-top:16px;border-top:1px solid #edf0f2}.small img{width:28px;height:28px}.small span{color:#5d646d;font-size:11px;margin-left:auto}footer{margin-top:24px;color:#5d646d;font-size:12px}</style><header><h1>InMoment · i 形变图标候选</h1><p>每组左侧：录音中，点击暂停；右侧：已暂停，点击继续。保留金色点、米白主笔与深绿圆底。</p></header><section class="board">${cards}</section><footer>本页为五组静态状态草稿，供选择；尚未替换应用图标。</footer></html>`);
console.log('Created five paired SVG icon candidates.');
