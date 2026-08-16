import readline from 'node:readline';

const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
let threadId;
let turnId;

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

for await (const line of input) {
  if (!line.trim()) continue;
  const message = JSON.parse(line);
  if (message.method === 'initialize') {
    send({ jsonrpc: '2.0', id: message.id, result: { userAgent: 'fake-codex-app-server' } });
  } else if (message.method === 'initialized') {
    // Notification has no response.
  } else if (message.method === 'thread/start') {
    threadId = `fixture-thread-${process.pid}`;
    send({ jsonrpc: '2.0', id: message.id, result: { thread: { id: threadId } } });
  } else if (message.method === 'turn/start') {
    turnId = 'fixture-turn-1';
    send({ jsonrpc: '2.0', id: message.id, result: { turn: { id: turnId } } });
    const prompt = message.params?.input?.[0]?.text ?? '';
    if (!prompt.includes('AFK_FIXTURE_HOLD')) {
      queueMicrotask(() => {
        send({
          jsonrpc: '2.0',
          method: 'item/completed',
          params: {
            item: {
              type: 'agentMessage',
              text: '<goal_complete>{"type":"goal_complete","kind":"task","summary":"app server fixture complete"}</goal_complete>',
            },
          },
        });
        send({
          jsonrpc: '2.0',
          method: 'thread/tokenUsage/updated',
          params: { tokenUsage: { inputTokens: 21, outputTokens: 8, totalTokens: 29 } },
        });
        send({
          jsonrpc: '2.0',
          method: 'turn/completed',
          params: { turn: { id: turnId, status: 'completed' } },
        });
      });
    }
  } else if (message.method === 'turn/interrupt') {
    send({ jsonrpc: '2.0', id: message.id, result: {} });
  }
}
