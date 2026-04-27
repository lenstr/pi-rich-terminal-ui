import type { ExtensionAPI, Theme, ThemeColor } from "@mariozechner/pi-coding-agent";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { type Component, Text, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@mariozechner/pi-tui";
import type { Static } from "typebox";
import { Type } from "typebox";
import { Parse } from "typebox/value";

const MESSAGE_TYPE = "rich-terminal-ui";
const TAG_PATTERN = /<json-render>([\s\S]*?)<\/json-render>/g;
const RawElementSchema = Type.Object(
  {
    type: Type.String(),
    props: Type.Record(Type.String(), Type.Unknown()),
    children: Type.Array(Type.String()),
  },
  { additionalProperties: false },
);
const RawSpecSchema = Type.Object(
  {
    root: Type.String(),
    elements: Type.Record(Type.String(), RawElementSchema),
  },
  { additionalProperties: false },
);

type RichSpec = Static<typeof RawSpecSchema>;
interface RichMessageDetails { spec: RichSpec; }
interface CustomAgentMessage { role: "custom"; customType: string; }

export default function (pi: ExtensionAPI) {
  let pendingSpecs: RichSpec[] = [];
  let queuedSpecs: RichSpec[] = [];
  let rawTextByContentIndex = new Map<number, string>();

  pi.registerMessageRenderer<RichMessageDetails>(MESSAGE_TYPE, (message, _options, theme) => {
    const spec = parseMessageSpec(message.details);
    if (!spec) return undefined;
    return new RichComponent(spec, theme);
  });

  pi.registerTool({
    name: "render_rich_ui",
    label: "Render Rich UI",
    description: "Render a rich terminal UI spec. Use this for charts, dashboards, tables, metrics, architecture diagrams, and other visual displays.",
    promptSnippet: "Render rich terminal UI specs for charts, dashboards, tables, metrics, architecture diagrams, and visual displays",
    promptGuidelines: [
      "Use render_rich_ui whenever the user asks to show, display, render, or visualize charts, dashboards, tables, metrics, graphs, architecture diagrams, or flow diagrams.",
      "Use ArchitectureDiagram for Mermaid-like architecture or flow diagrams; provide structured nodes, edges, direction, and optional groups instead of Mermaid source text.",
      "Use render_rich_ui for XYChart requests instead of replying with Markdown-only text.",
      "Supported element types are: Box, Text, Heading, Divider, Newline, Spacer, BarChart, XYChart, LineChart, VerticalBarChart, Sparkline, Table, List, Card, StatusLine, KeyValue, Badge, ProgressBar, Metric, Callout, Timeline, ArchitectureDiagram, FlowDiagram, Diagram. Do not invent layout types like Columns; use Box with props.flexDirection=\"row\" and props.gap for horizontal layouts.",
      "render_rich_ui input must be a spec object: { root: \"id\", elements: { id: { type: \"LineChart\", props: {...}, children: [] } } }.",
      "Every id listed in an element's children array must exist in elements. Use children: [] for leaf elements.",
      "For line graphs, use element type LineChart with props.series, props.xLabel, props.yLabel, and props.showLegend. Each series must be { name, color?, data: [{ x, y, label? }] }; x/y must be numeric and category labels such as months go in point.label, not point.x.",
      "For tables, use props.columns as [{ header, key, width? }] and props.rows as objects keyed by column key.",
      "For multi-series charts, set series[].color to distinct colors such as blue, red, green, yellow, magenta, cyan, gray, or theme tokens such as accent, success, error, warning, muted, dim, text.",
      "Text elements use props.text (not content). Box borders use props.borderStyle (for example \"single\"), not border: true.",
    ],
    parameters: RawSpecSchema,
    prepareArguments(args) {
      return Parse(RawSpecSchema, normalizeRichSpecArgs(args));
    },
    async execute(_toolCallId, params) {
      const spec = Parse(RawSpecSchema, params);
      const errors = validateSpec(spec);
      if (errors.length > 0) {
        return {
          content: [{ type: "text", text: `Invalid rich terminal UI spec:\n${errors.map((error) => `- ${error}`).join("\n")}` }],
          details: { spec } satisfies RichMessageDetails,
          isError: true,
        };
      }

      queuedSpecs.push(spec);
      return {
        content: [{ type: "text", text: "Rendered rich terminal UI below." }],
        details: { spec } satisfies RichMessageDetails,
      };
    },
    renderCall(_args, theme) {
      return new Text(theme.fg("toolTitle", theme.bold("render_rich_ui")), 0, 0);
    },
    renderResult(result, _options, theme) {
      const spec = parseMessageSpec(result.details);
      return spec
        ? new Text(theme.fg("muted", "Rendered rich terminal UI below."), 0, 0)
        : new Text(theme.fg("error", "Invalid rich terminal UI spec"), 0, 0);
    },
  });

  pi.on("context", async (event) => ({
    messages: event.messages.filter((message) => !isRichMessage(message)),
  }));
  pi.on("message_start", async (event) => {
    if (event.message.role !== "assistant") return;
    pendingSpecs = [];
    rawTextByContentIndex = new Map();
  });

  pi.on("message_update", async (event) => {
    if (event.message.role !== "assistant") return;

    updateRawText(event.assistantMessageEvent, rawTextByContentIndex);
    const rawText = Array.from(rawTextByContentIndex.values()).join("");
    const specs = extractSpecs(rawText);
    if (specs.length > 0) pendingSpecs = specs;
    stripRichTagsFromMessage(event.message, rawTextByContentIndex);
  });

  pi.on("message_end", async (event) => {
    if (event.message.role !== "assistant") return;

    const rawText = rawTextByContentIndex.size > 0 ? Array.from(rawTextByContentIndex.values()).join("") : renderContentText(event.message.content);
    const specs = extractSpecs(rawText);
    const specsToRender = specs.length > 0 ? specs : pendingSpecs;
    stripRichTagsFromMessage(event.message, rawTextByContentIndex);
    pendingSpecs = [];
    rawTextByContentIndex = new Map();

    queuedSpecs.push(...specsToRender);
  });

  pi.on("agent_end", async () => {
    if (queuedSpecs.length === 0) return;
    const specs = queuedSpecs;
    queuedSpecs = [];

    // During message_end pi is still streaming, so sendMessage() would steer the
    // agent and can cause repeated turns. Defer until the session is idle.
    setTimeout(() => {
      for (const spec of specs) {
        pi.sendMessage<RichMessageDetails>({
          customType: MESSAGE_TYPE,
          content: "",
          display: true,
          details: { spec },
        });
      }
    }, 0);
  });
}

class RichComponent implements Component {
  constructor(private readonly spec: RichSpec, private readonly theme: Theme) {}

  render(width: number): string[] {
    const safeWidth = Math.max(1, width);
    const errors = validateSpec(this.spec);
    return errors.length > 0
      ? errors.map((error) => clipLine(this.theme.fg("error", `Invalid rich UI: ${error}`), safeWidth))
      : this.renderElement(this.spec.root, safeWidth, new Set());
  }

  invalidate(): void {}

  private renderElement(id: string, width: number, seen: Set<string>): string[] {
    if (seen.has(id)) return [this.theme.fg("error", `[cycle: ${id}]`)];
    const element = this.spec.elements[id];
    if (!element) return [this.theme.fg("error", `[missing: ${id}]`)];

    const nextSeen = new Set(seen);
    nextSeen.add(id);
    const children = element.children.flatMap((childId) => this.renderElement(childId, width, nextSeen));
    const props = element.props;

    switch (element.type) {
      case "Box": return this.renderBox(props, element.children, width, nextSeen);
      case "Text": return this.renderText(props, width);
      case "Heading": return this.renderHeading(props, width);
      case "Divider": return [divider(width, getString(props.title), this.theme)];
      case "Newline": return [""];
      case "Spacer": return Array.from({ length: Math.max(1, getNumber(props.lines, 1)) }, () => "");
      case "BarChart": return this.renderBarChart(props, width);
      case "XYChart": return this.renderXYChart(props, width, undefined);
      case "LineChart": return this.renderXYChart(props, width, "line");
      case "VerticalBarChart": return this.renderXYChart(props, width, "bar");
      case "Sparkline": return this.renderSparkline(props, width);
      case "Table": return this.renderTable(props, width);
      case "List": return this.renderList(props, width);
      case "Card": return this.renderCard(props, children, width);
      case "StatusLine": return this.renderStatusLine(props, width);
      case "KeyValue": return this.renderKeyValue(props, width);
      case "Badge": return [truncateToWidth(this.renderBadge(props), width)];
      case "ProgressBar": return [this.renderProgressBar(props, width)];
      case "Metric": return this.renderMetric(props, width);
      case "Callout": return this.renderCallout(props, width);
      case "Timeline": return this.renderTimeline(props, width);
      case "ArchitectureDiagram":
      case "FlowDiagram":
      case "Diagram": return this.renderArchitectureDiagram(props, width);
      default: return [this.theme.fg("warning", `[unsupported: ${element.type}]`)];
    }
  }

  private renderBox(props: Record<string, unknown>, childIds: string[], width: number, seen: Set<string>): string[] {
    const padding = Math.max(0, getNumber(props.padding, 0));
    const gap = Math.max(0, getNumber(props.gap, 0));
    const bordered = typeof props.borderStyle === "string" && props.borderStyle.length > 0;
    const innerWidth = Math.max(1, width - padding * 2 - (bordered ? 2 : 0));
    const childLines = props.flexDirection === "row"
      ? this.renderRow(childIds, innerWidth, gap, seen)
      : childIds.flatMap((childId, index) => [
          ...(index > 0 ? Array.from({ length: gap }, () => "") : []),
          ...this.renderElement(childId, innerWidth, seen),
        ]);
    const padded = childLines.map((line) => `${" ".repeat(padding)}${padLine(line, innerWidth)}${" ".repeat(padding)}`);
    return bordered ? borderLines(padded, width, undefined, this.theme) : padded.map((line) => truncateToWidth(line, width));
  }

  private renderRow(childIds: string[], width: number, gap: number, seen: Set<string>): string[] {
    if (childIds.length === 0) return [];
    const gapWidth = gap * (childIds.length - 1);
    const colWidth = Math.max(1, Math.floor((width - gapWidth) / childIds.length));
    const rendered = childIds.map((childId) => this.renderElement(childId, colWidth, seen));
    const height = Math.max(...rendered.map((lines) => lines.length));
    return Array.from({ length: height }, (_, row) => rendered
      .map((lines) => padLine(lines[row] ?? "", colWidth))
      .join(" ".repeat(gap)));
  }

  private renderText(props: Record<string, unknown>, width: number): string[] {
    const color = getThemeColor(props.color, "text");
    const value = props.bold === true ? this.theme.bold(getString(props.text)) : getString(props.text);
    return wrapTextWithAnsi(this.theme.fg(color, value), width);
  }

  private renderHeading(props: Record<string, unknown>, width: number): string[] {
    const text = this.theme.fg("accent", this.theme.bold(getString(props.text)));
    const level = getString(props.level, "h2");
    const prefix = level === "h1" ? "# " : level === "h3" ? "### " : "## ";
    return wrapTextWithAnsi(prefix + text, width);
  }

  private renderBarChart(props: Record<string, unknown>, width: number): string[] {
    const data = getBarData(props.data);
    if (data.length === 0) return [];
    const max = Math.max(...data.map((item) => item.value), 1);
    const labelWidth = Math.min(18, Math.max(...data.map((item) => visibleWidth(item.label)), 1));
    const valueWidth = Math.max(...data.map((item) => String(item.value).length), 1);
    const barWidth = Math.max(1, width - labelWidth - valueWidth - 5 - (props.showPercentage === true ? 7 : 0));
    return data.map((item) => {
      const size = Math.round((item.value / max) * barWidth);
      const bar = this.theme.fg(getThemeColor(item.color, "accent"), "█".repeat(size));
      const pct = props.showPercentage === true ? ` ${(item.value / max * 100).toFixed(0).padStart(3)}%` : "";
      return truncateToWidth(`${padLine(item.label, labelWidth)} │ ${padLine(bar, barWidth)} ${String(item.value).padStart(valueWidth)}${pct}`, width);
    });
  }

  private renderXYChart(props: Record<string, unknown>, width: number, defaultChartType: XYChartType | undefined): string[] {
    const series = getXYSeries(props);
    const points = series.flatMap((item) => item.data);
    if (points.length === 0) return [];

    const height = Math.max(4, Math.min(24, Math.round(getNumber(props.height, 10))));
    const baseChartType = defaultChartType ?? getXYChartType(props.type ?? props.chartType);
    if (!baseChartType) return [this.theme.fg("error", "Invalid XYChart: props.chartType or props.type is required and must be scatter, line, or bar")];

    const labelWidth = 7;
    const plotWidth = Math.max(8, Math.min(Math.max(8, Math.round(getNumber(props.width, width))), width) - labelWidth - 1);
    const minX = Math.min(...points.map((point) => point.x));
    const maxX = Math.max(...points.map((point) => point.x));
    const minY = Math.min(...points.map((point) => point.y));
    const maxY = Math.max(...points.map((point) => point.y));
    const xRange = Math.max(1, maxX - minX);
    const yRange = Math.max(1, maxY - minY);
    const grid = series.some((item) => (getXYChartType(item.type ?? props.type ?? props.chartType) ?? baseChartType) === "line")
      ? renderLineGrid(series, plotWidth, height, minX, xRange, minY, yRange, this.theme)
      : Array.from({ length: height }, () => Array.from({ length: plotWidth }, () => " "));

    for (let index = 0; index < series.length; index++) {
      const item = series[index];
      if (!item) continue;
      const color = getThemeColor(item.color, "accent");
      const char = plotChar(index);
      const chartType = getXYChartType(item.type ?? props.type ?? props.chartType) ?? baseChartType;
      if (chartType === "line") continue;

      const scaledPoints = item.data
        .map((point) => ({
          point,
          x: clamp(Math.round(((point.x - minX) / xRange) * (plotWidth - 1)), 0, plotWidth - 1),
          y: clamp(height - 1 - Math.round(((point.y - minY) / yRange) * (height - 1)), 0, height - 1),
        }))
        .sort((a, b) => a.point.x - b.point.x);

      if (chartType === "bar") {
        for (const scaled of scaledPoints) {
          const barColor = getThemeColor(scaled.point.color ?? item.color, color);
          for (let y = scaled.y; y < height; y++) grid[y]![scaled.x] = this.theme.fg(barColor, "█");
        }
      } else {
        for (const scaled of scaledPoints) grid[scaled.y]![scaled.x] = this.theme.fg(getThemeColor(scaled.point.color ?? item.color, color), char);
      }
    }

    const yTickLabels = getYTickLabels(minY, maxY, height);
    const lines = grid.map((row, index) => {
      const label = yTickLabels.get(index) ?? "";
      return clipLine(`${padLine(label, labelWidth)}│${row.join("")}`, width);
    });
    lines.push(clipLine(`${" ".repeat(labelWidth)}└${"─".repeat(plotWidth)}`, width));
    lines.push(clipLine(`${" ".repeat(labelWidth + 1)}${renderXAxisLabels(points, minX, maxX, xRange, plotWidth)}`, width));
    const xLabel = getString(props.xLabel);
    if (xLabel) lines.push(clipLine(`${" ".repeat(labelWidth + 1)}${centerLine(this.theme.fg("muted", xLabel), plotWidth)}`, width));

    const yLabel = getString(props.yLabel);
    if (yLabel) lines.unshift(clipLine(this.theme.fg("muted", yLabel), width));
    if (props.showLegend === true && series.length > 1) {
      lines.push(clipLine(series.map((item, index) => `${this.theme.fg(getThemeColor(item.color, "accent"), plotChar(index))} ${item.name}`).join("  "), width));
    }
    return lines;
  }

  private renderSparkline(props: Record<string, unknown>, width: number): string[] {
    const values = getNumbers(props.data).slice(0, Math.max(1, width));
    if (values.length === 0) return [];
    const min = Math.min(...values);
    const max = Math.max(...values);
    const chars = "▁▂▃▄▅▆▇█";
    const line = values.map((value) => chars[Math.round(((value - min) / Math.max(1, max - min)) * (chars.length - 1))] ?? "▁").join("");
    return [truncateToWidth(this.theme.fg(getThemeColor(props.color, "accent"), line), width)];
  }

  private renderTable(props: Record<string, unknown>, width: number): string[] {
    const columns = getColumns(props.columns);
    const rows = getRows(props.rows);
    if (columns.length === 0) return [];
    const widths = columns.map((column) => Math.max(3, column.width ?? Math.min(20, Math.max(column.header.length, ...rows.map((row) => stringify(row[column.key]).length)))));
    shrinkWidths(widths, width - Math.max(0, columns.length - 1) * 3);
    const header = columns.map((column, index) => padLine(column.header, widths[index] ?? 3)).join(" │ ");
    const separator = widths.map((columnWidth) => "─".repeat(columnWidth)).join("─┼─");
    return [
      truncateToWidth(this.theme.fg(getThemeColor(props.headerColor, "accent"), header), width),
      truncateToWidth(this.theme.fg("borderMuted", separator), width),
      ...rows.map((row) => truncateToWidth(columns.map((column, index) => padLine(stringify(row[column.key]), widths[index] ?? 3)).join(" │ "), width)),
    ];
  }

  private renderList(props: Record<string, unknown>, width: number): string[] {
    return getStrings(props.items).flatMap((item, index) => wrapTextWithAnsi(`${props.ordered === true ? `${index + 1}.` : "•"} ${item}`, width));
  }

  private renderCard(props: Record<string, unknown>, children: string[], width: number): string[] {
    const padding = Math.max(0, getNumber(props.padding, 1));
    const title = getString(props.title);
    const lines = children.length > 0 ? children : [""];
    const maxContentWidth = Math.max(1, width - 2 - padding * 2);
    const contentWidth = Math.max(1, Math.min(maxContentWidth, Math.max(...lines.map((line) => getLineContentWidth(clipLine(line, maxContentWidth))), 0)));
    const titleWidth = title ? visibleWidth(` ${title} `) : 0;
    const cardWidth = Math.max(3, Math.min(width, Math.max(titleWidth + 2, contentWidth + padding * 2 + 2)));
    const innerWidth = Math.max(1, cardWidth - 2 - padding * 2);
    const padded = lines.map((line) => `${" ".repeat(padding)}${padLine(clipLine(line, innerWidth), innerWidth)}${" ".repeat(padding)}`);
    return borderLines(padded, cardWidth, title, this.theme);
  }

  private renderStatusLine(props: Record<string, unknown>, width: number): string[] {
    const status = getStatus(props.status);
    const icon = status === "success" ? "✓" : status === "error" ? "✗" : status === "warning" ? "!" : "i";
    return [truncateToWidth(`${this.theme.fg(statusColor(status), icon)} ${getString(props.text)}`, width)];
  }

  private renderKeyValue(props: Record<string, unknown>, width: number): string[] {
    return [truncateToWidth(`${this.theme.fg("muted", `${getString(props.label)}:`)} ${stringify(props.value)}`, width)];
  }

  private renderBadge(props: Record<string, unknown>): string {
    const color = variantColor(getString(props.variant, "info"));
    return this.theme.fg(color, `[${getString(props.label)}]`);
  }

  private renderProgressBar(props: Record<string, unknown>, width: number): string {
    const progress = clamp(getNumber(props.progress, 0), 0, 1);
    const label = getString(props.label);
    const requested = getNumber(props.width, Math.min(24, Math.max(6, width - label.length - 8)));
    const barWidth = Math.max(3, Math.min(requested, width - label.length - 8));
    const filled = Math.round(progress * barWidth);
    const bar = `${this.theme.fg("accent", "█".repeat(filled))}${this.theme.fg("dim", "░".repeat(barWidth - filled))}`;
    return truncateToWidth(`${label ? `${label} ` : ""}[${bar}] ${Math.round(progress * 100)}%`, width);
  }

  private renderMetric(props: Record<string, unknown>, width: number): string[] {
    const trend = props.trend === "up" ? this.theme.fg("success", "↗") : props.trend === "down" ? this.theme.fg("error", "↘") : "";
    return [truncateToWidth(`${this.theme.fg("muted", getString(props.label))} ${this.theme.bold(stringify(props.value))} ${trend}`, width)];
  }

  private renderCallout(props: Record<string, unknown>, width: number): string[] {
    const type = getString(props.type, "info");
    const color = variantColor(type);
    const title = this.theme.fg(color, this.theme.bold(getString(props.title, type.toUpperCase())));
    const content = wrapTextWithAnsi(getString(props.content), Math.max(1, width - 4));
    return borderLines([title, ...content], width, undefined, this.theme, color);
  }

  private renderTimeline(props: Record<string, unknown>, width: number): string[] {
    return getTimelineItems(props.items).flatMap((item) => {
      const color = variantColor(item.status ?? "info");
      const head = truncateToWidth(`${this.theme.fg(color, "●")} ${this.theme.bold(item.title)}`, width);
      const description = item.description ? wrapTextWithAnsi(`${this.theme.fg("dim", "│")} ${item.description}`, width) : [];
      return [head, ...description];
    });
  }

  private renderArchitectureDiagram(props: Record<string, unknown>, width: number): string[] {
    // Keep diagrams structured instead of parsing Mermaid text: validation stays
    // cheap, and the LLM can generate the same JSON shape as other components.
    const nodes = getDiagramNodes(props.nodes);
    if (nodes.length === 0) return [this.theme.fg("error", "ArchitectureDiagram requires props.nodes")];

    const nodeIds = new Set(nodes.map((node) => node.id));
    const edges = getDiagramEdges(props.edges).filter((edge) => nodeIds.has(edge.from) && nodeIds.has(edge.to));
    const groups = getDiagramGroups(props.groups);
    const direction = getDiagramDirection(props.direction);
    const title = getString(props.title);
    const lines = title ? [this.theme.fg("accent", this.theme.bold(title)), ""] : [];

    lines.push(...(direction === "TB" || direction === "BT"
      ? this.renderDiagramVertical(nodes, edges, direction, width)
      : this.renderDiagramHorizontal(nodes, edges, direction, width)));

    if (groups.length > 0) {
      lines.push("", ...this.renderDiagramGroups(groups, nodes, width));
    }

    return lines.map((line) => clipLine(line, width));
  }

  private renderDiagramHorizontal(nodes: DiagramNode[], edges: DiagramEdge[], direction: DiagramDirection, width: number): string[] {
    // Render each dependency level as a column. This is intentionally simpler
    // than full graph routing so dense diagrams remain stable in narrow terminals.
    const levels = getDiagramLevels(nodes, edges);
    const orderedLevels = direction === "RL" ? [...levels].reverse() : levels;
    const gaps = Math.max(0, orderedLevels.length - 1);
    const nodeById = new Map(nodes.map((node) => [node.id, node]));
    const nodeWidths = orderedLevels.map((level) => Math.max(7, Math.min(24, Math.max(...level.map((nodeId) => visibleWidth(nodeById.get(nodeId)?.label ?? nodeId))) + 4)));
    const minNodeWidth = 7;
    const minNodeTotal = orderedLevels.length * minNodeWidth;
    // Spend spare width on connectors first; otherwise labels collapse into
    // arrowheads and the diagram looks like disconnected boxes.
    const gapWidth = gaps > 0 ? Math.max(3, Math.min(12, Math.floor((width - minNodeTotal) / gaps))) : 0;
    shrinkWidthsToMinimum(nodeWidths, width - gapWidth * gaps, minNodeWidth);
    const columns = orderedLevels.map((level, index) => this.renderDiagramColumn(level, nodes, nodeWidths[index] ?? 7));
    const height = Math.max(...columns.map((column) => column.lines.length));
    const centeredColumns = columns.map((column) => centerDiagramColumn(column, height));
    const lines: string[] = [];

    for (let row = 0; row < height; row++) {
      const parts: string[] = [];
      for (let index = 0; index < centeredColumns.length; index++) {
        parts.push(centeredColumns[index]?.lines[row] ?? " ".repeat(nodeWidths[index] ?? 7));
        if (index < centeredColumns.length - 1) {
          const left = centeredColumns[index];
          const right = centeredColumns[index + 1];
          parts.push(this.renderDiagramHorizontalConnector(row, orderedLevels[index] ?? [], orderedLevels[index + 1] ?? [], left, right, edges, direction, gapWidth));
        }
      }
      lines.push(clipLine(parts.join(""), width));
    }

    return lines;
  }

  private renderDiagramVertical(nodes: DiagramNode[], edges: DiagramEdge[], direction: DiagramDirection, width: number): string[] {
    // TB/BT is a level layout, not orthogonal edge routing: sibling nodes share
    // a row and the connector summarizes edges to the next level.
    const levels = getDiagramLevels(nodes, edges);
    const orderedLevels = direction === "BT" ? [...levels].reverse() : levels;
    const nodeWidth = Math.max(7, Math.min(22, Math.max(...nodes.map((node) => visibleWidth(node.label))) + 4, Math.floor(width / 2)));
    const lines: string[] = [];

    for (let index = 0; index < orderedLevels.length; index++) {
      lines.push(...this.renderDiagramLevelRow(orderedLevels[index] ?? [], nodes, nodeWidth, width));
      if (index < orderedLevels.length - 1) {
        const connectorEdges = getEdgesBetweenLevels(orderedLevels[index] ?? [], orderedLevels[index + 1] ?? [], edges, direction);
        const labels = uniqueStrings(connectorEdges.map((edge) => edge.label).filter((label) => label !== undefined));
        const label = labels.length > 0 ? ` ${labels.join(" / ")}` : "";
        lines.push(centerLine(`${this.theme.fg("border", "│")}${this.theme.fg("muted", label)}`, width));
        lines.push(centerLine(this.theme.fg("border", direction === "BT" ? "▲" : "▼"), width));
      }
    }

    return lines;
  }

  private renderDiagramColumn(level: string[], nodes: DiagramNode[], nodeWidth: number): DiagramColumn {
    const nodeById = new Map(nodes.map((node) => [node.id, node]));
    const lines: string[] = [];
    const middleRows = new Map<string, number>();

    for (const nodeId of level) {
      const node = nodeById.get(nodeId);
      if (!node) continue;
      if (lines.length > 0) lines.push("");
      const block = this.renderDiagramNodeBlock(node, nodeWidth);
      // Store the label row so horizontal connectors land on the node center,
      // even after columns with fewer nodes are vertically padded.
      middleRows.set(nodeId, lines.length + 1);
      lines.push(...block);
    }

    return { lines, middleRows };
  }

  private renderDiagramLevelRow(level: string[], nodes: DiagramNode[], nodeWidth: number, width: number): string[] {
    const nodeById = new Map(nodes.map((node) => [node.id, node]));
    const blocks = level.flatMap((nodeId) => {
      const node = nodeById.get(nodeId);
      return node ? [this.renderDiagramNodeBlock(node, nodeWidth)] : [];
    });
    if (blocks.length === 0) return [];

    return [0, 1, 2].map((row) => centerLine(blocks.map((block) => block[row] ?? "").join("  "), width));
  }

  private renderDiagramNodeBlock(node: DiagramNode, width: number): string[] {
    const borderColor = getThemeColor(node.color, "border");
    const labelColor = getThemeColor(node.color, "accent");
    const innerWidth = Math.max(1, width - 2);
    return [
      this.theme.fg(borderColor, `┌${"─".repeat(innerWidth)}┐`),
      `${this.theme.fg(borderColor, "│")}${centerLine(this.theme.fg(labelColor, node.label), innerWidth)}${this.theme.fg(borderColor, "│")}`,
      this.theme.fg(borderColor, `└${"─".repeat(innerWidth)}┘`),
    ];
  }

  private renderDiagramHorizontalConnector(row: number, leftIds: string[], rightIds: string[], left: DiagramColumn | undefined, right: DiagramColumn | undefined, edges: DiagramEdge[], direction: DiagramDirection, width: number): string {
    if (!left || !right) return " ".repeat(width);

    const edge = direction === "RL"
      ? findDiagramEdgeAtRow(row, leftIds, rightIds, left.middleRows, edges, "RL")
      : findDiagramEdgeAtRow(row, leftIds, rightIds, right.middleRows, edges, "LR");

    if (!edge) return " ".repeat(width);
    const color = edge.style === "dashed" || edge.style === "dotted" ? "muted" : "border";
    return this.theme.fg(color, renderDiagramConnector(edge, width, direction));
  }

  private renderDiagramGroups(groups: DiagramGroup[], nodes: DiagramNode[], width: number): string[] {
    const nodeById = new Map(nodes.map((node) => [node.id, node]));
    return groups.flatMap((group, index) => {
      const groupNodes = group.nodes.flatMap((nodeId) => {
        const node = nodeById.get(nodeId);
        return node ? [`• ${node.label}`] : [];
      });
      if (groupNodes.length === 0) return [];

      const contentWidth = Math.max(visibleWidth(` ${group.label} `), ...groupNodes.map((line) => visibleWidth(line)));
      const groupWidth = Math.max(4, Math.min(width, contentWidth + 4));
      return [
        ...(index > 0 ? [""] : []),
        ...borderLines(groupNodes, groupWidth, group.label, this.theme, getThemeColor(group.color, "borderAccent")),
      ];
    });
  }
}

function normalizeRichSpecArgs(value: unknown): unknown {
  if (!isRecord(value)) return makeErrorSpec("render_rich_ui input must be an object with root/elements or a chart element object");

  if (isRecord(value.elements)) {
    const elements: Record<string, unknown> = {};
    for (const [id, rawElement] of Object.entries(value.elements)) {
      elements[id] = normalizeElement(rawElement);
    }
    return { root: getString(value.root, Object.keys(elements)[0] ?? "root"), elements };
  }

  if (typeof value.type === "string" || typeof value.component === "string") {
    return {
      root: "chart",
      elements: {
        chart: normalizeElement(value),
      },
    };
  }

  if (Array.isArray(value.series) || Array.isArray(value.data)) {
    return {
      root: "chart",
      elements: {
        chart: normalizeElement({ ...value, type: inferChartElementType(value) }),
      },
    };
  }

  return makeErrorSpec("render_rich_ui input must include root/elements, a type/component field, or chart data/series");
}

function normalizeElement(value: unknown): unknown {
  if (!isRecord(value)) return { type: "Callout", props: { type: "error", title: "Invalid element", content: "Element must be an object" }, children: [] };

  const type = getString(value.type, getString(value.component, "Callout"));
  const props: Record<string, unknown> = isRecord(value.props) ? { ...value.props } : {};
  for (const [key, rawValue] of Object.entries(value)) {
    if (key !== "type" && key !== "component" && key !== "props" && key !== "children") props[key] = rawValue;
  }

  return {
    type,
    props,
    children: Array.isArray(value.children) ? value.children.filter((child): child is string => typeof child === "string") : [],
  };
}

function inferChartElementType(value: Record<string, unknown>): string {
  const explicit = getString(value.chartType, getString(value.type));
  const chartType = getXYChartType(explicit);
  if (chartType === "line") return "LineChart";
  if (chartType === "bar") return "VerticalBarChart";
  return "XYChart";
}

function makeErrorSpec(message: string): RichSpec {
  return {
    root: "error",
    elements: {
      error: {
        type: "Callout",
        props: { type: "error", title: "Invalid rich terminal UI spec", content: message },
        children: [],
      },
    },
  };
}

function validateSpec(spec: RichSpec): string[] {
  const errors: string[] = [];
  if (!spec.elements[spec.root]) errors.push(`root element "${spec.root}" is missing`);

  for (const [id, element] of Object.entries(spec.elements)) {
    for (const childId of element.children) {
      if (!spec.elements[childId]) errors.push(`element "${id}" references missing child "${childId}"`);
    }

    if (element.type === "XYChart") {
      const chartTypeValue = element.props.type ?? element.props.chartType;
      if (chartTypeValue === undefined) {
        errors.push(`element "${id}" (XYChart) must set props.chartType or props.type to "scatter", "line", or "bar"`);
      } else if (!getXYChartType(chartTypeValue)) {
        errors.push(`element "${id}" (XYChart) has invalid chart type "${stringify(chartTypeValue)}"; expected "scatter", "line", or "bar"`);
      }
    }

    if (isDiagramElementType(element.type)) {
      const nodes = getDiagramNodes(element.props.nodes);
      if (nodes.length === 0) errors.push(`element "${id}" (${element.type}) must include props.nodes with at least one {id,label}`);

      const nodeIds = new Set<string>();
      for (const node of nodes) {
        if (nodeIds.has(node.id)) errors.push(`element "${id}" (${element.type}) has duplicate node id "${node.id}"`);
        nodeIds.add(node.id);
      }

      for (const edge of getDiagramEdges(element.props.edges)) {
        if (!nodeIds.has(edge.from)) errors.push(`element "${id}" (${element.type}) edge references missing from node "${edge.from}"`);
        if (!nodeIds.has(edge.to)) errors.push(`element "${id}" (${element.type}) edge references missing to node "${edge.to}"`);
      }

      for (const group of getDiagramGroups(element.props.groups)) {
        for (const nodeId of group.nodes) {
          if (!nodeIds.has(nodeId)) errors.push(`element "${id}" (${element.type}) group "${group.id}" references missing node "${nodeId}"`);
        }
      }
    }

    const series = getExplicitXYSeries(element.props.series);
    for (const item of series) {
      if (item.type && !getXYChartType(item.type)) {
        errors.push(`element "${id}" series "${item.name}" has invalid type "${item.type}"; expected "scatter", "line", or "bar"`);
      }
    }
  }

  return errors;
}

function extractSpecs(text: string): RichSpec[] {
  return Array.from(text.matchAll(TAG_PATTERN), (match) => parseSpec(match[1]?.trim() ?? "")).filter((spec) => spec !== undefined);
}

function updateRawText(event: { type: string; contentIndex?: number; delta?: string; content?: string }, rawTextByContentIndex: Map<number, string>): void {
  if (typeof event.contentIndex !== "number") return;
  if (event.type === "text_start") rawTextByContentIndex.set(event.contentIndex, rawTextByContentIndex.get(event.contentIndex) ?? "");
  if (event.type === "text_delta" && typeof event.delta === "string") {
    rawTextByContentIndex.set(event.contentIndex, `${rawTextByContentIndex.get(event.contentIndex) ?? ""}${event.delta}`);
  }
  if (event.type === "text_end" && typeof event.content === "string") rawTextByContentIndex.set(event.contentIndex, event.content);
}

function stripRichTagsFromMessage(message: AgentMessage, rawTextByContentIndex: ReadonlyMap<number, string>): void {
  if (message.role !== "assistant") return;
  message.content.forEach((block, index) => {
    if (block.type === "text") block.text = stripRichTags(rawTextByContentIndex.get(index) ?? block.text);
  });
}

function stripRichTags(text: string): string {
  // Hide render payloads while the assistant is streaming. If a closing tag has
  // not arrived yet, drop the open block so raw JSON never flashes in chat.
  const withoutClosedBlocks = text.replace(/<json-render>[\s\S]*?<\/json-render>/g, "");
  const openBlockStart = withoutClosedBlocks.indexOf("<json-render>");
  const withoutOpenBlock = openBlockStart === -1 ? withoutClosedBlocks : withoutClosedBlocks.slice(0, openBlockStart);
  return stripPartialOpeningTag(withoutOpenBlock).trimEnd();
}

function stripPartialOpeningTag(text: string): string {
  const tag = "<json-render>";
  for (let length = Math.min(tag.length - 1, text.length); length > 0; length--) {
    if (text.endsWith(tag.slice(0, length))) return text.slice(0, -length);
  }
  return text;
}

function parseSpec(json: string): RichSpec | undefined {
  try {
    return Parse(RawSpecSchema, JSON.parse(json));
  } catch {
    return undefined;
  }
}

function parseMessageSpec(details: unknown): RichSpec | undefined {
  if (!isRecord(details) || !("spec" in details)) return undefined;
  try {
    return Parse(RawSpecSchema, details.spec);
  } catch {
    return undefined;
  }
}

function isRichMessage(message: AgentMessage): boolean {
  return "role" in message && message.role === "custom" && isCustomMessage(message) && message.customType === MESSAGE_TYPE;
}

function isCustomMessage(message: AgentMessage): message is AgentMessage & CustomAgentMessage {
  return "role" in message && message.role === "custom" && "customType" in message && typeof message.customType === "string";
}

function renderContentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((block) => isRecord(block) && block.type === "text" && typeof block.text === "string" ? block.text : "").join("");
}

