import path from "node:path";
import { writeJsonFileAtomic, type AtomicFileSystem } from "../lib/secure-store.js";

/**
 * The mechanics of a credential document on disk.
 *
 * Two stores keep credentials — one for SSH hosts, one for JumpServer
 * bastions — and they keep them the same way: a JSON document in a
 * directory only its owner can read, written atomically, and changed one
 * writer at a time.  The record inside it is the store's own business; how
 * the file is read, parsed, written and serialised is not, so it lives
 * here.
 */

export type CredentialDocumentStoreOptions<Document> = {
  /** Where the document lives. */
  file: string;
  fileSystem: AtomicFileSystem;
  /** Whether the platform's secure storage can encrypt at all. */
  encryptionAvailable: () => boolean;
  /** Whether a parsed document is one this store wrote. */
  isDocument: (value: unknown) => value is Document;
  /** The document a store starts from when there is none yet. */
  emptyDocument: () => Document;
  messages: {
    /** The platform has no secure storage to encrypt with. */
    unavailable: string;
    /** The document is there but cannot be read. */
    corrupted: string;
  };
};

export function createCredentialDocumentStore<Document>(options: CredentialDocumentStoreOptions<Document>): {
  read(): Promise<Document>;
  write(document: Document): Promise<void>;
  mutate<Result>(operation: () => Promise<Result>): Promise<Result>;
} {
  const { file, fileSystem, encryptionAvailable, isDocument, emptyDocument, messages } = options;
  const directory = path.dirname(file);
  let queue: Promise<void> = Promise.resolve();

  function assertAvailable(): void {
    if (!encryptionAvailable()) throw new Error(messages.unavailable);
  }

  async function read(): Promise<Document> {
    assertAvailable();
    let content: string;
    try {
      content = await fileSystem.readFile(file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyDocument();
      throw new Error(messages.corrupted);
    }
    try {
      const document: unknown = JSON.parse(content);
      if (!isDocument(document)) throw new Error(messages.corrupted);
      return document;
    } catch (error) {
      if (error instanceof Error && error.message === messages.corrupted) throw error;
      throw new Error(messages.corrupted);
    }
  }

  async function write(document: Document): Promise<void> {
    assertAvailable();
    await writeJsonFileAtomic(file, document, fileSystem);
  }

  /**
   * Run one change at a time.
   *
   * The queue belongs to this store, not to the process: two stores
   * writing two different files do not have to wait for each other.
   */
  function mutate<Result>(operation: () => Promise<Result>): Promise<Result> {
    const next = queue.then(operation, operation);
    queue = next.then(() => undefined, () => undefined);
    return next;
  }

  return { read, write, mutate };
}
