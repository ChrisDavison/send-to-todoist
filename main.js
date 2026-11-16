const {
  ItemView,
  Modal,
  Notice,
  Platform,
  Plugin,
  PluginSettingTab,
  SecretComponent,
  Setting,
  debounce,
  requestUrl,
} = require("obsidian");

/*
 * Send to Todoist: move a task line into Todoist, one way
 *
 * A sent line becomes `[>]` with the marker tag and a link to the Todoist
 * task. Todoist owns the task from then on; nothing syncs back.
 *
 * The task text goes through Todoist's quick-add parser, so words such as
 * "tomorrow" or "p2" work. Tasks-plugin emojis are converted to the same
 * syntax first. The project, section and labels come from the marker
 * property of the note (or of the note its `project` property links to) and
 * are set by ID, because the parser only matches one-word project names.
 *
 * Open child tasks become subtasks. Other child lines go in the description.
 *
 * Plain JavaScript on purpose: no build step, no dependencies.
 */

const API = "https://api.todoist.com/api/v1";
const DOCTOR_VIEW = "send-to-todoist-doctor";
const PARENT_PROPERTY = "project";
const SIGIL = { project: "#", section: "/", label: "%" };

const DEFAULT_SETTINGS = {
  tokenSecret: "",
  markerTag: "todoist",
  markerProperty: "todoist",
  // null: use the name of the current vault. Empty: links carry no vault name.
  vault: null,
};

const LIST_ITEM = /^(\s*)([-*+]|\d+[.)])\s+(?:\[(.)\](?:\s+|$))?(.*)$/;
const WIKILINK = /!?\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g;
const TAG = /(^|\s)#([\p{L}\p{N}_/-]*[\p{L}_/-][\p{L}\p{N}_/-]*)/gu;
const SCHEDULED = /⏳️?\s*(\d{4}-\d{2}-\d{2})/u;
const DUE = /📅️?\s*(\d{4}-\d{2}-\d{2})/u;
const PRIORITY = /[🔺⏫🔼]/u;
const PRIORITIES = { "🔺": "p1", "⏫": "p2", "🔼": "p3" };
const TASK_FIELD = "(?:[⏳📅🛫➕✅❌]\\uFE0F?\\s*\\d{4}-\\d{2}-\\d{2}|[🔺⏫🔼🔽⏬]\\uFE0F?|\\^[A-Za-z0-9-]+$)";
const TASK_FIELDS = new RegExp(TASK_FIELD, "gu");
const TRAILING_TASK_FIELDS = new RegExp(`(?:\\s*${TASK_FIELD})+\\s*$`, "u");

// ---------------------------------------------------------------------------
// Lines
// ---------------------------------------------------------------------------

function parseListItem(line) {
  const match = line.match(LIST_ITEM);
  if (!match) return null;
  return { indent: match[1], marker: match[2], status: match[3], body: match[4] };
}

// A plain bullet, `[ ]` or `[/]`.
function isSendable(item) {
  return item.status === undefined || item.status === " " || item.status === "/";
}

function indentWidth(line) {
  return line.match(/^\s*/)[0].replace(/\t/g, "    ").length;
}

// The line after the last line indented deeper than `start`.
function blockEnd(lines, start) {
  const width = indentWidth(lines[start]);
  let end = start + 1;
  for (let index = start + 1; index < lines.length; index++) {
    if (lines[index].trim() === "") continue;
    if (indentWidth(lines[index]) <= width) break;
    end = index + 1;
  }
  return end;
}

function tagsIn(text) {
  return [...text.matchAll(TAG)].map((match) => match[2]);
}

function hasTag(text, tag) {
  return tagsIn(text).some((found) => found.toLowerCase() === tag.toLowerCase());
}

/*
 * The task at `start` with everything below it. Open child tasks become
 * subtasks at any depth. A closed child task is left out with its subtree.
 * Every other child line is a note of the nearest task above it.
 */
