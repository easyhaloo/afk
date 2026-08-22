/** AFK Control security: only the main process runs a fixed, non-user-configurable diagnostics whitelist. */
import { app, BrowserWindow, dialog, ipcMain } from "electron";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, promises as fs } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

type EventRecord = {
  id: string;
  timestamp: string;
  source: string;
  result: string;
  nextStep: string;
  raw: string;
};

type AgentRuntime = {
  id: "claude" | "codex" | "gemini" | "opencode";
  label: string;
  command: string;
  available: boolean;
  executable: string;
  summary: string;
  status: "available" | "missing" | "error";
};

const AGENT_RUNTIME_DEFINITIONS: Array<Pick<AgentRuntime, "id" | "label" | "command"> & { versionArgs: string[] }> = [
  { id: "claude", label: "Claude Code", command: "claude", versionArgs: ["--version"] },
  { id: "codex", label: "Codex", command: "codex", versionArgs: ["--version"] },
  { id: "gemini", label: "Gemini CLI", command: "gemini", versionArgs: ["--version"] },
  { id: "opencode", label: "OpenCode", command: "opencode", versionArgs: ["--version"] },
];

function diagnosticPath() {
  const home = homedir();
  const entries = [
    ...(process.env.PATH || "").split(path.delimiter),
    path.join(home, "Library", "pnpm"),
    path.join(home, ".local", "bin"),
    path.join(home, ".npm-global", "bin"),
    path.join(home, ".bun", "bin"),
    path.join(home, ".cargo", "bin"),
    "/opt/homebrew/bin",
    "/opt/homebrew/sbin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
    "/usr/sbin",
    "/sbin",
  ].filter((entry, index, values) => entry && values.indexOf(entry) === index);
  return entries.join(path.delimiter);
}

function diagnosticEnvironment() {
  return { ...process.env, PATH: diagnosticPath() };
}

async function exec(command: string, args: string[], cwd?: string) {
  try {
    const { stdout, stderr } = await run(command, args, { cwd, env: diagnosticEnvironment(), timeout: 8_000, maxBuffer: 2_000_000 });
    return { ok: true, stdout: String(stdout).trim(), stderr: String(stderr).trim() };
  } catch (error) {
    return { ok: false, stdout: "", stderr: error instanceof Error ? error.message : String(error) };
  }
}

async function executable(name: string) {
  const result = await exec("/usr/bin/which", [name]);
  return result.ok ? result.stdout : "";
}

function firstLine(value: string, fallback: string) {
  return value.split("\n").map((line) => line.trim()).find(Boolean)?.slice(0, 160) || fallback;
}

async function detectAgentRuntimes(): Promise<AgentRuntime[]> {
  return Promise.all(AGENT_RUNTIME_DEFINITIONS.map(async (definition) => {
    const executablePath = await executable(definition.command);
    if (!executablePath) {
      return {
        ...definition,
        available: false,
        executable: "",
        status: "missing" as const,
        summary: `未在本机 PATH 中发现 ${definition.command}`,
      };
    }

    const version = await exec(executablePath, definition.versionArgs);
    if (!version.ok) {
      return {
        ...definition,
        available: false,
        executable: executablePath,
        status: "error" as const,
        summary: `已发现命令，但版本检测失败：${firstLine(version.stderr, "未知错误")}`,
      };
    }

    return {
      ...definition,
      available: true,
      executable: executablePath,
      status: "available" as const,
      summary: firstLine(version.stdout || version.stderr, "已发现可调用命令"),
    };
  }));
}

function resolveWorkspace(input?: string) {
  const candidate = input?.trim() || process.env.AFK_WORKSPACE || path.resolve(process.cwd(), "..");
  const root = path.resolve(candidate);
  if (!existsSync(root)) throw new Error(`无法访问工作区：${root}`);
  return root;
}

async function eventFiles(root: string) {
  const runRoot = path.join(root, ".afk", "runs");
  if (!existsSync(runRoot)) return [] as string[];
  const files: string[] = [];
  const walk = async (directory: string): Promise<void> => {
    const entries = await fs.readdir(directory, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(target);
      if (entry.isFile() && entry.name === "events.jsonl") files.push(target);
      if (files.length >= 10) return;
    }
  };
  await walk(runRoot);
  return files.sort().reverse();
}

