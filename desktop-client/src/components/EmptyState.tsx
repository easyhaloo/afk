import { FolderOpen } from "lucide-react";

export function Empty() {
  return <div className="empty"><FolderOpen size={24} /><h2>没有运行记录</h2><p>运行记录保存在运行时的任务存储中。选择工作区后，已有记录会显示在这里。</p></div>;
}
