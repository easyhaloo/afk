import { useEffect, useId, useState } from "react";
import ReactMarkdown from "react-markdown";
import type { Components } from "react-markdown";
import remarkGfm from "remark-gfm";

type MarkdownContentProps = {
  source: string;
};

type MermaidDiagramProps = {
  source: string;
};

function MermaidDiagram({ source }: MermaidDiagramProps) {
  const generatedId = useId().replace(/:/g, "");
  const [svg, setSvg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let disposed = false;

    async function renderDiagram() {
      try {
        const { default: mermaid } = await import("mermaid");
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: "strict",
          theme: "default",
        });
        const result = await mermaid.render(`backlog-mermaid-${generatedId}`, source);
        if (!disposed) {
          setSvg(result.svg);
          setError(null);
        }
      } catch (renderError) {
        if (!disposed) {
          setSvg(null);
          setError(renderError instanceof Error ? renderError.message : "流程图语法无效");
        }
      }
    }

    void renderDiagram();
    return () => {
      disposed = true;
    };
  }, [generatedId, source]);

  return (
    <div className="markdown-mermaid" aria-label="Mermaid 流程图">
      {svg ? (
        <div className="markdown-mermaid-svg" dangerouslySetInnerHTML={{ __html: svg }} />
      ) : (
        <div className="markdown-mermaid-fallback">
          <span>{error ? "流程图渲染失败，已显示 Mermaid 源码" : "正在渲染流程图…"}</span>
          <pre><code>{source}</code></pre>
        </div>
      )}
    </div>
  );
}

const markdownComponents: Components = {
  code({ className, children, ...props }) {
    const language = /language-(\S+)/.exec(className ?? "")?.[1];
    const source = String(children).replace(/\n$/, "");

    if (language === "mermaid") {
      return <MermaidDiagram source={source} />;
    }

    return <code className={className} {...props}>{children}</code>;
  },
  input({ type, checked, ...props }) {
    if (type === "checkbox") {
      return <input type="checkbox" checked={checked} disabled {...props} />;
    }
    return <input type={type} checked={checked} {...props} />;
  },
  a({ href, children, ...props }) {
    return <a href={href} target="_blank" rel="noreferrer" {...props}>{children}</a>;
  },
};

export function MarkdownContent({ source }: MarkdownContentProps) {
  return (
    <div className="markdown-content">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
        {source}
      </ReactMarkdown>
    </div>
  );
}
