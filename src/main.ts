/**
 * Reveal Hidden Files — Obsidian plugin v0.3.7.
 *
 * Shows or hides dot-prefixed files and folders in Obsidian's File
 * Explorer panel. Per-pattern deny list (minimatch syntax) keeps
 * matching entries hidden even when the toggle is on. Default deny
 * patterns ship pre-populated for `.git/` and `.venv/` to prevent
 * freezes on vaults with real git repositories or Python virtual
 * environments.
 *
 * Architecture per the design doc in this plugin's design/ folder:
 *
 *   - Patch `adapter.reconcileDeletion` with an auto-surface wrapper.
 *     The wrapper tracks every hidden+existing path Obsidian's
 *     watcher reports in `hiddenPaths`. When the filter passes
 *     (toggle on AND not denied), the wrapper also calls
 *     `reconcileFileInternal` to surface the entry and adds it to
 *     `surfacedPaths`.
 *   - Two-pronged population at `onLayoutReady`:
 *       (a) `initialListRecursive()` calls `adapter.listRecursive("")`
 *           once. Obsidian's recursive walk covers the vault root and
 *           re-walks INTO dot-folders to find filtered children. The
 *           wrapper sees every reconcileDeletion call and populates
 *           the Set.
 *       (b) `walkNonHiddenForDots("/")` then walks every non-hidden
 *           folder via `adapter.list` and surfaces dot-children at
 *           any depth that listRecursive did not reach. Closes the
 *           depth-coverage gap that v0.3.0 left open for vaults with
 *           deeply-nested dot-folders such as `.cache/` or `.backups/`
 *           inside non-hidden parents.
 *   - On toggle change, iterate `hiddenPaths` and apply the current
 *     filter to each path (surface non-denied, un-surface denied).
 *   - Force-removal fallback for vaults where `reconcileDeletion`
 *     returns successfully but leaves the entry in `vault.fileMap`
 *     (observed in large vaults; root cause unexplained).
 *   - One-time migration on plugin load seeds the default deny
 *     patterns and force-removes orphan entries from prior v0.2.x
 *     sessions that surfaced everything.
 *
 * The `reconcileDeletion`-interception pattern is adapted from
 * polyipseity/obsidian-show-hidden-files. The default deny patterns
 * and the freeze diagnosis are adopted from their GH#12 fix. The
 * `walkNonHiddenForDots` pass is new in v0.3.1 — polyipseity's plugin
 * does not have this pass, presumably because their user base does
 * not encounter deeply-nested dot-folders inside non-hidden parents.
 *
 * Desktop only — the patched adapter methods are Obsidian internals
 * that differ between desktop and mobile builds.
 */

import { App, Notice, Platform, Plugin, PluginSettingTab, Setting, TFile, TFolder } from "obsidian";
import { minimatch } from "minimatch";
import * as fs from "fs";

/**
 * Minimal typed surface for the one Node `fs` call this plugin makes
 * (`fs.promises.readdir` with `withFileTypes`). Declared locally so
 * type-checking does not depend on the Node type definitions
 * (`@types/node`) being present: the community-store code scanner
 * type-checks without them, which otherwise makes every `fs` access
 * resolve to `any` and cascade into unsafe-value warnings. This pins
 * concrete types at the call site; behavior is unchanged.
 */
interface FsDirEntry {
	name: string;
	isDirectory(): boolean;
}
const fsPromises = (fs as unknown as {
	promises: {
		readdir(path: string, options: { withFileTypes: true }): Promise<FsDirEntry[]>;
	};
}).promises;

/** Settings persisted per vault via Obsidian's loadData / saveData APIs. */
interface RevealHiddenFilesSettings {
	/** When true, non-denied dotfile entries are surfaced in the File Explorer. */
	showHidden: boolean;
	/**
	 * Glob patterns (minimatch syntax) that keep matching entries
	 * hidden even when `showHidden` is true. Patterns match against
	 * each entry's full vault-relative path.
	 */
	denyPatterns: string[];
	/**
	 * True after the one-time migration that seeds
	 * `DEFAULT_DENY_PATTERNS` into `denyPatterns` has run for this
	 * vault. Prevents the migration from re-running if the user later
	 * removes any of the defaults.
	 */
	denyPatternsInitialized?: boolean;
}

/**
 * Patterns seeded on first plugin load so heavy folders never surface
 * by default. `.git/` in any real git repository contains thousands of
 * object files (one per content snapshot) that block the renderer when
 * surfaced en masse. `.venv/` is the conventional Python virtual
 * environment directory and carries similar volume. The user can
 * remove any of these patterns through the settings panel; the
 * migration only runs once per vault.
 */
const DEFAULT_DENY_PATTERNS = [
	".git",
	".venv",
];

