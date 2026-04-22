import { complete, type Message } from "@mariozechner/pi-ai";
import {
	BorderedLoader,
	convertToLlm,
	serializeConversation,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionContext,
	type SessionEntry,
} from "@mariozechner/pi-coding-agent";
import { Key } from "@mariozechner/pi-tui";
import { mkdir, stat, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

type BrainstormAction = "start" | "finish" | "cancel";

type BrainstormMarker = {
	action: BrainstormAction;
	topic?: string;
	startedAt?: number;
	previousTools?: string[];
	savedPath?: string;
};

type BrainstormState = {
	active: boolean;
	topic?: string;
	startedAt?: number;
	previousTools: string[];
	startIndex: number;
};

const DEFAULT_TOOLS = ["read", "bash", "edit", "write"];
const BRAINSTORM_TOOLS: string[] = [];
const BRAINSTORM_ENTRY_TYPE = "brainstorm-state";
const DEFAULT_TOPIC = "brainstorm";

const SUMMARY_SYSTEM_PROMPT = `You are writing a markdown summary of a brainstorming conversation.

Write a concise but useful summary that helps someone resume or review the discussion later.

Requirements:
- Output valid markdown only.
- Start with a level-1 heading.
- Capture the user's real goal or topic.
- Include the strongest recommendations or preferences that emerged.
- If options were compared, say which option was preferred and why.
- Include open questions, risks, and unresolved tradeoffs.
- Include next steps only if the user explicitly asked for next steps.
- Do not invent decisions that were not actually made.
- Keep it crisp and skimmable.`;

const inactiveState = (): BrainstormState => ({
	active: false,
	previousTools: DEFAULT_TOOLS,
	startIndex: -1,
});

const isStringArray = (value: unknown): value is string[] =>
	Array.isArray(value) && value.every((item) => typeof item === "string");

const slugify = (value: string): string => {
	const slug = value
		.toLowerCase()
		.trim()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.replace(/-{2,}/g, "-");
	return slug || DEFAULT_TOPIC;
};

const formatDate = (timestamp: number): string => new Date(timestamp).toISOString().slice(0, 10);

const defaultSummaryPath = (state: BrainstormState): string => {
	const date = formatDate(state.startedAt ?? Date.now());
	const topic = slugify(state.topic ?? DEFAULT_TOPIC);
	return `brainstorms/${date}-${topic}.md`;
};

const buildSummaryPrompt = (state: BrainstormState, conversationText: string): string => {
	const topicLine = state.topic ? `Topic: ${state.topic}` : "Topic: General brainstorming";
	const startedLine = state.startedAt ? `Started: ${new Date(state.startedAt).toISOString()}` : undefined;

	return [
		"Summarize this brainstorming session.",
		topicLine,
		startedLine,
		"",
		"Produce a helpful markdown summary that preserves recommendations, preferences, tradeoffs, open questions, and any conclusions reached.",
		"Only include action items if the user explicitly asked for actions or next steps.",
		"",
		"<conversation>",
		conversationText,
		"</conversation>",
	]
		.filter(Boolean)
		.join("\n");
};

const buildFallbackSummary = (state: BrainstormState, conversationText: string): string => {
	const title = state.topic ? `# Brainstorm Summary: ${state.topic}` : "# Brainstorm Summary";
	const lines = [
		title,
		"",
		`- Date: ${formatDate(state.startedAt ?? Date.now())}`,
		`- Topic: ${state.topic ?? "General brainstorming"}`,
		"",
		"## Notes",
		"",
		"Model-based summarization was unavailable, so the conversation transcript is included below.",
		"",
		"## Transcript",
		"",
		"```text",
		conversationText.trim() || "(No brainstorm messages yet)",
		"```",
	];
	return lines.join("\n");
};

const getBrainstormMessages = (branch: SessionEntry[], startIndex: number): Message[] =>
	branch
		.slice(Math.max(startIndex + 1, 0))
		.filter((entry): entry is SessionEntry & { type: "message" } => entry.type === "message")
		.map((entry) => entry.message);

const deriveStateFromBranch = (branch: SessionEntry[]): BrainstormState => {
	let state = inactiveState();

	for (let i = 0; i < branch.length; i++) {
		const entry = branch[i];
		if (entry.type !== "custom" || entry.customType !== BRAINSTORM_ENTRY_TYPE) {
			continue;
		}

		const data = (entry.data ?? {}) as BrainstormMarker;
		if (data.action === "start") {
			state = {
				active: true,
				topic: typeof data.topic === "string" && data.topic.trim() ? data.topic.trim() : undefined,
				startedAt: typeof data.startedAt === "number" ? data.startedAt : Date.now(),
				previousTools: isStringArray(data.previousTools) ? data.previousTools : DEFAULT_TOOLS,
				startIndex: i,
			};
		}

		if (data.action === "finish" || data.action === "cancel") {
			state = inactiveState();
		}
	}

	return state;
};

const setBrainstormUi = (ctx: ExtensionContext, state: BrainstormState) => {
	if (!ctx.hasUI) {
		return;
	}

	if (!state.active) {
		ctx.ui.setStatus("brainstorm", undefined);
		ctx.ui.setWidget("brainstorm", undefined);
		return;
	}

	const topicLabel = state.topic ? ` • ${state.topic}` : "";
	ctx.ui.setStatus("brainstorm", ctx.ui.theme.fg("accent", `🧠 brainstorm${topicLabel}`));
	ctx.ui.setWidget("brainstorm", [
		ctx.ui.theme.fg("accent", ctx.ui.theme.bold("🧠 Brainstorm mode active")),
		state.topic ? `${ctx.ui.theme.fg("dim", "topic:")} ${state.topic}` : ctx.ui.theme.fg("dim", "topic: general"),
		ctx.ui.theme.fg("dim", "conversation only • tools blocked • no file edits"),
		ctx.ui.theme.fg("dim", "finish: /brainstorm   cancel: /brainstorm cancel   shortcut: Ctrl+Alt+B"),
	]);
};

const notify = (ctx: ExtensionContext, message: string, level: "info" | "warning" | "error" = "info") => {
	if (ctx.hasUI) {
		ctx.ui.notify(message, level);
	}
};

const applyBranchState = (
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	currentState: BrainstormState,
	nextState: BrainstormState,
) => {
	if (!currentState.active && nextState.active) {
		pi.setActiveTools(BRAINSTORM_TOOLS);
	}

	if (currentState.active && !nextState.active) {
		pi.setActiveTools(currentState.previousTools.length > 0 ? currentState.previousTools : DEFAULT_TOOLS);
	}

	if (currentState.active && nextState.active) {
		pi.setActiveTools(BRAINSTORM_TOOLS);
	}

	setBrainstormUi(ctx, nextState);
};

const generateSummary = async (state: BrainstormState, ctx: ExtensionCommandContext): Promise<string | null> => {
	const messages = getBrainstormMessages(ctx.sessionManager.getBranch(), state.startIndex);
	const conversationText = serializeConversation(convertToLlm(messages));

	if (!conversationText.trim()) {
		return buildFallbackSummary(state, "No brainstorm messages were exchanged.");
	}

	if (!ctx.model) {
		return buildFallbackSummary(state, conversationText);
	}

	const result = await ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
		const loader = new BorderedLoader(tui, theme, `Summarizing brainstorm with ${ctx.model!.id}...`);
		loader.onAbort = () => done(null);

		const summarize = async () => {
			const auth = await ctx.modelRegistry.getApiKeyAndHeaders(ctx.model!);
			if (!auth.ok || !auth.apiKey) {
				done(buildFallbackSummary(state, conversationText));
				return;
			}

			const userMessage: Message = {
				role: "user",
				content: [{ type: "text", text: buildSummaryPrompt(state, conversationText) }],
				timestamp: Date.now(),
			};

			const response = await complete(
				ctx.model!,
				{ systemPrompt: SUMMARY_SYSTEM_PROMPT, messages: [userMessage] },
				{ apiKey: auth.apiKey, headers: auth.headers, signal: loader.signal },
			);

			if (response.stopReason === "aborted") {
				done(null);
				return;
			}

			const summary = response.content
				.filter((part): part is { type: "text"; text: string } => part.type === "text")
				.map((part) => part.text)
				.join("\n")
				.trim();

			done(summary || buildFallbackSummary(state, conversationText));
		};

		summarize().catch(() => done(buildFallbackSummary(state, conversationText)));
		return loader;
	});

	return result;
};

