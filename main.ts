import {
	AbstractInputSuggest,
	App,
	Notice,
	Plugin,
	PluginSettingTab,
	Setting,
	TFile,
	TFolder,
	Vault,
	normalizePath,
} from "obsidian";

interface WeeklyFileManagerSettings {
	rootFolder: string;
	subfolderTemplate: string;
	sectionSeparator: string;
	createIndexNotes: boolean;
}

const DEFAULT_SETTINGS: WeeklyFileManagerSettings = {
	rootFolder: "",
	subfolderTemplate: "{{year}}/{{month_folder}}",
	sectionSeparator: "---",
	createIndexNotes: true,
};

const MONTH_NAMES = [
	"January", "February", "March", "April", "May", "June",
	"July", "August", "September", "October", "November", "December",
];

const DATE_RANGE_RE = /(\d{4}-\d{2}-\d{2})\s*-\s*(\d{4}-\d{2}-\d{2})/;

function parseISODate(s: string): Date {
	const [y, m, d] = s.split("-").map(Number);
	return new Date(y, m - 1, d);
}

function formatISODate(d: Date): string {
	const y = d.getFullYear();
	const m = String(d.getMonth() + 1).padStart(2, "0");
	const day = String(d.getDate()).padStart(2, "0");
	return `${y}-${m}-${day}`;
}

function stripMdExtension(path: string): string {
	return path.endsWith(".md") ? path.slice(0, -3) : path;
}

function basenameOf(path: string): string {
	const withoutExt = stripMdExtension(path);
	const lastSlash = withoutExt.lastIndexOf("/");
	return lastSlash === -1 ? withoutExt : withoutExt.slice(lastSlash + 1);
}

function addDays(d: Date, days: number): Date {
	const copy = new Date(d);
	copy.setDate(copy.getDate() + days);
	return copy;
}

interface ParsedWeekFile {
	start: Date;
	end: Date;
}

function parseWeekFilename(basename: string): ParsedWeekFile | null {
	const match = DATE_RANGE_RE.exec(basename);
	if (!match) return null;
	return { start: parseISODate(match[1]), end: parseISODate(match[2]) };
}

/**
 * Renders a subfolder template like "{{year}}/{{month_folder}}" against a
 * date, so the folder layout under the root isn't tied to any one
 * structure. Supported placeholders:
 *   {{year}}         -> 2026
 *   {{month}}        -> September
 *   {{month_num}}    -> 09
 *   {{month_folder}} -> 09_September
 * An empty (or empty-after-trimming) template means "no subfolders".
 */
function renderSubfolderTemplate(template: string, date: Date): string {
	const monthNum = String(date.getMonth() + 1).padStart(2, "0");
	const monthName = MONTH_NAMES[date.getMonth()];

	const rendered = template
		.replace(/{{\s*year\s*}}/gi, String(date.getFullYear()))
		.replace(/{{\s*month_folder\s*}}/gi, `${monthNum}_${monthName}`)
		.replace(/{{\s*month_num\s*}}/gi, monthNum)
		.replace(/{{\s*month\s*}}/gi, monthName);

	return rendered
		.split("/")
		.map((segment) => segment.trim())
		.filter((segment) => segment.length > 0)
		.join("/");
}

/**
 * Splits note content into a leading frontmatter block (if any) and a list
 * of todo sections separated by lines that are exactly the separator.
 */
function splitIntoSections(content: string, separator: string): { frontmatter: string; sections: string[] } {
	let body = content;
	let frontmatter = "";

	if (body.startsWith("---")) {
		const fmEnd = body.indexOf("\n---", 3);
		if (fmEnd !== -1) {
			const afterFm = body.indexOf("\n", fmEnd + 1);
			const end = afterFm === -1 ? body.length : afterFm + 1;
			frontmatter = body.slice(0, end);
			body = body.slice(end);
		}
	}

	const lines = body.split("\n");
	const sections: string[] = [];
	let current: string[] = [];

	for (const line of lines) {
		if (line.trim() === separator) {
			sections.push(current.join("\n"));
			current = [];
		} else {
			current.push(line);
		}
	}
	sections.push(current.join("\n"));

	return { frontmatter, sections };
}

/**
 * A section still needs attention if it has at least one list item that
 * isn't checked off, either an open checkbox `- [ ]` (at any indentation)
 * or a plain bullet with no checkbox at all, since those carry no
 * completion state.
 */
function sectionHasUnfinishedTodo(section: string): boolean {
	const lines = section.split("\n");
	for (const line of lines) {
		const checkboxMatch = /^\s*-\s*\[( |x|X)\]/.exec(line);
		if (checkboxMatch) {
			if (checkboxMatch[1] === " ") return true;
			continue;
		}
		const plainBulletMatch = /^\s*-\s+\S/.exec(line);
		if (plainBulletMatch) return true;
	}
	return false;
}

