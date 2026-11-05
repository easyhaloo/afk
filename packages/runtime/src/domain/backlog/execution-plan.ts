export interface ExecutionPlan {
  readonly baseRef: string;
  readonly targetRef: string;
  readonly sourceRef?: string;
}

export function executionRef(value: unknown, label = 'execution ref'): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(value)
    || value.includes('..') || value.includes('//')
    || value.split('/').some(segment => !segment || segment.startsWith('.') || segment.endsWith('.') || segment.endsWith('.lock'))) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

export function createExecutionPlan(input: { baseRef: string; targetRef?: string; sourceRef?: string }): ExecutionPlan {
  return Object.freeze({
    baseRef: executionRef(input.baseRef, 'Base Ref'),
    targetRef: executionRef(input.targetRef ?? input.baseRef, 'Target Ref'),
    ...(input.sourceRef === undefined ? {} : { sourceRef: executionRef(input.sourceRef, 'Source Ref') }),
  });
}

export function parseExecutionPlan(description?: string): ExecutionPlan | undefined {
  let inSection = false;
  const refs: Record<string, string> = {};
  for (const line of (description ?? '').split(/\r?\n/)) {
    const heading = /^#{1,6}\s+(.+?)\s*$/.exec(line);
    if (heading) {
      inSection = heading[1].toLowerCase() === 'base version';
      continue;
    }
    if (!inSection) continue;
    const match = /^[-*]\s*(Base|Target|Source)\s+Ref\s*:\s*(.*?)\s*$/i.exec(line.trim());
    if (!match) continue;
    const key = match[1].toLowerCase();
    const value = executionRef(match[2], `${match[1]} Ref`);
    if (refs[key] !== undefined && refs[key] !== value) throw new Error(`conflicting ${match[1]} Ref declarations`);
    refs[key] = value;
  }
  if (!Object.keys(refs).length) return undefined;
  if (!refs.base) throw new Error('Base Ref is required when declaring execution refs');
  return createExecutionPlan({ baseRef: refs.base, targetRef: refs.target, sourceRef: refs.source });
}