const saveSummaryToFile = async (summary: string, state: BrainstormState, ctx: ExtensionCommandContext): Promise<string | null> => {
	const suggestedPath = defaultSummaryPath(state);
	const chosenPath = await ctx.ui.input("Save brainstorm summary", suggestedPath);
	if (chosenPath === undefined) {
		return null;
	}

	const finalPath = (chosenPath.trim() || suggestedPath).replace(/^@/, "");
	const absolutePath = resolve(ctx.cwd, finalPath);

	try {
		await stat(absolutePath);
		const overwrite = await ctx.ui.confirm("File exists", `Overwrite ${finalPath}?`);
		if (!overwrite) {
			return null;
		}
	} catch {
		// File does not exist yet.
	}

	await mkdir(dirname(absolutePath), { recursive: true });
	await writeFile(absolutePath, summary, "utf8");
	return finalPath;
};

export default function brainstormExtension(pi: ExtensionAPI) {
	let state = inactiveState();

	const syncStateFromBranch = (ctx: ExtensionContext) => {
		const nextState = deriveStateFromBranch(ctx.sessionManager.getBranch());
		applyBranchState(pi, ctx, state, nextState);
		state = nextState;
	};

	const startBrainstorm = (topic: string | undefined, ctx: ExtensionContext) => {
		if (state.active) {
			notify(ctx, "Brainstorm mode is already active.", "warning");
			return;
		}

		const nextState: BrainstormState = {
			active: true,
			topic,
			startedAt: Date.now(),
			previousTools: pi.getActiveTools(),
			startIndex: ctx.sessionManager.getBranch().length,
		};

		pi.appendEntry<BrainstormMarker>(BRAINSTORM_ENTRY_TYPE, {
			action: "start",
			topic,
			startedAt: nextState.startedAt,
			previousTools: nextState.previousTools,
		});

		pi.setActiveTools(BRAINSTORM_TOOLS);
		state = nextState;
		setBrainstormUi(ctx, state);
		notify(
			ctx,
			`Brainstorm mode started${topic ? `: ${topic}` : ""}. Ask questions freely. Use /brainstorm to finish or /brainstorm cancel to discard.`,
		);
	};

	const stopBrainstorm = (action: Exclude<BrainstormAction, "start">, ctx: ExtensionContext, savedPath?: string) => {
		if (!state.active) {
			notify(ctx, "Brainstorm mode is not active.", "warning");
			return;
		}

		const previousTools = state.previousTools.length > 0 ? state.previousTools : DEFAULT_TOOLS;
		pi.appendEntry<BrainstormMarker>(BRAINSTORM_ENTRY_TYPE, {
			action,
			topic: state.topic,
			startedAt: state.startedAt,
			previousTools,
			savedPath,
		});

		pi.setActiveTools(previousTools);
		state = inactiveState();
		setBrainstormUi(ctx, state);
	};

	const finishBrainstorm = async (ctx: ExtensionCommandContext) => {
		if (!state.active) {
			notify(ctx, "Brainstorm mode is not active.", "warning");
			return;
		}

		const summary = await generateSummary(state, ctx);
		if (summary === null) {
			notify(ctx, "Summary cancelled. Brainstorm mode is still active.", "info");
			return;
		}

		const reviewedSummary = await ctx.ui.editor("Review brainstorm summary", summary);
		if (reviewedSummary === undefined) {
			notify(ctx, "Finish cancelled. Brainstorm mode is still active.", "info");
			return;
		}

		const nextAction = await ctx.ui.select("Finish brainstorm", [
			"Save summary to markdown",
			"Finish without saving",
			"Continue brainstorming",
		]);

		if (!nextAction || nextAction === "Continue brainstorming") {
			notify(ctx, "Brainstorm mode is still active.", "info");
			return;
		}

		if (nextAction === "Finish without saving") {
			stopBrainstorm("finish", ctx);
			notify(ctx, "Brainstorm finished.", "info");
			return;
		}

		const savedPath = await saveSummaryToFile(reviewedSummary, state, ctx);
		if (!savedPath) {
			notify(ctx, "Save cancelled. Brainstorm mode is still active.", "info");
			return;
		}

		stopBrainstorm("finish", ctx, savedPath);
		notify(ctx, `Brainstorm summary saved to ${savedPath}`, "info");
	};

	const openBrainstormMenu = async (ctx: ExtensionCommandContext) => {
		const choice = await ctx.ui.select("Brainstorm mode", [
			"Continue brainstorming",
			"Finish and summarize",
			"Cancel and discard",
		]);

		if (!choice || choice === "Continue brainstorming") {
			return;
		}

		if (choice === "Finish and summarize") {
			await finishBrainstorm(ctx);
			return;
		}

		stopBrainstorm("cancel", ctx);
		notify(ctx, "Brainstorm discarded.", "info");
	};

	const handleBrainstormCommand = async (args: string, ctx: ExtensionCommandContext) => {
		const trimmed = args.trim();

		if (!state.active) {
			if (trimmed === "finish" || trimmed === "done" || trimmed === "cancel") {
				notify(ctx, "Brainstorm mode is not active.", "warning");
				return;
			}
			startBrainstorm(trimmed || undefined, ctx);
			return;
		}

		if (trimmed === "cancel") {
			stopBrainstorm("cancel", ctx);
			notify(ctx, "Brainstorm discarded.", "info");
			return;
		}

		if (trimmed === "finish" || trimmed === "done") {
			await finishBrainstorm(ctx);
			return;
		}

		if (!ctx.hasUI) {
			notify(ctx, "Brainstorm mode is active. Use /brainstorm finish or /brainstorm cancel.", "info");
			return;
		}

		await openBrainstormMenu(ctx);
	};

	pi.registerCommand("brainstorm", {
		description: "Start or finish conversation-only brainstorm mode",
		handler: handleBrainstormCommand,
	});

	pi.registerShortcut(Key.ctrlAlt("b"), {
		description: "Start or finish brainstorm mode",
		handler: async (ctx) => {
			await handleBrainstormCommand("", ctx);
		},
	});

	pi.on("before_agent_start", async (event) => {
		if (!state.active) {
			return;
		}

		const topicLine = state.topic ? `Current topic: ${state.topic}` : undefined;
		return {
			systemPrompt: `${event.systemPrompt}\n\nYou are in brainstorm mode. This is a conversation-only ideation session.\n\nRules:\n- Answer the user's questions directly.\n- Help compare ideas, sharpen tradeoffs, and refine thinking.\n- Do not suggest implementation steps, code changes, tasks, or action plans unless the user explicitly asks for them.\n- Do not volunteer to edit files, write code, or create plans.\n- If the user asks for the best option, choose one and explain why.\n- Avoid empty neutrality. Do not stop at \"it depends\"; still make a recommendation when the user wants one.\n- Be engaged and opinionated, but not pushy.\n- Keep answers concise unless the user asks for depth.\n- Do not use tools in brainstorm mode.\n${topicLine ? `- ${topicLine}` : ""}`,
		};
	});

	pi.on("tool_call", async () => {
		if (!state.active) {
			return;
		}

		return {
			block: true,
			reason: "Brainstorm mode is conversation-only. Tools are disabled until you finish or cancel /brainstorm.",
		};
	});

	pi.on("session_start", async (_event, ctx) => {
		syncStateFromBranch(ctx);
	});

	pi.on("session_tree", async (_event, ctx) => {
		syncStateFromBranch(ctx);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		setBrainstormUi(ctx, inactiveState());
	});
}