export default class WeeklyFileManagerPlugin extends Plugin {
	settings: WeeklyFileManagerSettings;

	async onload() {
		await this.loadSettings();

		this.addRibbonIcon("calendar-plus", "Roll over to next week", () => {
			this.rollOverActiveFile();
		});

		this.addCommand({
			id: "roll-over-week",
			name: "Roll over to next week",
			checkCallback: (checking: boolean) => {
				const file = this.app.workspace.getActiveFile();
				const parsed = file ? parseWeekFilename(file.basename) : null;
				if (!file || !parsed) return false;
				if (!checking) {
					this.rollOverFile(file, parsed);
				}
				return true;
			},
		});

		this.addSettingTab(new WeeklyFileManagerSettingTab(this.app, this));
	}

	rollOverActiveFile() {
		const file = this.app.workspace.getActiveFile();
		if (!file) {
			new Notice("No active file to roll over.");
			return;
		}
		const parsed = parseWeekFilename(file.basename);
		if (!parsed) {
			new Notice(`"${file.basename}" doesn't look like a weekly file (expected a "YYYY-MM-DD - YYYY-MM-DD" name).`);
			return;
		}
		this.rollOverFile(file, parsed);
	}

	async rollOverFile(file: TFile, parsed: ParsedWeekFile) {
		if (!this.settings.rootFolder.trim()) {
			new Notice("Set a root folder for Weekly File Manager in the plugin settings first.");
			return;
		}

		const content = await this.app.vault.read(file);
		const { sections } = splitIntoSections(content, this.settings.sectionSeparator);

		const unfinishedSections = sections
			.map((s) => s.trim())
			.filter((s) => s.length > 0 && sectionHasUnfinishedTodo(s));

		const newStart = addDays(parsed.start, 7);
		const newEnd = addDays(parsed.end, 7);
		const subfolder = renderSubfolderTemplate(this.settings.subfolderTemplate, newStart);
		const folderPath = normalizePath(
			subfolder ? `${this.settings.rootFolder}/${subfolder}` : this.settings.rootFolder
		);
		const fileName = `${formatISODate(newStart)} - ${formatISODate(newEnd)}.md`;
		const filePath = normalizePath(`${folderPath}/${fileName}`);

		const existing = this.app.vault.getAbstractFileByPath(filePath);
		if (existing instanceof TFile) {
			new Notice(`${fileName} already exists. Opening it.`);
			await this.app.workspace.getLeaf(false).openFile(existing);
			return;
		}

		const indexNotePath = await this.ensureFolderAndIndexNotes(folderPath);

		const linkLine = indexNotePath
			? `[[${stripMdExtension(indexNotePath)}|${basenameOf(indexNotePath)}]]\n\n`
			: "";
		const sectionsContent = unfinishedSections
			.map((s) => `${s}\n${this.settings.sectionSeparator}`)
			.join("\n") + (unfinishedSections.length > 0 ? "\n" : "");
		const newContent = linkLine + sectionsContent;

		const newFile = await this.app.vault.create(filePath, newContent);
		await this.app.workspace.getLeaf(false).openFile(newFile);

		if (indexNotePath) {
			await this.appendLinkEntry(indexNotePath, filePath, basenameOf(filePath));
		}

		new Notice(
			unfinishedSections.length > 0
				? `Created ${fileName} with ${unfinishedSections.length} carried-over section(s).`
				: `Created ${fileName}. Everything last week was finished, so it starts empty.`
		);
	}

