import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { load as loadYaml } from 'js-yaml';
import type { BacklogState } from '../../domain/backlog/index.js';

/**
 * The AFK lifecycle states a mapping may name, in the order the error
 * messages list them.
 */
const AFK_STATES = ['ready', 'rework', 'in_progress', 'verification', 'merge_ready', 'done', 'blocked'] as const;

/** One configured mapping: a project+type's AFK states → native status names. */
export interface GeelibStateMappingEntry {
  /** The numeric Geelib project (`sub_id`). */
  project: string | number;
  /**
   * The work-item type the entry drives — the type name (需求) or the
   * numeric type id. The name is the stable identifier; the id is the form
   * the platform's matter payload always carries.
   */
  type: string | number;
  /** AFK state → the native status name that type/project uses. */
  states: Readonly<{ [afkState: string]: string }>;
}

/** The type identity of a work item, as the resolver keys a lookup. */
export interface GeelibMatterType {
  subId: number;
  typeId: number;
  /** The type name when the platform's payload carries one. */
  typeName: string | undefined;
}

/** A validated lookup table for one project+type. */
type StateTable = Readonly<{ [afkState: string]: string }>;

/** Where the state mappings live, next to AFK's other system data. */
export const DEFAULT_GELIB_STATE_MAPPINGS_PATH = join(homedir(), '.afk', 'geelib-state-mappings.yml');

/** An untyped JSON/YAML object, narrowed from `unknown`. */
type UnknownObject = { [key: string]: unknown };

function isObject(value: unknown): value is UnknownObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The geelib state-mapping resolver: the user-configured layer of the
 * platform's per-type, per-project state machines.
 *
 * Resolution order (owned by the provider): the verified static map first,
 * this configuration second, the generic stage fallback last. The resolver
 * itself only knows layer b — it is pure logic over injected data and never
 * touches the filesystem; the file loading lives in
 * `loadGeelibStateMappings`, called through the provider's options.
 */
export class GeelibStateMappingResolver {
  private readonly tables = new Map<string, StateTable>();

  constructor(entries: readonly GeelibStateMappingEntry[] = []) {
    entries.forEach((entry, index) => this.install(entry, index + 1));
  }

  /** True when nothing is configured — the provider then skips type lookups. */
  get isEmpty(): boolean {
    return this.tables.size === 0;
  }

  /**
   * The configured native name for an AFK state on this project+type, or
   * undefined when the entry is missing (the provider falls back to the
   * static map).
   */
  nativeStateFor(type: GeelibMatterType, state: BacklogState): string | undefined {
    return this.lookup(type)?.[state];
  }

  /**
   * The configured AFK state for a native status name, or undefined when
   * the name is not configured (the provider falls back to the static map
   * and then the generic stage).
   */
  afkStateFor(type: GeelibMatterType, nativeName: string): BacklogState | undefined {
    const table = this.lookup(type);
    if (!table) return undefined;
    const state = Object.keys(table).find(afkState => table[afkState] === nativeName);
    return state as BacklogState | undefined;
  }

  /** The lookup keys a type identity may take: the name first, the id second. */
  private keys(type: GeelibMatterType): string[] {
    const keys: string[] = [];
    if (type.typeName?.trim()) keys.push(`${type.subId}:${type.typeName.trim()}`);
    if (type.typeId) keys.push(`${type.subId}:${String(type.typeId)}`);
    return keys;
  }

  private lookup(type: GeelibMatterType): StateTable | undefined {
    for (const key of this.keys(type)) {
      const table = this.tables.get(key);
      if (table) return table;
    }
    return undefined;
  }

  /** Validate one entry and index it under its name and id keys. */
  private install(entry: GeelibStateMappingEntry, position: number): void {
    const where = `entry #${position}`;
    if (!isObject(entry)) throw new Error(`geelib state mappings ${where} must be an object with project, type and states`);
    const project = entry.project === undefined || entry.project === null || String(entry.project).trim() === ''
      ? undefined
      : String(entry.project).trim();
    if (project === undefined) throw new Error(`geelib state mappings ${where}: project is required (the numeric sub_id)`);
    const type = entry.type === undefined || entry.type === null || String(entry.type).trim() === ''
      ? undefined
      : String(entry.type).trim();
    if (type === undefined) throw new Error(`geelib state mappings ${where}: type is required (the type name, e.g. 需求, or the numeric type id)`);
    if (!isObject(entry.states) || Object.keys(entry.states).length === 0) {
      throw new Error(`geelib state mappings ${where} (project ${project}, type ${type}): states must be a non-empty object of AFK state → native name`);
    }
    const table: { [afkState: string]: string } = {};
    for (const [state, native] of Object.entries(entry.states)) {
      if (!(AFK_STATES as readonly string[]).includes(state)) {
        throw new Error(`geelib state mappings ${where} (project ${project}, type ${type}): '${state}' is not an AFK state (one of ${AFK_STATES.join(', ')})`);
      }
      if (typeof native !== 'string' || native.trim() === '') {
        throw new Error(`geelib state mappings ${where} (project ${project}, type ${type}): the native name for '${state}' must be a non-empty string`);
      }
      table[state] = native.trim();
    }
    for (const key of this.keys({ subId: Number(project), typeId: Number(type), typeName: type })) {
      if (this.tables.has(key)) {
        throw new Error(`geelib state mappings ${where}: duplicate mapping for project ${project}, type ${type}`);
      }
    }
    this.tables.set(`${project}:${type}`, table);
  }
}

/**
 * Read `~/.afk/geelib-state-mappings.yml` (or the given path) into a
 * resolver.
 *
 * A missing file is no configuration — the static mapping alone drives the
 * platform, which is the pre-configuration behavior. A file that exists but
 * cannot be parsed, or carries invalid entries, throws a readable error:
 * a mistyped mapping must fail loudly instead of silently sending AFK's
 * writes to the wrong native state.
 */
export function loadGeelibStateMappings(path: string = DEFAULT_GELIB_STATE_MAPPINGS_PATH): GeelibStateMappingResolver {
  if (!existsSync(path)) return new GeelibStateMappingResolver([]);
  let document: unknown;
  try {
    document = loadYaml(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new Error(`geelib state mappings ${path} is not valid YAML: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!isObject(document) || !Array.isArray(document.mappings)) {
    throw new Error(`geelib state mappings ${path} must contain a \`mappings\` list`);
  }
  return new GeelibStateMappingResolver(document.mappings as GeelibStateMappingEntry[]);
}
