import { dialog } from "electron";
import { IPC_CHANNELS } from "../../../shared/ipc-contract.js";
import {
  sshCredentialSetInput,
  sshFingerprintInput,
  sshListOptions,
  validateJumpserverBastionId,
  validateJumpserverBastionInput,
  validateJumpserverSyncOptions,
  validateSshExternalTerminalId,
  validateSshHostId,
  validateSshHostInput,
  validateSshResize,
  validateSshSessionId,
} from "../../security/ssh-validation.js";
import { registerHandler, registerHandlerMulti } from "../handler-registry.js";
import { sshService } from "../ipc-services.js";
import type { JumpserverService } from "../ipc-services.js";

/**
 * The channels the SSH feature answers: the managed hosts, the sessions, and
 * the JumpServer bastions.
 */

export function registerSshHandlers(jumpserverService: JumpserverService) {
  registerHandler(IPC_CHANNELS.sshList, sshListOptions, (opts) => opts === undefined ? sshService.listHosts() : sshService.listHosts(opts));
  registerHandler(IPC_CHANNELS.sshAdd, validateSshHostInput, (input) => sshService.addHost(input));
  registerHandlerMulti(IPC_CHANNELS.sshUpdate, [validateSshHostId, validateSshHostInput], ([hostId, input]) => sshService.updateHost(hostId, input));
  registerHandler(IPC_CHANNELS.sshRemove, validateSshHostId, (id) => sshService.removeHost(id));
  registerHandler(IPC_CHANNELS.sshTrust, (v: unknown) => {
    if (!v || typeof v !== "object") throw new Error("SSH 信任参数无效");
    const input = v as Record<string, unknown>;
    return { hostId: validateSshHostId(input.hostId), fingerprint: sshFingerprintInput(input.fingerprint) };
  }, (validated) => sshService.trustFingerprint(validated));
  registerHandler(IPC_CHANNELS.sshGenerateKey, (v: unknown) => v, () => sshService.generateKey());
  registerHandler(IPC_CHANNELS.sshDeployKey, validateSshHostId, (id) => sshService.deployKey(id));
  registerHandler(IPC_CHANNELS.sshTest, validateSshHostId, (id) => sshService.testHost(id));
  registerHandler(IPC_CHANNELS.sshUpload, validateSshHostId, async (id) => {
    const selection = await dialog.showOpenDialog({ title: "选择要上传的文件", properties: ["openFile"] });
    if (selection.canceled || !selection.filePaths[0]) return null;
    return sshService.uploadFile(id, selection.filePaths[0]);
  });
  registerHandler(IPC_CHANNELS.sshConnect, validateSshHostId, (id) => sshService.connect(id));
  registerHandlerMulti(IPC_CHANNELS.sshOpenExternal, [validateSshHostId, (v) => v === undefined ? "iterm2" : validateSshExternalTerminalId(v)], ([hostId, terminal]) => sshService.openExternal(hostId, terminal));
  registerHandler(IPC_CHANNELS.sshCredentialHas, validateSshHostId, (id) => sshService.hasCredential(id));
  registerHandler(IPC_CHANNELS.sshCredentialSet, sshCredentialSetInput, (validated) => sshService.setCredential(validated.hostId, validated.password));
  registerHandler(IPC_CHANNELS.sshCredentialRemove, validateSshHostId, (id) => sshService.removeCredential(id));
  registerHandler(IPC_CHANNELS.sshInput, (v: unknown) => {
    if (!v || typeof v !== "object") throw new Error("SSH 输入参数无效");
    const input = v as Record<string, unknown>;
    if (typeof input.data !== "string") throw new Error("SSH 输入参数无效");
    return { sessionId: validateSshSessionId(input.sessionId), data: input.data };
  }, (validated) => sshService.input(validated.sessionId, validated.data));
  registerHandler(IPC_CHANNELS.sshResize, (v: unknown) => {
    if (!v || typeof v !== "object") throw new Error("SSH 尺寸参数无效");
    const input = v as Record<string, unknown>;
    const size = validateSshResize(input.cols, input.rows);
    return { sessionId: validateSshSessionId(input.sessionId), size };
  }, (validated) => sshService.resize(validated.sessionId, validated.size.cols, validated.size.rows));
  registerHandler(IPC_CHANNELS.sshClose, validateSshSessionId, (sessionId) => sshService.close(sessionId));

  registerHandler(IPC_CHANNELS.jumpserverAddBastion, validateJumpserverBastionInput, (input) => jumpserverService.addBastion(input));
  registerHandler(IPC_CHANNELS.jumpserverSyncAssets, (v: unknown) => {
    if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error("JumpServer 资产同步参数无效");
    const obj = v as Record<string, unknown>;
    return { bastionId: validateJumpserverBastionId(obj.bastionId), opts: validateJumpserverSyncOptions(obj) };
  }, (validated) => jumpserverService.syncAssets(validated.bastionId, validated.opts));
  registerHandler(IPC_CHANNELS.jumpserverRemoveBastion, (v: unknown) => {
    if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error("JumpServer 移除堡垒机参数无效");
    const obj = v as Record<string, unknown>;
    return validateJumpserverBastionId(obj.bastionId);
  }, (bastionId) => jumpserverService.removeBastion(bastionId));
  registerHandler(IPC_CHANNELS.jumpserverListBastions, (v: unknown) => v, () => jumpserverService.listBastions());
  registerHandler(IPC_CHANNELS.jumpserverGetSyncLog, (v: unknown) => {
    if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error("JumpServer 同步日志参数无效");
    const obj = v as Record<string, unknown>;
    return validateJumpserverBastionId(obj.bastionId);
  }, (bastionId) => jumpserverService.getSyncLog(bastionId));
}
