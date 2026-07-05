import { Text, truncateToWidth, visibleWidth, wrapTextWithAnsi, type Component } from "@earendil-works/pi-tui";

export interface FoldableToolResultOptions {
  expanded?: boolean;
  isPartial?: boolean;
}

export interface FoldableToolResultRenderContext {
  isError?: boolean;
}

export interface FoldableToolResultConfig {
  toolName: string;
  fullOutputLabel?: string;
  previewLines?: number;
}

function textContentFromResult(result: unknown): string {
  const content = (result as { content?: unknown } | undefined)?.content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((block): block is { type: string; text: string } =>
      !!block && typeof block === "object" &&
      (block as { type?: unknown }).type === "text" &&
      typeof (block as { text?: unknown }).text === "string")
    .map((block) => block.text)
    .join("\n");
}

function compactPreviewLines(text: string, maxLines: number, width: number): string[] {
  const lines: string[] = [];
  for (const line of text.trimEnd().split("\n")) {
    if (lines.length >= maxLines) break;
    if (!line.trim()) continue;
    lines.push(truncateToWidth(line, width));
  }
  return lines;
}

export class FoldableToolResultView implements Component {
  constructor(
    private readonly text: string,
    private readonly isError: boolean,
    private readonly options: FoldableToolResultOptions,
    private readonly theme: any,
    private readonly config: Required<FoldableToolResultConfig>,
  ) {}

  invalidate(): void {}

  render(width: number): string[] {
    const safeWidth = Math.max(1, Math.floor(width));
    const trimmedText = this.text.trimEnd();
    if (!trimmedText) {
      return [this.theme.fg("dim", truncateToWidth(`No ${this.config.toolName} output`, safeWidth))];
    }

    if (this.isError || this.options.expanded) {
      return wrapTextWithAnsi(trimmedText, safeWidth);
    }

    const preview = compactPreviewLines(trimmedText, this.config.previewLines, safeWidth);
    const lines = preview.length > 0
      ? preview.map((line) => this.theme.fg("dim", line))
      : [this.theme.fg("dim", truncateToWidth("output: (blank)", safeWidth))];
    lines.push(this.theme.fg("muted", truncateToWidth(`expand for full ${this.config.fullOutputLabel} output`, safeWidth)));
    return lines;
  }
}

export function renderFoldableToolResult(
  result: unknown,
  options: FoldableToolResultOptions,
  theme: any,
  config: FoldableToolResultConfig,
  context?: FoldableToolResultRenderContext,
): Component {
  const fullConfig: Required<FoldableToolResultConfig> = {
    toolName: config.toolName,
    fullOutputLabel: config.fullOutputLabel ?? config.toolName,
    previewLines: config.previewLines ?? 6,
  };
  const text = textContentFromResult(result);
  const isError = context?.isError === true || (result as { isError?: unknown } | undefined)?.isError === true;
  if (!options.expanded && !isError && options.isPartial) {
    return new Text(theme.fg("muted", `expand for full ${fullConfig.fullOutputLabel} output`), 0, 0);
  }
  return new FoldableToolResultView(text, isError, options, theme, fullConfig);
}

export const __foldableToolResultTest = {
  textContentFromResult,
  compactPreviewLines,
  visibleTextWidth: visibleWidth,
};