function borderLines(lines: string[], width: number, title: string | undefined, theme: Theme, color: ThemeColor = "border"): string[] {
  const innerWidth = Math.max(1, width - 2);
  const titleText = title ? ` ${title} ` : "";
  const topFill = Math.max(0, innerWidth - visibleWidth(titleText));
  const top = `┌${titleText}${"─".repeat(topFill)}┐`;
  const bottom = `└${"─".repeat(innerWidth)}┘`;
  return [
    theme.fg(color, clipLine(top, width)),
    ...lines.map((line) => `${theme.fg(color, "│")}${padLine(clipLine(line, innerWidth), innerWidth)}${theme.fg(color, "│")}`),
    theme.fg(color, clipLine(bottom, width)),
  ];
}

function clipLine(value: string, width: number): string {
  // Use an empty suffix: default ellipses create bright right-edge artifacts in
  // bordered/colored TUI output.
  return truncateToWidth(value, width, "");
}

function getLineContentWidth(value: string): number {
  return visibleWidth(stripAnsi(value).trimEnd());
}

function stripAnsi(value: string): string {
  return value
    .replace(/\x1b\[[0-9;]*[A-Za-z]/g, "")
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\_[^\x07]*(?:\x07|\x1b\\)/g, "");
}

function divider(width: number, title: string, theme: Theme): string {
  if (!title) return theme.fg("borderMuted", "─".repeat(width));
  const label = ` ${title} `;
  const left = Math.max(0, Math.floor((width - visibleWidth(label)) / 2));
  const right = Math.max(0, width - left - visibleWidth(label));
  return theme.fg("borderMuted", `${"─".repeat(left)}${label}${"─".repeat(right)}`);
}