	/**
	 * Ensures every folder segment of `folderPath` exists and, when index
	 * notes are enabled, that each subfolder segment below the root has an
	 * index note (e.g. "ACEO/2026/09_September/09_September.md") linking up
	 * to its parent segment's index note. This is what lets the graph view
	 * show weekly notes connected to their month, and months connected to
	 * their year, without depending on folder location (which the graph
	 * ignores). The root folder itself is created but never gets an index
	 * note. Returns the deepest segment's index note path, or null if there
	 * were no subfolder segments or index notes are disabled.
	 */
	async ensureFolderAndIndexNotes(folderPath: string): Promise<string | null> {
		const rootSegmentCount = this.settings.rootFolder.split("/").filter((s) => s.length > 0).length;
		const segments = folderPath.split("/").filter((s) => s.length > 0);
		let current = "";
		let parentIndexNotePath: string | null = null;

		for (let i = 0; i < segments.length; i++) {
			const segment = segments[i];
			current = current ? `${current}/${segment}` : segment;
			if (!this.app.vault.getAbstractFileByPath(current)) {
				try {
					await this.app.vault.createFolder(current);
				} catch (e) {
					// Someone else (or Obsidian's own cache lagging behind
					// disk) may have already created this folder between our
					// check and this call; only re-throw if it's genuine.
					if (!this.app.vault.getAbstractFileByPath(current)) throw e;
				}
			}

			const isRootSegment = i < rootSegmentCount;
			if (!this.settings.createIndexNotes || isRootSegment) continue;

			const indexNotePath = normalizePath(`${current}/${segment}.md`);
			if (!this.app.vault.getAbstractFileByPath(indexNotePath)) {
				const linkLine = parentIndexNotePath
					? `[[${stripMdExtension(parentIndexNotePath)}|${basenameOf(parentIndexNotePath)}]]\n`
					: "";
				await this.app.vault.create(indexNotePath, linkLine);

				if (parentIndexNotePath) {
					await this.appendLinkEntry(parentIndexNotePath, indexNotePath, segment);
				}
			}
			parentIndexNotePath = indexNotePath;
		}

		return parentIndexNotePath;
	}

	/**
	 * Appends a "- [[target|label]]" bullet to the given note, so index
	 * notes keep a visible, linked list of their children (a year note
	 * listing its months, a month note listing its weekly notes) in
	 * addition to each child linking back up to its parent.
	 */
	async appendLinkEntry(notePath: string, targetPath: string, label: string) {
		const note = this.app.vault.getAbstractFileByPath(notePath);
		if (!(note instanceof TFile)) return;
		await this.app.vault.append(note, `- [[${stripMdExtension(targetPath)}|${label}]]\n`);
	}

	onunload() {}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}
}

class FolderSuggest extends AbstractInputSuggest<TFolder> {
	getSuggestions(query: string): TFolder[] {
		const lowerQuery = query.toLowerCase();
		const folders: TFolder[] = [];
		Vault.recurseChildren(this.app.vault.getRoot(), (file) => {
			if (file instanceof TFolder && file.path.toLowerCase().contains(lowerQuery)) {
				folders.push(file);
			}
		});
		return folders;
	}

	renderSuggestion(folder: TFolder, el: HTMLElement): void {
		el.setText(folder.path);
	}
}

class WeeklyFileManagerSettingTab extends PluginSettingTab {
	plugin: WeeklyFileManagerPlugin;

	constructor(app: App, plugin: WeeklyFileManagerPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		new Setting(containerEl)
			.setName("Root folder")
			.setDesc("The vault folder everything lives under. Required. Start typing to search your existing folders.")
			.addText((text) => {
				text
					.setPlaceholder("e.g. ACEO")
					.setValue(this.plugin.settings.rootFolder)
					.onChange(async (value) => {
						this.plugin.settings.rootFolder = value.trim();
						await this.plugin.saveSettings();
					});

				new FolderSuggest(this.app, text.inputEl).onSelect(async (folder) => {
					text.setValue(folder.path);
					this.plugin.settings.rootFolder = folder.path;
					await this.plugin.saveSettings();
				});
			});

		new Setting(containerEl)
			.setName("Subfolder layout")
			.setDesc(
				"How new weekly notes are nested under the root folder. Use " +
				"{{year}}, {{month}} (September), {{month_num}} (09), and " +
				"{{month_folder}} (09_September) as placeholders, separated by " +
				"\"/\". Leave empty to put weekly notes directly in the root folder."
			)
			.addText((text) =>
				text
					.setPlaceholder("{{year}}/{{month_folder}}")
					.setValue(this.plugin.settings.subfolderTemplate)
					.onChange(async (value) => {
						this.plugin.settings.subfolderTemplate = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Section separator")
			.setDesc("The line used to separate todo sections in a weekly note.")
			.addText((text) =>
				text
					.setPlaceholder("---")
					.setValue(this.plugin.settings.sectionSeparator)
					.onChange(async (value) => {
						this.plugin.settings.sectionSeparator = value.trim() || DEFAULT_SETTINGS.sectionSeparator;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Link notes for the graph view")
			.setDesc(
				"Create a small index note per year/month folder (e.g. " +
				"\"09_September.md\") and link each new weekly note to its " +
				"month note, and each month note to its year note. This is " +
				"what makes the graph view show weekly notes connected to " +
				"their month, and months connected to their year."
			)
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.createIndexNotes)
					.onChange(async (value) => {
						this.plugin.settings.createIndexNotes = value;
						await this.plugin.saveSettings();
					})
			);
	}
}
