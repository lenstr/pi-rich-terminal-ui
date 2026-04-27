# pi-rich-terminal-ui

Pi extension that adds a `render_rich_ui` tool for rendering rich terminal UI specs: charts, dashboards, tables, metrics, architecture diagrams, and other visual displays.

## Features

- Line, bar, XY charts, and sparklines
- Tables, cards, metrics, progress bars, status lines, and callouts
- Architecture and flow diagrams
- Custom TUI rendering inside pi
- Supports `<json-render>...</json-render>` blocks from assistant output

## Install

Latest branch, updateable with `pi update`:

```bash
pi install git:github.com/lenstr/pi-rich-terminal-ui
```

Pinned release:

```bash
pi install git:github.com/lenstr/pi-rich-terminal-ui@v1.0.0
```

## Usage

Ask pi to render a chart, dashboard, table, metric view, or diagram. The extension registers the `render_rich_ui` tool.

## Development

```bash
npm install
npm run typecheck
pi -e ./extensions/rich-terminal-ui.ts
```

## License

MIT