function padLine(value: string, width: number): string {
  const truncated = truncateToWidth(value, width, "");
  return truncated + " ".repeat(Math.max(0, width - visibleWidth(truncated)));
}

function shrinkWidths(widths: number[], maxTotal: number): void {
  shrinkWidthsToMinimum(widths, maxTotal, 3);
}

function shrinkWidthsToMinimum(widths: number[], maxTotal: number, minimum: number): void {
  while (widths.reduce((sum, width) => sum + width, 0) > maxTotal && widths.some((width) => width > minimum)) {
    const index = widths.indexOf(Math.max(...widths));
    widths[index] = Math.max(minimum, (widths[index] ?? minimum) - 1);
  }
}

function getString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function stringify(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

function getNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function getStrings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function getNumbers(value: unknown): number[] {
  return Array.isArray(value) ? value.filter((item): item is number => typeof item === "number" && Number.isFinite(item)) : [];
}

function getThemeColor(value: unknown, fallback: ThemeColor): ThemeColor {
  if (isThemeColor(value)) return value;
  if (typeof value !== "string") return fallback;

  switch (value.toLowerCase()) {
    case "blue":
    case "cyan": return "accent";
    case "green": return "success";
    case "red": return "error";
    case "yellow":
    case "orange": return "warning";
    case "magenta":
    case "purple":
    case "violet": return "customMessageText";
    case "gray":
    case "grey": return "muted";
    case "black": return "dim";
    case "white": return "text";
    default: return fallback;
  }
}

function isThemeColor(value: unknown): value is ThemeColor {
  switch (value) {
    case "accent":
    case "border":
    case "borderAccent":
    case "borderMuted":
    case "success":
    case "error":
    case "warning":
    case "muted":
    case "dim":
    case "text":
    case "customMessageText":
    case "toolTitle":
    case "toolOutput":
      return true;
    default:
      return false;
  }
}

function getStatus(value: unknown): "success" | "error" | "warning" | "info" {
  return value === "success" || value === "error" || value === "warning" || value === "info" ? value : "info";
}

function statusColor(status: "success" | "error" | "warning" | "info"): ThemeColor {
  return status === "info" ? "accent" : status;
}

function variantColor(variant: string): ThemeColor {
  if (variant === "success" || variant === "error" || variant === "warning") return variant;
  return variant === "muted" ? "muted" : "accent";
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

interface BarItem { label: string; value: number; color?: string; }
function getBarData(value: unknown): BarItem[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!isRecord(item)) return [];
    const label = getString(item.label);
    const number = getNumber(item.value, Number.NaN);
    return label && Number.isFinite(number) ? [{ label, value: number, color: getString(item.color, "accent") }] : [];
  });
}

