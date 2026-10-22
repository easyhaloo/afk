import { Buffer } from "node:buffer";

const MAX_COPY_TEXT_BYTES = 64 * 1024;

type ClipboardWriter = {
  writeText: (text: string) => void;
};

export function createClipboardService(writer: ClipboardWriter) {
  return {
    copyText(value: unknown) {
      if (typeof value !== "string") throw new TypeError("剪贴板内容必须是纯文本");
      if (Buffer.byteLength(value, "utf8") > MAX_COPY_TEXT_BYTES) throw new RangeError("剪贴板内容超过 64 KiB");
      writer.writeText(value);
      return true;
    },
  };
}
