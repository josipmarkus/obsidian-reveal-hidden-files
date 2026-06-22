# Contributing to Reveal Hidden Files

Thanks for your interest in improving Reveal Hidden Files, an Obsidian plugin that reveals dot-prefixed files and folders in the File Explorer panel, with a per-pattern deny list. This repository holds the plugin's public source and release builds.

## Prerequisites

- [Node.js](https://nodejs.org) 18 or newer
- npm (bundled with Node.js)

## Build from source

```bash
npm install
npm run build
```

`npm run build` type-checks the source and bundles it into `main.js`, the file Obsidian loads.

## Repository layout

- `src/main.ts` — the plugin source; all code changes go here.
- `main.js` — the generated bundle (produced by the build; do not edit by hand).
- `styles.css` — the plugin's styles.
- `manifest.json` — plugin metadata Obsidian reads (id, version, minimum app version).
- `versions.json` — maps each plugin version to the minimum Obsidian version it supports.

## Reporting bugs

Open an issue on the [issue tracker](https://github.com/josipmarkus/obsidian-reveal-hidden-files/issues). Include your Obsidian version, your operating system, and the steps to reproduce.

## Proposing changes

Open an issue to discuss the change first, then a pull request. This repository is published from an upstream development workspace, so accepted changes are integrated upstream and re-published here.

## License

Reveal Hidden Files is released under the MIT License. See [LICENSE](LICENSE).
