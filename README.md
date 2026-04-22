# pi-brainstorm

A small pi extension that adds a conversation-only `/brainstorm` mode.

## What it does

When brainstorm mode is active:
- blocks all tool calls
- prevents file edits/writes
- keeps the conversation exploratory
- avoids unsolicited "you should do X next" suggestions
- gives a clear recommendation when you ask for the best option
- shows a visible reminder in the UI
- offers to save a markdown summary when you finish

## UX

- `/brainstorm` starts brainstorm mode
- `/brainstorm` again opens a small menu:
  - Continue brainstorming
  - Finish and summarize
  - Cancel and discard
- `/brainstorm finish` finishes directly
- `/brainstorm cancel` exits immediately without a summary
- `Ctrl+Alt+B` is a shortcut for the same flow

While active, the footer/widget remind you how to finish or cancel.

## Install / test

### Quick test

```bash
pi --no-extensions -e /home/paul/projects/pi-brainstorm/extensions/brainstorm.ts
```

### Use from your normal pi setup

Either:
- copy or symlink `extensions/brainstorm.ts` into `~/.pi/agent/extensions/`
- or add the file path to your pi extension settings

## Summary export

When you finish a brainstorm, the extension:
1. collects the conversation since brainstorm mode started
2. asks the current model to draft a markdown summary
3. opens that summary in an editor so you can tweak it
4. optionally writes it to a markdown file

Default save path:

```text
brainstorms/YYYY-MM-DD-topic.md
```

## Notes

- During brainstorm mode, tools are disabled on purpose.
- The extension restores your previously active tools after finishing/canceling.
- If model-based summarization is unavailable, the extension falls back to a simple markdown transcript.
