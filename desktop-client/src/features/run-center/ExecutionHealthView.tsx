import type { RuntimeHealth } from "../../../shared/execution-contract";
import { Activity, ChevronDown } from "lucide-react";

const labels = { live: "存活", stale: "心跳过期", exited: "已退出", unknown: "未知" };

export function ExecutionHealthView({ health }: { health?: RuntimeHealth }) {
  return <section className={`execution-health ${health?.state ?? "unknown"}`} aria-label="运行健康">
    <details>
      <summary><Activity size={14} aria-hidden="true" /><span>运行健康</span><b>{health ? labels[health.state] : "未知"}</b><ChevronDown size={13} aria-hidden="true" /></summary>
      <p>{health?.reason ?? "没有运行时观测，审计进度不能证明进程存活。"}</p>
      {health ? <dl>
        <div><dt>观测时间</dt><dd>{new Date(health.observedAt).toLocaleString("zh-CN")}</dd></div>
        {health.heartbeatAt ? <div><dt>最近心跳</dt><dd>{new Date(health.heartbeatAt).toLocaleString("zh-CN")}</dd></div> : null}
        {health.runnerPid ? <div><dt>Runner PID</dt><dd>{health.runnerPid}</dd></div> : null}
        {health.provider ? <div><dt>Agent</dt><dd>{health.provider} · {health.executionMode ?? "未记录"} · {health.transport ?? "未记录"}</dd></div> : null}
      </dl> : null}
      <small>运行健康不改变任务结果；接管不暂停 Runner。</small>
    </details>
  </section>;
}
