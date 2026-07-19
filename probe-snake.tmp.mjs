import { chromium } from 'playwright';
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await page.goto('http://localhost:4203', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(5000);
const out = await page.evaluate(() => {
  const v = window.__orbitalVerification;
  const keys = v ? Object.keys(v) : [];
  let drawables = null, entity = null;
  try { if (v?.getLastDrawables) drawables = JSON.stringify(v.getLastDrawables())?.slice(0, 1500); } catch (e) { drawables = 'ERR ' + e.message; }
  try { if (v?.getEntityState) entity = JSON.stringify(v.getEntityState())?.slice(0, 1500); } catch (e) { entity = 'ERR ' + e.message; }
  return { keys, drawables, entity };
});
console.log(JSON.stringify(out, null, 1));
await browser.close();