const DEFAULT_SETTINGS: RevealHiddenFilesSettings = {
	showHidden: false,
	denyPatterns: [...DEFAULT_DENY_PATTERNS],
	denyPatternsInitialized: true,
};

/**
 * Internal Obsidian adapter methods this plugin depends on. None are
 * in the published `obsidian.d.ts`. They are stable on desktop
 * Obsidian and are the same surface the
 * polyipseity/obsidian-show-hidden-files community plugin uses.
 */
interface AdapterInternals {
	/** Convert vault-relative path to its case-corrected internal form. */
	getRealPath: (normalizedPath: string) => string;
	/** Convert vault-relative path to absolute filesystem path. */
	getFullPath: (normalizedPath: string) => string;
	/**
	 * Check whether the path exists on disk. The leading underscore
	 * marks the method as private; calling the public `exists` instead
	 * creates an await loop because that path goes through the patched
	 * `reconcileDeletion`.
	 */
	_exists: (fullPath: string, normalizedPath: string) => Promise<boolean>;
	/**
	 * Add a file or folder to the vault tree regardless of the dotfile
	 * filter. The plugin calls this from the patch wrapper when the
	 * filter passes for a hidden path.
	 */
	reconcileFileInternal: (realPath: string, normalizedPath: string) => Promise<void>;
	/**
	 * Remove an entry from the vault tree. Obsidian's watcher calls
	 * this for every dotfile it discovers; the patch wrapper
	 * intercepts those calls.
	 */
	reconcileDeletion: (realPath: string, normalizedPath: string) => Promise<void>;
	/**
	 * Trigger a recursive scan of the vault. Called once at
	 * `onLayoutReady` so the patch wrapper sees every existing dotfile
	 * and populates `hiddenPaths`.
	 */
	listRecursive: (normalizedPath: string) => Promise<void>;
}

/**
 * Minimal monkey-patch helper. Wraps `obj[methodName]` with the
 * function returned by `makeWrapper`. Returns a restore function that
 * puts the original method back when called. Same shape as the popular
 * `monkey-around` library; kept inline to avoid an extra dependency.
 */
function around<T extends object>(
	obj: T,
	methodName: keyof T,
	makeWrapper: (next: T[keyof T]) => T[keyof T],
): () => void {
	const original = obj[methodName];
	if (typeof original !== "function") return () => undefined;
	obj[methodName] = makeWrapper(original);
	return () => {
		obj[methodName] = original;
	};
}

/**
 * Returns true if any segment of the path begins with a period. Treats
 * `.` and `..` as not hidden so the function does not false-positive
 * on relative path references.
 */
function isHiddenPath(path: string): boolean {
	return path.split("/").some((seg) => seg.startsWith(".") && seg !== "." && seg !== "..");
}

/**
 * Returns the vault tree's view of `path`: "folder" / "file" / "null" /
 * "other". `hideAll` calls it before and after `reconcileDeletion` to
 * decide whether the force-removal fallback is needed.
 */
function vaultKind(app: App, path: string): string {
	const f = app.vault.getAbstractFileByPath(path);
	if (f === null) return "null";
	if (f instanceof TFolder) return "folder";
	if (f instanceof TFile) return "file";
	return "other";
}

/**
 * Force-remove an entry from Obsidian's vault tree and the File
 * Explorer view. Fallback path for the v0.2.x-observed "reconcileDeletion
 * no-op at scale" symptom: in some vaults the standard
 * `adapter.reconcileDeletion` returns successfully but leaves the
 * entry in `vault.fileMap` and in the view's `fileItems` map. Root
 * cause unexplained as of v0.3.0; mitigated by this helper.
 *
 * Steps:
 *   1. Splice the entry from its parent folder's `children` array.
 *   2. Delete the path from `vault.fileMap`.
 *   3. Detach the File Explorer view's `FileItem.el` from the DOM and
 *      remove the path from `view.fileItems`.
 *
 * Touches private Obsidian internals (`vault.fileMap`,
 * `view.fileItems`, `FileItem.el`). Stable in practice across
 * supported Obsidian versions; not part of the public plugin API.
 */
function forceRemove(app: App, path: string): void {
	const file = app.vault.getAbstractFileByPath(path);
	if (file === null) return;

	const parent = file.parent;
	if (parent && Array.isArray(parent.children)) {
		const idx = parent.children.indexOf(file);
		if (idx >= 0) parent.children.splice(idx, 1);
	}

	const vaultAny = app.vault as unknown as { fileMap?: Record<string, unknown> };
	if (vaultAny.fileMap && path in vaultAny.fileMap) {
		delete vaultAny.fileMap[path];
	}

	const explorerLeaf = app.workspace.getLeavesOfType("file-explorer")[0];
	if (explorerLeaf) {
		const view = explorerLeaf.view as unknown as {
			fileItems?: Record<string, { el?: HTMLElement }>;
		};
		if (view.fileItems && path in view.fileItems) {
			const item = view.fileItems[path];
			if (item?.el && typeof item.el.remove === "function") {
				item.el.remove();
			}
			delete view.fileItems[path];
		}
	}
}

