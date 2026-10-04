// The requirement is now "it always moves". So assert that in the states that
// previously left it parked:
//   - on arrival, before any interaction
//   - immediately after a scroll (scrub owns the frame, briefly)
//   - after scrolling has STOPPED (must resume on its own)
//   - after a nav jump
// Resolve playwright from this repo's own node_modules, falling back to a
// global install. Hardcoding an absolute path meant the checker could only
// ever run on the machine that wrote it.
const { chromium } = require(require.resolve('playwright', { paths: [__dirname] }));
const URL = process.env.TARGET || 'http://127.0.0.1:8899/landing.html';

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  let fails = 0;
  const ok = (cond, msg) => { console.log(`   ${cond ? 'ok  ' : 'FAIL'} ${msg}`); if (!cond) fails++; };

  // ---------- 1. moves on arrival ----------
  await page.goto(URL, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1200);
  const a1 = await page.evaluate(() => document.getElementById('clip').currentTime);
  await page.waitForTimeout(2000);
  const a2 = await page.evaluate(() => ({ t: document.getElementById('clip').currentTime,
                                           paused: document.getElementById('clip').paused }));
  console.log('1. on arrival (no interaction)');
  ok(a2.t > a1 + 0.3, `advances on its own ${a1.toFixed(2)}s -> ${a2.t.toFixed(2)}s`);
  ok(!a2.paused, 'genuinely playing, not advancing by accident');

  // ---------- 2. after a scroll, it must come BACK on its own ----------
  console.log('\n2. after scrolling stops (this is what looked broken before)');
  await page.evaluate(() => window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'instant' }));
  await page.waitForTimeout(120);
  const during = await page.evaluate(() => document.getElementById('clip').paused);
  console.log(`   (during the scrub: paused=${during})`);
  // The design holds playback until the frame lands at its target, which takes
  // ~2.4s. Wait for the real condition rather than a fixed delay.
  await page.waitForFunction(
    () => !document.getElementById('clip').paused,
    null, { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(400);
  const b1 = await page.evaluate(() => ({ t: document.getElementById('clip').currentTime,
                                          paused: document.getElementById('clip').paused }));
  await page.waitForTimeout(2000);
  const b2 = await page.evaluate(() => document.getElementById('clip').currentTime);
  ok(!b1.paused, `resumed playback by itself after the scroll stopped`);
  ok(b2 > b1.t + 0.3, `moving again: ${b1.t.toFixed(2)}s -> ${b2.toFixed(2)}s`);

  // ---------- 3. idle for a while: must still be moving ----------
  console.log('\n3. left alone for 6s');
  const c1 = await page.evaluate(() => document.getElementById('clip').currentTime);
  await page.waitForTimeout(6000);
  const c2 = await page.evaluate(() => ({ t: document.getElementById('clip').currentTime,
                                          paused: document.getElementById('clip').paused }));
  ok(c2.t > c1 + 1.0, `still moving while idle: ${c1.toFixed(2)}s -> ${c2.t.toFixed(2)}s`);
  ok(!c2.paused, 'never parked while idle');

  // ---------- 4. it loops rather than ending at the last frame ----------
  console.log('\n4. loop behaviour');
  const looped = await page.evaluate(async () => {
    const v = document.getElementById('clip');
    const d = v.duration;
    v.currentTime = d - 0.4;              // wind it to the very end
    await new Promise(r => setTimeout(r, 2500));
    return { dur: d, t: v.currentTime, ended: v.ended, paused: v.paused };
  });
  ok(!looped.ended && looped.t < looped.dur - 0.2,
     `wrapped instead of stopping at the end (t=${looped.t.toFixed(2)} of ${looped.dur.toFixed(2)})`);

  // ---------- 5. Arc mark present and actually painted ----------
  console.log('\n5. Arc network mark beside "Built on Arc"');
  const arc = await page.evaluate(() => {
    const wrap = document.querySelector('.foot-arc');
    const svg = wrap && wrap.querySelector('svg');
    if (!wrap || !svg) return { found: false, text: document.querySelector('.foot').textContent.replace(/\s+/g,' ').trim() };
    const r = svg.getBoundingClientRect();
    const path = svg.querySelector('path');
    const stops = [...svg.querySelectorAll('stop')].map(s => s.getAttribute('stop-color'));
    return { found: true, w: Math.round(r.width), h: Math.round(r.height),
             dLen: path.getAttribute('d').length, stops,
             text: wrap.textContent.trim(), fill: path.getAttribute('fill') };
  });
  ok(arc.found, 'the Arc mark exists in the footer');
  if (arc.found) {
    ok(arc.w > 0 && arc.h > 0, `it has real dimensions (${arc.w}x${arc.h})`);
    ok(arc.dLen > 200, `carries real path geometry (${arc.dLen} chars), not a placeholder`);
    ok(JSON.stringify(arc.stops) === JSON.stringify(['#1C2998','#3E2B63','#942753']),
       `uses Arc's official brand gradient ${arc.stops.join(' -> ')}`);
    ok(arc.text.includes('Built on Arc'), `reads "${arc.text}"`);
  }

  // ---------- 6. both marks coexist ----------
  const marks = await page.evaluate(() => ({
    ease: !!document.querySelector('.foot .mark-glyph'),
    arc: !!document.querySelector('.foot .arc-mark'),
    easeColor: getComputedStyle(document.querySelector('.foot .mark-glyph')).backgroundColor
  }));
  console.log('\n6. footer lockups');
  ok(marks.ease, 'Ease mark still present');
  ok(marks.arc, 'Arc mark present alongside it');

  await browser.close();
  console.log('\n' + (fails ? fails + ' problems' : 'always moving, Arc mark in place'));
  process.exit(fails ? 1 : 0);
})();
