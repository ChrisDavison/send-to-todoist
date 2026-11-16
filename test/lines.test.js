const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

// main.js has no exports for its helpers, so run it and read its functions
// from the script's global scope.
const context = {
  module: { exports: {} },
  require: () => ({ ItemView: class {}, Modal: class {}, Plugin: class {}, PluginSettingTab: class {} }),
};
vm.createContext(context);
vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "main.js"), "utf8"), context);

// Values from the script belong to another realm; compare them as plain data.
const plain = (value) => JSON.parse(JSON.stringify(value));
const uriFor = (linkpath, heading) => context.obsidianUri("notes", linkpath, heading);
const convert = (body) => plain(context.convertTaskText(body, "todoist", uriFor));

test("Tasks emojis become quick-add syntax", () => {
  assert.deepEqual(convert("Review camera plan 🔺 ⏳ 2026-11-20 📅 2026-11-21"), {
    text: "Review camera plan 2026-11-20 {2026-11-21} p1",
    labels: [],
  });
  assert.equal(convert("Strength log 📅 2026-11-15").text, "Strength log 2026-11-15");
  assert.equal(convert("Read paper ⏫ 🛫 2026-11-01 ➕ 2026-10-01").text, "Read paper p2");
  assert.equal(convert("Low priority 🔽").text, "Low priority");
  assert.equal(convert("Call the bank tomorrow p2").text, "Call the bank tomorrow p2");
});

test("tags become labels and leave the text", () => {
  assert.deepEqual(convert("Revise #español/grammar verbs #todoist #blocked"), {
    text: "Revise verbs",
    labels: ["español", "grammar", "blocked"],
  });
  assert.deepEqual(convert("Issue #12 and C# stay").labels, []);
});

test("wikilinks become Obsidian links", () => {
  assert.equal(
    convert("Ask [[Christos Tachtatzis]] about [[Notes/DDC (Barony)#Live camera|the plan]]").text,
    "Ask [Christos Tachtatzis](obsidian://open?vault=notes&file=Christos%20Tachtatzis) about " +
      "[the plan](obsidian://open?vault=notes&file=Notes%2FDDC%20%28Barony%29%23Live%20camera)",
  );
  assert.equal(convert("See [[Obsidian#Tasks]]").text, "See [Obsidian > Tasks](obsidian://open?vault=notes&file=Obsidian%23Tasks)");
  assert.equal(context.obsidianUri("", "Notes/Home"), "obsidian://open?file=Notes%2FHome");
});

test("a sent line keeps its text and Tasks fields", () => {
  const url = "https://app.todoist.com/app/task/123";
  assert.equal(
    context.markSent("\t- [ ] Review [[Barony]] camera plan 🔺 ⏳ 2026-11-20", "todoist", url),
    `\t- [>] Review [[Barony]] camera plan #todoist [↗](${url}) 🔺 ⏳ 2026-11-20`,
  );
  assert.equal(context.markSent("- Plain bullet", "todoist", url), `- [>] Plain bullet #todoist [↗](${url})`);
  assert.equal(context.markSent("- [ ] Tagged #todoist 📅 2026-11-21", "todoist", url), `- [>] Tagged #todoist [↗](${url}) 📅 2026-11-21`);
  assert.equal(context.markSent("* [/] With block id ^abc123", "todoist", url), `* [>] With block id #todoist [↗](${url}) ^abc123`);
  assert.equal(context.markRefiled("    - [ ] Child ⏳ 2026-11-20"), "    - [>] Child ⏳ 2026-11-20");
});

test("child tasks become subtasks and other child lines become notes", () => {
  const lines = [
    "- [ ] Parent",
    "\t- A bullet",
    "\t\t- A nested bullet",
    "\t- [ ] Open child",
    "\t\t- Child bullet",
    "\t\t- [ ] Grandchild",
    "\t- [x] Done child",
    "\t\t- [ ] Open task below a done child",
    "\t- [/] Child in progress",
    "",
    "\t- Bullet after a blank line",
    "- [ ] Next task",
  ];
  const task = plain(context.buildTask(lines, 0));
  assert.deepEqual(task.notes, ["- A bullet", "  - A nested bullet", "- Bullet after a blank line"]);
  assert.deepEqual(task.subtasks.map((subtask) => [subtask.line, subtask.body]), [[3, "Open child"], [8, "Child in progress"]]);
  assert.deepEqual(task.subtasks[0].notes, ["- Child bullet"]);
  assert.deepEqual(task.subtasks[0].subtasks.map((subtask) => subtask.line), [5]);
  assert.equal(context.blockEnd(lines, 0), 11);
});

test("only open tasks and plain bullets can be sent", () => {
  const sendable = (line) => context.isSendable(context.parseListItem(line));
  assert.equal(sendable("- [ ] Open"), true);
  assert.equal(sendable("- [/] In progress"), true);
  assert.equal(sendable("- Bullet"), true);
  assert.equal(sendable("- [x] Done"), false);
  assert.equal(sendable("- [>] Sent"), false);
  assert.equal(context.parseListItem("A paragraph"), null);
});

test("target specs", () => {
  assert.deepEqual(plain(context.parseTargetSpec("#Madrid para graduación /ddc %👩🏻 lidia @dissemination")), {
    project: "Madrid para graduación",
    section: "ddc",
    labels: ["👩🏻 lidia", "dissemination"],
    errors: [],
  });
  assert.equal(context.parseTargetSpec("#personal/spanish").project, "personal/spanish");
  assert.deepEqual(plain(context.parseTargetSpec("/ddc").errors), ["A section needs a project."]);
  assert.equal(context.formatTargetSpec({ project: "work", section: null, labels: ["ddc"] }), "#work %ddc");
});

test("targets resolve against Todoist names", () => {
  const catalog = {
    projects: [{ id: "p1", name: "work" }, { id: "p2", name: "personal" }],
    sections: [{ id: "s1", name: "DDC", project_id: "p1" }],
    labels: [{ id: "l1", name: "❌ blocked" }, { id: "l2", name: "ddc" }],
  };
  const resolved = plain(context.resolveTarget(context.parseTargetSpec("#Work /ddc %blocked %new"), catalog));
  assert.equal(resolved.project.id, "p1");
  assert.equal(resolved.section.id, "s1");
  assert.deepEqual(resolved.labels, ["❌ blocked"]);
  assert.deepEqual(resolved.missing, [{ kind: "label", name: "new" }]);

  const wrongProject = plain(context.resolveTarget(context.parseTargetSpec("#personal /ddc"), catalog));
  assert.deepEqual(wrongProject.missing, [{ kind: "section", name: "ddc", project: "personal" }]);
  assert.equal(context.nearestName(catalog.projects, "persnal").name, "personal");
  assert.equal(context.nearestName(catalog.projects, "music"), undefined);
});
