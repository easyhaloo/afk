import { app, BrowserWindow, ipcMain } from "electron";
import { createRequire } from "node:module";
const electronUpdater = createRequire(import.meta.url)("electron-updater") as typeof import("electron-updater");
const { autoUpdater } = electronUpdater;
import { IPC_CHANNELS, type DesktopUpdateStatus } from "../../shared/ipc-contract.js";
import { assertTrustedSender } from "../security/sender-guard.js";
let status: DesktopUpdateStatus = { state: "idle" };
function publish(next: DesktopUpdateStatus) { status=next; for (const window of BrowserWindow.getAllWindows()) window.webContents.send(IPC_CHANNELS.updateStatus,status); }
function unsupportedMessage() { if (!app.isPackaged) return "开发模式下不执行安装包自动更新。"; if (process.platform==="linux"&&!process.env.APPIMAGE) return "Linux 自动更新仅支持 AppImage；当前安装方式请手动安装新版本。"; return undefined; }
export function registerUpdateService() {
 autoUpdater.autoDownload=false; autoUpdater.autoInstallOnAppQuit=true; autoUpdater.allowPrerelease=false;
 autoUpdater.on("checking-for-update",()=>publish({state:"checking"}));
 autoUpdater.on("update-available",info=>publish({state:"available",version:info.version}));
 autoUpdater.on("update-not-available",info=>publish({state:"not-available",version:info.version}));
 autoUpdater.on("download-progress",progress=>publish({state:"downloading",percent:Math.round(progress.percent)}));
 autoUpdater.on("update-downloaded",info=>publish({state:"downloaded",version:info.version}));
 autoUpdater.on("error",error=>publish({state:"error",message:error.message}));
 ipcMain.handle(IPC_CHANNELS.updateGetStatus,event=>{assertTrustedSender(event);return status;});
 ipcMain.handle(IPC_CHANNELS.updateCheck,async event=>{assertTrustedSender(event);const message=unsupportedMessage();if(message){const next={state:"unsupported" as const,message};publish(next);return next;}publish({state:"checking"});try{await autoUpdater.checkForUpdates();return status;}catch(error){const next={state:"error" as const,message:error instanceof Error?error.message:String(error)};publish(next);return next;}});
 ipcMain.handle(IPC_CHANNELS.updateDownload,async event=>{assertTrustedSender(event);if(status.state!=="available")throw new Error("当前没有可下载的更新");try{await autoUpdater.downloadUpdate();return status;}catch(error){const next={state:"error" as const,message:error instanceof Error?error.message:String(error)};publish(next);return next;}});
 ipcMain.handle(IPC_CHANNELS.updateInstall,event=>{assertTrustedSender(event);if(status.state!=="downloaded")throw new Error("更新尚未下载完成");autoUpdater.quitAndInstall(false,true);return true;});
 if(app.isPackaged&&!(process.platform==="linux"&&!process.env.APPIMAGE))void autoUpdater.checkForUpdates().catch(error=>publish({state:"error",message:error instanceof Error?error.message:String(error)}));else{const message=unsupportedMessage();if(message)status={state:"unsupported",message};}
}
