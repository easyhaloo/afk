const port = Number(process.env.AFK_CDP_PORT || 9222);
const workspace = process.env.AFK_TEST_WORKSPACE;
if (!workspace) throw new Error('AFK_TEST_WORKSPACE is required');

async function main() {
  const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then(response => response.json());
  const target = targets.find(item => item.type === 'page' && item.title === 'AFK Control');
  if (!target) throw new Error('AFK Control target not found');
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  let id = 0;
  const pending = new Map();
  socket.onmessage = event => { const message = JSON.parse(event.data); const entry = pending.get(message.id); if (!entry) return; pending.delete(message.id); message.error ? entry.reject(new Error(message.error.message)) : entry.resolve(message.result); };
  const call = (method, params) => new Promise((resolve, reject) => { const requestId = ++id; pending.set(requestId, { resolve, reject }); socket.send(JSON.stringify({ id: requestId, method, params })); });
  const expression = `window.afkDesktop.snapshot(${JSON.stringify(workspace)}).then(value => value.workflowTemplates)`;
  const result = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  console.log(JSON.stringify(result.result.value, null, 2));
  socket.close();
}
main().catch(error => { console.error(error.stack || error); process.exit(1); });