function buildTask(lines, start) {
  const root = { line: start, body: parseListItem(lines[start]).body, width: indentWidth(lines[start]), subtasks: [], notes: [], bullets: [] };
  const open = [root];
  let skipDeeperThan = null;
  for (let index = start + 1; index < blockEnd(lines, start); index++) {
    if (lines[index].trim() === "") continue;
    const width = indentWidth(lines[index]);
    if (skipDeeperThan !== null && width > skipDeeperThan) continue;
    skipDeeperThan = null;
    while (open[open.length - 1].width >= width) open.pop();
    const owner = open[open.length - 1];
    const item = parseListItem(lines[index]);
    if (item && item.status !== undefined) {
      if (!isSendable(item)) {
        skipDeeperThan = width;
        continue;
      }
      const task = { line: index, body: item.body, width, subtasks: [], notes: [], bullets: [] };
      owner.subtasks.push(task);
      open.push(task);
      continue;
    }
    while (owner.bullets.length && owner.bullets[owner.bullets.length - 1] >= width) owner.bullets.pop();
    const nesting = "  ".repeat(owner.bullets.length);
    if (item) {
      owner.notes.push(`${nesting}- ${item.body}`);
      owner.bullets.push(width);
    } else {
      owner.notes.push(`${nesting}${lines[index].trim()}`);
    }
  }
  return root;
}

// ---------------------------------------------------------------------------
// Text
// ---------------------------------------------------------------------------

function obsidianUri(vault, path, heading) {
  const file = encodeURIComponent(heading ? `${path}#${heading}` : path).replace(/[()]/g, (bracket) => (bracket === "(" ? "%28" : "%29"));
  return vault ? `obsidian://open?vault=${encodeURIComponent(vault)}&file=${file}` : `obsidian://open?file=${file}`;
}

// `uriFor(linkpath, heading)` gives the URI for a wikilink target.
function convertLinks(text, uriFor) {
  return text.replace(WIKILINK, (match, target, alias) => {
    const [linkpath, ...headings] = target.split("#");
    const heading = headings.join("#");
    const shown = alias ?? [linkpath, heading].filter(Boolean).join(" > ");
    return `[${shown.trim()}](${uriFor(linkpath.trim(), heading.trim())})`;
  });
}

/*
 * The text for Todoist's quick-add parser, and the Obsidian tags to set as
 * labels. Tags leave the text so the parser does not read them as projects.
 */
function convertTaskText(body, markerTag, uriFor) {
  const labels = [];
  let text = convertLinks(body, uriFor).replace(TAG, (match, space, tag) => {
    if (tag.toLowerCase() !== markerTag.toLowerCase()) labels.push(...tag.split("/").filter(Boolean));
    return space;
  });
  const scheduled = text.match(SCHEDULED)?.[1];
  const due = text.match(DUE)?.[1];
  const priority = PRIORITIES[text.match(PRIORITY)?.[0]];
  text = text.replace(TASK_FIELDS, "");
  const parts = [text, scheduled ?? due, scheduled && due ? `{${due}}` : null, priority];
  return { text: parts.filter(Boolean).join(" ").replace(/\s+/g, " ").trim(), labels };
}

// The sent line: `[>]`, then the marker tag and the task link before any Tasks fields.
function markSent(line, markerTag, url) {
  const item = parseListItem(line);
  const fields = item.body.match(TRAILING_TASK_FIELDS);
  const text = (fields ? item.body.slice(0, fields.index) : item.body).trimEnd();
  const tag = hasTag(text, markerTag) ? "" : ` #${markerTag}`;
  const tail = fields ? ` ${fields[0].trim()}` : "";
  return `${item.indent}${item.marker} [>] ${text}${tag} [↗](${url})${tail}`;
}

function markRefiled(line) {
  const item = parseListItem(line);
  return `${item.indent}${item.marker} [>] ${item.body}`;
}

// ---------------------------------------------------------------------------
// Targets
// ---------------------------------------------------------------------------

