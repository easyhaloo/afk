import { BrowserWindow, ipcMain } from "electron";
import { assertTrustedSender } from "../security/sender-guard.js";

/**
 * The registration machinery.
 *
 * Every channel in the desktop is registered the same way: a trusted sender,
 * the input checked against a schema, and the error the caller sees. The
 * machinery is here so the channels themselves read as what they do.
 */
type HandlerSchema = (value: unknown) => unknown;

type HandlerArgs<Schemas extends readonly HandlerSchema[]> = {
  [K in keyof Schemas]: Schemas[K] extends (value: unknown) => infer Result ? Result : never;
};

export function registerHandler<Schema extends (value: unknown) => unknown>(
  channel: string,
  schema: Schema,
  fn: (input: ReturnType<Schema>) => unknown,
) {
  ipcMain.handle(channel, async (event, input: unknown) => {
    assertTrustedSender(event);
    try {
      return await fn(schema(input) as ReturnType<Schema>);
    } catch (error) {
      throw error instanceof Error ? error : new Error(String(error));
    }
  });
}

export function registerHandlerMulti<Schemas extends [HandlerSchema, ...HandlerSchema[]]>(
  channel: string,
  argSchemas: readonly [...Schemas],
  fn: (args: HandlerArgs<Schemas>) => unknown,
) {
  ipcMain.handle(channel, async (event, ...args: unknown[]) => {
    assertTrustedSender(event);
    try {
      const validated = args.map((arg, i) => argSchemas[i](arg) as unknown) as HandlerArgs<Schemas>;
      return await fn(validated);
    } catch (error) {
      throw error instanceof Error ? error : new Error(String(error));
    }
  });
}

/** Send an event to every window the desktop has open. */
export function broadcast(channel: string, ...args: unknown[]) {
  for (const window of BrowserWindow.getAllWindows()) window.webContents.send(channel, ...args);
}
