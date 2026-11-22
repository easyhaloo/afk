import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

export async function startLoopback(cancel) {
  const model = 'w10-synthetic';
  const server = createServer(async (request, response) => {
    try {
      assert.equal(request.url, '/v1/chat/completions');
      assert.equal(request.method, 'POST');
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks));
      assert.equal(body.model, model);
      const results = body.messages.filter(message => message.role === 'tool');
      let tool, args;
      if (cancel) { tool = 'bash'; args = { command: 'sh probe.sh' }; }
      else if (!results.length) { tool = 'read'; args = { path: 'input.json' }; }
      else if (results.length === 1) {
        const content = results[0].content;
        const values = JSON.parse(typeof content === 'string' ? content : content[0].text);
        tool = 'write'; args = { path: 'total.txt', content: String(values.reduce((sum, value) => sum + value, 0)) };
      }
      const delta = tool ? { tool_calls: [{ index: 0, id: `call_${results.length}`, type: 'function',
        function: { name: tool, arguments: JSON.stringify(args) } }] } :
        { content: '<goal_complete>{"type":"goal_complete","kind":"task","summary":"done"}</goal_complete>' };
      const send = (choices, usage) => response.write(`data: ${JSON.stringify({ id: 'w10', object: 'chat.completion.chunk', model, choices, usage })}\n\n`);
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      send([{ index: 0, delta: { role: 'assistant', ...delta }, finish_reason: null }]);
      send([{ index: 0, delta: {}, finish_reason: tool ? 'tool_calls' : 'stop' }]);
      send([], { prompt_tokens: 31, completion_tokens: 7, total_tokens: 38 });
      response.end('data: [DONE]\n\n');
    } catch {
      response.writeHead(400).end();
    }
  });
  await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
  const agent = process.env.PI_CODING_AGENT_DIR;
  writeFileSync(join(agent, 'models.json'), JSON.stringify({ providers: { w10: {
    baseUrl: `http://127.0.0.1:${server.address().port}/v1`, api: 'openai-completions', apiKey: 'fixture', models: [{ id: model }],
  } } }));
  writeFileSync(join(agent, 'settings.json'), JSON.stringify({ defaultProvider: 'w10', defaultModel: model, retry: { enabled: false } }));
  return server;
}