type XYChartType = "scatter" | "line" | "bar";
interface XYPoint { x: number; y: number; label?: string; color?: string; }
interface XYSeries { name: string; color?: string; type?: string; data: XYPoint[]; }


function getXYSeries(props: Record<string, unknown>): XYSeries[] {
  const explicitSeries = getExplicitXYSeries(props.series);
  if (explicitSeries.length > 0) return explicitSeries;

  const data = getXYPoints(props.data);
  return data.length > 0 ? [{ name: getString(props.name, "data"), color: getString(props.color, "accent"), data }] : [];
}

function getExplicitXYSeries(value: unknown): XYSeries[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item, index) => {
    if (!isRecord(item)) return [];
    const data = getXYPoints(item.data);
    if (data.length === 0) return [];
    return [{ name: getString(item.name, `series ${index + 1}`), color: getString(item.color, defaultSeriesColor(index)), type: getString(item.type), data }];
  });
}

function defaultSeriesColor(index: number): string {
  return ["accent", "success", "warning", "error", "customMessageText", "muted"][index % 6] ?? "accent";
}

function getXYPoints(value: unknown): XYPoint[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!isRecord(item)) return [];
    const x = getNumber(item.x, Number.NaN);
    const y = getNumber(item.y, Number.NaN);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return [];
    return [{ x, y, label: getString(item.label) || undefined, color: getString(item.color) || undefined }];
  });
}

