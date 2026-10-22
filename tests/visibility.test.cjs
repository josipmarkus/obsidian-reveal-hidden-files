const assert = require('node:assert/strict');
const { test } = require('node:test');
const { buildSync } = require('esbuild');
const vm = require('node:vm');

class TFile {
	constructor(path, parent) { this.path = path; this.parent = parent; this.extension = 'md'; }
}
class TFolder {
	constructor(path) { this.path = path; this.children = []; }
}
const obsidian = { TFile, TFolder, Plugin: class {}, PluginSettingTab: class {} };
const bundle = buildSync({ entryPoints: ['src/main.ts'], bundle: true, platform: 'node',
	format: 'cjs', external: ['obsidian'], write: false }).outputFiles[0].text;
const observers = [];
class MutationObserver {
	constructor(callback) { this.callback = callback; observers.push(this); }
	observe(container, options) { this.container = container; this.options = options; }
	disconnect() { this.disconnected = true; }
}
const moduleStub = { exports: {} };
vm.runInNewContext(bundle, { module: moduleStub, exports: moduleStub.exports,
	require: (name) => name === 'obsidian' ? obsidian : require(name), console, MutationObserver });
const Plugin = moduleStub.exports.default;

function fixture({ deletionNoop = false } = {}) {
	const parent = new TFolder('ebooks/node_modules');
	const denied = new TFile('ebooks/node_modules/README.md', parent);
	parent.children.push(denied);
	const hidden = new TFile('.notes.md', null);
	const fileMap = { [parent.path]: parent, [denied.path]: denied, [hidden.path]: hidden };
	// Model the resolver's cached paths: removing a vault entry without its
	// deletion event leaves a null file for iterateRefsForFile.
	const cachedPaths = new Set([denied.path, hidden.path]);
	const calls = [];
	const adapter = {
		getRealPath: (path) => path, getFullPath: (path) => path,
		_exists: async () => true,
		async reconcileFileInternal(realPath, path) { calls.push(['surface', path]); },
		async reconcileDeletion(realPath, path) {
			assert.equal(this, adapter);
			calls.push(['delete', path]);
			if (deletionNoop) return;
			delete fileMap[path];
			cachedPaths.delete(path);
		},
	};
	const plugin = new Plugin();
	plugin.app = { vault: { adapter, fileMap, getAbstractFileByPath: (path) => fileMap[path] ?? null },
		workspace: { getLeavesOfType: () => [] } };
	plugin.settings = { showHidden: true, denyPatterns: ['node_modules'] };
	const resolveLinks = () => {
		for (const path of cachedPaths) assert.ok(fileMap[path].extension);
	};
	return { plugin, parent, denied, hidden, fileMap, cachedPaths, calls, adapter, resolveLinks };
}

test('startup deny filtering leaves indexed files and parent children intact', () => {
	const f = fixture();
	f.plugin.refreshExplorerVisibility();
	assert.equal(f.fileMap[f.denied.path], f.denied);
	assert.deepEqual(f.parent.children, [f.denied]);
	f.resolveLinks();
});

test('hiding bypasses the auto-surface wrapper even while showHidden is true', async () => {
	const f = fixture();
	f.plugin.installAdapterPatch();
	f.plugin.surfacedPaths.add(f.hidden.path);
	await f.plugin.hideAll();
	assert.deepEqual(f.calls, [['delete', f.hidden.path]]);
	f.resolveLinks();
});

test('a reconciliation no-op never falls back to deleting cached vault entries', async () => {
	const f = fixture({ deletionNoop: true });
	f.plugin.settings.showHidden = false;
	f.plugin.installAdapterPatch();
	f.plugin.surfacedPaths.add(f.hidden.path);
	await f.plugin.hideAll();
	assert.equal(f.fileMap[f.hidden.path], f.hidden);
	assert.equal(f.plugin.surfacedPaths.has(f.hidden.path), true);
	f.resolveLinks();
});

// Minimal explorer DOM contract; the runtime plugin is bundled above unchanged.
function explorer(paths) {
	const titles = paths.map((path) => {
		const classes = new Set();
		const item = { classList: {
			toggle: (name, enabled) => enabled ? classes.add(name) : classes.delete(name),
			remove: (name) => classes.delete(name),
		}, classes };
		return { path, item, getAttribute() { return this.path; }, closest: () => item };
	});
	const containerEl = { querySelectorAll: (selector) => selector === '[data-path]' ? titles
		: titles.filter((title) => title.item.classes.has('rhf-denied')).map((title) => title.item) };
	return { view: { containerEl }, titles };
}

const isHidden = (title) => title.item.classes.has('rhf-denied');