export default class RevealHiddenFilesPlugin extends Plugin {
	settings: RevealHiddenFilesSettings = DEFAULT_SETTINGS;
	/**
	 * Every hidden+existing path the wrapper has seen, regardless of
	 * filter state. Populated by the patch wrapper and the initial
	 * `listRecursive`. Iterated on toggle change to apply the current
	 * filter to each path.
	 */
	private hiddenPaths: Set<string> = new Set();
	/**
	 * Subset of `hiddenPaths` that are currently surfaced in the File
	 * Explorer. Iterated by `hideAll` so we only un-surface what we
	 * actually surfaced; spares the per-path `_exists` cost on
	 * thousands of denied paths that are tracked but never surfaced.
	 */
	private surfacedPaths: Set<string> = new Set();
	private unpatch: (() => void) | null = null;
	private toggling = false;

	// "Go to settings" button injected on the Hotkeys tab — see setupHotkeysBackButton.
	private hotkeysBackBodyObserver: MutationObserver | null = null;
	private hotkeysBackTabObserver: MutationObserver | null = null;
	private hotkeysBackWatchedModal: HTMLElement | null = null;
	private hotkeysBackReevalQueued = false;

	async onload() {
		await this.loadSettings();

		this.addCommand({
			id: "toggle-hidden-files",
			name: "Toggle hidden files visibility",
			callback: () => void this.toggleVisibility(),
		});

		this.addRibbonIcon(
			"eye-off",
			"Toggle hidden files visibility",
			() => void this.toggleVisibility(),
		);

		this.addSettingTab(new RevealHiddenFilesSettingTab(this.app, this));
		this.setupHotkeysBackButton();

		this.installAdapterPatch();

		this.app.workspace.onLayoutReady(async () => {
			this.cleanupDeniedEntries();
			await this.initialListRecursive();
			await this.walkNonHiddenForDots("/");
			// Intentionally skip applyVisibility here: the patch wrapper
			// (during listRecursive) and walkNonHiddenForDots have already
			// applied settings.showHidden to every tracked path. Calling
			// applyVisibility now would hideAll-then-showAll the same
			// entries, which is wasted work and risks a visible flicker.
			// applyVisibility runs only on toggle / deny-pattern change.
		});
	}

	onunload() {
		void this.cleanup();
	}

	/**
	 * Set this plugin's recommended shortcut (⌥H for "Toggle hidden files
	 * visibility") in one click. Replaces only this plugin's own shortcut; other
	 * plugins and core hotkeys are untouched. The command ships with no shortcut.
	 */
	applyRecommendedHotkeys(): void {
		try {
			const hk = (this.app as unknown as {
				hotkeyManager?: {
					setHotkeys?: (id: string, h: unknown[]) => void;
					customKeys?: Record<string, unknown[]>;
					bake?: () => void;
					save?: () => void;
				};
			}).hotkeyManager;
			if (!hk) throw new Error("no hotkey manager");
			const scheme: Record<string, { modifiers: string[]; key: string }> = {
				"toggle-hidden-files": { modifiers: ["Alt"], key: "H" },
			};
			let applied = 0;
			for (const cmd of Object.keys(scheme)) {
				const chord = scheme[cmd];
				const id = `${this.manifest.id}:${cmd}`;
				if (typeof hk.setHotkeys === "function") hk.setHotkeys(id, [chord]);
				else if (hk.customKeys) hk.customKeys[id] = [chord];
				else throw new Error("unsupported hotkey manager");
				applied++;
			}
			hk.bake?.();
			hk.save?.();
			new Notice(`Reveal Hidden Files: applied ${applied} recommended shortcut.`);
		} catch {
			new Notice(
				'Couldn’t set the shortcut automatically. Open Settings → Hotkeys, search "Reveal Hidden Files," and set ⌥H by hand.',
			);
		}
	}