function getXYChartType(value: unknown): XYChartType | undefined {
  if (typeof value !== "string") return undefined;
  switch (value.toLowerCase().replace(/[-_\s]/g, "")) {
    case "scatter":
    case "points":
    case "point":
      return "scatter";
    case "line":
    case "lines":
    case "linechart":
      return "line";
    case "bar":
    case "bars":
    case "barchart":
    case "column":
    case "columns":
    case "verticalbar":
    case "verticalbars":
    case "verticalbarchart":
      return "bar";
    default:
      return undefined;
  }
}

function plotChar(index: number): string {
  return ["●", "◆", "■", "▲", "✦", "×"][index % 6] ?? "●";
}

interface BrailleCell { mask: number; color: ThemeColor; }

type BrailleGrid = (BrailleCell | undefined)[][];

function renderLineGrid(series: XYSeries[], width: number, height: number, minX: number, xRange: number, minY: number, yRange: number, theme: Theme): string[][] {
  const subWidth = Math.max(1, width * 2);
  const subHeight = Math.max(1, height * 4);
  const brailleGrid: BrailleGrid = Array.from({ length: height }, () => Array.from({ length: width }, () => undefined));

  for (const item of series) {
    const color = getThemeColor(item.color, "accent");
    const points = item.data
      .map((point) => ({
        x: clamp(Math.round(((point.x - minX) / xRange) * (subWidth - 1)), 0, subWidth - 1),
        y: clamp(subHeight - 1 - Math.round(((point.y - minY) / yRange) * (subHeight - 1)), 0, subHeight - 1),
      }))
      .sort((a, b) => a.x - b.x);

    for (let index = 1; index < points.length; index++) {
      const previous = points[index - 1]!;
      const current = points[index]!;
      drawBrailleLine(brailleGrid, previous.x, previous.y, current.x, current.y, color);
    }
    for (const point of points) drawBraillePoint(brailleGrid, point.x, point.y, color);
  }

  return brailleGrid.map((row) => row.map((cell) => cell ? theme.fg(cell.color, String.fromCodePoint(0x2800 + cell.mask)) : " "));
}

