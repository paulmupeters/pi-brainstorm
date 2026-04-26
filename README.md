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
- drafts a decision-oriented markdown brief when you finish
- can replace the brainstorm transcript with the reviewed brief in LLM context when you finish without saving or when you save and choose the context-preserving option

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

## Brief export

When you finish a brainstorm, the extension:
1. collects the conversation since brainstorm mode started
2. asks the current model, or an optional dedicated summary-model override, to draft a concise decision brief
3. opens that brief in an editor so you can tweak it
4. then offers:
   - `Brief to context`
   - `Brief to markdown`
   - `Brief to markdown and context`
   - `Continue brainstorming`
   - `Exit`

The generated brief uses `# Decision Brief: <topic>` when the session reached a clear decision, recommendation, or strong preference. If no firm conclusion emerged, it uses `# Brainstorm Brief: <topic>` and calls out the strongest current leaning without inventing certainty. It leads with the recommendation/current leaning, then covers rationale, alternatives, risks/open questions, and a transcript summary capped at 5 sentences.

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

If you choose **Brief to context** or **Brief to markdown and context**, the brainstorm transcript stays in session history, but future LLM context uses the reviewed brief instead of the full brainstorm exchange.

## Notes

- During brainstorm mode, only the `read` tool is enabled on purpose.
- The extension restores your previously active tools after finishing/canceling.
- If model-based brief generation is unavailable, the extension falls back to a simple markdown transcript.