	/**
	 * Clear every Reveal Hidden Files shortcut, back to the shipped no-shortcut
	 * default — the exact inverse of applyRecommendedHotkeys. Touches only this
	 * plugin's own commands; other plugins and core hotkeys are untouched.
	 */
	resetHotkeys(): void {
		try {
			const hk = (this.app as unknown as {
				hotkeyManager?: {
					setHotkeys?: (id: string, h: unknown[]) => void;
					removeHotkeys?: (id: string) => void;
					customKeys?: Record<string, unknown[]>;
					bake?: () => void;
					save?: () => void;
				};
			}).hotkeyManager;
			if (!hk) throw new Error("no hotkey manager");
			const prefix = `${this.manifest.id}:`;
			const all = (this.app as unknown as {
				commands?: { commands?: Record<string, unknown> };
			}).commands?.commands ?? {};
			const ids = Object.keys(all).filter((id) => id.startsWith(prefix));
			let cleared = 0;
			for (const id of ids) {
				if (typeof hk.removeHotkeys === "function") hk.removeHotkeys(id);
				else if (typeof hk.setHotkeys === "function") hk.setHotkeys(id, []);
				else if (hk.customKeys) delete hk.customKeys[id];
				else throw new Error("unsupported hotkey manager");
				cleared++;
			}
			hk.bake?.();
			hk.save?.();
			new Notice(`Reveal Hidden Files: cleared ${cleared} shortcut.`);
		} catch {
			new Notice(
				'Couldn’t clear the shortcut automatically. Open Settings → Hotkeys, search "Reveal Hidden Files," and clear it by hand.',
			);
		}
	}

	/**
	 * Open Obsidian's Hotkeys settings tab, pre-filtered to this plugin's
	 * commands. The "Go to Reveal Hidden Files settings" button on that tab is
	 * injected by setupHotkeysBackButton, which keeps it in sync however you reach
	 * the tab.
	 */
	openHotkeysTab(): void {
		const setting = (this.app as unknown as {
			setting?: {
				open?: () => void;
				openTabById?: (id: string) => unknown;
				activeTab?: { setQuery?: (q: string) => void };
			};
		}).setting;
		if (!setting?.openTabById) return;
		setting.open?.();
		setting.openTabById("hotkeys");
		// Filter to this plugin once the tab has rendered; the watcher injects the button.
		window.setTimeout(() => setting?.activeTab?.setQuery?.(this.manifest.name), 0);
	}

	/**
	 * Make "Go to Reveal Hidden Files settings" appear on Obsidian's Hotkeys tab
	 * whenever it is filtered to this plugin's commands — no matter how you get
	 * there (this plugin's "Open Hotkeys" button, the settings sidebar, or
	 * Obsidian's per-plugin hotkey shortcut). A cheap always-on watcher notices
	 * the Settings window opening; a scoped watcher then keeps the button in sync
	 * while Settings is open. Both are idempotent and debounced, and do no work
	 * while you are editing.
	 */
	private setupHotkeysBackButton(): void {
		const syncModal = (): void => {
			const modal = activeDocument.querySelector<HTMLElement>(".mod-settings");
			if (modal && modal !== this.hotkeysBackWatchedModal) {
				this.detachHotkeysTabObserver();
				this.attachHotkeysTabObserver(modal);
			} else if (!modal && this.hotkeysBackWatchedModal) {
				this.detachHotkeysTabObserver();
			}
		};
		this.hotkeysBackBodyObserver = new MutationObserver(syncModal);
		this.hotkeysBackBodyObserver.observe(activeDocument.body, { childList: true });
		syncModal(); // catch a Settings window that is already open
		this.register(() => {
			this.hotkeysBackBodyObserver?.disconnect();
			this.hotkeysBackBodyObserver = null;
			this.detachHotkeysTabObserver();
		});
	}

	private attachHotkeysTabObserver(modal: HTMLElement): void {
		this.hotkeysBackWatchedModal = modal;
		const reeval = (): void => {
			this.hotkeysBackReevalQueued = false;
			this.syncHotkeysBackButton(modal);
		};
		const schedule = (): void => {
			if (this.hotkeysBackReevalQueued) return;
			this.hotkeysBackReevalQueued = true;
			window.setTimeout(reeval, 100); // debounce re-renders (tab switch, typing)
		};
		this.hotkeysBackTabObserver = new MutationObserver(schedule);
		this.hotkeysBackTabObserver.observe(modal, { childList: true, subtree: true });
		reeval();
	}

	private detachHotkeysTabObserver(): void {
		this.hotkeysBackTabObserver?.disconnect();
		this.hotkeysBackTabObserver = null;
		if (this.hotkeysBackWatchedModal) {
			this.removeHotkeysBackButton(this.hotkeysBackWatchedModal);
		}
		this.hotkeysBackWatchedModal = null;
	}

