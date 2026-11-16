# Send to Todoist

An Obsidian plugin that moves a task line into [Todoist](https://todoist.com),
one way. Keep roadmaps and checklists in Obsidian, and send only the tasks that
need a date or a reminder.

```markdown
- [ ] Review [[Barony]] camera plan 🔺 ⏳ 2026-11-20
- [>] Review [[Barony]] camera plan #todoist [↗](https://app.todoist.com/app/task/123) 🔺 ⏳ 2026-11-20
```

After a send, Todoist owns the task. The line stays as a `[>]` pointer with a
link to the Todoist task, and nothing syncs back.

It works on desktop and mobile.

## Commands

- **Send task** sends the line at the cursor, or each selected line.
- **Send tagged tasks in this note** sends every open task that has the marker
  tag (`#todoist` by default).
- **Open doctor** opens a tab that checks the targets in your vault against
  Todoist.

- **Copy link to heading** copies a link to the heading above the cursor.
- **Copy link to block** copies a link to the list item or paragraph at the
  cursor, and gives it a block ID when it has none.

A line can be sent when it is a plain bullet, `[ ]` or `[/]`.

## What is sent

The task text goes through Todoist's quick-add parser, so `tomorrow`,
`every Monday` and `p2` in the text work as they do in Todoist. Before the
send, the plugin changes these parts of the line:

| On the line | Sent |
|---|---|
| `⏳ 2026-11-20` | the date |
| `📅 2026-11-21` | the deadline, or the date when there is no `⏳` |
| `🔺` `⏫` `🔼` | `p1` `p2` `p3` |
| `[[Note\|alias]]` | `[alias](obsidian://open?…)` |
| `#tag/nested` | the labels `tag` and `nested` |
| the marker tag, `🔽`, `⏬`, `🛫`, `➕` | removed |

Lines below the task:

- An open child task becomes a subtask, at any depth, and its line becomes `[>]`.
- A child task that is done or cancelled is not sent.
- Other child lines go in the description of the task above them.

The description starts with a link back to the note, at the heading above the
task.

## Links to a place in a note

The link in the description and the two copy commands make a Markdown link with
an `obsidian://` address. The text is the note, then the headings down to the
place:

```markdown
[Project > Log > 2026-01-01](obsidian://open?vault=notes&file=Project%23Log%232026-01-01)
[Project > Log > 2026-01-01 ^k3x9ab](obsidian://open?vault=notes&file=Project%23%5Ek3x9ab)
```

## Where a task goes

Put a property on a note, in Todoist syntax. Quote it, because YAML reads an
unquoted `#` as a comment.

```yaml
todoist: "#work /ddc %urgent"
```

- `#` is the project, `/` the section and `%` (or `@`) a label. Names can have
  spaces.
- A label or project matches without the emoji at the start of its name, so
  `%blocked` finds “❌ blocked”.
- A note without the property uses the note its `project` property links to,
  and so on upward. With no property on the way, the task goes to the Inbox.

If a project, section or label does not exist, the send asks before it creates
it.

## Doctor

The doctor lists each target that does not match Todoist, with buttons to
correct the property or to create the missing item. Below that, it shows your
Todoist projects and sections with the notes that send to each one. Notes with
`type: project` or `type: roadmap` and `status: active` that have no target
appear under Inbox. A click on a note opens it beside the doctor.

## Settings

- **Todoist API token**: from Todoist, Settings > Integrations > Developer. It
  is kept in Obsidian's secret storage, on each device separately.
- **Marker tag** and **Marker property**: `todoist` by default.
- **Vault name in links**: the vault name used in `obsidian://` links. Leave it
  empty to make links without a vault name.
- **Templates folder**: the doctor ignores notes in this folder.

## Network use

The plugin needs a Todoist account and its API token. It talks only to the
Todoist API (`api.todoist.com`): it sends the text of the tasks you send, with
their child lines and a link to the note, and it reads the names of your
projects, sections and labels. It sends nothing else, and it has no telemetry.

## Install

Copy `main.js`, `manifest.json` and `styles.css` from a release into
`.obsidian/plugins/send-to-todoist/` in your vault, then enable the plugin.
It needs Obsidian 1.11.4 or later.

## Develop

Plain JavaScript, with no build step and no dependencies.

```sh
node --test
```

To release, set the version in `manifest.json` and `versions.json`, then push
an annotated tag with the same version. The tag message becomes the release
notes.
