import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export default {
  id: 'w11-skill-negative-observer',
  async setup(ctx) {
    const cwd = ctx.location.directory;
    const scripts = join(process.env.XDG_DATA_HOME, 'jev-agent-guard/current/scripts');
    const { runAdapter } = await import(pathToFileURL(join(scripts, 'adapters/runtime-adapter.mjs')));
    const { currentSkillTask } = await import(pathToFileURL(join(scripts, 'skill-scope.mjs')));
    const record = (session, fields) => appendFileSync(process.env.W11_GUARD_RECEIPT, JSON.stringify({
      session, cwd, task: JSON.parse(process.env.AFK_SKILL_TASK_CONTEXT), trusted: currentSkillTask(cwd, process.env), ...fields,
    }) + '\n');
    await ctx.session.hook('prompt', async event => {
      const session = event.sessionID ?? event.session?.id;
      const prompt = event.prompt.text.slice(0, 2000);
      const decision = await runAdapter({ host: 'opencode', event: 'prompt', payload: { cwd, session_id: session, prompt } });
      const { data } = await ctx.skill.list({});
      record(session, { hook: 'prompt', prompt, replay: decision, catalogSize: data.length, catalogHasSkill: data.some(skill => skill.id === 'reconcile-bags') });
    });
    await ctx.session.hook('context', async event => {
      const system = event.system.map(part => part.text ?? '');
      const { data } = await ctx.skill.list({});
      record(event.sessionID ?? event.session?.id, { hook: 'context', advice: system.filter(text => text.startsWith('Suggested Skill: ')),
        catalog: data.map(skill => skill.id),
        systemMentionsSkill: system.some(text => text.includes('reconcile-bags')) });
    });
  },
};
