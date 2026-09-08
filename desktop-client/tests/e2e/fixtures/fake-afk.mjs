#!/usr/bin/env node
/**
 * Fake `afk` CLI used by Playwright end-to-end tests to drive the BacklogPage
 * UI without requiring a real GitHub / GitLab authentication. The Electron
 * process spawns this binary via the standard `which afk` lookup, so the
 * BacklogService never sees a difference between this and the real CLI.
 *
 * Subset of the real `afk backlog` surface:
 *   - list [--state] [--mode] [--parent] [--tag] [--platform] --json
 *   - show --id <id> [--platform] --json
 *   - create <title> --description-file /dev/stdin [...] --json
 *   - tag add|remove --id <id> --tag <tag> --json
 *
 * Each command emits a JSON envelope (success or failure) on stdout,
 * matching the real CLI's `--json` protocol. A tiny shared in-memory store
 * persists writes between calls in the same Electron session.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import process from "node:process";

// Verbose tracing for E2E debugging — flip to true to dump every call.
const DEBUG = process.env.FAKE_AFK_DEBUG === "1";
function log(...parts) {
  if (DEBUG) process.stderr.write(`[fake-afk] ${parts.join(" ")}\n`);
}

const STORE_PATH = process.env.FAKE_AFK_STORE ?? "";
const args = process.argv.slice(2);
log("argv", JSON.stringify(args));
const subcommand = args[args.indexOf("backlog") + 1];

function flag(name) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

function flagAll(name) {
  const out = [];
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === name && i + 1 < args.length) out.push(args[i + 1]);
  }
  return out;
}

function ok(kind, data) {
  process.stdout.write(JSON.stringify({ ok: true, kind, data }));
}

function fail(kind, code, message) {
  process.stdout.write(JSON.stringify({ ok: false, kind, error: { code, message } }));
  process.exit(1);
}

function branchOf(ref) {
  const parts = String(ref).split(":");
  return parts[0];
}

// Persisted store: each subprocess invocation reloads from a JSON file so
// writes from one call (create / tag add / tag remove) survive into the
// next list call. Without this, every spawn would start with a fresh seed.
const SEED_STORE = {
  items: [
    { id: "1", title: "登录态切换", description: "切换登录态并保留当前工作区。", dependsOn: [], state: "ready", executionMode: "afk", tags: ["billing"], branchName: "afk/backlog-1", providerRef: "stub:1", webUrl: "https://github.com/example/issues/1" },
    { id: "2", title: "kg 演示", dependsOn: ["1"], state: "in_progress", executionMode: "afk", tags: ["urgent"], branchName: "afk/backlog-2", providerRef: "stub:2" },
    { id: "3", title: "支付回调", dependsOn: [], state: "done", executionMode: "hitl", tags: [], branchName: "afk/backlog-3", providerRef: "stub:3" },
  ],
  nextId: 4,
};

function loadStore() {
  if (!STORE_PATH) return structuredClone(SEED_STORE);
  if (!existsSync(STORE_PATH)) {
    const fresh = structuredClone(SEED_STORE);
    saveStore(fresh);
    return fresh;
  }
  try {
    const parsed = JSON.parse(readFileSync(STORE_PATH, "utf8"));
    if (!Array.isArray(parsed.items) || typeof parsed.nextId !== "number") throw new Error("malformed store");
    return parsed;
  } catch {
    const fresh = structuredClone(SEED_STORE);
    saveStore(fresh);
    return fresh;
  }
}

function saveStore(store) {
  if (!STORE_PATH) return;
  try {
    writeFileSync(STORE_PATH, JSON.stringify(store), "utf8");
  } catch {
    // best-effort
  }
}

function mutate(fn) {
  const store = loadStore();
  const result = fn(store);
  saveStore(store);
  return result;
}

function filterBy(store, options = {}) {
  let out = store.items.slice();
  if (options.state) out = out.filter((i) => i.state === options.state);
  if (options.mode) out = out.filter((i) => i.executionMode === options.mode);
  if (options.parent) out = out.filter((i) => i.parentId === options.parent);
  if (options.tag) out = out.filter((i) => i.tags.includes(options.tag));
  if (options.platform) out = out.filter((i) => branchOf(i.providerRef) === options.platform);
  return out;
}

function readStdin() {
  if (process.stdin.isTTY) return "";
  try {
    return readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

function readDescription() {
  const file = flag("--description-file");
  if (file && file !== "/dev/stdin") {
    try {
      return readFileSync(file, "utf8");
    } catch {
      return "";
    }
  }
  const stdinContents = readStdin();
  log("stdin length", stdinContents.length);
  return stdinContents;
}
const descriptionText = readDescription();

if (subcommand === "list") {
  if (process.env.FAKE_AFK_FAIL_LIST === "1") {
    fail("backlog.list", "provider", "FAKE_AFK_FAIL_LIST is set");
  }
  const data = mutate((store) => filterBy(store, {
    state: flag("--state"),
    mode: flag("--mode"),
    parent: flag("--parent"),
    tag: flag("--tag"),
    platform: flag("--platform"),
  }));
  ok("backlog.list", data);
}
else if (subcommand === "show") {
  const id = flag("--id");
  const item = mutate((store) => store.items.find((i) => i.id === id));
  if (!item) fail("backlog.show", "not_found", `no item ${id}`);
  else ok("backlog.show", item);
}
else if (subcommand === "create") {
  // Argv: backlog create <title> --description-file <path-or-/dev/stdin> ...
  const title = args[args.indexOf("create") + 1];
  if (!title) fail("backlog.create", "validation", "title required");
  const description = descriptionText;
  log("create description", JSON.stringify(description));
  if (!description.trim()) fail("backlog.create", "validation", "description required");
  const item = mutate((store) => {
    const newItem = {
      id: String(store.nextId),
      title,
      description: description.trim(),
      dependsOn: flagAll("--depends-on"),
      state: "ready",
      executionMode: flag("--mode") ?? "afk",
      tags: flagAll("--tag"),
      branchName: `afk/backlog-${store.nextId}`,
      providerRef: "stub:new",
      parentId: flag("--parent"),
      baseBacklogId: flag("--base-backlog"),
    };
    store.items.unshift(newItem);
    store.nextId += 1;
    return newItem;
  });
  ok("backlog.create", item);
}
else if (subcommand === "tag") {
  const sub2 = args[args.indexOf("tag") + 1];
  const id = flag("--id");
  const tag = flag("--tag");
  const item = mutate((store) => {
    const target = store.items.find((i) => i.id === id);
    if (!target) return null;
    if (sub2 === "add") {
      if (!target.tags.includes(tag)) target.tags.push(tag);
      return target;
    }
    if (sub2 === "remove") {
      target.tags = target.tags.filter((t) => t !== tag);
      return target;
    }
    return null;
  });
  if (!item) fail(`backlog.tag.${sub2}`, "not_found", `no item ${id}`);
  else if (!tag) fail(`backlog.tag.${sub2}`, "validation", "tag required");
  else if (sub2 === "add") ok("backlog.tag.add", item);
  else if (sub2 === "remove") ok("backlog.tag.remove", item);
  else fail(`backlog.tag.${sub2}`, "validation", `unknown tag subcommand ${sub2}`);
}
else {
  fail(`backlog.${subcommand}`, "validation", `unknown subcommand ${subcommand}`);
}
