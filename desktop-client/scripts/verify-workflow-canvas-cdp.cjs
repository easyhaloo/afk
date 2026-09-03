#!/usr/bin/env node
const fs = require('node:fs/promises');

const debuggerPort = Number(process.env.AFK_CDP_PORT || 9222);
const workspace = process.env.AFK_TEST_WORKSPACE;
if (!workspace) throw new Error('AFK_TEST_WORKSPACE is required');

async function main() {
  const targets = await fetch(`http://127.0.0.1:${debuggerPort}/json/list`).then((response) => response.json());
  const target = targets.find((item) => item.type === 'page' && item.title === 'AFK Control');
  if (!target) throw new Error('AFK Control page target was not found');
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  const pending = new Map();
  let serial = 0;
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  socket.onmessage = (event) => {
    const message = JSON.parse(event.data);
    const entry = pending.get(message.id);
    if (!entry) return;
    pending.delete(message.id);
    message.error ? entry.reject(new Error(message.error.message)) : entry.resolve(message.result);
  };
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++serial;
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async (expression) => {
    const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text || 'Runtime evaluation failed');
    return result.result.value;
  };
  const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
  const clickAt = async (x, y) => {
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
  };
  const drag = async (from, to) => {
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: from.x, y: from.y, button: 'left', buttons: 1, clickCount: 1 });
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: from.x + (to.x - from.x) / 2, y: from.y + (to.y - from.y) / 2, button: 'left', buttons: 1 });
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: to.x, y: to.y, button: 'left', buttons: 1 });
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: to.x, y: to.y, button: 'left', buttons: 0, clickCount: 1 });
  };

  for (let attempt = 0; attempt < 40; attempt += 1) {
    const ready = await evaluate('Boolean([...document.querySelectorAll("button")].find(button => button.textContent.includes("工作流")))');
    if (ready) break;
    await wait(250);
    if (attempt === 39) throw new Error('renderer did not become ready');
  }
  await evaluate('[...document.querySelectorAll("button")].find(button => button.textContent.trim() === "工作流").click()');
  await wait(350);
  const actualSizes = [];
  for (const [width, height] of [[1440, 920], [1100, 720], [1024, 768], [768, 720]]) {
    await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false, screenWidth: width, screenHeight: height });
    await send('Emulation.setVisibleSize', { width, height });
    await wait(220);
    const metrics = await evaluate(`(() => { const stage=document.querySelector('.workflow-editor-stage').getBoundingClientRect(); const inspector=document.querySelector('.workflow-editor-inspector').getBoundingClientRect(); return { innerWidth, innerHeight, stageWidth:Math.round(stage.width), stageHeight:Math.round(stage.height), inspectorTop:Math.round(inspector.top), inspectorLeft:Math.round(inspector.left) }; })()`);
    if (metrics.innerWidth > width + 10 || metrics.innerHeight > height + 50) throw new Error(`window ${width}×${height} did not resize as requested: ${JSON.stringify(metrics)}`);
    if (metrics.stageWidth < 400 || metrics.stageHeight < 450) throw new Error(`canvas is not usable at ${width}×${height}: ${JSON.stringify(metrics)}`);
    actualSizes.push({ width, height, ...metrics });
    if (width === 1440 || width === 768) { const image = await send('Page.captureScreenshot', { format: 'png' }); await fs.mkdir('test-artifacts', { recursive: true }); await fs.writeFile(`test-artifacts/workflow-canvas-${width}.png`, Buffer.from(image.data, 'base64')); }
  }
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 920, deviceScaleFactor: 1, mobile: false, screenWidth: 1440, screenHeight: 920 });
  await send('Emulation.setVisibleSize', { width: 1440, height: 920 });
  await wait(150);

  const beforeDrag = await evaluate(`(() => { const node=[...document.querySelectorAll('.workflow-editor-node')].find(button => button.textContent.includes('执行 Agent')); const edge=document.querySelector('.workflow-editor-edges path:nth-of-type(3)'); const rect=node.getBoundingClientRect(); return { center:{x:rect.x+rect.width/2,y:rect.y+rect.height/2}, left:node.style.left, top:node.style.top, edge:edge.getAttribute('d') }; })()`);
  await evaluate(`(() => { const node=[...document.querySelectorAll('.workflow-editor-node')].find(button => button.textContent.includes('执行 Agent')); const stage=document.querySelector('.workflow-editor-stage'); const original=HTMLElement.prototype.setPointerCapture; HTMLElement.prototype.setPointerCapture=() => {}; const event=(type,x,y,buttons) => new PointerEvent(type,{bubbles:true,cancelable:true,pointerId:41,pointerType:'mouse',isPrimary:true,button:0,buttons,clientX:x,clientY:y}); try { node.dispatchEvent(event('pointerdown',${beforeDrag.center.x},${beforeDrag.center.y},1)); stage.dispatchEvent(event('pointermove',${beforeDrag.center.x + 27.5},${beforeDrag.center.y + 22.5},1)); stage.dispatchEvent(event('pointermove',${beforeDrag.center.x + 55},${beforeDrag.center.y + 45},1)); stage.dispatchEvent(event('pointerup',${beforeDrag.center.x + 55},${beforeDrag.center.y + 45},0)); } finally { HTMLElement.prototype.setPointerCapture=original; } })()`);
  await wait(100);
  const afterDrag = await evaluate(`(() => { const node=[...document.querySelectorAll('.workflow-editor-node')].find(button => button.textContent.includes('执行 Agent')); const edge=document.querySelector('.workflow-editor-edges path:nth-of-type(3)'); return { left:node.style.left, top:node.style.top, edge:edge.getAttribute('d') }; })()`);
  if (afterDrag.left === beforeDrag.left || afterDrag.top === beforeDrag.top || afterDrag.edge === beforeDrag.edge) throw new Error(`node drag did not update node and connected edge: ${JSON.stringify({ beforeDrag, afterDrag })}`);

  const panRect = await evaluate(`(() => { const stage=document.querySelector('.workflow-editor-stage').getBoundingClientRect(); return { x:stage.x+24, y:stage.bottom-55 }; })()`);
  const beforePan = await evaluate('document.querySelector(".workflow-editor-world").style.transform');
  await evaluate(`(() => { const stage=document.querySelector('.workflow-editor-stage'); const original=HTMLElement.prototype.setPointerCapture; HTMLElement.prototype.setPointerCapture=() => {}; const event=(type,x,y,buttons) => new PointerEvent(type,{bubbles:true,cancelable:true,pointerId:42,pointerType:'mouse',isPrimary:true,button:0,buttons,clientX:x,clientY:y}); try { stage.dispatchEvent(event('pointerdown',${panRect.x},${panRect.y},1)); stage.dispatchEvent(event('pointermove',${panRect.x + 60},${panRect.y - 28},1)); stage.dispatchEvent(event('pointerup',${panRect.x + 60},${panRect.y - 28},0)); } finally { HTMLElement.prototype.setPointerCapture=original; } })()`);
  await wait(100);
  const afterPan = await evaluate('document.querySelector(".workflow-editor-world").style.transform');
  if (beforePan === afterPan || !afterPan.includes('translate(60px, -28px)')) throw new Error(`canvas pan did not update transform: ${beforePan} => ${afterPan}`);

  await evaluate('document.querySelector("button[aria-label=\\"放大画布\\"]").click()');
  await wait(80);
  const zoomed = await evaluate('document.querySelector(".workflow-canvas-controls span").textContent');
  if (zoomed !== '110%') throw new Error(`zoom result invalid: ${zoomed}`);
  await evaluate('document.querySelector("button[aria-label=\\"重置画布\\"]").click()');
  await wait(80);
  const reset = await evaluate('({ zoom:document.querySelector(".workflow-canvas-controls span").textContent, transform:document.querySelector(".workflow-editor-world").style.transform })');
  if (reset.zoom !== '100%' || !reset.transform.includes('scale(1)')) throw new Error(`reset result invalid: ${JSON.stringify(reset)}`);

  await evaluate('[...document.querySelectorAll(".workflow-template-add button")].find(button => button.textContent.includes("Agent")).click(); [...document.querySelectorAll(".workflow-template-add button")].find(button => button.textContent.includes("QA")).click()');
  await wait(80);
  const templateState = await evaluate('({ nodes:[...document.querySelectorAll(".workflow-editor-node")].filter(node => node.className.includes("template-")).map(node => node.textContent), inspector:document.querySelector(".workflow-editor-inspector").textContent })');
  if (templateState.nodes.length !== 2 || !templateState.nodes.some(text => text.includes('Agent 1')) || !templateState.nodes.some(text => text.includes('QA 1'))) throw new Error(`template insertion did not render expected nodes: ${JSON.stringify(templateState)}`);
  await evaluate('document.querySelector(".workflow-editor-inspector .workflow-save").click()');
  await wait(450);
  const savedConfig = await fs.readFile(`${workspace}/.afk/config.yml`, 'utf8');
  const savedTemplate = await fs.readFile(`${workspace}/.afk/workflows/afk-control-workflow.yml`, 'utf8');
  if (!savedConfig.includes('template: afk-control-workflow') || !savedTemplate.includes('id: agent-') || !savedTemplate.includes('role: reviewer') || savedTemplate.indexOf('id: agent-') > savedTemplate.indexOf('id: qa-')) throw new Error('template nodes were not persisted as an ordered executable AFK workflow template');

  const setField = async (labelText, value) => evaluate(`(() => { const label=[...document.querySelectorAll('.workflow-field')].find(node => node.firstElementChild.textContent === ${JSON.stringify(labelText)}); if (!label) throw new Error('missing field: ' + ${JSON.stringify(labelText)}); const input=label.querySelector('input'); const set=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set; set.call(input,${JSON.stringify(value)}); input.dispatchEvent(new Event('input',{bubbles:true})); })()`);
  const expectValidation = async (labelText, value, expected) => { await setField(labelText, value); await wait(40); await evaluate('document.querySelector(".workflow-editor-inspector .workflow-save").click()'); await wait(60); const message = await evaluate('document.querySelector(".workflow-save-error")?.textContent || ""'); if (!message.includes(expected)) throw new Error(`invalid ${labelText} feedback was unclear: ${message}`); return message; };
  await evaluate('[...document.querySelectorAll(".workflow-editor-node")].find(button => button.textContent.includes("工作流配置")).click()');
  await wait(80);
  const tmuxError = await expectValidation('tmux 会话', 'invalid session', 'tmux 会话只能包含');
  await setField('tmux 会话', 'afk-canvas-test');
  const branchError = await expectValidation('目标分支', 'bad..branch', '目标分支不是有效 Git 分支名');
  await setField('目标分支', 'main');
  await evaluate('[...document.querySelectorAll(".workflow-editor-node")].find(button => button.textContent.includes("预算与恢复")).click()');
  await wait(60);
  const budgetError = await expectValidation('最大重试', '21', '最大重试必须在 0 到 20 之间');
  await setField('最大重试', '2');
  await evaluate('[...document.querySelectorAll(".workflow-editor-node")].find(button => button.textContent.includes("执行 Agent")).click()');
  await wait(60);
  const endpointError = await expectValidation('App Server', 'ftp://localhost', 'Codex App Server 地址必须使用');
  await setField('App Server', '');
  const tokenError = await expectValidation('Token 环境变量', '1BAD', 'Token 环境变量名称必须');
  await setField('Token 环境变量', '');
  const startupError = await expectValidation('Codex 启动超时（ms）', '999', 'Codex 启动超时必须在 1,000 到 300,000 ms 之间');

  const report = { actualSizes, drag: { before: beforeDrag, after: afterDrag }, pan: { before: beforePan, after: afterPan }, reset, templates: templateState.nodes.length, validation: { tmuxError, branchError, budgetError, endpointError, tokenError, startupError } };
  await fs.writeFile(`${workspace}/workflow-canvas-verification.json`, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  socket.close();
}
main().then(() => process.exit(0)).catch((error) => { console.error(error.stack || error); process.exit(1); });