// `#project /section %label`. Names can have spaces. `@label` also works.
function parseTargetSpec(spec) {
  const target = { project: null, section: null, labels: [], errors: [] };
  for (const token of spec.trim().split(/\s+(?=[#/%@])/)) {
    const name = token.slice(1).trim();
    if (!name) continue;
    if (token[0] === "#" && target.project) target.errors.push("More than one project.");
    else if (token[0] === "#") target.project = name;
    else if (token[0] === "/" && target.section) target.errors.push("More than one section.");
    else if (token[0] === "/") target.section = name;
    else if (token[0] === "%" || token[0] === "@") target.labels.push(name);
    else target.errors.push(`“${token}” has no #, / or % before it.`);
  }
  if (target.section && !target.project) target.errors.push("A section needs a project.");
  return target;
}

function formatTargetSpec(target) {
  return [
    target.project && `#${target.project}`,
    target.section && `/${target.section}`,
    ...target.labels.map((label) => `%${label}`),
  ].filter(Boolean).join(" ");
}

// Lower case, without the emoji some names start with ("❌ blocked").
function plainName(name) {
  return name.replace(/^[^\p{L}\p{N}]+/u, "").trim().toLowerCase();
}

function findByName(items, name) {
  const wanted = name.trim().toLowerCase();
  return items.find((item) => item.name.toLowerCase() === wanted) ?? items.find((item) => plainName(item.name) === plainName(name));
}

function editDistance(left, right) {
  let row = Array.from({ length: right.length + 1 }, (unused, index) => index);
  for (let i = 1; i <= left.length; i++) {
    const next = [i];
    for (let j = 1; j <= right.length; j++) {
      next[j] = Math.min(next[j - 1] + 1, row[j] + 1, row[j - 1] + (left[i - 1] === right[j - 1] ? 0 : 1));
    }
    row = next;
  }
  return row[right.length];
}

// The item whose name is one or two typing errors away.
function nearestName(items, name) {
  const wanted = plainName(name);
  const near = items
    .map((item) => ({ item, distance: editDistance(plainName(item.name), wanted) }))
    .filter((candidate) => candidate.distance <= 2 && candidate.distance < wanted.length / 2)
    .sort((left, right) => left.distance - right.distance)[0];
  return near?.item;
}

function resolveTarget(target, catalog) {
  const missing = [];
  const project = target.project ? findByName(catalog.projects, target.project) : null;
  if (target.project && !project) missing.push({ kind: "project", name: target.project });
  let section = null;
  if (target.section) {
    section = project ? findByName(catalog.sections.filter((candidate) => candidate.project_id === project.id), target.section) : null;
    if (!section) missing.push({ kind: "section", name: target.section, project: target.project });
  }
  const labels = [];
  for (const name of new Set(target.labels)) {
    const label = findByName(catalog.labels, name);
    if (label) labels.push(label.name);
    else missing.push({ kind: "label", name });
  }
  return { project: project ?? null, section: section ?? null, labels, missing };
}

function uniqueMissing(missing) {
  const seen = new Set();
  return missing.filter((item) => {
    const key = [item.kind, item.project ?? "", item.name].join("\n").toLowerCase();
    return !seen.has(key) && seen.add(key);
  });
}

function describeMissing(item) {
  return item.kind === "section" ? `section in #${item.project}` : item.kind;
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

class SendToTodoistPlugin extends Plugin {
  async onload() {
    this.settings = { ...DEFAULT_SETTINGS, ...(await this.loadData()) };
    this.catalog = null;
    this.addSettingTab(new SendToTodoistSettingTab(this.app, this));
    this.registerView(DOCTOR_VIEW, (leaf) => new DoctorView(leaf, this));

    this.addCommand({
      id: "send",
      name: "Send task",
      icon: "send",
      editorCallback: (editor, view) => this.sendSelection(editor, view.file),
    });
    this.addCommand({
      id: "send-tagged",
      name: "Send tagged tasks in this note",
      icon: "send",
      editorCallback: (editor, view) => this.sendTagged(editor, view.file),
    });
    this.addCommand({
      id: "doctor",
      name: "Open doctor",
      icon: "stethoscope",
      callback: () => this.openDoctor(),
    });
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  // ---- Todoist ----

  async api(method, path, body) {
    const token = this.settings.tokenSecret && (await this.app.secretStorage.getSecret(this.settings.tokenSecret));
    if (!token) throw new Error("Add a Todoist API token in the Send to Todoist settings.");
    const response = await requestUrl({
      url: `${API}/${path}`,
      method,
      headers: { Authorization: `Bearer ${token}` },
      contentType: "application/json",
      body: body && JSON.stringify(body),
      throw: false,
    });
    if (response.status >= 400) {
      throw Object.assign(new Error(`Todoist ${response.status}: ${response.text.slice(0, 200)}`), { status: response.status });
    }
    return response.json;
  }

  // Todoist sometimes answers 404 for a task it made a moment ago, and asks for a later try.
  async changeNewTask(path, body) {
    try {
      return await this.api("POST", path, body);
    } catch (error) {
      if (error.status !== 404) throw error;
      await sleep(4000);
      return this.api("POST", path, body);
    }
  }

  async listAll(path) {
    const results = [];
    let cursor = null;
    do {
      const page = await this.api("GET", `${path}?limit=200${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
      results.push(...page.results);
      cursor = page.next_cursor;
    } while (cursor);
    return results;
  }

  async loadCatalog(reload) {
    if (!this.catalog || reload) {
      const [projects, sections, labels] = await Promise.all([this.listAll("projects"), this.listAll("sections"), this.listAll("labels")]);
      this.catalog = { projects, sections, labels };
    }
    return this.catalog;
  }

  // Projects first: a new section needs its project.
  async createMissing(missing) {
    const catalog = await this.loadCatalog();
    for (const kind of ["project", "section", "label"]) {
      for (const item of missing.filter((candidate) => candidate.kind === kind)) {
        if (kind === "project") catalog.projects.push(await this.api("POST", "projects", { name: item.name }));
        if (kind === "label") catalog.labels.push(await this.api("POST", "labels", { name: item.name }));
        if (kind === "section") {
          const project = findByName(catalog.projects, item.project);
          catalog.sections.push(await this.api("POST", "sections", { name: item.name, project_id: project.id }));
        }
      }
    }
  }

  // ---- Notes ----

  linkVault() {
    return this.settings.vault ?? this.app.vault.getName();
  }

  uriFor(file) {
    return (linkpath, heading) => {
      const destination = linkpath ? this.app.metadataCache.getFirstLinkpathDest(linkpath, file.path) : file;
      const path = destination ? destination.path.replace(/\.md$/, "") : linkpath;
      return obsidianUri(this.linkVault(), path, heading);
    };
  }

  // The note that carries the marker property: this note, or the first one up its `project` links.
  targetHolder(file) {
    const seen = new Set();
    while (file && !seen.has(file.path)) {
      seen.add(file.path);
      const frontmatter = this.app.metadataCache.getFileCache(file)?.frontmatter ?? {};
      if (this.settings.markerProperty in frontmatter) return { file, spec: frontmatter[this.settings.markerProperty] };
      const parent = frontmatter[PARENT_PROPERTY];
      const linkpath = typeof parent === "string" ? parent.match(/\[\[([^\]|#]+)/)?.[1] : null;
      file = linkpath ? this.app.metadataCache.getFirstLinkpathDest(linkpath.trim(), file.path) : null;
    }
    return null;
  }

  // ---- Send ----

  sendSelection(editor, file) {
    const lines = editor.getValue().split("\n");
    const selected = new Set();
    for (const selection of editor.listSelections()) {
      const first = Math.min(selection.anchor.line, selection.head.line);
      const last = Math.max(selection.anchor.line, selection.head.line);
      for (let line = first; line <= last; line++) selected.add(line);
    }
    const starts = this.rootLines(lines, (line, item) => selected.has(line));
    if (!starts.length) return new Notice("No open task or list item here.");
    return this.send(editor, file, lines, starts);
  }

  sendTagged(editor, file) {
    const lines = editor.getValue().split("\n");
    const starts = this.rootLines(lines, (line, item) => hasTag(item.body, this.settings.markerTag));
    if (!starts.length) return new Notice(`No open task with #${this.settings.markerTag} in this note.`);
    return this.send(editor, file, lines, starts);
  }

  // Sendable lines that pass `wanted` and are not below another one of them.
  rootLines(lines, wanted) {
    const starts = [];
    let covered = 0;
    lines.forEach((line, index) => {
      const item = index >= covered && parseListItem(line);
      if (!item || !isSendable(item) || !wanted(index, item)) return;
      starts.push(index);
      covered = blockEnd(lines, index);
    });
    return starts;
  }

  async send(editor, file, lines, starts) {
    const edits = [];
    try {
      const holder = this.targetHolder(file);
      if (holder && (typeof holder.spec !== "string" || !holder.spec.trim())) {
        throw new Error(`The ${this.settings.markerProperty} property of “${holder.file.basename}” is empty.`);
      }
      const target = holder ? parseTargetSpec(holder.spec) : parseTargetSpec("");
      if (target.errors.length) throw new Error(`${holder.file.basename}: ${target.errors[0]}`);

      const tasks = starts.map((start) => buildTask(lines, start));
      const tagLabels = [];
      const convert = (task) => {
        Object.assign(task, convertTaskText(task.body, this.settings.markerTag, this.uriFor(file)));
        task.notes = task.notes.map((note) => convertLinks(note, this.uriFor(file)));
        tagLabels.push(...task.labels);
        task.subtasks.forEach(convert);
      };
      tasks.forEach(convert);

      const wanted = { ...target, labels: [...target.labels, ...tagLabels] };
      let catalog = await this.loadCatalog();
      let resolved = resolveTarget(wanted, catalog);
      if (resolved.missing.length) {
        catalog = await this.loadCatalog(true);
        resolved = resolveTarget(wanted, catalog);
      }
      if (resolved.missing.length) {
        if (!(await new CreateModal(this.app, resolved.missing).ask())) return;
        await this.createMissing(resolved.missing);
        resolved = resolveTarget(wanted, catalog);
      }

      const destination = resolved.section ? { section_id: resolved.section.id } : resolved.project ? { project_id: resolved.project.id } : null;
      const headings = this.app.metadataCache.getFileCache(file)?.headings ?? [];
      for (const task of tasks) {
        const heading = headings.filter((candidate) => candidate.position.start.line < task.line).pop()?.heading;
        const shown = [file.basename, heading].filter(Boolean).join(" > ");
        const link = `[${shown}](${obsidianUri(this.linkVault(), file.path.replace(/\.md$/, ""), heading)})`;
        await this.createTask(task, destination, [link, ...task.notes], target.labels, lines, edits);
      }
    } catch (error) {
      new Notice(error.message, 10000);
    } finally {
      this.applyEdits(editor, edits);
      if (edits.length) new Notice(`Sent ${edits.length} ${edits.length === 1 ? "task" : "tasks"} to Todoist.`);
    }
  }

  async createTask(task, destination, descriptionLines, targetLabels, lines, edits) {
    const created = await this.api("POST", "tasks/quick", { text: task.text });
    const url = `https://app.todoist.com/app/task/${created.id}`;
    const original = lines[task.line];
    edits.push({
      line: task.line,
      original,
      replacement: destination?.parent_id ? markRefiled(original) : markSent(original, this.settings.markerTag, url),
    });

    const labels = resolveTarget({ labels: [...targetLabels, ...task.labels] }, this.catalog).labels;
    const changes = {};
    if (descriptionLines.length) changes.description = descriptionLines.join("\n");
    if (labels.length) changes.labels = [...new Set([...created.labels, ...labels])];
    await Promise.all([
      destination && this.changeNewTask(`tasks/${created.id}/move`, destination),
      Object.keys(changes).length && this.changeNewTask(`tasks/${created.id}`, changes),
    ]);
    for (const subtask of task.subtasks) {
      await this.createTask(subtask, { parent_id: created.id }, subtask.notes, targetLabels, lines, edits);
    }
  }

  // The note can change while requests run, so find each line again by its text.
  applyEdits(editor, edits) {
    for (const edit of edits) {
      let line = edit.line;
      if (editor.getLine(line) !== edit.original) line = editor.getValue().split("\n").indexOf(edit.original);
      if (line >= 0) editor.setLine(line, edit.replacement);
    }
  }

  async openDoctor() {
    const existing = this.app.workspace.getLeavesOfType(DOCTOR_VIEW)[0];
    const leaf = existing ?? this.app.workspace.getLeaf("tab");
    if (!existing) await leaf.setViewState({ type: DOCTOR_VIEW, active: true });
    this.app.workspace.revealLeaf(leaf);
  }
}

// ---------------------------------------------------------------------------
// Create popup
// ---------------------------------------------------------------------------

class CreateModal extends Modal {
  constructor(app, missing) {
    super(app);
    this.missing = missing;
    this.accepted = false;
  }

  ask() {
    return new Promise((resolve) => {
      this.resolve = resolve;
      this.open();
    });
  }

  onOpen() {
    this.setTitle("Create in Todoist?");
    const list = this.contentEl.createDiv({ cls: "stt-missing" });
    for (const item of this.missing) {
      const row = list.createDiv({ cls: "stt-missing-row" });
      row.createEl("code", { text: `${SIGIL[item.kind]}${item.name}` });
      row.createSpan({ cls: "stt-faint", text: describeMissing(item) });
    }
    const buttons = this.contentEl.createDiv({ cls: "stt-even" });
    const create = buttons.createEl("button", { cls: "mod-cta", text: "Create and send" });
    create.addEventListener("click", () => {
      this.accepted = true;
      this.close();
    });
    buttons.createEl("button", { text: "Cancel" }).addEventListener("click", () => this.close());
  }

  onClose() {
    this.contentEl.empty();
    this.resolve(this.accepted);
  }
}

// ---------------------------------------------------------------------------
// Doctor
// ---------------------------------------------------------------------------

class DoctorView extends ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
    this.besideLeaf = null;
    this.renderSoon = debounce(() => this.render(), 300, true);
  }

  getViewType() {
    return DOCTOR_VIEW;
  }

  getDisplayText() {
    return "Todoist doctor";
  }

  getIcon() {
    return "stethoscope";
  }

  async onOpen() {
    this.contentEl.addClass("stt-doctor");
    this.registerEvent(this.app.metadataCache.on("changed", this.renderSoon));
    await this.reload();
  }

  async reload() {
    await this.act(() => this.plugin.loadCatalog(true));
  }

  // Run a Todoist or note change, then show the result or the error.
  async act(change) {
    this.error = null;
    try {
      await change();
    } catch (error) {
      this.error = error.message;
    }
    this.render();
  }

  setSpec(file, spec) {
    return this.app.fileManager.processFrontMatter(file, (frontmatter) => {
      frontmatter[this.plugin.settings.markerProperty] = spec;
    });
  }

  // On a phone there is no split, so the note opens in a new tab.
  openBeside(file) {
    if (Platform.isPhone) return this.app.workspace.getLeaf("tab").openFile(file);
    let attached = false;
    this.app.workspace.iterateAllLeaves((leaf) => {
      if (leaf === this.besideLeaf) attached = true;
    });
    if (!attached) this.besideLeaf = this.app.workspace.createLeafBySplit(this.leaf, "vertical");
    return this.besideLeaf.openFile(file);
  }

  noteLink(parent, file) {
    const link = parent.createEl("a", { text: file.basename });
    link.addEventListener("click", () => this.openBeside(file));
    return link;
  }

  // Each note that carries the marker property, with the notes that reach it through `project`.
  scan(catalog) {
    const entries = new Map();
    const unassigned = [];
    for (const file of this.app.vault.getMarkdownFiles()) {
      const frontmatter = this.app.metadataCache.getFileCache(file)?.frontmatter;
      if (!frontmatter) continue;
      const holder = this.plugin.targetHolder(file);
      if (!holder) {
        if (["project", "roadmap"].includes(frontmatter.type) && frontmatter.status === "active") unassigned.push(file);
        continue;
      }
      if (!entries.has(holder.file.path)) {
        const valid = typeof holder.spec === "string" && holder.spec.trim() !== "";
        const target = parseTargetSpec(valid ? holder.spec : "");
        entries.set(holder.file.path, { file: holder.file, spec: holder.spec, valid, target, resolved: resolveTarget(target, catalog), inherited: [] });
      }
      if (holder.file !== file) entries.get(holder.file.path).inherited.push(file);
    }
    const byName = (left, right) => left.file.basename.localeCompare(right.file.basename);
    return { entries: [...entries.values()].sort(byName), unassigned };
  }

  problems(entry, catalog) {
    const { file, target, resolved } = entry;
    if (!entry.valid) return [{ file, spec: "", message: "Empty value. In source mode, put the value in quotes.", fixes: [] }];
    const problems = target.errors.map((message) => ({ file, spec: entry.spec, message, fixes: [] }));
    const use = (changes) => {
      const spec = formatTargetSpec({ ...target, ...changes });
      return { label: `Use ${spec}`, run: () => this.setSpec(file, spec) };
    };
    const create = (item) => ({ label: `Create ${SIGIL[item.kind]}${item.name}`, run: () => this.plugin.createMissing([item]) });

    for (const item of resolved.missing) {
      const fixes = [];
      let message = `No ${item.kind} “${item.name}”.`;
      if (item.kind === "project") {
        const slash = item.name.indexOf("/");
        const parent = slash > 0 && !target.section && findByName(catalog.projects, item.name.slice(0, slash));
        if (parent) fixes.push(use({ project: parent.name, section: item.name.slice(slash + 1) }));
        const near = nearestName(catalog.projects, item.name);
        if (near) fixes.push(use({ project: near.name }));
        fixes.push(create(item));
      }
      if (item.kind === "section") {
        message = `No section “${item.name}” in “${item.project}”.`;
        if (resolved.project) {
          const near = nearestName(catalog.sections.filter((section) => section.project_id === resolved.project.id), item.name);
          if (near) fixes.push(use({ section: near.name }));
          fixes.push(create(item));
        }
        const label = findByName(catalog.labels, item.name);
        if (label) {
          message += ` A label “${label.name}” exists.`;
          fixes.push(use({ section: null, labels: [...target.labels, label.name] }));
        }
      }
      if (item.kind === "label") {
        const near = nearestName(catalog.labels, item.name);
        if (near) fixes.push(use({ labels: target.labels.map((label) => (label === item.name ? near.name : label)) }));
        fixes.push(create(item));
      }
      problems.push({ file, spec: entry.spec, message, fixes });
    }
    return problems;
  }

  // Todoist projects and sections in order, then the ones only the vault names.
  rows(catalog, entries, unassigned) {
    const inbox = catalog.projects.find((project) => project.inbox_project);
    const key = (found, name) => found?.id ?? (name ? `new:${name.toLowerCase()}` : null);
    const placed = entries.filter((entry) => entry.valid).map((entry) => ({
      entry,
      project: key(entry.resolved.project, entry.target.project) ?? inbox?.id,
      section: key(entry.resolved.section, entry.target.section),
    }));
    const at = (project, section) => placed.filter((place) => place.project === project && place.section === section).map((place) => place.entry);
    const newSections = (project) => [...new Set(placed.filter((place) => place.project === project && String(place.section).startsWith("new:")).map((place) => place.section))];

    const rows = [];
    const addProject = (id, name, depth, isNew) => {
      rows.push({ depth, name, isProject: true, isNew, entries: at(id, null), unassigned: id === inbox?.id ? unassigned : [] });
      for (const section of catalog.sections.filter((candidate) => candidate.project_id === id)) {
        rows.push({ depth: depth + 1, name: `/${section.name}`, entries: at(id, section.id), unassigned: [] });
      }
      for (const section of newSections(id)) {
        const found = at(id, section);
        rows.push({ depth: depth + 1, name: `/${found[0].target.section}`, isNew: true, entries: found, unassigned: [] });
      }
      const children = catalog.projects.filter((project) => project.parent_id === id).sort((left, right) => left.child_order - right.child_order);
      for (const child of children) addProject(child.id, `#${child.name}`, depth + 1, false);
    };
    const top = catalog.projects.filter((project) => !project.parent_id).sort((left, right) => left.child_order - right.child_order);
    for (const project of top) addProject(project.id, project.inbox_project ? project.name : `#${project.name}`, 0, false);
    const newProjects = [...new Set(placed.filter((place) => String(place.project).startsWith("new:")).map((place) => place.project))];
    for (const project of newProjects) {
      const name = placed.find((place) => place.project === project).entry.target.project;
      addProject(project, `#${name}`, 0, true);
    }
    return rows;
  }

  render() {
    const root = this.contentEl;
    root.empty();
    const catalog = this.plugin.catalog;
    if (this.error) root.createDiv({ cls: "stt-error", text: this.error });
    if (!catalog) return;

    const { entries, unassigned } = this.scan(catalog);
    const problems = entries.flatMap((entry) => this.problems(entry, catalog));
    const missing = uniqueMissing(entries.flatMap((entry) => entry.resolved.missing));

    if (problems.length) {
      const heading = root.createEl("h2", { text: "Problems" });
      heading.createSpan({ cls: "stt-faint", text: String(problems.length) });
      const panel = root.createDiv({ cls: "stt-panel" });
      for (const problem of problems) {
        const row = panel.createDiv({ cls: "stt-problem" });
        const what = row.createDiv();
        this.noteLink(what, problem.file);
        if (problem.spec) what.createEl("code", { text: problem.spec });
        row.createDiv({ cls: "stt-faint", text: problem.message });
        if (!problem.fixes.length) continue;
        const fixes = row.createDiv({ cls: "stt-fixes" });
        for (const fix of problem.fixes) {
          fixes.createEl("button", { text: fix.label }).addEventListener("click", () => this.act(fix.run));
        }
      }
    }

    const heading = root.createEl("h2", { text: "Todoist targets" });
    heading.createSpan({ cls: "stt-faint", text: `from ${entries.length} ${entries.length === 1 ? "note" : "notes"}` });
    const panel = root.createDiv({ cls: "stt-panel" });
    for (const row of this.rows(catalog, entries, unassigned)) {
      const element = panel.createDiv({ cls: `stt-row${row.isProject ? " stt-project" : ""}` });
      element.style.paddingLeft = `${12 + row.depth * 18}px`;
      element.createDiv({ cls: "stt-name", text: row.name });
      const used = row.entries.length || row.unassigned.length;
      element.createSpan({
        cls: `stt-chip ${row.isNew ? "stt-new" : used ? "stt-exists" : ""}`,
        text: row.isNew ? "new" : used ? "exists" : "no notes",
      });
      if (!used) continue;
      const notes = element.createDiv({ cls: "stt-notes" });
      const files = [...row.entries.map((entry) => entry.file), ...row.unassigned];
      files.forEach((file, index) => {
        if (index) notes.appendText(" · ");
        this.noteLink(notes, file);
      });
      const inherited = row.entries.flatMap((entry) => entry.inherited);
      if (!inherited.length) continue;
      const details = element.createEl("details", { cls: "stt-notes" });
      details.createEl("summary", { text: `${inherited.length} ${inherited.length === 1 ? "note" : "notes"} through ${PARENT_PROPERTY}` });
      inherited.forEach((file, index) => {
        if (index) details.appendText(" · ");
        this.noteLink(details, file);
      });
    }

    const buttons = root.createDiv({ cls: "stt-even" });
    if (missing.length) {
      const create = buttons.createEl("button", { cls: "mod-cta", text: `Create ${missing.length} in Todoist` });
      create.addEventListener("click", () => this.act(() => this.plugin.createMissing(missing)));
    }
    buttons.createEl("button", { text: "Refresh" }).addEventListener("click", () => this.reload());
  }
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

class SendToTodoistSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    const { settings } = this.plugin;
    containerEl.empty();
    const save = (key, clean) => async (value) => {
      settings[key] = clean(value);
      await this.plugin.saveSettings();
    };

    new Setting(containerEl)
      .setName("Todoist API token")
      .setDesc("Stored on this device only.")
      .addComponent((element) => new SecretComponent(this.app, element).setValue(settings.tokenSecret).onChange(save("tokenSecret", (value) => value)));

    new Setting(containerEl)
      .setName("Marker tag")
      .addText((text) => text.setValue(settings.markerTag).onChange(save("markerTag", (value) => value.replace(/^#/, "").trim() || DEFAULT_SETTINGS.markerTag)));

    new Setting(containerEl)
      .setName("Marker property")
      .addText((text) => text.setValue(settings.markerProperty).onChange(save("markerProperty", (value) => value.trim() || DEFAULT_SETTINGS.markerProperty)));

    new Setting(containerEl)
      .setName("Vault name in links")
      .setDesc("Empty: links open in the vault that is open.")
      .addText((text) => text.setValue(this.plugin.linkVault()).onChange(save("vault", (value) => value.trim())));
  }
}

module.exports = SendToTodoistPlugin;
