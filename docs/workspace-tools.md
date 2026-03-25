# Workspace MCP Tools

Deus MCP tools for user interaction and workspace state inspection.

## AskUserQuestion

Ask the user questions during execution to gather preferences, clarify instructions, or get implementation decisions.

**Input:**

| Parameter                 | Type       | Required | Description                                                  |
| ------------------------- | ---------- | -------- | ------------------------------------------------------------ |
| `questions`               | `array`    | Yes      | Up to 4 question objects                                     |
| `questions[].question`    | `string`   | Yes      | The question to ask                                          |
| `questions[].options`     | `string[]` | Yes      | Up to 4 options. "Other" is auto-provided — don't include it |
| `questions[].multiSelect` | `boolean`  | No       | Allow multiple selections                                    |

**Output:** `text`

```
User responses:
1. Option A
2.
   - Option B
   - Option C
```

Returns `"User cancelled the question..."` if the user dismisses the dialog.

---

## GetWorkspaceDiff

View all changes on the current branch (including uncommitted) compared against the merge base. Same diff shown in the Deus UI and used for PRs.

**Input:**

| Parameter | Type      | Required | Description                                        |
| --------- | --------- | -------- | -------------------------------------------------- |
| `file`    | `string`  | No       | Absolute file path for single-file unified diff    |
| `stat`    | `boolean` | No       | Return `git diff --stat` style per-file statistics |

**Output:** `text`

No args → full unified diff for all changes.
`stat: true` → per-file line counts.
`file: "/path"` → unified diff for that file.

```
--- a/src/index.ts
+++ b/src/index.ts
@@ -1 +1 @@
-old
+new
```

---

## DiffComment

Leave review comments on the workspace diff targeting specific file/line locations.

**Input:**

| Parameter               | Type     | Required | Description                                    |
| ----------------------- | -------- | -------- | ---------------------------------------------- |
| `comments`              | `array`  | Yes      | Array of comment objects                       |
| `comments[].file`       | `string` | Yes      | File path to comment on                        |
| `comments[].lineNumber` | `number` | Yes      | Line number to comment on                      |
| `comments[].body`       | `string` | Yes      | Comment body (prefer plain text over markdown) |

**Output:** `text`

```
Posted 2 comment(s) on the diff.
```

---

## GetTerminalOutput

View output from the user's terminal — dev servers, build/test logs, or interactive terminal sessions.

**Input:**

| Parameter  | Type     | Required | Description                                                           |
| ---------- | -------- | -------- | --------------------------------------------------------------------- |
| `source`   | `enum`   | No       | `"spotlight"` \| `"run_script"` \| `"terminal"` \| `"auto"` (default) |
| `maxLines` | `number` | No       | Max lines to return (default: 1000)                                   |

**Output:** `text`

```
[Run script - running]
> vite dev
  VITE v5.0.0  ready in 200 ms
  ➜ Local: http://localhost:5173/
```

Returns `"No terminal output available..."` if no active terminal is found.
