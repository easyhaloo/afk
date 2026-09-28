import { chromium } from '@playwright/test';
const browser = await chromium.connectOverCDP('http://127.0.0.1:9223');
const page = browser.contexts()[0].pages()[0];
await page.waitForTimeout(2000);

// 1. 确认当前工作区
const ws = await page.evaluate(async () => {
  const s = await window.afkDesktop.snapshot('');
  return { root: s.workspace.root, sessions: s.sessions.map(x => x.name), events: s.events.length, containers: s.containers.length };
});
console.log('SNAPSHOT::', JSON.stringify(ws));

// 2. 执行环境页 UI 验证
await page.getByRole('button', { name: '执行环境' }).first().click({ timeout: 10000 });
await page.waitForTimeout(800);
const envText = await page.locator('section.environment-grid').innerText().catch(() => 'none');
console.log('ENV_PAGE::', envText.replace(/\n+/g, ' § ').slice(0, 320));

// 3. 打开终端按钮
const openBtn = page.locator('article', { hasText: 'AFK tmux 会话' }).locator('button:has-text("打开终端")');
console.log('OPEN_BTN::', await openBtn.count());
if (await openBtn.count()) {
  await openBtn.first().click();
  await page.waitForTimeout(2500);
  const body = await page.locator('body').innerText();
  console.log('TERMINAL_OPEN::', body.includes('bypass permissions') || body.includes('Claude') || body.includes('claude'));
}
await page.screenshot({ path: '.e2e-env-144-final.png' });
await browser.close();
