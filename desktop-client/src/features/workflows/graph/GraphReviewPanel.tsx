import { useEffect, useState } from 'react';
import { RefreshCw, Download, Workflow } from 'lucide-react';
import { GraphSurface, type GraphSnapshot } from './GraphSurface';
import './graph.css';

type GraphStatus = { state: 'missing' | 'generating' | 'trusted' | 'stale' | 'rejected'; templateId: string; graph?: GraphSnapshot; diagnostics: Array<{ severity: string; message: string }> };

export function GraphReviewPanel({ workspace, templateId = 'sequential-review' }: { workspace: string; templateId?: string }) {
  const [status, setStatus] = useState<GraphStatus>({ state: 'missing', templateId, diagnostics: [] });
  const [busy, setBusy] = useState(false);
  const refresh = async () => {
    if (!workspace) return;
    setStatus(await window.afkDesktop.graphStatus(workspace, templateId) as GraphStatus);
  };
  const generate = async (format: 'json' | 'archify-json' = 'json') => {
    if (!workspace) return;
    setBusy(true);
    try { setStatus((await window.afkDesktop.graphGenerate({ workspace, templateId, format })).status as GraphStatus); }
    finally { setBusy(false); }
  };
  useEffect(() => { void refresh(); }, [workspace, templateId]);
  return <section className="graph-review-panel" aria-label="工作流审阅图"><header><div><span className="graph-eyebrow"><Workflow size={13} />WORKFLOW GRAPH</span><h2>审阅图</h2></div><div className="graph-actions"><button onClick={() => void refresh()} title="重新读取"><RefreshCw size={14} /></button><button onClick={() => void generate('archify-json')} title="导出 Archify JSON"><Download size={14} /></button><button className="graph-primary" disabled={busy} onClick={() => void generate()}>{busy ? '生成中…' : '生成审阅图'}</button></div></header><div className={`graph-status graph-status-${status.state}`}><i />{status.state === 'trusted' ? '已信任' : status.state === 'missing' ? '尚未生成' : status.state === 'stale' ? '输入已变化' : status.state === 'generating' ? '生成中' : '生成被拒绝'}</div>{status.graph ? <GraphSurface snapshot={status.graph} /> : <div className="graph-empty"><Workflow size={25} /><b>{status.state === 'rejected' ? '保留上一次审阅图' : '暂无审阅图'}</b><span>{status.diagnostics[0]?.message ?? '生成后将在此处显示只读工作流结构。'}</span></div>}{status.diagnostics.length ? <ul className="graph-diagnostics">{status.diagnostics.map((diagnostic, index) => <li key={`${diagnostic.message}-${index}`}>{diagnostic.message}</li>)}</ul> : null}</section>;
}
