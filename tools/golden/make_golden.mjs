import { writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const CHARSETS = { ascii: ' .:-=+*#%@', dots: ' .·:•●', binary: ' 01', blocks: ' ░▒▓█', code: ' .-=/<>[]{}#' }
const ACC_D = [120, 240, 255], ACC_L = [255, 50, 95]
let CFG, gw, gh, CH
const light = () => CFG.mode === 'light'

function mix(a,b,t){return [a[0]+(b[0]-a[0])*t,a[1]+(b[1]-a[1])*t,a[2]+(b[2]-a[2])*t];}
function rgb(a){return `rgb(${Math.max(0,Math.min(255,a[0]))|0},${Math.max(0,Math.min(255,a[1]))|0},${Math.max(0,Math.min(255,a[2]))|0})`;}
function pick(v,min=0){const n=CH.length;return CH[Math.max(min,Math.min(n-1,(v*n)|0))];}
function cellStyle(c,h){
 const x=c.x,y=c.y,m=c.m,L=c.L,src=[c.r,c.g,c.b],masked=CFG.mask,lt=light();
 const grain=1-CFG.noise*c.n;
 const st=CFG.style;
 if(st==='real'){
  if(masked&&m<.5){return {ch:(x+y)%3?' ':'.',col:rgb(lt?[205,205,200]:[40,40,44])};}
  const v=lt?1-L:L;
  let col=src.map(q=>q*grain);
  if(lt)col=col.map(q=>q*.92);
  col=mix(col,lt?ACC_L:ACC_D,h);
  return {ch:pick(Math.min(1,.55+v*.45+h),1),col:rgb(col)};
 }
 if(!lt){
  if(st==='blue'){
   let v=masked?(m>.5?(.18+.82*Math.min(1,L*1.3))*m:0):Math.min(1,Math.max(0,(L-.22)*1.5));
   v=Math.min(1,v+h*.9)*(.85+.15*grain);
   let ch=pick(v),col;
   if(ch===' '){ch=(x+y)%2?' ':'.';col=[60,108,236];}else col=mix([38,84,222],[255,255,255],.35+.65*v);
   if(h>.15)col=mix(col,[200,255,255],h);
   return {ch,col:rgb(col)};
  }
  if(st==='dark'){
   const k=(masked?(.15)*(1-m)+(.55+1.1*L)*m:.2+.85*Math.pow(L,1.6))*grain;
   let col=mix([120,30,40],src,m).map(v=>v*k);
   col=[col[0]+h*60,col[1]+h*230,col[2]+h*255];
   let ch=pick(Math.min(1,L*m+h));if(ch===' ')ch='.';
   return {ch,col:rgb(col)};
  }
  const fx=x/gw,fy=y/gh,a=Math.max(.15,1.1-fx-fy*.3),w=Math.max(0,.6-fx-fy*.4);
  const bg=[30*a+190*w,70*a+200*w,150*a+210*w];
  const sc=(masked?.7+.9*L:.35+.75*Math.pow(L,1.4))*grain;
  let col=mix(bg,src.map(v=>v*sc),m);
  col=[col[0]+h*120,col[1]+h*200,col[2]+h*255];
  return {ch:null,col:rgb(col),size:Math.min(1,(col[0]*.3+col[1]*.59+col[2]*.11)/255)};
 }
 const D=1-L;
 if(st==='blue'){
  let v=masked?(m>.5?(.2+.8*D)*m:0):Math.min(1,Math.max(0,(D-.15)*1.4));
  v=Math.min(1,v+h*.9)*(.85+.15*grain);
  let ch=pick(v),col;
  if(ch===' '){ch=(x+y)%2?' ':'.';col=[200,214,250];}else col=mix([236,241,255],[30,70,215],.4+.6*v);
  if(h>.15)col=mix(col,ACC_L,h);
  return {ch,col:rgb(col)};
 }
 if(st==='dark'){
  let v=masked?m*(.25+.75*D):Math.min(1,D*1.15);
  v=Math.min(1,v+h*.8);
  let ch=pick(v),col;
  if(ch===' '||(masked&&m<.5)){ch=(x+y)%3?' ':'.';col=[200,195,190];}
  else col=src.map(q=>q*(.55+.25*L)*grain);
  return {ch,col:rgb(mix(col,ACC_L,h))};
 }
 const bg=mix([226,232,245],[250,250,252],Math.min(1,x/gw*.8+y/gh*.3));
 let col=mix(bg,src.map(q=>q*.9*grain),m);
 return {ch:null,col:rgb(mix(col,ACC_L,h)),size:masked&&m<.5?.25:.25+.75*D};
}
function adjust(r,g,b,bc){
 const dist=Math.hypot(r-bc[0],g-bc[1],b-bc[2])/255;
 const m=CFG.mask?Math.min(1,Math.max(0,(dist-.12)/.18)):1;
 const l0=.299*r+.587*g+.114*b;
 [r,g,b]=[r,g,b].map(c=>((l0+(c-l0)*CFG.sat)-128)*CFG.contrast+128).map(c=>Math.max(0,Math.min(255,c*CFG.bright)));
 const L=(.299*r+.587*g+.114*b)/255;
 return {r,g,b,L,m};
}

let seed = 0x9e3779b9
function rand() {
  seed ^= seed << 13; seed >>>= 0
  seed ^= seed >>> 17
  seed ^= seed << 5; seed >>>= 0
  return seed / 4294967296
}
const parseRgb = (text) => text.match(/\d+/g).map(Number)

const cases = []
const adjusts = []
for (const style of ['real', 'blue', 'dark', 'mesh']) {
  for (const mode of ['dark', 'light']) {
    for (const mask of [false, true]) {
      for (const charset of Object.keys(CHARSETS)) {
        CFG = { style, mode, mask, charset, noise: [0, 0.25, 0.6][Math.floor(rand() * 3)], sat: 1.25, contrast: 1.1, bright: 1.25 }
        CH = CHARSETS[charset]
        gw = 40 + Math.floor(rand() * 200)
        gh = 20 + Math.floor(rand() * 120)
        for (let i = 0; i < 8; i++) {
          const cell = {
            x: Math.floor(rand() * gw), y: Math.floor(rand() * gh),
            r: rand() * 255, g: rand() * 255, b: rand() * 255,
            L: rand(), m: [0, 0.3, 0.5, 0.51, 0.8, 1, rand()][Math.floor(rand() * 7)], n: rand()
          }
          const h = [0, 0, 0.1, 0.16, 0.3, 0.7, 1, rand()][Math.floor(rand() * 8)]
          const out = cellStyle(cell, h)
          cases.push({ cfg: { ...CFG }, gw, gh, cell, h, ch: out.ch, col: parseRgb(out.col), size: out.size ?? null })
        }
      }
    }
  }
}
for (const mask of [false, true]) {
  for (let i = 0; i < 64; i++) {
    CFG = { mask, sat: rand() * 2, contrast: 0.5 + rand() * 1.5, bright: 0.4 + rand() * 1.4 }
    const bc = [rand() * 255, rand() * 255, rand() * 255].map(Math.round)
    const px = [rand() * 255, rand() * 255, rand() * 255].map(Math.round)
    adjusts.push({ cfg: { ...CFG }, bc, px, out: adjust(px[0], px[1], px[2], bc) })
  }
}
const target = join(dirname(fileURLToPath(import.meta.url)), 'cellstyle.json')
writeFileSync(target, JSON.stringify({ charsets: CHARSETS, cases, adjusts }) + '\n')
console.log(`${cases.length} cell cases, ${adjusts.length} adjust cases -> ${target}`)
