#!/usr/bin/env node
const fs = require('node:fs/promises');

const port = Number(process.env.AFK_CDP_PORT || 9222);
const workspace = process.env.AFK_TEST_WORKSPACE;
if (!workspace) throw new Error('AFK_TEST_WORKSPACE is required');

async function main() {
  const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then(response => response.json());
  const target = targets.find(item => item.type === 'page' && item.title === 'AFK Control');
  if (!target) throw new Error('AFK Control target not found');
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  const pending = new Map();
  let serial = 0;
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  socket.onmessage = event => { const message = JSON.parse(event.data); const entry = pending.get(message.id); if (!entry) return; pending.delete(message.id); message.error ? entry.reject(new Error(message.error.message)) : entry.resolve(message.result); };
  const send = (method, params = {}) => new Promise((resolve, reject) => { const id = ++serial; pending.set(id, { resolve, reject }); socket.send(JSON.stringify({ id, method, params })); });
  const evaluate = async expression => { const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }); if (result.exceptionDetails) throw new Error(result.exceptionDetails.text || 'renderer evaluation failed'); return result.result.value; };
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  const setInput = async (labelText, value, selector = 'input, textarea') => evaluate(`(() => { const label=[...document.querySelectorAll('.workflow-field')].find(node => node.firstElementChild.textContent === ${JSON.stringify(labelText)}); if (!label) throw new Error('missing field: ' + ${JSON.stringify(labelText)}); const input=label.querySelector(${JSON.stringify(selector)}); const prototype=input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(prototype, 'value').set.call(input, ${JSON.stringify(value)}); input.dispatchEvent(new Event('input',{bubbles:true})); })()`);
  const screenshot = async name => { const image = await send('Page.captureScreenshot', { format: 'png' }); await fs.mkdir('test-artifacts', { recursive: true }); await fs.writeFile(`test-artifacts/${name}.png`, Buffer.from(image.data, 'base64')); };

  for (let attempt = 0; attempt < 40; attempt += 1) {
    const ready = await evaluate('Boolean([...document.querySelectorAll("button")].find(button => button.textContent.trim() === "工作流"))');
    if (ready) break;
    await wait(200);
    if (attempt === 39) throw new Error('renderer did not become ready');
  }
  await evaluate('document.querySelector(".workflow-studio-page")?.querySelector(".workflow-back")?.click()');
  await wait(80);
  await evaluate('[...document.querySelectorAll("button")].find(button => button.textContent.trim() === "工作流").click()');
  await wait(250);
  const library = await evaluate(`(() => ({ title:document.querySelector('.workflow-library h1')?.textContent, cards:[...document.querySelectorAll('.workflow-library-card')].map(card => card.textContent.replace(/\\s+/g,' ').trim()) }))()`);
  if (library.title !== '工作流' || library.cards.length < 4 || !library.cards.some(card => card.includes('Issue 实现'))) throw new Error(`workflow library did not expose AFK templates: ${JSON.stringify(library)}`);
  await screenshot('workflow-library');

  await evaluate('[...document.querySelectorAll(".workflow-library-card")].find(card => card.textContent.includes("Issue 实现")).click()');
  await wait(220);
  const builtinEditor = await evaluate(`(() => ({ studio:document.querySelector('.workflow-studio-page')?.getAttribute('aria-label'), title:document.querySelector('.workflow-studio-title b')?.textContent, nodes:[...document.querySelectorAll('.workflow-editor-node')].map(node => node.textContent.replace(/\\s+/g,' ').trim()), edges:document.querySelectorAll('.workflow-editor-edges .workflow-edge').length, flowAnimation:getComputedStyle(document.querySelector('.workflow-edge-flow')).animationName, libraryPresent:Boolean(document.querySelector('.workflow-library')) }))()`);
  const expectedSteps = ['implement', 'verify-ac', 'publish', 'queue-qa'];
  if (builtinEditor.studio !== '工作流画布编辑器' || builtinEditor.title !== 'Issue 实现' || builtinEditor.edges !== 4 || builtinEditor.flowAnimation !== 'workflow-edge-flow' || expectedSteps.some(step => !builtinEditor.nodes.some(node => node.includes(step))) || builtinEditor.libraryPresent) throw new Error(`workflow editor did not visualize the selected AFK template: ${JSON.stringify(builtinEditor)}`);
  const pathFocus = await evaluate(`(() => ({ selected:document.querySelectorAll('.workflow-editor-node.selected').length, related:document.querySelectorAll('.workflow-editor-node.related').length, linkedEdges:document.querySelectorAll('.workflow-editor-edges .workflow-edge.linked').length }))()`);
  if (pathFocus.selected !== 1 || pathFocus.related < 2 || pathFocus.linkedEdges !== 1) throw new Error(`selected AFK step did not focus its true dependency path: ${JSON.stringify(pathFocus)}`);
  const archifyStructure = await evaluate(`(() => ({ phases:document.querySelectorAll('.workflow-canvas-phases span').length, tracks:document.querySelectorAll('.workflow-canvas-track').length, traceRuns:getComputedStyle(document.querySelector('.workflow-edge.linked .workflow-edge-flow')).animationIterationCount }))()`);
  if (archifyStructure.phases !== 4 || archifyStructure.tracks !== 2 || archifyStructure.traceRuns !== '1') throw new Error(`Archify-inspired columns, tracks, or finite trace were not rendered: ${JSON.stringify(archifyStructure)}`);
  const floatingInspector = await evaluate(`(() => { const stage=document.querySelector('.workflow-editor-stage'); const panel=document.querySelector('.workflow-studio-inspector'); return { inside: Boolean(stage && panel && stage.contains(panel)), panelWidth:Math.round(panel?.getBoundingClientRect().width || 0) }; })()`);
  if (!floatingInspector.inside || floatingInspector.panelWidth < 260) throw new Error(`inspector was not rendered inside the canvas: ${JSON.stringify(floatingInspector)}`);
  await evaluate('document.querySelector(".workflow-inspector-collapse").click()');
  await wait(90);
  const collapsedInspector = await evaluate(`(() => ({ panel:Boolean(document.querySelector('.workflow-studio-inspector')), trigger:Boolean(document.querySelector('.workflow-inspector-trigger')) }))()`);
  if (collapsedInspector.panel || !collapsedInspector.trigger) throw new Error(`inspector collapse did not leave a canvas trigger: ${JSON.stringify(collapsedInspector)}`);
  await evaluate('document.querySelector(".workflow-inspector-trigger").click()');
  await wait(90);
  if (!await evaluate('Boolean(document.querySelector(".workflow-editor-stage .workflow-studio-inspector"))')) throw new Error('inspector did not reopen inside the canvas');
  await screenshot('workflow-studio-builtin');

  await evaluate('document.querySelector(".workflow-back").click()');
  await wait(120);
  await evaluate('[...document.querySelectorAll(".workflow-library-card")].find(card => card.textContent.includes("并行规划")).click()');
  await wait(160);
  const parallelLayout = await evaluate(`(() => ({ title:document.querySelector('.workflow-studio-title b')?.textContent, planners:[...document.querySelectorAll('.workflow-editor-node')].filter(node => node.textContent.includes('plan-')).map(node => ({ title:node.querySelector('b')?.textContent, left:parseFloat(node.style.left), top:parseFloat(node.style.top) })) }))()`);
  if (parallelLayout.title !== '并行规划' || parallelLayout.planners.length !== 3 || new Set(parallelLayout.planners.map(node => node.left)).size !== 1 || new Set(parallelLayout.planners.map(node => node.top)).size !== 3) throw new Error(`parallel template was not layered and centered: ${JSON.stringify(parallelLayout)}`);
  await evaluate('document.querySelector(".workflow-back").click()');
  await wait(120);
  await evaluate('[...document.querySelectorAll(".workflow-library-card")].find(card => card.textContent.includes("顺序审查")).click()');
  await wait(160);
  const conditionalReview = await evaluate(`(() => ({ conditionalTrack:Boolean(document.querySelector('.workflow-canvas-track.track-conditional')), conditionalNode:Boolean(document.querySelector('.workflow-editor-node.track-conditional')), label:document.querySelector('.workflow-edge-label text')?.textContent, conditionalEdge:Boolean(document.querySelector('.workflow-edge.conditional')) }))()`);
  if (!conditionalReview.conditionalTrack || !conditionalReview.conditionalNode || conditionalReview.label !== 'review = failed' || !conditionalReview.conditionalEdge) throw new Error(`real workflow when clause was not rendered as a conditional branch: ${JSON.stringify(conditionalReview)}`);
  await screenshot('workflow-studio-sequential');
  await evaluate('document.querySelector(".workflow-back").click()');
  await wait(120);
  await evaluate('[...document.querySelectorAll(".workflow-library-card")].find(card => card.textContent.includes("Issue 实现")).click()');
  await wait(120);

  await evaluate('[...document.querySelectorAll(".workflow-studio-toolbar button")].find(button => button.textContent.includes("Agent")).click()');
  await wait(80);
  await setInput('节点名称', '发布实现');
  await setInput('节点说明', '实现发布前的改动，并产出可追溯的验证摘要。', 'textarea');
  await setInput('执行指令', 'Implement the release change, run focused tests, and return an evidence-backed completion summary.', 'textarea');
  await evaluate('[...document.querySelectorAll(".workflow-studio-toolbar button")].find(button => button.textContent.includes("QA")).click()');
  await wait(80);
  const customEditor = await evaluate(`(() => ({ title:document.querySelector('.workflow-studio-title b')?.textContent, custom:[...document.querySelectorAll('.custom-node')].map(node => node.textContent.replace(/\\s+/g,' ').trim()), inspector:document.querySelector('.workflow-studio-inspector')?.textContent.replace(/\\s+/g,' ').trim() }))()`);
  if (customEditor.title !== '自定义工作流' || customEditor.custom.length !== 2 || !customEditor.custom.some(text => text.includes('发布实现')) || !customEditor.inspector.includes('自定义可执行节点')) throw new Error(`custom node information editor was not available: ${JSON.stringify(customEditor)}`);
  const controls = await evaluate(`(() => { const panel=document.querySelector('.workflow-studio-inspector'); const input=panel.querySelector('input'); const select=panel.querySelector('select'); const textarea=panel.querySelector('textarea'); const save=panel.querySelector('.workflow-save'); return { inputHeight:Math.round(input.getBoundingClientRect().height), selectHeight:Math.round(select.getBoundingClientRect().height), textareaHeight:Math.round(textarea.getBoundingClientRect().height), buttonHeight:Math.round(save.getBoundingClientRect().height), sharedBorder:getComputedStyle(input).borderRadius === getComputedStyle(select).borderRadius }; })()`);
  if (controls.inputHeight !== controls.selectHeight || controls.inputHeight !== controls.buttonHeight || controls.textareaHeight < 78 || !controls.sharedBorder) throw new Error(`workflow controls are not visually unified: ${JSON.stringify(controls)}`);
  await evaluate('document.querySelector("[aria-label=\\"自动整理画布\\"]").click()');
  await wait(120);
  const autoLayout = await evaluate(`(() => [...document.querySelectorAll('.custom-node')].map(node => ({ text:node.textContent.replace(/\\s+/g,' ').trim(), left:parseFloat(node.style.left), top:parseFloat(node.style.top) })) )()`);
  if (autoLayout.length !== 2 || autoLayout[0].left !== 220 || autoLayout[1].left !== 410 || autoLayout.some(node => node.top !== 273)) throw new Error(`custom nodes did not settle into automatic layout: ${JSON.stringify(autoLayout)}`);
  const dragResult = await evaluate(`(() => { const node=document.querySelector('.custom-node'); const stage=document.querySelector('.workflow-editor-stage'); const start=node.getBoundingClientRect(); const finishX=start.left+74, finishY=start.top+78; node.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,pointerId:9,clientX:start.left+38,clientY:start.top+34,button:0,buttons:1})); stage.dispatchEvent(new PointerEvent('pointermove',{bubbles:true,pointerId:9,clientX:finishX,clientY:finishY,buttons:1})); stage.dispatchEvent(new PointerEvent('pointerup',{bubbles:true,pointerId:9,clientX:finishX,clientY:finishY,button:0})); return true; })()`);
  await wait(120);
  const dragged = await evaluate(`(() => { const node=document.querySelector('.custom-node'); return { left:parseFloat(node.style.left), top:parseFloat(node.style.top), dragging:document.querySelector('.workflow-editor-stage').classList.contains('is-dragging') }; })()`);
  if (dragged.left <= 220 || dragged.top <= 273 || dragged.dragging) throw new Error(`custom node drag did not update and settle cleanly: ${JSON.stringify({ dragResult, dragged })}`);
  await screenshot('workflow-studio-custom');
  await evaluate('document.querySelector(".workflow-studio-inspector .workflow-save").click()');
  await wait(450);
  const config = await fs.readFile(`${workspace}/.afk/config.yml`, 'utf8');
  const template = await fs.readFile(`${workspace}/.afk/workflows/afk-control-workflow.yml`, 'utf8');
  if (!config.includes('template: afk-control-workflow') || !config.includes('发布实现') || !template.includes('id: agent-') || !template.includes('Implement the release change')) throw new Error('custom workflow node data did not persist to AFK configuration and executable template');

  await evaluate('document.querySelector(".workflow-back").click()');
  await wait(160);
  const returnedLibrary = await evaluate(`(() => ({ cards:[...document.querySelectorAll('.workflow-library-card')].map(card => card.textContent.replace(/\\s+/g,' ').trim()), studioPresent:Boolean(document.querySelector('.workflow-studio-page')) }))()`);
  if (returnedLibrary.studioPresent || !returnedLibrary.cards.some(card => card.includes('自定义工作流'))) throw new Error(`back navigation did not return to the workflow list with custom template: ${JSON.stringify(returnedLibrary)}`);

  const result = { templates: library.cards.length, builtinEditor, archifyStructure, parallelLayout, conditionalReview, autoLayout, dragged, customNodes: customEditor.custom.length, returnedCards: returnedLibrary.cards.length };
  await fs.writeFile(`${workspace}/workflow-studio-verification.json`, JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
  socket.close();
}
main().then(() => process.exit(0)).catch(error => { console.error(error.stack || error); process.exit(1); });
