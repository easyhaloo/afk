const { writeFileSync } = require('node:fs');
const { resolve } = require('node:path');
const { pathToFileURL } = require('node:url');

async function verify() {
  const [playwright, executablePath] = process.argv.slice(2);
  const { chromium } = require(playwright);
  const browser = await chromium.launch({ executablePath, chromiumSandbox: true });
  try {
    const context = await browser.newContext({ offline: true, serviceWorkers: 'block' });
    const page = await context.newPage();
    await page.goto(pathToFileURL(resolve('parcel.html')).href);
    await page.getByRole('button', { name: 'Check parcel' }).click();
    const status = page.getByRole('status', { includeHidden: true });
    const observation = {
      browser: browser.version(),
      text: await status.textContent(),
      visible: await status.isVisible(),
      width: await status.evaluate(element => element.getBoundingClientRect().width),
    };
    await page.screenshot({ path: process.env.PARCEL_SCREENSHOT });
    writeFileSync(process.env.PARCEL_OBSERVATION, JSON.stringify(observation, null, 2));
    console.log(JSON.stringify(observation));
    if (observation.text !== 'Parcel ready' || !observation.visible || observation.width <= 0) process.exitCode = 1;
  } finally {
    await browser.close();
  }
}

verify().catch(error => { console.error(error); process.exitCode = 1; });
