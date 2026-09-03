const fs = require('node:fs/promises');
const port = Number(process.env.AFK_CDP_PORT || 9222);

async function main() {
  const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then(response => response.json());
  const target = targets.find(item => item.type === 'page' && item.title === 'AFK Control');
  if (!target) throw new Error('AFK Control target not found');
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  const pending = new Map(); let serial = 0;
  socket.onmessage = event => { const message = JSON.parse(event.data); const entry = pending.get(message.id); if (!entry) return; pending.delete(message.id); message.error ? entry.reject(new Error(message.error.message)) : entry.resolve(message.result); };
  const send = (method, params = {}) => new Promise((resolve, reject) => { const id = ++serial; pending.set(id, { resolve, reject }); socket.send(JSON.stringify({ id, method, params })); });
  const evaluate = async expression => { const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }); if (result.exceptionDetails) throw new Error(result.exceptionDetails.text || 'renderer evaluation failed'); return result.result.value; };
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  const screenshot = async name => { const image = await send('Page.captureScreenshot', { format: 'png' }); await fs.mkdir('test-artifacts', { recursive: true }); await fs.writeFile(`test-artifacts/${name}.png`, Buffer.from(image.data, 'base64')); };

  await evaluate('document.querySelector(".workflow-studio-page")?.querySelector(".workflow-back")?.click()');
  await wait(80);
  await evaluate('document.querySelectorAll(".workflow-library-card").length ? undefined : [...document.querySelectorAll("button")].find(button => button.textContent.trim() === "工作流")?.click()');
  await wait(100);
  await evaluate('[...document.querySelectorAll(".workflow-library-card")].find(card => card.textContent.includes("Issue 实现"))?.click()');
  await wait(160);
  const inspect = () => evaluate(`(() => { const page=document.querySelector('.workflow-studio-page'); const stage=document.querySelector('.workflow-editor-stage'); const node=document.querySelector('.workflow-editor-node'); const flow=document.querySelector('.workflow-edge-flow'); const save=document.querySelector('.workflow-save'); return { panel:getComputedStyle(page).getPropertyValue('--afk-panel').trim(), stage:getComputedStyle(stage).backgroundColor, node:getComputedStyle(node).backgroundColor, flow:getComputedStyle(flow).stroke, save:getComputedStyle(save).backgroundColor, animation:getComputedStyle(flow).animationName }; })()`);
  const originalTheme = await evaluate('document.documentElement.getAttribute("data-afk-theme")');
  const light = await inspect();
  if (light.panel !== '#ffffff' || light.animation !== 'workflow-edge-flow') throw new Error(`light palette is not applied: ${JSON.stringify(light)}`);
  await screenshot('workflow-colour-light');
  await evaluate('document.documentElement.setAttribute("data-afk-theme", "graphite")');
  await wait(80);
  const graphite = await inspect();
  if (graphite.panel !== '#242624' || graphite.animation !== 'workflow-edge-flow') throw new Error(`graphite palette is not applied: ${JSON.stringify(graphite)}`);
  await screenshot('workflow-colour-graphite');
  await evaluate(`document.documentElement.setAttribute("data-afk-theme", ${JSON.stringify(originalTheme || 'light')})`);
  console.log(JSON.stringify({ light, graphite }, null, 2));
  socket.close();
}
main().catch(error => { console.error(error.stack || error); process.exit(1); });
