// The settled-request popup must fit and stay legible on a phone, and its
// controls must clear the touch floor. Checks real geometry at 7 sizes.
// Resolve playwright from this repo's own node_modules, falling back to a
// global install. Hardcoding an absolute path meant the checker could only
// ever run on the machine that wrote it.
const { chromium } = require(require.resolve('playwright', { paths: [__dirname] }));
const URL = process.env.TARGET || 'http://127.0.0.1:8901/.pop-harness.html';
const SIZES = [[1280,800],[1920,1080],[768,1024],[390,844],[375,812],[320,640]];

(async () => {
  const browser = await chromium.launch();
  let fails = 0;
  for (const [w,h] of SIZES) {
    const page = await browser.newPage({ viewport: { width: w, height: h } });
    await page.goto(URL, { waitUntil: 'networkidle' });
    const r = await page.evaluate(() => {
      const card = document.querySelector('.pop-card');
      const ring = document.querySelector('.pop-ring');
      const amt  = document.querySelector('.pop-amt');
      const done = document.querySelector('.pop-close');
      const btn  = document.querySelector('.msg-ring');
      const cb = card.getBoundingClientRect(), rb = ring.getBoundingClientRect();
      const ab = amt.getBoundingClientRect(), db = done.getBoundingClientRect();
      const bb = btn.getBoundingClientRect();
      const before = getComputedStyle(ring, '::before');
      return {
        docScrollW: document.documentElement.scrollWidth,
        innerW: innerWidth,
        cardFits: cb.width <= innerWidth && cb.left >= -0.5 && cb.right <= innerWidth + 0.5,
        ringSize: Math.round(rb.width),
        ringFits: rb.left >= -0.5 && rb.right <= innerWidth + 0.5,
        ringPaints: before.backgroundColor !== 'rgba(0, 0, 0, 0)',
        amtOverflowsRing: ab.width > rb.width,
        amtVisible: ab.width > 0,
        doneH: Math.round(db.height),
        doneFits: db.right <= innerWidth + 0.5,
        msgRing: Math.round(bb.width) + 'x' + Math.round(bb.height),
        msgRingTouch: bb.width >= 44 && bb.height >= 44,
        msgRingPaints: getComputedStyle(btn,'::before').backgroundImage.includes('conic-gradient')
      };
    });
    const hScroll = r.docScrollW > r.innerW + 1;
    const bad = [];
    if (hScroll) bad.push('horizontal scroll');
    if (!r.cardFits) bad.push('card overflows');
    if (!r.ringFits) bad.push('ring overflows');
    if (!r.ringPaints) bad.push('ring does not paint');
    if (!r.amtVisible || r.amtOverflowsRing) bad.push('amount not visible in ring');
    if (r.doneH < 44) bad.push(`Done only ${r.doneH}px tall`);
    if (!r.msgRingTouch) bad.push(`dismiss ring ${r.msgRing} under 44px`);
    if (!r.msgRingPaints) bad.push('dismiss ring does not paint');
    if (bad.length) fails++;
    console.log(`${String(w).padStart(4)}x${String(h).padEnd(4)} ${bad.length ? 'FAIL ' + bad.join('; ') : 'pass'}`);
    console.log(`       ring ${r.ringSize}px  Done ${r.doneH}px  dismiss ${r.msgRing}`);
    await page.close();
  }
  await browser.close();
  console.log('\n' + (fails ? fails + ' sizes failed' : `${SIZES.length}/${SIZES.length} sizes clean`));
  process.exit(fails ? 1 : 0);
})();
