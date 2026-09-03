#!/usr/bin/env node
const fs = require('node:fs/promises');

const port = Number(process.env.AFK_CDP_PORT || 9222);
const expectations = [
  { name: 'Issue 实现', phases: 4, tracks: 2, pairs: [['开始', 'implement'], ['implement', 'verify-ac'], ['verify-ac', 'publish'], ['publish', 'queue-qa']] },
  { name: '合并前 QA', phases: 1, tracks: 1, pairs: [['开始', 'verify-ac']] },
  { name: '简单循环', phases: 1, tracks: 1, pairs: [['开始', 'run']] },
  { name: '顺序审查', phases: 3, tracks: 2, condition: 'review = failed', pairs: [['开始', 'implement'], ['implement', 'review'], ['review', 'fix']] },
  { name: '并行规划', phases: 1, tracks: 1, pairs: [['开始', 'plan-frontend'], ['开始', 'plan-backend'], ['开始', 'plan-infra']], parallel: ['plan-frontend', 'plan-backend', 'plan-infra'] },
  { name: '规划与审查', phases: 3, tracks: 1, pairs: [['开始', 'plan-frontend'], ['开始', 'plan-backend'], ['plan-frontend', 'review'], ['plan-backend', 'review'], ['review', 'fix']], parallel: ['plan-frontend', 'plan-backend'] },
];

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
  const screenshot = async name => { const image = await send('Page.captureScreenshot', { format: 'png' }); await fs.mkdir('test-artifacts', { recursive: true }); await fs.writeFile(`test-artifacts/${name}.png`, Buffer.from(image.data, 'base64')); };
  const openTemplate = async name => {
    await evaluate('document.querySelector(".workflow-studio-page")?.querySelector(".workflow-back")?.click()');
    await wait(100);
    await evaluate('document.querySelectorAll(".workflow-library-card").length ? undefined : [...document.querySelectorAll("button")].find(button => button.textContent.trim() === "工作流")?.click()');
    await wait(120);
    await evaluate(`(() => { const card=[...document.querySelectorAll('.workflow-library-card')].find(card => card.textContent.includes(${JSON.stringify(name)})); if (!card) throw new Error('missing workflow template: ' + ${JSON.stringify(name)}); card.click(); })()`);
    await wait(220);
  };
  const inspect = () => evaluate(`(() => {
    const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
    const rectData = element => { const rect=element.getBoundingClientRect(); return { left:rect.left, right:rect.right, top:rect.top, bottom:rect.bottom, centerY:rect.top + rect.height / 2, width:rect.width, height:rect.height }; };
    const nodes = [...document.querySelectorAll('.workflow-editor-node')].map(node => { const rect=rectData(node); return { title:node.querySelector('b')?.textContent, cssWidth:parseFloat(getComputedStyle(node).width), cssHeight:parseFloat(getComputedStyle(node).height), ...rect }; });
    const overlapPairs = [];
    for (let left = 0; left < nodes.length; left += 1) for (let right = left + 1; right < nodes.length; right += 1) { const a=nodes[left], b=nodes[right]; const w=Math.max(0, Math.min(a.right,b.right)-Math.max(a.left,b.left)); const h=Math.max(0, Math.min(a.bottom,b.bottom)-Math.max(a.top,b.top)); if (w*h > 1) overlapPairs.push([a.title,b.title]); }
    const paths = [...document.querySelectorAll('.workflow-edge-base')].map(path => {
      const length=path.getTotalLength(); const ctm=path.getScreenCTM(); const point=value => { const local=path.getPointAtLength(value); return new DOMPoint(local.x,local.y).matrixTransform(ctm); };
      const start=point(0), end=point(length);
      const nearest=(side, point) => nodes.map(node => ({ title:node.title, error:distance(point, { x:side === 'right' ? node.right : node.left, y:node.centerY }) })).sort((a,b)=>a.error-b.error)[0];
      const source=nearest('right',start), target=nearest('left',end);
      const intrusions=[];
      for (let sample=1; sample<length-1; sample+=1) { const p=point(sample); for (const node of nodes) { if (node.title === source.title || node.title === target.title) continue; if (p.x > node.left + 1 && p.x < node.right - 1 && p.y > node.top + 1 && p.y < node.bottom - 1) intrusions.push(node.title); } }
      return { source, target, intrusion:[...new Set(intrusions)] };
    });
    return { nodeSizes:nodes.map(node => ({ title:node.title, cssWidth:node.cssWidth, cssHeight:node.cssHeight })), paths, maxSourceError:Math.max(...paths.map(path=>path.source.error)), maxTargetError:Math.max(...paths.map(path=>path.target.error)), intrusionCount:paths.reduce((count,path)=>count+path.intrusion.length,0), overlapPairs, phases:document.querySelectorAll('.workflow-canvas-phases span').length, tracks:document.querySelectorAll('.workflow-canvas-track').length, labels:[...document.querySelectorAll('.workflow-edge-label text')].map(node=>node.textContent), traceRuns:getComputedStyle(document.querySelector('.workflow-edge.linked .workflow-edge-flow')).animationIterationCount };
  })()`);

  const reports = [];
  for (const expected of expectations) {
    await openTemplate(expected.name);
    const report = await inspect();
    const actualPairs = report.paths.map(path => [path.source.title, path.target.title]);
    const samePairs = JSON.stringify(actualPairs) === JSON.stringify(expected.pairs);
    const sameCondition = JSON.stringify(report.labels) === JSON.stringify(expected.condition ? [expected.condition] : []);
    const parallelAligned = !expected.parallel || new Set(expected.parallel.map(title => report.paths.find(path => path.target.title === title)?.target.title)).size === expected.parallel.length;
    const valid = report.paths.length === expected.pairs.length && samePairs && report.maxSourceError <= 1.1 && report.maxTargetError <= 1.1 && report.intrusionCount === 0 && report.overlapPairs.length === 0 && report.phases === expected.phases && report.tracks === expected.tracks && sameCondition && report.traceRuns === '1' && report.nodeSizes.every(node => node.cssWidth === 164 && node.cssHeight === 94) && parallelAligned;
    if (!valid) throw new Error(`workflow geometry failed for ${expected.name}: ${JSON.stringify({ expected, report, actualPairs, samePairs, sameCondition, parallelAligned })}`);
    reports.push({ template: expected.name, ...report });
    if (expected.name === 'Issue 实现' || expected.name === '顺序审查' || expected.name === '规划与审查') await screenshot(`workflow-geometry-${expected.name.replaceAll(' ', '-').replaceAll('与', '-').replaceAll('顺序', 'sequential').replaceAll('规划', 'planner').replaceAll('审查', 'review').replaceAll('Issue', 'issue').replaceAll('实现', 'implementation')}`);
  }
  await fs.writeFile('test-artifacts/workflow-edge-geometry-verification.json', JSON.stringify(reports, null, 2));
  console.log(JSON.stringify(reports, null, 2));
  socket.close();
}
main().catch(error => { console.error(error.stack || error); process.exit(1); });