async function readEvents(root: string): Promise<EventRecord[]> {
  const output: EventRecord[] = [];
  for (const file of await eventFiles(root)) {
    const source = path.basename(path.dirname(file));
    const lines = (await fs.readFile(file, "utf8").catch(() => "")).split("\n").filter(Boolean).reverse();
    for (const raw of lines) {
      let parsed: Record<string, unknown> = {};
      try { parsed = JSON.parse(raw) as Record<string, unknown>; } catch { /* retain raw event */ }
      const text = (key: string) => typeof parsed[key] === "string" ? String(parsed[key]) : undefined;
      output.push({
        id: `${source}-${createHash("sha1").update(raw).digest("hex").slice(0, 12)}`,
        timestamp: text("timestamp") || text("at") || text("time") || "—",
        source,
        result: text("message") || text("event") || text("type") || "AFK 运行事件",
        nextStep: text("nextStep") || text("next_step") || "打开运行检查器查看详情",
        raw,
      });
      if (output.length >= 160) return output;
    }
  }
  return output;
}

async function listContainers() {
  const output: Array<{ engine: string; name: string; image: string; status: string }> = [];
  for (const engine of ["docker", "podman"]) {
    if (!(await executable(engine))) continue;
    const result = await exec(engine, ["ps", "--format", "{{.Names}}\t{{.Image}}\t{{.Status}}"]); 
    if (!result.ok) continue;
    for (const line of result.stdout.split("\n").filter(Boolean)) {
      const [name, image, status] = line.split("\t");
      output.push({ engine, name: name || "—", image: image || "—", status: status || "unknown" });
    }
  }
  return output;
}

async function listTmux() {
  if (!(await executable("tmux"))) return [] as Array<{ name: string; windows: string; attached: boolean }>;
  const result = await exec("tmux", ["list-sessions", "-F", "#{session_name}\t#{session_windows}\t#{session_attached}"]);
  if (!result.ok) return [];
  return result.stdout.split("\n").filter(Boolean).map((line) => {
    const [name, windows, attached] = line.split("\t");
    return { name, windows: windows || "0", attached: attached === "1" };
  });
}

function validSession(value: string) {
  return /^[A-Za-z0-9_.:-]{1,100}$/.test(value);
}

async function snapshot(workspace?: string) {
  const root = resolveWorkspace(workspace);
  const afkPath = await executable("afk");
  const version = afkPath ? await exec(afkPath, ["--version"], root) : { ok: false, stdout: "", stderr: "未在 PATH 中发现 afk" };
  const [events, containers, sessions, agentRuntimes] = await Promise.all([
    readEvents(root),
    listContainers(),
    listTmux(),
    detectAgentRuntimes(),
  ]);
  return {
    workspace: { root, afkDirectoryPresent: existsSync(path.join(root, ".afk")), eventCount: events.length },
    afk: { available: Boolean(afkPath), executable: afkPath || "afk", summary: version.ok ? firstLine(version.stdout || version.stderr, "AFK 已就绪") : firstLine(version.stderr, "AFK 未就绪") },
    agentRuntimes,
    events,
    containers,
    sessions,
  };
}

async function createWindow() {
  const window = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1100,
    minHeight: 720,
    title: "AFK Control",
    backgroundColor: "#f7f7fa",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  if (process.env.ELECTRON_RENDERER_URL) await window.loadURL(process.env.ELECTRON_RENDERER_URL);
  else await window.loadFile(path.join(__dirname, "../dist/index.html"));
}

app.whenReady().then(async () => {
  ipcMain.handle("afk:choose-workspace", async () => {
    const selected = await dialog.showOpenDialog({ title: "选择 AFK 工作区", properties: ["openDirectory"] });
    return selected.canceled ? null : selected.filePaths[0] || null;
  });
  ipcMain.handle("afk:snapshot", (_event, workspace: string) => snapshot(workspace));
  ipcMain.handle("afk:tmux-pane", async (_event, name: string) => {
    if (!validSession(name) || !(await listTmux()).some((item) => item.name === name)) throw new Error("tmux 会话不存在或不安全");
    const result = await exec("tmux", ["capture-pane", "-p", "-t", name, "-S", "-160"]);
    if (!result.ok) throw new Error(result.stderr);
    return result.stdout;
  });
  ipcMain.handle("afk:tmux-send", async (_event, name: string, line: string) => {
    if (!validSession(name) || !(await listTmux()).some((item) => item.name === name)) throw new Error("tmux 会话不存在或不安全");
    if (!line.trim() || line.length > 4_000 || line.includes("\0")) throw new Error("接管输入为空或超过安全长度");
    const result = await exec("tmux", ["send-keys", "-t", name, line, "Enter"]);
    if (!result.ok) throw new Error(result.stderr);
    return true;
  });
  await createWindow();
  app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) void createWindow(); });
});

app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
