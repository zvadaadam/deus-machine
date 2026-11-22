import { BaseToolRenderer, CodeBlock, ToolFileLink, ToolFileTypeIcon } from "../components";
import type { ToolRendererProps } from "../../chat-types";
import { computeDiffStats } from "../utils/computeDiffStats";
import { detectLanguageFromPath } from "../utils/detectLanguage";

export function WriteToolRenderer({ toolUse, toolResult, isLoading }: ToolRendererProps) {
  const { file_path, content } = toolUse.input ?? {};
  const safeFilePath = typeof file_path === "string" ? file_path : "";
  const safeContent = typeof content === "string" ? content : "";
  const { added } = computeDiffStats("", safeContent);
  const language = safeFilePath ? detectLanguageFromPath(safeFilePath) : undefined;

  return (
    <BaseToolRenderer
      toolName="Write"
      icon={<ToolFileTypeIcon path={safeFilePath} />}
      toolUse={toolUse}
      toolResult={toolResult}
      isLoading={isLoading}
      renderSummary={() => (
        <>
          <ToolFileLink path={safeFilePath} target="files" />
          {added > 0 && (
            <span className="ml-1.5 inline-flex items-center gap-1 tabular-nums">
              <span className="text-success">+{added}</span>
            </span>
          )}
        </>
      )}
      renderContent={() => (
        <CodeBlock
          code={safeContent}
          language={language}
          showLineNumbers={true}
          maxHeight="300px"
        />
      )}
    />
  );
}
