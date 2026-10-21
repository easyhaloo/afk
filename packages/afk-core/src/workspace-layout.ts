/**
 * Where AFK keeps its files.
 *
 * The paths are relative to the root that owns them: a project root, a
 * worktree, or the user's home. The configuration is written by the
 * desktop and read by the runner, and each side spelled the path out. A
 * change to the path left the desktop saving a configuration the runner
 * never read - while the desktop read back its own, so the board looked
 * right and the run used different settings.
 *
 * The list lives in the core package because every layer needs it and
 * the core package is the one layer all of them may reach.
 */
export const AFK_CONFIG_FILE = '.afk/config.yml';

/**
 * Where a project's workflow templates live.
 *
 * The runtime reads the templates and the desktop writes them, and each
 * side spelled the directory out. A change to it left the desktop
 * writing templates the runner never found, and the board showing them
 * as if they were runnable.
 */
export const AFK_WORKFLOW_DIRECTORY = '.afk/workflows';

/**
 * Where the execution journal lives.
 *
 * The runtime writes the journal and the retro command reads it, and
 * each side spelled the directory out. A change to it left the retro
 * reporting on a run whose journal it could not find - a report with
 * the evidence missing and nothing saying why.
 */
export const AFK_EXECUTIONS_DIRECTORY = '.afk/executions';

/**
 * Where the runtime keeps the records of the runs it is tracking.
 *
 * The runtime writes the records and the desktop reads them - the live
 * ones and the archive of the finished ones - and each side spelled the
 * path out. A path that moved left the desktop showing no run history
 * at all, with nothing saying the records had gone missing.
 */
export const AFK_RUNTIME_TASKS_DIRECTORY = '.afk/runtime/tasks';

/** Where the runtime archives the records of the runs that have finished. */
export const AFK_RUNTIME_ARCHIVE_DIRECTORY = 'archive';

/** Where the runtime keeps the registry of the resources it handed out. */
export const AFK_RUNTIME_RESOURCES_FILE = '.afk/runtime/resources.sqlite';
