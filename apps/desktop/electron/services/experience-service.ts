import { ExperienceStore, experienceScope, experienceStorePath, verifyExperienceRun, type ExperienceRecord } from "@afk/runtime/execution";
import { parseExperienceQuery, parseExperienceScope, parseExperienceSelection, parseExperienceVerify, type DesktopExperience, type ExperienceQuery, type ExperienceSelection, type ExperienceVerifyInput } from "../../shared/experience-contract.js";

function project(record: ExperienceRecord): DesktopExperience {
  return { id: record.id, scope: record.scope, status: record.status, trigger: record.trigger, rootCause: record.rootCause, action: record.action,
    evidence: [...record.evidence], source: { runId: record.source.runId, workItemId: record.source.workItemId }, expiresAt: record.expiresAt, occurrences: record.occurrences,
    ...(record.verifiedEvidence ? { verifiedEvidence: { runId: record.verifiedEvidence.runId, evidence: [...record.verifiedEvidence.evidence], verifiedAt: record.verifiedEvidence.verifiedAt } } : {}) };
}

export function createExperienceService(options: {
  projects: () => Promise<string[]>;
  file?: string;
  verifyRun?: typeof verifyExperienceRun;
}) {
  const file = options.file ?? experienceStorePath();
  async function projects() {
    try { return [...new Set((await options.projects()).map(parseExperienceScope))]; }
    catch { throw new Error("无法读取项目范围，请刷新工作项来源并检查 Provider 配置。"); }
  }
  async function scoped<Result>(scope: string, operation: (store: ExperienceStore) => Result | Promise<Result>): Promise<Result> {
    if (!(await projects()).includes(scope)) throw new Error("该项目不在当前工作项来源中，请重新选择项目。");
    experienceScope(`${scope}#1`);
    let store: ExperienceStore | undefined;
    try {
      store = new ExperienceStore({ file });
      return await operation(store);
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      if (message === "Experience not found") throw new Error("当前项目中找不到该经验，请刷新列表。");
      if (/independent|new evidence|fresh run|another project|intact recorded run|successful/.test(message)) throw new Error("验证未通过：需要同一项目中完整、成功的独立 QA 运行及新证据，不能使用原失败运行。");
      if (/revoked|Revoked|Expired|expired|saturated|limit reached/.test(message)) throw new Error("经验已撤销、过期或达到证据上限，无法验证。请刷新并检查记录。");
      throw new Error("经验操作失败，请检查本机经验库、审计记录和已验证修正后重试。");
    } finally { store?.close(); }
  }
  function requireRecord(store: ExperienceStore, input: ExperienceSelection) {
    const record = store.get(input.id, input.scope);
    if (!record) throw new Error("Experience not found");
    return record;
  }
  return {
    projects,
    async list(raw: ExperienceQuery): Promise<DesktopExperience[]> {
      const input = parseExperienceQuery(raw);
      return scoped(input.scope, store => (input.prompt ? store.recall({ ...input, prompt: input.prompt, limit: 20, maxChars: 32000 }) : store.list({ scope: input.scope, limit: 100 })).map(project));
    },
    async verify(raw: ExperienceVerifyInput): Promise<DesktopExperience> {
      const input = parseExperienceVerify(raw);
      return scoped(input.scope, async store => {
        const record = requireRecord(store, input);
        if (record.status === "revoked") throw new Error("Revoked experience");
        const evidence = await (options.verifyRun ?? verifyExperienceRun)({ scope: input.scope, runId: input.runId, evidence: [] });
        return project(store.verify(input.id, { runId: input.runId, action: input.action, evidence }));
      });
    },
    async revoke(raw: ExperienceSelection): Promise<DesktopExperience> {
      const input = parseExperienceSelection(raw);
      return scoped(input.scope, store => { requireRecord(store, input); return project(store.revoke(input.id)); });
    },
  };
}
