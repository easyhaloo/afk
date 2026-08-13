import type { Command, Argument, Option } from 'commander';

export interface ArgumentSpec {
  name: string;
  required: boolean;
  variadic: boolean;
}

export interface OptionSpec {
  long: string | null;
  short: string | null;
  description: string;
  /** Placeholder name parsed from the option flags, e.g. `labels` for `--label <labels...>`. */
  argName: string | null;
}

export interface CommandSpec {
  name: string;
  description: string;
  aliases: string[];
  args: ArgumentSpec[];
  options: OptionSpec[];
  subcommands: CommandSpec[];
}

export interface CompletionSpec {
  name: string;
  commands: CommandSpec[];
}

/** Skip commander's auto-generated `help` subcommand. The introspected tree
 * never contains hidden commands (`__complete` is registered separately, not
 * via buildCompletionTree), so a name check is sufficient. */
function isUserCommand(cmd: Command): boolean {
  return cmd.name() !== 'help';
}

function extractArgument(arg: Argument): ArgumentSpec {
  return { name: arg.name(), required: arg.required, variadic: arg.variadic };
}

function extractOption(opt: Option): OptionSpec {
  const placeholder = opt.flags.match(/<[^>]+>|\[[^\]]+\]/);
  const argName = placeholder
    ? placeholder[0].replace(/[<>\[\]]/g, '').replace(/\.{3}$/, '')
    : null;
  return {
    long: opt.long ?? null,
    short: opt.short ?? null,
    description: opt.description,
    argName,
  };
}

function extractCommand(cmd: Command): CommandSpec {
  return {
    name: cmd.name(),
    description: cmd.description(),
    aliases: cmd.aliases(),
    args: cmd.registeredArguments.map(extractArgument),
    options: cmd.options.map(extractOption),
    subcommands: cmd.commands.filter(isUserCommand).map(extractCommand),
  };
}

export function extractSpec(program: Command): CompletionSpec {
  return {
    name: program.name(),
    commands: program.commands.filter(isUserCommand).map(extractCommand),
  };
}