test('deny visibility covers every explorer, rerenders, renames and pattern edits', async () => {
	const f = fixture();
	const first = explorer(['ebooks/node_modules/README.md', 'notes.md']);
	const second = explorer(['node_modules', '.allowed.md']);
	const leaves = [first, second];
	f.plugin.app.workspace.getLeavesOfType = () => leaves;
	f.plugin.refreshExplorerVisibility();
	assert.deepEqual(first.titles.map(isHidden), [true, false]);
	assert.deepEqual(second.titles.map(isHidden), [true, false]);
	const observer = observers.find((observer) => observer.container === first.view.containerEl);
	assert.deepEqual(Array.from(observer.options.attributeFilter), ['data-path']);
	first.titles[1].path = 'node_modules/new.md';
	observer.callback();
	assert.equal(isHidden(first.titles[1]), true);
	const third = explorer(['node_modules/added.md']);
	leaves.push(third);
	f.plugin.refreshExplorerVisibility();
	assert.equal(isHidden(third.titles[0]), true);
	f.plugin.settings.showHidden = false;
	f.plugin.settings.denyPatterns = [];
	await f.plugin.applyVisibility();
	assert.equal(isHidden(first.titles[0]), false);
	assert.equal(isHidden(third.titles[0]), false);
	assert.equal(f.fileMap[f.denied.path], f.denied);
	f.resolveLinks();
});

test('deny edits preserve hidden-file revealing and use core deletion events', async () => {
	const f = fixture();
	f.plugin.installAdapterPatch();
	await f.adapter.reconcileDeletion('.notes.md', '.notes.md');
	assert.deepEqual(f.calls, [['surface', '.notes.md']]);
	f.plugin.settings.denyPatterns.push('.notes.md');
	await f.plugin.applyVisibility();
	assert.deepEqual(f.calls, [['surface', '.notes.md'], ['delete', '.notes.md']]);
	f.resolveLinks();
});

test('denied watcher paths skip filesystem stat and never surface', async () => {
	const f = fixture();
	f.adapter._exists = async () => { assert.fail('denied path must skip stat'); };
	f.plugin.installAdapterPatch();
	await f.adapter.reconcileDeletion('node_modules/.cache/x.md', 'node_modules/.cache/x.md');
	assert.deepEqual(f.calls, [['delete', 'node_modules/.cache/x.md']]);
});

test('unload removes explorer filtering and restores the original adapter method', async () => {
	const f = fixture();
	const leaf = explorer(['node_modules/README.md']);
	f.plugin.app.workspace.getLeavesOfType = () => [leaf];
	const original = f.adapter.reconcileDeletion;
	f.plugin.installAdapterPatch();
	f.plugin.refreshExplorerVisibility();
	const observer = observers.find((observer) => observer.container === leaf.view.containerEl);
	f.plugin.surfacedPaths.add(f.hidden.path);
	await f.plugin.cleanup();
	assert.equal(isHidden(leaf.titles[0]), false);
	assert.equal(observer.disconnected, true);
	assert.equal(f.adapter.reconcileDeletion, original);
	assert.deepEqual(f.calls, [['delete', f.hidden.path]]);
	f.resolveLinks();
});

test('startup installs safe filtering before scans and repeated loads keep cache entries valid', async () => {
	const f = fixture();
	const leaf = explorer([f.denied.path]);
	f.plugin.app.workspace.getLeavesOfType = () => [leaf];
	for (let i = 0; i < 2; i++) {
		const plugin = i === 0 ? f.plugin : new Plugin();
		plugin.app = f.plugin.app;
		plugin.settings = f.plugin.settings;
		plugin.loadSettings = async () => {};
		plugin.addCommand = plugin.addRibbonIcon = plugin.addSettingTab = () => {};
		plugin.setupHotkeysBackButton = plugin.registerEvent = () => {};
		plugin.app.workspace.on = () => ({});
		let ready;
		plugin.app.workspace.onLayoutReady = (callback) => { ready = callback; };
		plugin.initialListRecursive = async () => {
			assert.equal(isHidden(leaf.titles[0]), true);
			assert.equal(f.fileMap[f.denied.path], f.denied);
			f.resolveLinks();
		};
		plugin.walkNonHiddenForDots = async () => {};
		await plugin.onload();
		await ready();
		await plugin.cleanup();
		await ready(); // A late layout callback after unload must not reapply filtering.
		assert.equal(isHidden(leaf.titles[0]), false);
		assert.equal(plugin.explorerObservers.size, 0);
		f.resolveLinks();
	}
});


test('closed explorer panes release observers and visibility classes', () => {
	const f = fixture();
	const leaf = explorer(['node_modules/README.md']);
	let leaves = [leaf];
	f.plugin.app.workspace.getLeavesOfType = () => leaves;
	f.plugin.refreshExplorerVisibility();
	const observer = observers.find((observer) => observer.container === leaf.view.containerEl);
	leaves = [];
	f.plugin.refreshExplorerVisibility();
	assert.equal(observer.disconnected, true);
	assert.equal(isHidden(leaf.titles[0]), false);
	assert.equal(f.plugin.explorerObservers.size, 0);
});
