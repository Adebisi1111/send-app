// Responsive + contrast check for landing.html.
// Uses the app's real served file at every stated target size and asserts on
// the live DOM rather than on a hand-computed guess.
// Resolve playwright from this repo's own node_modules, falling back to a
// global install. Hardcoding an absolute path meant the checker could only
// ever run on the machine that wrote it.
const { chromium } = require(require.resolve('playwright', { paths: [__dirname] }));
const { mkdirSync } = require('fs');
const { join } = require('path');
const SHOT_DIR = process.env.SHOT_DIR || join(__dirname, '.ui-shots');
mkdirSync(SHOT_DIR, { recursive: true });

const SIZES = [[1280,720],[1920,1080],[2560,1080],[768,1024],[390,844],[375,812],[320,640]];
const URL = process.env.TARGET || 'http://127.0.0.1:8894/landing.html';

function PROBE() {
  const de = document.documentElement;
  const v = document.getElementById('clip');
  const parse = c => (c.match(/[\d.]+/g)||[]).map(Number);
  const lum = rgb => { const f=x=>{x/=255; return x<=0.03928? x/12.92 : Math.pow((x+0.055)/1.055,2.4);};
                       return 0.2126*f(rgb[0])+0.7152*f(rgb[1])+0.0722*f(rgb[2]); };
  const ratio = (a,b) => { const la=lum(a), lb=lum(b); const hi=Math.max(la,lb), lo=Math.min(la,lb);
                           return (hi+0.05)/(lo+0.05); };
  const effBg = el => { let n=el; while(n && n!==de){ const b=parse(getComputedStyle(n).backgroundColor);
                        if(b.length>=3 && (b[3]===undefined||b[3]>0.9)) return b.slice(0,3); n=n.parentElement; }
                        return [10,11,13]; };

  // collect overflowing elements, excluding .grain (inset:-50% by design and
  // clipped by .stage overflow:hidden)
  const over = [];
  // .grain is inset:-50% and .stage video is scale(1.02); both are clipped by
  // .stage overflow:hidden, so their boxes exceed the viewport by design.
  const CLIPPED = new Set(['grain','stage','clip','veil','VIDEO']);
  document.querySelectorAll('body *').forEach(el => {
    // .grain is inset:-50%, .stage video is scale(1.02); both are clipped by
    // .stage overflow:hidden so their boxes exceed the viewport by design.
    // The video has no className, hence the explicit tag entry.
    if (CLIPPED.has(el.className) || CLIPPED.has(el.tagName)) return;
    const r = el.getBoundingClientRect();
    if (r.width > 0 && r.right > window.innerWidth + 1) over.push(el.tagName + '.' + el.className);
  });

  // small-text contrast for the visible panel
  const bad = [];
  document.querySelectorAll('.panel').forEach(p => {
    if ((+p.style.opacity || 0) < 0.05) return;   // only judge what is readable
    p.querySelectorAll('*').forEach(el => {
      const t = [...el.childNodes].filter(n=>n.nodeType===3 && n.textContent.trim())
                  .map(n=>n.textContent.trim()).join(' ');
      if (!t) return;
      const cs = getComputedStyle(el);
      if (cs.display === 'none') return;
      const fg = parse(cs.color); if (fg.length < 3) return;
      const fs = parseFloat(cs.fontSize), fw = parseInt(cs.fontWeight)||400;
      const large = fs >= 24 || (fs >= 18.66 && fw >= 700);
      const need = large ? 3 : 4.5;
      const r = ratio(fg.slice(0,3), effBg(el));
      if (r < need) bad.push(fs+'px "'+t.slice(0,24)+'" '+r.toFixed(2)+'/'+need);
    });
  });

  // every touch target that is a button or link
  const small = [];
  document.querySelectorAll('a,button').forEach(el => {
    const r = el.getBoundingClientRect();
    if (r.height > 0 && r.height < 36) small.push((el.textContent||'').trim().slice(0,16)+' h='+Math.round(r.height));
  });

  // Two real bugs lived in this file unnoticed for a long time: `className=`
  // (React syntax) inside plain HTML, on a link and on a wrapper. The elements
  // still rendered and still worked, so nothing threw -- they simply came out
  // with class="" and therefore completely unstyled at 17px, failing the touch
  // floor above. Every check missed them because it looked for a class that had
  // never been applied. Assert the cause, not just the symptom.
  const reactAttrs = [];
  document.querySelectorAll('body *').forEach(el => {
    for (const a of el.attributes) {
      // NOTE: the HTML parser lowercases attribute names, so React's className
      // arrives here as "classname". A case-sensitive regex silently matches
      // nothing -- which is exactly how this guard passed a page that still had
      // the bug. Match case-insensitively.
      if (/^(classname|htmlfor|onclick|onchange|defaultvalue|tabindex)$/i.test(a.name)
          && a.name !== 'tabindex') {
        reactAttrs.push(a.name + ' on <' + el.tagName.toLowerCase() + '> "'
          + el.textContent.trim().slice(0, 28) + '"');
      }
    }
  });
  reactAttrs.forEach((f) => small.push('REACT ATTR ' + f));

  return { sw: de.scrollWidth, vw: window.innerWidth, hscroll: de.scrollWidth > window.innerWidth,
           over, badContrast: bad, smallTargets: small,
           video: v.videoWidth+'x'+v.videoHeight, dur: v.duration,
           boot: document.getElementById('boot').className,
           hasBlob: (v.currentSrc||'').startsWith('blob:') };
}

(async () => {
  const browser = await chromium.launch();
  let fails = 0;
  for (const [w, h] of SIZES) {
    const page = await browser.newPage({ viewport: { width: w, height: h } });
    await page.goto(URL, { waitUntil: 'networkidle' });
    await page.waitForTimeout(2600);
    // exercise the scrub so a panel is actually visible at this size
    await page.evaluate(() => window.scrollTo(0, (document.documentElement.scrollHeight - innerHeight) * 0.5));
    await page.waitForTimeout(600);
    const r = await page.evaluate(PROBE);  // real fn, no string escaping

    const issues = [];
    if (r.hscroll) issues.push('H-SCROLL ' + r.sw + '>' + r.vw);
    if (r.over.length) issues.push('overflow: ' + r.over.join(','));
    if (r.badContrast.length) issues.push('contrast: ' + r.badContrast.join(' | '));
    if (r.smallTargets.length) issues.push('small targets: ' + r.smallTargets.join(','));
    if (!r.hasBlob) issues.push('video not blob-backed');
    if (r.boot !== 'done') issues.push('preloader stuck: ' + r.boot);
    if (issues.length) fails++;

    console.log(
      String(w).padStart(4) + 'x' + String(h).padEnd(5) +
      (issues.length ? 'FAIL  ' + issues.join('  ') : 'pass')
    );
    // into a repo-local dir so this works on any machine, not just the one
    // that wrote it. SHOT_DIR is created by verify-ui.mjs.
    await page.screenshot({ path: `${SHOT_DIR}/ease-${w}x${h}.png` });
    await page.close();
  }
  await browser.close();
  console.log('\n' + (SIZES.length - fails) + '/' + SIZES.length + ' sizes clean  <- ' + URL.split('/').pop());
  process.exit(fails ? 1 : 0);
})();
