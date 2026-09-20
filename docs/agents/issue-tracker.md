# Issue tracker: GitHub

Issues and specs live in GitHub Issues for `dymoo/llm-router`. Use the `gh` CLI or the configured GitHub integration; infer the repository from the Git remote.

## Operations

- Create: `gh issue create --repo dymoo/llm-router --title "..." --body-file <file>`.
- Read: `gh issue view <number> --repo dymoo/llm-router --comments`; include labels and relevant comments.
- List: `gh issue list --repo dymoo/llm-router --state open --json number,title,body,labels`.
- Comment: `gh issue comment <number> --repo dymoo/llm-router --body-file <file>`.
- Label: `gh issue edit <number> --add-label "..." --remove-label "..."`.
- Close: `gh issue close <number> --comment "..."` after acceptance criteria pass.

Publishing to the issue tracker means creating a GitHub issue. Fetching a ticket means reading its issue, labels, and comments. Reuse an existing issue rather than duplicating it. Configuring this tracker does not itself create issues or labels.

## Pull requests as a triage surface

**PRs as a request surface: no.**

## Wayfinding

A map is an issue labelled `wayfinder:map`; work items are linked child issues labelled `wayfinder:<type>`. Use native GitHub sub-issues and dependencies when available. Otherwise use a map task list, `Part of #N`, and `Blocked by: #N` links. An unblocked, unassigned open child is eligible to be claimed. Record evidence before closing completed work.