	/**
	 * Show the button only when the Hotkeys tab is active, a search filter is in
	 * effect, and at least one visible command row belongs to this plugin;
	 * otherwise remove it. Idempotent — safe to run on every (debounced) mutation.
	 */
	private syncHotkeysBackButton(modal: HTMLElement): void {
		const setting = (this.app as unknown as {
			setting?: { activeTab?: { id?: string } };
		}).setting;
		const content = modal.querySelector<HTMLElement>(".vertical-tab-content");
		if (!content || setting?.activeTab?.id !== "hotkeys") {
			this.removeHotkeysBackButton(modal);
			return;
		}
		const search = content.querySelector<HTMLInputElement>("input");
		if (!search || search.value.trim() === "") {
			this.removeHotkeysBackButton(modal); // no filter → don't clutter the full list
			return;
		}
		const prefix = `${this.manifest.name}:`;
		const ours = Array.from(content.querySelectorAll(".setting-item-name")).some(
			(el) => (el.textContent ?? "").startsWith(prefix),
		);
		if (!ours) {
			this.removeHotkeysBackButton(modal);
			return;
		}
		this.ensureHotkeysBackButton(content);
	}

	private ensureHotkeysBackButton(content: HTMLElement): void {
		if (content.querySelector(".rhf-hotkeys-back")) return; // already present
		const setting = (this.app as unknown as {
			setting?: { openTabById?: (id: string) => unknown };
		}).setting;
		const bar = content.createDiv({ cls: "rhf-hotkeys-back" });
		bar
			.createEl("button", { text: `Go to ${this.manifest.name} settings` })
			.addEventListener("click", () => setting?.openTabById?.(this.manifest.id));
		content.prepend(bar);
	}

	private removeHotkeysBackButton(root: HTMLElement): void {
		root.querySelectorAll(".rhf-hotkeys-back").forEach((el) => el.remove());
	}

	private async cleanup() {
		await this.hideAll();
		this.hiddenPaths.clear();
		this.surfacedPaths.clear();
		if (this.unpatch) {
			this.unpatch();
			this.unpatch = null;
		}
	}

	/**
	 * Auto-surface wrapper:
	 *   1. Non-hidden paths fall through immediately.
	 *   2. Denied paths (deny-list match) fall through immediately, BEFORE the
	 *      filesystem stat below — they are never surfaced, so stat-ing them is
	 *      pure waste. This is the hot path: heavy `.git/` churn (a git commit,
	 *      checkout, or status) makes Obsidian's watcher fire reconcileDeletion
	 *      for thousands of entries, and a per-call `_exists` stat floods Node's
	 *      libuv thread pool — a multi-core CPU spike. Skipping denied paths here
	 *      keeps that churn off the filesystem entirely.
	 *   3. Remaining hidden paths get an `_exists` check. If the file is gone from
	 *      disk, drop from `hiddenPaths` / `surfacedPaths` and fall through.
	 *   4. Hidden+existing paths are added to `hiddenPaths`; if the toggle is on,
	 *      `reconcileFileInternal` surfaces them and adds to `surfacedPaths`.
	 *   5. Otherwise fall through to the original `reconcileDeletion`.
	 */
	private installAdapterPatch() {
		const adapter = this.app.vault.adapter as unknown as AdapterInternals;

		this.unpatch = around(
			adapter as unknown as Record<string, unknown>,
			"reconcileDeletion",
			(next) => {
				const original = next as (rp: string, p: string) => Promise<void>;
				// `.call` returns `any` without strictBindCallApply, so funnel the
				// original invocation through one typed helper to keep the wrapper
				// returns type-safe.
				const callOriginal = (rp: string, p: string): Promise<void> =>
					original.call(adapter, rp, p) as Promise<void>;
				const wrapped = async (realPath: string, path: string): Promise<void> => {
					if (!isHiddenPath(path)) {
						return callOriginal(realPath, path);
					}
					// Denied paths are never surfaced — short-circuit BEFORE the fs stat
					// so heavy .git/ churn never hits the filesystem (the multi-core spike).
					if (this.isDenied(path)) {
						return callOriginal(realPath, path);
					}
					try {
						const exists = await adapter._exists(adapter.getFullPath(path), path);
						if (!exists) {
							this.hiddenPaths.delete(path);
							this.surfacedPaths.delete(path);
							return callOriginal(realPath, path);
						}
						this.hiddenPaths.add(path);
						if (this.settings.showHidden) {
							await adapter.reconcileFileInternal(realPath, path);
							this.surfacedPaths.add(path);
							return;
						}
					} catch {
						// Ignore wrapper errors; fall through to the original.
					}
					return callOriginal(realPath, path);
				};
				return wrapped;
			},
		);
	}

	async toggleVisibility() {
		if (this.toggling) return;
		this.toggling = true;
		try {
			this.settings.showHidden = !this.settings.showHidden;
			await this.saveSettings();
			await this.applyVisibility();
			new Notice(
				`Hidden files: ${this.settings.showHidden ? "visible" : "hidden"}`,
			);
		} finally {
			this.toggling = false;
		}
	}