function drawBrailleLine(grid: BrailleGrid, x1: number, y1: number, x2: number, y2: number, color: ThemeColor): void {
  const dx = Math.abs(x2 - x1);
  const dy = Math.abs(y2 - y1);
  const sx = x1 < x2 ? 1 : -1;
  const sy = y1 < y2 ? 1 : -1;
  let error = dx - dy;
  let x = x1;
  let y = y1;

  while (true) {
    setBrailleSubpixel(grid, x, y, color);
    if (x === x2 && y === y2) break;
    const e2 = error * 2;
    if (e2 > -dy) {
      error -= dy;
      x += sx;
    }
    if (e2 < dx) {
      error += dx;
      y += sy;
    }
  }
}

function drawBraillePoint(grid: BrailleGrid, x: number, y: number, color: ThemeColor): void {
  setBrailleSubpixel(grid, x, y, color);
  setBrailleSubpixel(grid, x + 1, y, color);
  setBrailleSubpixel(grid, x, y + 1, color);
  setBrailleSubpixel(grid, x + 1, y + 1, color);
}

function setBrailleSubpixel(grid: BrailleGrid, x: number, y: number, color: ThemeColor): void {
  if (x < 0 || y < 0) return;
  const row = Math.floor(y / 4);
  const column = Math.floor(x / 2);
  const bit = brailleBit(x % 2, y % 4);
  const existing = grid[row]?.[column];
  if (existing) {
    existing.mask |= bit;
    existing.color = color;
  } else if (grid[row] && column < grid[row].length) {
    grid[row]![column] = { mask: bit, color };
  }
}

