import { FolderOpen } from "lucide-react";

export function Empty() {
  return <div className="empty"><FolderOpen size={24} /><h2>没有运行记录</h2><p>选择包含 `.afk/runs` 的工作区后，记录会显示在这里。</p></div>;
}