	/**
	 * Apply the current filter to the currently-tracked paths. Called
	 * from `toggleVisibility` (on toggle change) and from the settings
	 * panel (on deny-pattern edit). The implementation hides everything
	 * surfaced first, then surfaces non-denied tracked paths if the
	 * toggle is on. The hide-then-show pattern is simpler than per-path
	 * diffing and the cost is bounded by `surfacedPaths` (small) and
	 * `hiddenPaths` (a `.git/`-denied default keeps this in the
	 * hundreds even on big repositories).
	 *
	 * Per the v0.3.0 design doc the plugin does NOT touch Obsidian's
	 * `showUnsupportedFiles` setting. Users who want unrecognized-
	 * extension files (`.log`, `.env`, `.gitkeep`, extension-less
	 * files) to appear enable that setting separately through
	 * Settings → Files & Links.
	 */
	async applyVisibility() {
		await this.hideAll();
		if (this.settings.showHidden) {
			await this.showAll();
		}
	}

	/**
	 * Gitignore-style deny matching per requirements v0.3.0 FR3:
	 *   - Patterns without a `/` match the basename at any depth
	 *     (e.g., `.DS_Store` matches `.DS_Store`, `notes/.DS_Store`,
	 *     `notes/archive/.DS_Store`). The natural mental model users
	 *     bring from `.gitignore`, `.dockerignore`, `.npmignore`.
	 *   - Patterns with a `/` use minimatch full-path globbing
	 *     (e.g., `.git/**` matches everything inside any root `.git/`,
	 *     and a pattern targeting a specific path under `.obsidian/`
	 *     plugin folders works per its own path).
	 * Both forms coexist in a single deny list.
	 */
	private isDenied(path: string): boolean {
		if (this.settings.denyPatterns.length === 0) return false;
		const basename = path.split("/").pop() ?? "";
		return this.settings.denyPatterns.some((pattern) => {
			try {
				if (!pattern.includes("/")) {
					return minimatch(basename, pattern);
				}
				return minimatch(path, pattern);
			} catch {
				return false;
			}
		});
	}

	/**
	 * Surface every tracked hidden+existing path the current filter
	 * allows. Iterates `hiddenPaths` (which may be large) but the
	 * per-path work is cheap: an `isDenied` minimatch check (typically
	 * under 10 microseconds per pattern) and, for non-denied paths
	 * only, a single `reconcileFileInternal` call.
	 */
	private async showAll() {
		const adapter = this.app.vault.adapter as unknown as AdapterInternals;
		const paths = Array.from(this.hiddenPaths);
		for (const path of paths) {
			if (this.isDenied(path)) continue;
			try {
				const realPath = adapter.getRealPath(path);
				await adapter.reconcileFileInternal(realPath, path);
				this.surfacedPaths.add(path);
			} catch {
				// Skip paths that fail to surface; continue with the rest.
			}
		}
	}

	/**
	 * Un-surface every currently-surfaced path. Iterates
	 * `surfacedPaths` (small — bounded by what the filter has actually
	 * exposed, not by total dotfile count). Tries `reconcileDeletion`
	 * first; if the entry remains in `vault.fileMap` after the call,
	 * applies the force-removal fallback.
	 */
	private async hideAll() {
		const adapter = this.app.vault.adapter as unknown as AdapterInternals;
		const paths = Array.from(this.surfacedPaths);
		for (const path of paths) {
			try {
				const before = vaultKind(this.app, path);
				await adapter.reconcileDeletion(adapter.getRealPath(path), path);
				const after = vaultKind(this.app, path);
				if (after !== "null" && before !== "null") {
					forceRemove(this.app, path);
				}
				this.surfacedPaths.delete(path);
			} catch {
				// Skip paths that fail to un-surface; continue with the rest.
			}
		}
	}

	/**
	 * Initial `listRecursive("")` at `onLayoutReady`. Obsidian's recursive
	 * walk fires `reconcileDeletion` for every dotfile it discovers at the
	 * vault root AND inside dot-folders (Obsidian re-walks the filtered
	 * portions of the tree). The patch wrapper sees each call and
	 * populates `hiddenPaths`. Denied paths are tracked but not surfaced;
	 * their cost on the walk is the wrapper's fast-path overhead only
	 * (isHiddenPath check + isDenied minimatch + fall-through).
	 *
	 * This pass does NOT find dot-children at depth inside non-hidden
	 * parents. `walkNonHiddenForDots` runs alongside this pass to cover
	 * that case.
	 */
	private async initialListRecursive() {
		const adapter = this.app.vault.adapter as unknown as AdapterInternals;
		try {
			await adapter.listRecursive("");
		} catch {
			// Ignore a failed recursive scan; the walk pass still runs.
		}
	}