function brailleBit(x: number, y: number): number {
  if (x === 0 && y === 0) return 1 << 0;
  if (x === 0 && y === 1) return 1 << 1;
  if (x === 0 && y === 2) return 1 << 2;
  if (x === 0 && y === 3) return 1 << 6;
  if (x === 1 && y === 0) return 1 << 3;
  if (x === 1 && y === 1) return 1 << 4;
  if (x === 1 && y === 2) return 1 << 5;
  return 1 << 7;
}

function formatAxisNumber(value: number): string {
  const abs = Math.abs(value);
  if (abs >= 1000 || (abs > 0 && abs < 0.01)) return value.toExponential(1);
  if (Number.isInteger(value)) return String(value);
  return value.toFixed(abs < 10 ? 2 : 1).replace(/\.0+$/, "").replace(/(\.\d*?)0+$/, "$1");
}

function formatXValue(value: number, points: XYPoint[]): string {
  const exactPoint = points.find((point) => point.x === value && point.label);
  return exactPoint?.label ?? formatAxisNumber(value);
}

function getYTickLabels(minY: number, maxY: number, height: number): Map<number, string> {
  const labels = new Map<number, string>();
  const tickCount = Math.max(2, Math.min(5, height));
  const range = maxY - minY;
  for (let index = 0; index < tickCount; index++) {
    const ratio = tickCount === 1 ? 0 : index / (tickCount - 1);
    const row = Math.round(ratio * (height - 1));
    labels.set(row, formatAxisNumber(maxY - range * ratio));
  }
  return labels;
}

function renderXAxisLabels(points: XYPoint[], minX: number, maxX: number, xRange: number, width: number): string {
  const line = Array.from({ length: width }, () => " ");
  const ticks = getXTicks(points, minX, maxX, width);
  for (const tick of ticks) {
    const label = formatXValue(tick, points);
    const labelWidth = visibleWidth(label);
    if (labelWidth === 0 || labelWidth > width) continue;
    const column = clamp(Math.round(((tick - minX) / xRange) * (width - 1)), 0, width - 1);
    const start = clamp(Math.round(column - labelWidth / 2), 0, width - labelWidth);
    const end = start + labelWidth;
    if (line.slice(start, end).some((char) => char !== " ")) continue;
    for (let index = 0; index < labelWidth; index++) line[start + index] = label[index] ?? " ";
  }
  return line.join("");
}

function getXTicks(points: XYPoint[], minX: number, maxX: number, width: number): number[] {
  const maxTicks = Math.max(2, Math.min(8, Math.floor(width / 8) + 1));
  const uniqueXValues = [...new Set(points.map((point) => point.x))].sort((a, b) => a - b);
  if (uniqueXValues.length <= maxTicks) return uniqueXValues;

  const tickCount = Math.min(maxTicks, 6);
  return Array.from({ length: tickCount }, (_, index) => minX + ((maxX - minX) * index) / Math.max(1, tickCount - 1));
}

function centerLine(value: string, width: number): string {
  const valueWidth = visibleWidth(value);
  if (valueWidth >= width) return clipLine(value, width);
  const left = Math.floor((width - valueWidth) / 2);
  return `${" ".repeat(left)}${value}${" ".repeat(width - valueWidth - left)}`;
}

interface Column { header: string; key: string; width?: number; }
function getColumns(value: unknown): Column[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!isRecord(item)) return [];
    const header = getString(item.header);
    const key = getString(item.key);
    const width = getNumber(item.width, Number.NaN);
    return header && key ? [{ header, key, width: Number.isFinite(width) ? width : undefined }] : [];
  });
}

