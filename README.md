# Reveal Hidden Files

An Obsidian desktop plugin that surfaces dot-prefixed files and folders in the File Explorer panel, with a per-pattern deny list for entries you want to keep hidden.

The plugin ships with default deny patterns for `.git/` and `.venv/` so vaults with real git repositories or Python virtual environments do not freeze on toggle. Other dot-prefixed entries (`.obsidian/`, `.env/`, `.trash/`, `.DS_Store`) appear when the toggle is on by default. Remove the defaults under *Settings → Community plugins → Reveal Hidden Files → Deny patterns* if you want `.git/` or `.venv/` visible; add new patterns there for any other dotfile content you want kept hidden.

## Installation

**From Obsidian:** In Settings → Community plugins → Browse, search for "Reveal Hidden Files", then install and enable it.

**From GitHub:** Download `main.js`, `manifest.json`, and `styles.css` from the [latest release](https://github.com/josipmarkus/obsidian-reveal-hidden-files/releases) into `YourVault/.obsidian/plugins/reveal-hidden-files/`, then enable the plugin in Settings → Community plugins.

## Usage

1. Enable **Reveal Hidden Files** in Settings → Community plugins.
2. Toggle visibility through any of the following affordances. All four invoke the same toggle state:
   - The eye-off ribbon icon in Obsidian's left ribbon
   - The command palette command *Toggle hidden files visibility*
   - An optional keyboard shortcut you bind under *Settings → Hotkeys*
   - The toggle control inside the plugin's settings panel
3. Optional: edit deny patterns under *Settings → Community plugins → Reveal Hidden Files → Deny patterns*. The defaults (`.git`, `.venv`) keep heavy folders hidden even when the toggle is on; add your own to keep additional entries hidden, or remove either default to surface that folder. Patterns use **gitignore-style semantics**: a pattern without a forward slash matches the basename at any depth (e.g., `.DS_Store` matches `.DS_Store` everywhere it appears in the vault; `node_modules` matches every `node_modules` folder; `.audit` matches every `.audit` folder). A pattern containing a forward slash matches the full vault-relative path via minimatch glob syntax (e.g., `.git/**` matches everything inside any root `.git/`; `.obsidian/plugins/*/data.json` matches that specific path; `**/.DS_Store` is equivalent to bare `.DS_Store` under the basename rule but more explicit).
4. Optional: enable *Settings → Files & Links → Detect all file extensions* in Obsidian if you want files with unrecognized extensions (such as `.aeml`, `.env`, or extension-less files) to also appear in the File Explorer. This plugin handles dotfile visibility only; the extension setting is a separate Obsidian preference the plugin does not modify.

## Behavior

- Reveals any vault-relative path whose name begins with `.`, at any depth — except entries matching a deny pattern
- Works for root-level and nested hidden paths, including deep dot-folders inside non-hidden parents (`system/writing/guides/.../.audit/`, `knowledge/glossary/.versions/`, etc.)
- Deny patterns use gitignore-style basename matching for bare names; full-path minimatch for patterns with `/`
- Toggle state and deny patterns persist per vault across Obsidian restarts
- Default deny patterns for `.git` and `.venv` are seeded on first plugin load; remove them in settings if you want those folders visible
- Serializes rapid toggle clicks so an in-flight toggle is not interrupted
- Does not rename, delete, or modify vault files on disk
- Does not modify Obsidian's "Detect all file extensions" setting; that remains under your control
- Restores Obsidian's default File Explorer behavior when the plugin is disabled or uninstalled

## Affordances

| Affordance | Always available | Configurable |
|---|---|---|
| Ribbon icon | Yes | Hide via Obsidian's *Appearance* settings |
| Command palette command | Yes | Searchable as "Toggle hidden files visibility" |
| Keyboard shortcut | No (unbound by default) | Bind under *Settings → Hotkeys* |
| Settings-panel toggle | Yes | — |

## Compatibility

Desktop only. The plugin depends on Obsidian's local filesystem adapter and several undocumented internal methods (`reconcileDeletion`, `reconcileFileInternal`, `getRealPath`, `_exists`, `listRecursive`). These are stable in practice but could change in a future Obsidian release, in which case the plugin may need an update.

## Security and privacy

- Uses Node.js filesystem APIs to read the current vault
- Uses undocumented Obsidian internals to register hidden paths in the File Explorer
- Reveals hidden files that may contain secrets, credentials, or configuration; review your deny patterns before sharing screenshots of your vault
- Does not use telemetry
- Does not make network requests
- Does not require an account or external service
- Does not include ads or paid features

## Development

Build from source:

```bash
npm install      # install dependencies
npm run build    # production bundle (writes main.js)
npm run dev      # watch build for iterating against a side-loaded vault
```

`main.js` is generated and is not committed to the repository.

## Credits

The `reconcileDeletion` interception pattern is adapted from [polyipseity/obsidian-show-hidden-files](https://github.com/polyipseity/obsidian-show-hidden-files), the community plugin that first solved this problem.

## License

MIT — see [LICENSE](LICENSE). You are free to use, modify, and redistribute it.