	/**
	 * Depth-first walk through every non-hidden folder via `adapter.list`,
	 * finding hidden children at any depth that `listRecursive("")` missed.
	 *
	 * Why this exists: Obsidian's `listRecursive("")` walks the vault root
	 * and recurses INTO dot-folders to find their filtered children, but
	 * it does not re-walk non-hidden parents (those are already in
	 * Obsidian's vault tree from its normal scan, with dotfiles filtered
	 * out at any depth). Some vaults have dot-folders such as `.cache/`
	 * or `.backups/` nested several levels inside non-hidden parents
	 * (`projects/app/.cache/`, `notes/archive/.backups/`).
	 * `listRecursive("")` does not find them; this method does.
	 *
	 * Behavior:
	 *   - For each hidden child found, if not denied AND not already
	 *     tracked, add to `hiddenPaths` and surface via
	 *     `reconcileFileInternal`. If the toggle is on, also add to
	 *     `surfacedPaths`.
	 *   - Recurse into non-hidden subfolders, skipping any folder that
	 *     matches a deny pattern (so a user-added deny for a non-hidden
	 *     folder short-circuits walks under it).
	 *   - Yield to the event loop every 50 subfolders processed so the
	 *     renderer stays responsive in vaults with many non-hidden
	 *     subfolders.
	 *
	 * The check is idempotent on re-entry: `hiddenPaths.has(path)`
	 * prevents double-surfacing entries already populated by
	 * `listRecursive("")`.
	 */
	private async walkNonHiddenForDots(parentPath: string): Promise<void> {
		const adapter = this.app.vault.adapter as unknown as AdapterInternals;
		// v0.3.3: use Node's fs.readdir directly instead of adapter.list.
		// `adapter.list` applies Obsidian's dotfile filter and silently
		// omits hidden entries from the returned listing, which made
		// v0.3.2's walk never surface deep `.cache/`, `.backups/` etc.
		// fs.readdir returns every entry on disk regardless
		// of name.
		const fullParent = adapter.getFullPath(parentPath === "/" ? "" : parentPath);
		let entries: FsDirEntry[];
		try {
			entries = await fsPromises.readdir(fullParent, { withFileTypes: true });
		} catch {
			return;
		}
		// Process hidden children of this folder (the entries
		// `adapter.list` would have filtered out).
		for (const entry of entries) {
			const name = entry.name;
			if (!name.startsWith(".") || name === "." || name === "..") continue;
			const childPath = parentPath === "/" ? name : `${parentPath}/${name}`;
			if (this.isDenied(childPath)) continue;
			if (this.hiddenPaths.has(childPath)) continue;
			this.hiddenPaths.add(childPath);
			// Surface only when the filter passes. With showHidden
			// false, populate hiddenPaths but leave the vault tree
			// alone — a later toggle-on iterates hiddenPaths and
			// surfaces non-denied paths then.
			if (this.settings.showHidden) {
				try {
					const realPath = adapter.getRealPath(childPath);
					await adapter.reconcileFileInternal(realPath, childPath);
					this.surfacedPaths.add(childPath);
				} catch {
					// Skip children that fail to surface; continue.
				}
			}
		}
		// Recurse into non-hidden, non-denied subfolders, yielding to the
		// event loop every 50 to keep the renderer responsive.
		let processed = 0;
		for (const entry of entries) {
			if (!entry.isDirectory()) continue;
			if (entry.name.startsWith(".")) continue;
			const folderPath = parentPath === "/" ? entry.name : `${parentPath}/${entry.name}`;
			if (this.isDenied(folderPath)) continue;
			await this.walkNonHiddenForDots(folderPath);
			if (++processed % 50 === 0) {
				await new Promise((r) => window.setTimeout(r, 0));
			}
		}
	}

	/**
	 * Force-remove every vault-tree entry currently matching a deny
	 * pattern. Runs once per plugin load, after settings are loaded
	 * and before the initial `listRecursive`. Cleans up "orphan"
	 * entries that earlier plugin versions (v0.2.5 and prior) had
	 * surfaced into the vault tree but that the v0.3.0 defaults would
	 * have denied.
	 */
	private cleanupDeniedEntries() {
		if (this.settings.denyPatterns.length === 0) return;
		const vaultAny = this.app.vault as unknown as { fileMap?: Record<string, unknown> };
		const fileMap = vaultAny.fileMap ?? {};
		const denied = Object.keys(fileMap).filter((path) => this.isDenied(path));
		if (denied.length === 0) return;
		for (const path of denied) {
			forceRemove(this.app, path);
			this.hiddenPaths.delete(path);
			this.surfacedPaths.delete(path);
		}
	}

