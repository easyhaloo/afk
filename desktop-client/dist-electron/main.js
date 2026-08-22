"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
/** AFK Control security: only the main process runs a fixed, non-user-configurable diagnostics whitelist. */
const electron_1 = require("electron");
const node_child_process_1 = require("node:child_process");
const node_crypto_1 = require("node:crypto");
const node_fs_1 = require("node:fs");
const node_os_1 = require("node:os");
const node_path_1 = __importDefault(require("node:path"));
const node_util_1 = require("node:util");
const run = (0, node_util_1.promisify)(node_child_process_1.execFile);
const AGENT_RUNTIME_DEFINITIONS = [
    { id: "claude", label: "Claude Code", command: "claude", versionArgs: ["--version"] },
    { id: "codex", label: "Codex", command: "codex", versionArgs: ["--version"] },
    { id: "gemini", label: "Gemini CLI", command: "gemini", versionArgs: ["--version"] },
    { id: "opencode", label: "OpenCode", command: "opencode", versionArgs: ["--version"] },
];
function diagnosticPath() {
    const home = (0, node_os_1.homedir)();
    const entries = [
        ...(process.env.PATH || "").split(node_path_1.default.delimiter),
        node_path_1.default.join(home, "Library", "pnpm"),
        node_path_1.default.join(home, ".local", "bin"),
        node_path_1.default.join(home, ".npm-global", "bin"),
        node_path_1.default.join(home, ".bun", "bin"),
        node_path_1.default.join(home, ".cargo", "bin"),
        "/opt/homebrew/bin",
        "/opt/homebrew/sbin",
        "/usr/local/bin",
        "/usr/bin",
        "/bin",
        "/usr/sbin",
        "/sbin",
    ].filter((entry, index, values) => entry && values.indexOf(entry) === index);
    return entries.join(node_path_1.default.delimiter);
}
function diagnosticEnvironment() {
    return { ...process.env, PATH: diagnosticPath() };
}
async function exec(command, args, cwd) {
    try {
        const { stdout, stderr } = await run(command, args, { cwd, env: diagnosticEnvironment(), timeout: 8_000, maxBuffer: 2_000_000 });
        return { ok: true, stdout: String(stdout).trim(), stderr: String(stderr).trim() };
    }
    catch (error) {
        return { ok: false, stdout: "", stderr: error instanceof Error ? error.message : String(error) };
    }
}
async function executable(name) {
    const result = await exec("/usr/bin/which", [name]);
    return result.ok ? result.stdout : "";
}
function firstLine(value, fallback) {
    return value.split("\n").map((line) => line.trim()).find(Boolean)?.slice(0, 160) || fallback;
}
async function detectAgentRuntimes() {
    return Promise.all(AGENT_RUNTIME_DEFINITIONS.map(async (definition) => {
        const executablePath = await executable(definition.command);
        if (!executablePath) {
            return {
                ...definition,
                available: false,
                executable: "",
                status: "missing",
                summary: `未在本机 PATH 中发现 ${definition.command}`,
            };
        }
        const version = await exec(executablePath, definition.versionArgs);
        if (!version.ok) {
            return {
                ...definition,
                available: false,
                executable: executablePath,
                status: "error",
                summary: `已发现命令，但版本检测失败：${firstLine(version.stderr, "未知错误")}`,
            };
        }
        return {
            ...definition,
            available: true,
            executable: executablePath,
            status: "available",
            summary: firstLine(version.stdout || version.stderr, "已发现可调用命令"),
        };
    }));
}
function resolveWorkspace(input) {
    const candidate = input?.trim() || process.env.AFK_WORKSPACE || node_path_1.default.resolve(process.cwd(), "..");
    const root = node_path_1.default.resolve(candidate);
    if (!(0, node_fs_1.existsSync)(root))
        throw new Error(`无法访问工作区：${root}`);
    return root;
}
async function eventFiles(root) {
    const runRoot = node_path_1.default.join(root, ".afk", "runs");
    if (!(0, node_fs_1.existsSync)(runRoot))
        return [];
    const files = [];
    const walk = async (directory) => {
        const entries = await node_fs_1.promises.readdir(directory, { withFileTypes: true }).catch(() => []);
        for (const entry of entries) {
            const target = node_path_1.default.join(directory, entry.name);
            if (entry.isDirectory())
                await walk(target);
            if (entry.isFile() && entry.name === "events.jsonl")
                files.push(target);
            if (files.length >= 10)
                return;
        }
    };
    await walk(runRoot);
    return files.sort().reverse();
}
async function readEvents(root) {
    const output = [];
    for (const file of await eventFiles(root)) {
        const source = node_path_1.default.basename(node_path_1.default.dirname(file));
        const lines = (await node_fs_1.promises.readFile(file, "utf8").catch(() => "")).split("\n").filter(Boolean).reverse();
        for (const raw of lines) {
            let parsed = {};
            try {
                parsed = JSON.parse(raw);
            }
            catch { /* retain raw event */ }
            const text = (key) => typeof parsed[key] === "string" ? String(parsed[key]) : undefined;
            output.push({
                id: `${source}-${(0, node_crypto_1.createHash)("sha1").update(raw).digest("hex").slice(0, 12)}`,
                timestamp: text("timestamp") || text("at") || text("time") || "—",
                source,
                result: text("message") || text("event") || text("type") || "AFK 运行事件",
                nextStep: text("nextStep") || text("next_step") || "打开运行检查器查看详情",
                raw,
            });
            if (output.length >= 160)
                return output;
        }
    }
    return output;
}
async function listContainers() {
    const output = [];
    for (const engine of ["docker", "podman"]) {
        if (!(await executable(engine)))
            continue;
        const result = await exec(engine, ["ps", "--format", "{{.Names}}\t{{.Image}}\t{{.Status}}"]);
        if (!result.ok)
            continue;
        for (const line of result.stdout.split("\n").filter(Boolean)) {
            const [name, image, status] = line.split("\t");
            output.push({ engine, name: name || "—", image: image || "—", status: status || "unknown" });
        }
    }
    return output;
}
async function listTmux() {
    if (!(await executable("tmux")))
        return [];
    const result = await exec("tmux", ["list-sessions", "-F", "#{session_name}\t#{session_windows}\t#{session_attached}"]);
    if (!result.ok)
        return [];
    return result.stdout.split("\n").filter(Boolean).map((line) => {
        const [name, windows, attached] = line.split("\t");
        return { name, windows: windows || "0", attached: attached === "1" };
    });
}
function validSession(value) {
    return /^[A-Za-z0-9_.:-]{1,100}$/.test(value);
}
async function snapshot(workspace) {
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
        workspace: { root, afkDirectoryPresent: (0, node_fs_1.existsSync)(node_path_1.default.join(root, ".afk")), eventCount: events.length },
        afk: { available: Boolean(afkPath), executable: afkPath || "afk", summary: version.ok ? firstLine(version.stdout || version.stderr, "AFK 已就绪") : firstLine(version.stderr, "AFK 未就绪") },
        agentRuntimes,
        events,
        containers,
        sessions,
    };
}
async function createWindow() {
    const window = new electron_1.BrowserWindow({
        width: 1440,
        height: 920,
        minWidth: 1100,
        minHeight: 720,
        title: "AFK Control",
        backgroundColor: "#f7f7fa",
        webPreferences: {
            preload: node_path_1.default.join(__dirname, "preload.js"),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true,
        },
    });
    if (process.env.ELECTRON_RENDERER_URL)
        await window.loadURL(process.env.ELECTRON_RENDERER_URL);
    else
        await window.loadFile(node_path_1.default.join(__dirname, "../dist/index.html"));
}
electron_1.app.whenReady().then(async () => {
    electron_1.ipcMain.handle("afk:choose-workspace", async () => {
        const selected = await electron_1.dialog.showOpenDialog({ title: "选择 AFK 工作区", properties: ["openDirectory"] });
        return selected.canceled ? null : selected.filePaths[0] || null;
    });
    electron_1.ipcMain.handle("afk:snapshot", (_event, workspace) => snapshot(workspace));
    electron_1.ipcMain.handle("afk:tmux-pane", async (_event, name) => {
        if (!validSession(name) || !(await listTmux()).some((item) => item.name === name))
            throw new Error("tmux 会话不存在或不安全");
        const result = await exec("tmux", ["capture-pane", "-p", "-t", name, "-S", "-160"]);
        if (!result.ok)
            throw new Error(result.stderr);
        return result.stdout;
    });
    electron_1.ipcMain.handle("afk:tmux-send", async (_event, name, line) => {
        if (!validSession(name) || !(await listTmux()).some((item) => item.name === name))
            throw new Error("tmux 会话不存在或不安全");
        if (!line.trim() || line.length > 4_000 || line.includes("\0"))
            throw new Error("接管输入为空或超过安全长度");
        const result = await exec("tmux", ["send-keys", "-t", name, line, "Enter"]);
        if (!result.ok)
            throw new Error(result.stderr);
        return true;
    });
    await createWindow();
    electron_1.app.on("activate", () => { if (electron_1.BrowserWindow.getAllWindows().length === 0)
        void createWindow(); });
});
electron_1.app.on("window-all-closed", () => { if (process.platform !== "darwin")
    electron_1.app.quit(); });
