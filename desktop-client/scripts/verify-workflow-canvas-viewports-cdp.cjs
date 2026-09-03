const port = Number(process.env.AFK_CDP_PORT || 9222);

async function main() {
  const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then(response => response.json());
  const target = targets.find(item => item.type === 'page' && item.title === 'AFK Control');
  if (!target) throw new Error('AFK Control target not found');
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  let serial = 0;
  const pending = new Map();
  socket.onmessage = event => { const message = JSON.parse(event.data); const entry = pending.get(message.id); if (!entry) return; pending.delete(message.id); message.error ? entry.reject(new Error(message.error.message)) : entry.resolve(message.result); };
  const send = (method, params = {}) => new Promise((resolve, reject) => { const id = ++serial; pending.set(id, { resolve, reject }); socket.send(JSON.stringify({ id, method, params })); });
  const evaluate = async expression => { const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }); if (result.exceptionDetails) throw new Error(result.exceptionDetails.text || 'renderer evaluation failed'); return result.result.value; };
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

  await evaluate('document.querySelector(".workflow-studio-page")?.querySelector(".workflow-back")?.click()');
  await wait(80);
  await evaluate('document.querySelectorAll(".workflow-library-card").length ? undefined : [...document.querySelectorAll("button")].find(button => button.textContent.trim() === "工作流")?.click()');
  await wait(100);
  await evaluate('[...document.querySelectorAll(".workflow-library-card")].find(card => card.textContent.includes("并行规划"))?.click()');
  await wait(140);

  const reports = [];
  for (const [width, height] of [[1440, 920], [1100, 720], [1024, 768], [768, 720]]) {
    await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false, screenWidth: width, screenHeight: height });
    await wait(100);
    const report = await evaluate(`(() => { const stage=document.querySelector('.workflow-editor-stage').getBoundingClientRect(); const inspector=document.querySelector('.workflow-studio-inspector').getBoundingClientRect(); const nodes=[...document.querySelectorAll('.workflow-editor-node')].map(node=>node.getBoundingClientRect()); return { width:innerWidth,height:innerHeight,stage:{width:Math.round(stage.width),height:Math.round(stage.height)}, inspector:{left:Math.round(inspector.left),top:Math.round(inspector.top)}, nodeCount:nodes.length, allNodeSizes:nodes.every(node=>node.width>=160&&node.height>=94), documentOverflow:document.documentElement.scrollWidth>document.documentElement.clientWidth+1, planners:[...document.querySelectorAll('.workflow-editor-node')].filter(node=>node.textContent.includes('plan-')).map(node=>({left:parseFloat(node.style.left),top:parseFloat(node.style.top)})) }; })()`);
    if (report.nodeCount !== 4 || !report.allNodeSizes || report.documentOverflow || new Set(report.planners.map(node => node.left)).size !== 1) throw new Error(`viewport layout failed at ${width}x${height}: ${JSON.stringify(report)}`);
    reports.push(report);
  }
  await send('Emulation.clearDeviceMetricsOverride');
  console.log(JSON.stringify(reports, null, 2));
  socket.close();
}
main().catch(error => { console.error(error.stack || error); process.exit(1); });