	async loadSettings() {
		const loaded = (await this.loadData()) as
			| Partial<RevealHiddenFilesSettings>
			| null;
		this.settings = Object.assign({}, DEFAULT_SETTINGS, loaded ?? {});
		// One-time migration: seed DEFAULT_DENY_PATTERNS for vaults
		// configured before defaults existed (denyPatternsInitialized
		// missing). Idempotent — flag prevents re-seeding if the user
		// later removes any default.
		if (loaded?.denyPatternsInitialized !== true) {
			for (const pattern of DEFAULT_DENY_PATTERNS) {
				if (!this.settings.denyPatterns.includes(pattern)) {
					this.settings.denyPatterns.push(pattern);
				}
			}
			this.settings.denyPatternsInitialized = true;
			await this.saveSettings();
		}
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}
}

class RevealHiddenFilesSettingTab extends PluginSettingTab {
	plugin: RevealHiddenFilesPlugin;

	constructor(app: App, plugin: RevealHiddenFilesPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		new Setting(containerEl)
			.setName("Show hidden files")
			.setDesc(
				"Show files and folders whose names start with a period in the file explorer panel. Entries matching any deny pattern below stay hidden even when this is on.",
			)
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.showHidden)
					.onChange(async (value) => {
						if (value === this.plugin.settings.showHidden) return;
						this.plugin.settings.showHidden = value;
						await this.plugin.saveSettings();
						await this.plugin.applyVisibility();
					}),
			);

		new Setting(containerEl)
			.setName("Deny patterns")
			.setDesc(
				"Glob patterns (minimatch syntax) that keep matching entries hidden even when the toggle is on. One pattern per line. Patterns match against the full vault-relative path. The defaults exclude .git and .venv (their internal storage holds thousands of files that block the renderer when surfaced). Remove those patterns if you want either folder visible. Examples: .git/** matches everything inside .git; **/.DS_Store matches every .DS_Store at any depth.",
			);

		const textareaRow = containerEl.createDiv({ cls: "reveal-hidden-files-deny-row" });
		const textarea = textareaRow.createEl("textarea", {
			cls: "reveal-hidden-files-deny-textarea",
		});
		textarea.value = this.plugin.settings.denyPatterns.join("\n");
		textarea.placeholder = ".git\n.git/**\n.venv\n.venv/**\n**/.DS_Store";
		textarea.rows = 8;
		textarea.addEventListener("input", () => {
			void (async () => {
				this.plugin.settings.denyPatterns = textarea.value
					.split("\n")
					.map((p) => p.trim())
					.filter((p) => p.length > 0);
				await this.plugin.saveSettings();
				if (this.plugin.settings.showHidden) {
					await this.plugin.applyVisibility();
				}
			})();
		});

		new Setting(containerEl)
			.setName("Files with unrecognized extensions")
			.setDesc(
				"This plugin handles dotfile visibility only. To also show files with unrecognized extensions (.log, .env, .gitkeep, extension-less files), enable Obsidian's \"detect all file extensions\" setting under settings → files & links. This plugin does not toggle that setting.",
			);

		containerEl.createEl("hr", { cls: "rhf-settings-divider" });
		new Setting(containerEl)
			.setName("Hotkey scheme")
			.setDesc(
				"The command ships with no shortcut — an unvetted guess clashes with Obsidian's own keys too easily. Apply All sets the recommended shortcut (shown below); Remove All clears it; Open Hotkeys lets you bind it yourself.",
			)
			.setHeading();
		new Setting(containerEl)
			.setName("Apply recommended shortcut")
			.setDesc(
				"Set the recommended shortcut in one click. Replaces only Reveal Hidden Files' own shortcut; other plugins are untouched.",
			)
			.addButton((b) =>
				b
					.setButtonText("Apply All")
					.setCta()
					.onClick(() => this.plugin.applyRecommendedHotkeys()),
			);
		new Setting(containerEl)
			.setName("Remove all Reveal Hidden Files shortcuts")
			.setDesc(
				"Clear every Reveal Hidden Files shortcut, back to the shipped no-shortcut default. The exact inverse of Apply All — other plugins are untouched.",
			)
			.addButton((b) =>
				b
					.setButtonText("Remove All")
					.setDestructive()
					.onClick(() => this.plugin.resetHotkeys()),
			);
		new Setting(containerEl)
			.setName("Open Hotkeys settings")
			.setDesc("Jump to Obsidian's Hotkeys tab, filtered to Reveal Hidden Files, to view or change the shortcut.")
			.addButton((b) =>
				b.setButtonText("Open Hotkeys").onClick(() => this.plugin.openHotkeysTab()),
			);
		const opt = Platform.isMacOS ? "⌥" : "Alt";
		const grid = containerEl.createDiv({ cls: "rhf-keymap" });
		const row = (chord: string, what: string): void => {
			const r = grid.createDiv({ cls: "rhf-keymap-row" });
			r.createSpan({ cls: "rhf-keymap-chord", text: chord });
			r.createSpan({ cls: "rhf-keymap-what", text: what });
		};
		row(`${opt} H`, "Toggle hidden files visibility");
	}
}
