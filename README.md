# pi-brainstorm

A small pi extension that adds a read-only `/brainstorm` mode.

## What it does

When brainstorm mode is active:
- allows only the `read` tool
- blocks shell commands and file edits/writes
- keeps the conversation exploratory
- avoids unsolicited "you should do X next" suggestions
- gives a clear recommendation when you ask for the best option
- shows a visible reminder in the UI
- offers to save a markdown summary when you finish
- can replace the brainstorm transcript with the reviewed summary in LLM context when you finish without saving or when you save and choose the context-preserving option

## UX

- `/brainstorm` starts brainstorm mode
- `/brainstorm` again opens a small menu:
  - Continue brainstorming
  - Finish and summarize
  - Cancel and discard
- `/brainstorm finish` finishes directly
- `/brainstorm cancel` exits immediately without a summary
- `/brainstorm-summary-model` configures an optional dedicated summary model
- `Ctrl+Alt+B` is a shortcut for the same flow

While active, the footer/widget reminds you how to finish or cancel.

## Install / test

### Quick test

```bash
pi --no-extensions -e /home/paul/projects/pi-brainstorm/extensions/brainstorm.ts
```

### Use from your normal pi setup

Either:
- install from npm with `pi install npm:@paulmupeters/pi-brainstorm`
- copy or symlink `extensions/brainstorm.ts` into `~/.pi/agent/extensions/`
- or add the file path to your pi extension settings

## Summary export

When you finish a brainstorm, the extension:
1. collects the conversation since brainstorm mode started
2. asks the current model, or an optional dedicated summary-model override, to draft a markdown summary
3. opens that summary in an editor so you can tweak it
4. then offers:
   - `Summary to context`
   - `Summary to markdown`
   - `Summary to markdown and context`
   - `Continue brainstorming`
   - `Exit`

Default save path:

```text
brainstorms/YYYY-MM-DD-topic.md
```

### Optional summary model override

By default, brainstorm summaries use the currently active Pi model.

You can persist a separate user-level summary model with:

```text
/brainstorm-summary-model
```

Or set it directly:

```text
/brainstorm-summary-model google/gemini-2.5-flash
/brainstorm-summary-model clear
```

The preference is stored globally in `~/.pi/agent/settings.json` under `piBrainstorm.summaryModel` and falls back to the active model when unset or unavailable.

If you choose **Summary to context** or **Summary to markdown and context**, the brainstorm transcript stays in session history, but future LLM context uses the reviewed summary instead of the full brainstorm exchange.

## Notes

- During brainstorm mode, only the `read` tool is enabled on purpose.
- The extension restores your previously active tools after finishing/canceling.
- If model-based summarization is unavailable, the extension falls back to a simple markdown transcript.
