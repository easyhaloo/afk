#!/usr/bin/env node
// OpenCode 2.x plugin (V2 API).
//
// V1 (adapters/opencode.mjs) is a named export returning a hooks object.
// V2 requires a default export `{ id, setup }` with hooks registered inside
// setup(ctx) through domain-grouped helpers. Hook mapping (V1 -> V2):
//   chat.message                       -> ctx.session.hook("prompt")
//   experimental.chat.system.transform -> ctx.session.hook("context")
//   tool.execute.before                -> ctx.tool.hook("execute.before")
//   tool.execute.after                 -> ctx.tool.hook("execute.after")
//
// This module deliberately does NOT import adapters/opencode.mjs. V1 has a
// top-level `fs.realpathSync(process.argv[1])` CLI guard; under V2 opencode is
// a bun-compiled single-file binary, so process.argv[1] is /$bunfs/root/opencode
// and realpathSync throws ENOENT at import time. We import runtime-adapter.mjs
// and context-filter.mjs directly instead (neither has argv side effects).
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const denyError = reason => {
  const error = new Error(reason || 'jev-agent-guard blocked this action.');
  error.jevDeny = true;
  return error;
};

export function resolveScriptsRoot(env = process.env) {
  if (env.JEV_SCRIPTS_ROOT) return path.resolve(env.JEV_SCRIPTS_ROOT);
  // This file lives at <scripts>/adapters/opencode-v2.mjs; the scripts root is one level up.
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
}

export function jevAgentGuardV2({ scriptsRoot = resolveScriptsRoot(), env = process.env } = {}) {
  const runtimeUrl = pathToFileURL(path.join(scriptsRoot, 'adapters', 'runtime-adapter.mjs')).href;
  const filterUrl = pathToFileURL(path.join(scriptsRoot, 'context-filter.mjs')).href;

  return {
    id: 'jev-agent-guard',

    async setup(ctx) {
      const directory = ctx?.location?.directory ?? process.cwd();

      let runAdapter;
      let compactToolOutput;
      try {
        ({ runAdapter } = await import(runtimeUrl));
        ({ compactToolOutput } = await import(filterUrl));
      } catch (error) {
        console.error('[jev-agent-guard] could not load adapter; plugin skipped:', error?.message ?? error);
        return;
      }
      if (typeof runAdapter !== 'function') {
        console.error('[jev-agent-guard] runtime-adapter did not export runAdapter; plugin skipped');
        return;
      }

      // prompt -> nextStep recommendation, stashed per session and injected on
      // the next context transform.
      const recommendations = new Map();
      const sidOf = event => event?.sessionID ?? event?.session?.id ?? '';

      // V1: chat.message
      await ctx.session.hook('prompt', async event => {
        try {
          const session = sidOf(event);
          const prompt = (event?.prompt?.text ?? '').slice(0, 2000);
          const decision = await runAdapter({ host: 'opencode', event: 'prompt', payload: {
            prompt, session_id: session, cwd: directory,
          }, env });
          if (decision?.nextStep) recommendations.set(session, decision.nextStep);
        } catch (error) {
          console.error('[jev-agent-guard] prompt hook failed:', error?.message ?? error);
        }
      });

      // V1: experimental.chat.system.transform
      await ctx.session.hook('context', async event => {
        try {
          const session = sidOf(event);
          const recommendation = recommendations.get(session);
          if (!recommendation) return;
          event.system.push({ type: 'text', text: recommendation });
          recommendations.delete(session);
        } catch (error) {
          console.error('[jev-agent-guard] context hook failed:', error?.message ?? error);
        }
      });

      // V1: tool.execute.before. Only a deterministic deny is re-thrown so a
      // hook failure never breaks a legitimate tool call.
      await ctx.tool.hook('execute.before', async event => {
        try {
          const decision = await runAdapter({ host: 'opencode', event: 'before-action', payload: {
            tool_name: event.tool, session_id: sidOf(event), tool_input: event.input, cwd: directory,
          }, env });
          if (decision?.decision === 'deny') throw denyError(decision.reason);
        } catch (error) {
          if (error?.jevDeny) throw error;
          console.error('[jev-agent-guard] before-action hook failed:', error?.message ?? error);
        }
      });

      // V1: tool.execute.after, plus tool-output compaction.
      await ctx.tool.hook('execute.after', async event => {
        try {
          const success = event.status !== 'error';
          await runAdapter({ host: 'opencode', event: 'after-action', payload: {
            tool_name: event.tool, session_id: sidOf(event), tool_input: event.input, cwd: directory,
            outcome: { success },
          }, env });
          if (success && event.result && typeof compactToolOutput === 'function') {
            const raw = event.result.content;
            const output = typeof raw === 'string' ? raw : JSON.stringify(raw ?? '');
            event.result = { ...event.result, content: compactToolOutput({
              command: event.input?.command ?? '', output, success,
              fullRequested: env.JEV_FULL_OUTPUT === '1',
            }) };
          }
        } catch (error) {
          console.error('[jev-agent-guard] after-action hook failed:', error?.message ?? error);
        }
      });

      if (env.JEV_DEBUG === '1') {
        console.error('[jev-agent-guard] V2 plugin ready, directory =', directory);
      }
    },
  };
}

export default jevAgentGuardV2();