function getRows(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

type DiagramDirection = "LR" | "RL" | "TB" | "BT";
interface DiagramNode { id: string; label: string; type?: string; color?: string; }
interface DiagramEdge { from: string; to: string; label?: string; style?: string; }
interface DiagramGroup { id: string; label: string; nodes: string[]; color?: string; }
interface DiagramColumn { lines: string[]; middleRows: Map<string, number>; }

function isDiagramElementType(value: string): boolean {
  return value === "ArchitectureDiagram" || value === "FlowDiagram" || value === "Diagram";
}

function getDiagramDirection(value: unknown): DiagramDirection {
  return value === "RL" || value === "TB" || value === "BT" ? value : "LR";
}

function getDiagramNodes(value: unknown): DiagramNode[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!isRecord(item)) return [];
    const id = getString(item.id);
    const label = getString(item.label, id);
    if (!id || !label) return [];
    return [{ id, label, type: getString(item.type) || undefined, color: getString(item.color) || undefined }];
  });
}

function getDiagramEdges(value: unknown): DiagramEdge[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!isRecord(item)) return [];
    const from = getString(item.from);
    const to = getString(item.to);
    if (!from || !to) return [];
    return [{ from, to, label: getString(item.label) || undefined, style: getString(item.style) || undefined }];
  });
}

function getDiagramGroups(value: unknown): DiagramGroup[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item, index) => {
    if (!isRecord(item)) return [];
    const id = getString(item.id, `group-${index + 1}`);
    const label = getString(item.label, id);
    const nodes = getStrings(item.nodes);
    if (!id || !label || nodes.length === 0) return [];
    return [{ id, label, nodes, color: getString(item.color) || undefined }];
  });
}

function getDiagramLevels(nodes: DiagramNode[], edges: DiagramEdge[]): string[][] {
  // Longest-path layering keeps dependent services to the right/bottom of their
  // sources. Cycles are tolerated by seeding a fallback node instead of failing.
  const nodeIds = new Set(nodes.map((node) => node.id));
  const validEdges = edges.filter((edge) => nodeIds.has(edge.from) && nodeIds.has(edge.to));
  const incoming = new Map(nodes.map((node) => [node.id, 0]));
  for (const edge of validEdges) incoming.set(edge.to, (incoming.get(edge.to) ?? 0) + 1);

  const levels = new Map<string, number>();
  for (const node of nodes) {
    if ((incoming.get(node.id) ?? 0) === 0) levels.set(node.id, 0);
  }
  if (levels.size === 0 && nodes[0]) levels.set(nodes[0].id, 0);

  for (let pass = 0; pass < nodes.length; pass++) {
    let changed = false;
    for (const edge of validEdges) {
      const fromLevel = levels.get(edge.from);
      if (fromLevel === undefined) continue;
      const nextLevel = fromLevel + 1;
      if ((levels.get(edge.to) ?? -1) < nextLevel) {
        levels.set(edge.to, nextLevel);
        changed = true;
      }
    }
    if (!changed) break;
  }

  const fallbackLevel = Math.max(0, ...Array.from(levels.values())) + 1;
  for (const node of nodes) {
    if (!levels.has(node.id)) levels.set(node.id, fallbackLevel);
  }

  const result: string[][] = [];
  for (const node of nodes) {
    const level = levels.get(node.id) ?? 0;
    result[level] = [...(result[level] ?? []), node.id];
  }
  return result.filter((level) => level.length > 0);
}

function centerDiagramColumn(column: DiagramColumn, height: number): DiagramColumn {
  // Columns can have different node counts. Vertical padding keeps branches
  // visually centered while preserving each node's connector row.
  const width = Math.max(1, ...column.lines.map((line) => visibleWidth(line)));
  const topPadding = Math.max(0, Math.floor((height - column.lines.length) / 2));
  const bottomPadding = Math.max(0, height - column.lines.length - topPadding);
  const middleRows = new Map<string, number>();
  for (const [nodeId, row] of column.middleRows) middleRows.set(nodeId, row + topPadding);
  return {
    lines: [
      ...Array.from({ length: topPadding }, () => " ".repeat(width)),
      ...column.lines.map((line) => padLine(line, width)),
      ...Array.from({ length: bottomPadding }, () => " ".repeat(width)),
    ],
    middleRows,
  };
}

function findDiagramEdgeAtRow(row: number, leftIds: string[], rightIds: string[], targetRows: ReadonlyMap<string, number>, edges: DiagramEdge[], direction: "LR" | "RL"): DiagramEdge | undefined {
  // Draw one connector per target row; this avoids stacked overlapping arrows
  // in dense fan-out columns and keeps the output readable.
  const targetId = Array.from(targetRows.entries()).find((entry) => entry[1] === row)?.[0];
  if (!targetId) return undefined;

  return direction === "RL"
    ? edges.find((edge) => rightIds.includes(edge.from) && leftIds.includes(edge.to) && edge.to === targetId)
    : edges.find((edge) => leftIds.includes(edge.from) && rightIds.includes(edge.to) && edge.to === targetId);
}

function renderDiagramConnector(edge: DiagramEdge, width: number, direction: DiagramDirection): string {
  // Reserve shaft characters around labels so a short gap still reads as an
  // arrow instead of a floating label plus arrowhead.
  const fill = edge.style === "dashed" ? "┄" : edge.style === "dotted" ? "┈" : "─";
  const arrow = direction === "RL" ? "◀" : "▶";
  if (width <= 1) return arrow;

  const shaftWidth = width - 1;
  const maxLabelWidth = Math.max(0, shaftWidth - 2);
  const label = edge.label && maxLabelWidth > 0 ? truncateToWidth(edge.label, maxLabelWidth, "") : "";
  const labelWidth = visibleWidth(label);
  const leftFill = labelWidth > 0 ? Math.max(1, Math.floor((shaftWidth - labelWidth) / 2)) : 0;
  const rightFill = Math.max(0, shaftWidth - labelWidth - leftFill);
  const shaft = labelWidth > 0
    ? `${fill.repeat(leftFill)}${label}${fill.repeat(rightFill)}`
    : fill.repeat(shaftWidth);
  return direction === "RL" ? `${arrow}${shaft}` : `${shaft}${arrow}`;
}

function getEdgesBetweenLevels(current: string[], next: string[], edges: DiagramEdge[], direction: DiagramDirection): DiagramEdge[] {
  return direction === "BT"
    ? edges.filter((edge) => next.includes(edge.from) && current.includes(edge.to))
    : edges.filter((edge) => current.includes(edge.from) && next.includes(edge.to));
}

function uniqueStrings(values: (string | undefined)[]): string[] {
  return [...new Set(values.filter((value): value is string => typeof value === "string" && value.length > 0))];
}

interface TimelineItem { title: string; description?: string; status?: string; }
function getTimelineItems(value: unknown): TimelineItem[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!isRecord(item)) return [];
    const title = getString(item.title);
    if (!title) return [];
    return [{ title, description: getString(item.description) || undefined, status: getString(item.status) || undefined }];
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
