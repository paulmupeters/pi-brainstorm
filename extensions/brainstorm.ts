import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { complete, type Message } from "@mariozechner/pi-ai";
import {
	BorderedLoader,
	buildSessionContext,
	convertToLlm,
	serializeConversation,
	type CustomMessageEntry,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionContext,
	type SessionEntry,
} from "@mariozechner/pi-coding-agent";
import { Key } from "@mariozechner/pi-tui";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";

type BrainstormAction = "start" | "finish" | "cancel";

type BrainstormMarker = {
	action: BrainstormAction;
	topic?: string;
	startedAt?: number;
	previousTools?: string[];
	savedPath?: string;
	summary?: string;
	summaryInContext?: boolean;
};

type BrainstormState = {
	active: boolean;
	topic?: string;
	startedAt?: number;
	previousTools: string[];
	startIndex: number;
};

type SummaryModelPreference = {
	provider: string;
	modelId: string;
};

type PiModel = NonNullable<ExtensionContext["model"]>;

const DEFAULT_TOOLS = ["read", "bash", "edit", "write"];
const BRAINSTORM_TOOLS = ["read"];
const BRAINSTORM_ENTRY_TYPE = "brainstorm-state";
const DEFAULT_TOPIC = "brainstorm";
const BRAINSTORM_SETTINGS_KEY = "piBrainstorm";
const SUMMARY_MODEL_SETTING_KEY = "summaryModel";
const SUMMARY_MODEL_COMMAND = "brainstorm-summary-model";
const SUMMARY_MODEL_CLEAR_ARGS = new Set(["active", "clear", "default", "unset"]);
const SUMMARY_TO_CONTEXT_OPTION = "Brief to context";
const SUMMARY_TO_MARKDOWN_OPTION = "Brief to markdown";
const SUMMARY_TO_MARKDOWN_AND_CONTEXT_OPTION = "Brief to markdown and context";
const CONTINUE_BRAINSTORMING_OPTION = "Continue brainstorming";
const EXIT_OPTION = "Exit";
const BRAINSTORM_CONTEXT_SUMMARY_CUSTOM_TYPE = "brainstorm-context-summary";
const BRAINSTORM_CONTEXT_SUMMARY_PREFIX =
	"A previous brainstorm transcript was replaced with the following brief:\n\n<brief>\n";
const BRAINSTORM_CONTEXT_SUMMARY_SUFFIX = "\n</brief>";

const SUMMARY_SYSTEM_PROMPT = `You are writing the default end-of-session artifact for a brainstorming conversation.

Produce a concise, decision-oriented markdown brief, not a chronological transcript recap.

Requirements:
- Output valid markdown only.
- Start with exactly one level-1 heading:
  - Use "# Decision Brief: <topic>" when the session reached a clear decision, recommendation, or strong preference.
  - Use "# Brainstorm Brief: <topic>" when no firm decision emerged.
- Lead with "## Recommendation" or "## Current leaning".
- State when there was no firm decision; do not invent certainty.
- Include rationale for the recommendation or current leaning.
- Include alternatives considered and why they were not preferred.
- Include risks, open questions, and unresolved tradeoffs.
- Include "## Transcript Summary" as a very short recap capped at 5 sentences.
- Include next steps only if the user explicitly asked for next steps.
- Keep it crisp, skimmable, and useful as a decision record.`;

const inactiveState = (): BrainstormState => ({
	active: false,
	previousTools: DEFAULT_TOOLS,
	startIndex: -1,
});

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

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

const formatModelRef = (provider: string, modelId: string): string => `${provider}/${modelId}`;

const formatSummaryModelPreference = (preference: SummaryModelPreference): string =>
	formatModelRef(preference.provider, preference.modelId);

const parseSummaryModelPreference = (value: string): SummaryModelPreference | null => {
	const trimmed = value.trim();
	const slashIndex = trimmed.indexOf("/");
	if (slashIndex <= 0 || slashIndex === trimmed.length - 1) {
		return null;
	}

	const provider = trimmed.slice(0, slashIndex).trim();
	const modelId = trimmed.slice(slashIndex + 1).trim();
	if (!provider || !modelId) {
		return null;
	}

	return { provider, modelId };
};

const sameModel = (
	a: { provider: string; id: string } | undefined | null,
	b: { provider: string; id: string } | undefined | null,
): boolean => !!a && !!b && a.provider === b.provider && a.id === b.id;

const getPiAgentDir = (): string =>
	process.env.PI_CODING_AGENT_DIR ? resolve(process.env.PI_CODING_AGENT_DIR) : resolve(homedir(), ".pi/agent");

const getGlobalSettingsPath = (): string => resolve(getPiAgentDir(), "settings.json");

const readGlobalSettings = async (): Promise<Record<string, unknown>> => {
	try {
		const text = await readFile(getGlobalSettingsPath(), "utf8");
		if (!text.trim()) {
			return {};
		}

		const parsed = JSON.parse(text);
		return isPlainObject(parsed) ? parsed : {};
	} catch (error) {
		const fsError = error as NodeJS.ErrnoException;
		if (fsError.code === "ENOENT") {
			return {};
		}
		throw error;
	}
};

const loadSummaryModelPreference = async (): Promise<SummaryModelPreference | null> => {
	const settings = await readGlobalSettings();
	const config = settings[BRAINSTORM_SETTINGS_KEY];
	if (!isPlainObject(config)) {
		return null;
	}

	const rawValue = config[SUMMARY_MODEL_SETTING_KEY];
	return typeof rawValue === "string" ? parseSummaryModelPreference(rawValue) : null;
};

const saveSummaryModelPreference = async (preference: SummaryModelPreference | null): Promise<void> => {
	const settings = await readGlobalSettings();
	const config = isPlainObject(settings[BRAINSTORM_SETTINGS_KEY])
		? { ...(settings[BRAINSTORM_SETTINGS_KEY] as Record<string, unknown>) }
		: {};

	if (preference) {
		config[SUMMARY_MODEL_SETTING_KEY] = formatSummaryModelPreference(preference);
		settings[BRAINSTORM_SETTINGS_KEY] = config;
	} else {
		delete config[SUMMARY_MODEL_SETTING_KEY];
		if (Object.keys(config).length === 0) {
			delete settings[BRAINSTORM_SETTINGS_KEY];
		} else {
			settings[BRAINSTORM_SETTINGS_KEY] = config;
		}
	}

	await mkdir(getPiAgentDir(), { recursive: true });
	await writeFile(getGlobalSettingsPath(), `${JSON.stringify(settings, null, 2)}\n`, "utf8");
};

const defaultSummaryPath = (state: BrainstormState): string => {
	const date = formatDate(state.startedAt ?? Date.now());
	const topic = slugify(state.topic ?? DEFAULT_TOPIC);
	return `brainstorms/${date}-${topic}.md`;
};

const buildSummaryPrompt = (state: BrainstormState, conversationText: string): string => {
	const topicLine = state.topic ? `Topic: ${state.topic}` : "Topic: General brainstorming";
	const startedLine = state.startedAt ? `Started: ${new Date(state.startedAt).toISOString()}` : undefined;

	return [
		"Create the default end-of-session decision brief for this brainstorming session.",
		topicLine,
		startedLine,
		"",
		"The brief should prioritize what was decided, recommended, or clarified over the order of discussion.",
		"If there is a clear recommendation or strong preference, title it as a Decision Brief and lead with that recommendation.",
		"If there is no firm decision, title it as a Brainstorm Brief and explicitly describe the strongest current leaning without overstating certainty.",
		"Only include action items or next steps if the user explicitly asked for them.",
		"Keep the Transcript Summary section to 5 sentences or fewer.",
		"",
		"<conversation>",
		conversationText,
		"</conversation>",
	]
		.filter(Boolean)
		.join("\n");
};

const buildFallbackSummary = (state: BrainstormState, conversationText: string): string => {
	const title = state.topic ? `# Brainstorm Brief: ${state.topic}` : "# Brainstorm Brief";
	const lines = [
		title,
		"",
		`- Date: ${formatDate(state.startedAt ?? Date.now())}`,
		`- Topic: ${state.topic ?? "General brainstorming"}`,
		"",
		"## Current leaning",
		"",
		"Model-based summarization was unavailable, so no decision-oriented brief could be generated automatically.",
		"",
		"## Transcript Summary",
		"",
		"The full brainstorm transcript is included below because automatic brief generation was unavailable.",
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

const getBrainstormMarker = (entry: SessionEntry): BrainstormMarker | null => {
	if (entry.type !== "custom" || entry.customType !== BRAINSTORM_ENTRY_TYPE) {
		return null;
	}

	return isPlainObject(entry.data) ? (entry.data as BrainstormMarker) : null;
};

type BrainstormContextCompression = {
	startIndex: number;
	finishIndex: number;
	startedAt: number;
	summary: string;
	timestamp: string;
};

const getBrainstormContextCompressions = (branch: SessionEntry[]): BrainstormContextCompression[] => {
	const compressions: BrainstormContextCompression[] = [];
	let active: { startIndex: number; startedAt: number; unsupported: boolean } | null = null;

	for (let i = 0; i < branch.length; i++) {
		const entry = branch[i];
		const marker = getBrainstormMarker(entry);

		if (marker?.action === "start" && typeof marker.startedAt === "number") {
			active = { startIndex: i, startedAt: marker.startedAt, unsupported: false };
			continue;
		}

		if (!active) {
			continue;
		}

		if (entry.type === "compaction" || entry.type === "branch_summary") {
			active.unsupported = true;
		}

		if (!marker || marker.startedAt !== active.startedAt || (marker.action !== "finish" && marker.action !== "cancel")) {
			continue;
		}

		const summary = typeof marker.summary === "string" ? marker.summary.trim() : "";
		if (marker.action === "finish" && marker.summaryInContext && summary && !active.unsupported) {
			compressions.push({
				startIndex: active.startIndex,
				finishIndex: i,
				startedAt: active.startedAt,
				summary,
				timestamp: entry.timestamp,
			});
		}

		active = null;
	}

	return compressions;
};

const buildBrainstormContextSummaryMessage = (summary: string): string =>
	`${BRAINSTORM_CONTEXT_SUMMARY_PREFIX}${summary.trim()}${BRAINSTORM_CONTEXT_SUMMARY_SUFFIX}`;

const buildBrainstormAwareContextMessages = (branch: SessionEntry[]): AgentMessage[] | null => {
	const compressions = getBrainstormContextCompressions(branch);
	if (compressions.length === 0) {
		return null;
	}

	const compressionByStart = new Map(compressions.map((compression) => [compression.startIndex, compression]));
	const syntheticEntries: SessionEntry[] = [];
	let currentCompression: BrainstormContextCompression | null = null;
	let summaryIndex = 0;
	let parentId: string | null = null;

	const appendEntry = <T extends SessionEntry>(entry: T): void => {
		const nextEntry = { ...entry, parentId } as T;
		syntheticEntries.push(nextEntry);
		parentId = nextEntry.id;
	};

	for (let i = 0; i < branch.length; i++) {
		const entry = branch[i];

		if (!currentCompression) {
			currentCompression = compressionByStart.get(i) ?? null;
			if (currentCompression) {
				continue;
			}
		}

		if (currentCompression) {
			if (i === currentCompression.finishIndex) {
				const summaryEntry: CustomMessageEntry<{ startedAt: number }> = {
					type: "custom_message",
					id: `${BRAINSTORM_CONTEXT_SUMMARY_CUSTOM_TYPE}-${summaryIndex++}`,
					parentId,
					timestamp: currentCompression.timestamp,
					customType: BRAINSTORM_CONTEXT_SUMMARY_CUSTOM_TYPE,
					content: buildBrainstormContextSummaryMessage(currentCompression.summary),
					display: false,
					details: { startedAt: currentCompression.startedAt },
				};
				syntheticEntries.push(summaryEntry);
				parentId = summaryEntry.id;
				currentCompression = null;
				continue;
			}

			if (entry.type !== "message" && entry.type !== "custom_message") {
				appendEntry(entry);
			}
			continue;
		}

		if (entry.type === "custom" && entry.customType === BRAINSTORM_ENTRY_TYPE) {
			continue;
		}

		appendEntry(entry);
	}

	if (syntheticEntries.length === 0) {
		return [];
	}

	return buildSessionContext(syntheticEntries, syntheticEntries[syntheticEntries.length - 1]?.id ?? null).messages;
};

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

const setBrainstormUi = (
	ctx: ExtensionContext,
	state: BrainstormState,
	summaryModelPreference: SummaryModelPreference | null,
) => {
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
		`${ctx.ui.theme.fg("dim", "summary:")} ${getSummaryModelLabel(summaryModelPreference)}`,
		ctx.ui.theme.fg("dim", "read-only • file edits and shell commands blocked"),
		ctx.ui.theme.fg(
			"dim",
			`finish: /brainstorm   cancel: /brainstorm cancel   summary model: /${SUMMARY_MODEL_COMMAND}   shortcut: Ctrl+Alt+B`,
		),
	]);
};

const getSummaryModelLabel = (summaryModelPreference: SummaryModelPreference | null): string =>
	summaryModelPreference ? formatSummaryModelPreference(summaryModelPreference) : "active model";

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
	summaryModelPreference: SummaryModelPreference | null,
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

	setBrainstormUi(ctx, nextState, summaryModelPreference);
};

const resolveSummaryModel = async (
	ctx: ExtensionCommandContext,
	summaryModelPreference: SummaryModelPreference | null,
) => {
	const warnings: string[] = [];
	const candidates: Array<{ model: PiModel; source: "override" | "active" }> = [];

	if (summaryModelPreference) {
		const overrideModel = ctx.modelRegistry.find(summaryModelPreference.provider, summaryModelPreference.modelId);
		if (overrideModel) {
			candidates.push({ model: overrideModel, source: "override" });
		} else {
			warnings.push(
				`Configured summary model ${formatSummaryModelPreference(summaryModelPreference)} was not found. Falling back to the active model.`,
			);
		}
	}

	if (ctx.model && !candidates.some((candidate) => sameModel(candidate.model, ctx.model))) {
		candidates.push({ model: ctx.model, source: "active" });
	}

	for (const candidate of candidates) {
		const auth = await ctx.modelRegistry.getApiKeyAndHeaders(candidate.model);
		if (auth.ok && auth.apiKey) {
			return { ...candidate, auth, warnings };
		}

		const modelRef = formatModelRef(candidate.model.provider, candidate.model.id);
		const reason = !auth.ok ? auth.error : `No API key for ${modelRef}`;
		if (candidate.source === "override") {
			warnings.push(`Configured summary model ${modelRef} is unavailable (${reason}). Falling back to the active model.`);
		} else {
			warnings.push(`Active model ${modelRef} is unavailable for summary generation (${reason}).`);
		}
	}

	return {
		model: null,
		auth: null,
		source: "none" as const,
		warnings,
	};
};

const summarizeConversation = async (
	model: PiModel,
	apiKey: string,
	headers: Record<string, string> | undefined,
	state: BrainstormState,
	conversationText: string,
	signal?: AbortSignal,
): Promise<string> => {
	const userMessage: Message = {
		role: "user",
		content: [{ type: "text", text: buildSummaryPrompt(state, conversationText) }],
		timestamp: Date.now(),
	};

	const response = await complete(
		model,
		{ systemPrompt: SUMMARY_SYSTEM_PROMPT, messages: [userMessage] },
		{ apiKey, headers, signal },
	);

	if (response.stopReason === "aborted") {
		throw new Error("aborted");
	}

	return response.content
		.filter((part): part is { type: "text"; text: string } => part.type === "text")
		.map((part) => part.text)
		.join("\n")
		.trim();
};

const generateSummary = async (
	state: BrainstormState,
	summaryModelPreference: SummaryModelPreference | null,
	ctx: ExtensionCommandContext,
): Promise<string | null> => {
	const messages = getBrainstormMessages(ctx.sessionManager.getBranch(), state.startIndex);
	const conversationText = serializeConversation(convertToLlm(messages));

	if (!conversationText.trim()) {
		return buildFallbackSummary(state, "No brainstorm messages were exchanged.");
	}

	const resolution = await resolveSummaryModel(ctx, summaryModelPreference);
	for (const warning of resolution.warnings) {
		notify(ctx, warning, "warning");
	}

	if (!resolution.model || !resolution.auth) {
		return buildFallbackSummary(state, conversationText);
	}

	const fallbackSummary = buildFallbackSummary(state, conversationText);
	const sourceLabel = resolution.source === "override" ? "summary model" : "active model";

	if (!ctx.hasUI) {
		try {
			const summary = await summarizeConversation(
				resolution.model,
				resolution.auth.apiKey,
				resolution.auth.headers,
				state,
				conversationText,
				ctx.signal,
			);
			return summary || fallbackSummary;
		} catch {
			return fallbackSummary;
		}
	}

	const result = await ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
		const loader = new BorderedLoader(tui, theme, `Summarizing brainstorm with ${resolution.model.id} (${sourceLabel})...`);
		loader.onAbort = () => done(null);

		const summarize = async () => {
			try {
				const summary = await summarizeConversation(
					resolution.model,
					resolution.auth.apiKey,
					resolution.auth.headers,
					state,
					conversationText,
					loader.signal,
				);
				done(summary || fallbackSummary);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				if (message === "aborted") {
					done(null);
					return;
				}
				done(fallbackSummary);
			}
		};

		summarize().catch(() => done(fallbackSummary));
		return loader;
	});

	return result;
};

const saveSummaryToFile = async (summary: string, state: BrainstormState, ctx: ExtensionCommandContext): Promise<string | null> => {
	const suggestedPath = defaultSummaryPath(state);
	const chosenPath = await ctx.ui.input(
		`Save brainstorm brief — press Enter to store at ${suggestedPath}`,
		"Type a different path, or leave blank for the default",
	);
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
	let summaryModelPreference: SummaryModelPreference | null = null;
	let summaryModelPreferenceLoaded = false;

	const setCurrentUiState = (ctx: ExtensionContext) => {
		setBrainstormUi(ctx, state, summaryModelPreference);
	};

	const ensureSummaryModelPreferenceLoaded = async (ctx?: ExtensionContext) => {
		if (summaryModelPreferenceLoaded) {
			return;
		}

		try {
			summaryModelPreference = await loadSummaryModelPreference();
			summaryModelPreferenceLoaded = true;
		} catch (error) {
			summaryModelPreference = null;
			summaryModelPreferenceLoaded = true;
			if (ctx) {
				const message = error instanceof Error ? error.message : String(error);
				notify(ctx, `Could not load brainstorm settings from ${getGlobalSettingsPath()}: ${message}`, "warning");
			}
		}
	};

	const updateSummaryModelPreference = async (
		preference: SummaryModelPreference | null,
		ctx: ExtensionContext,
	): Promise<boolean> => {
		try {
			await saveSummaryModelPreference(preference);
			summaryModelPreference = preference;
			summaryModelPreferenceLoaded = true;
			setCurrentUiState(ctx);
			return true;
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			notify(ctx, `Could not save brainstorm settings to ${getGlobalSettingsPath()}: ${message}`, "error");
			return false;
		}
	};

	const syncStateFromBranch = (ctx: ExtensionContext) => {
		const nextState = deriveStateFromBranch(ctx.sessionManager.getBranch());
		applyBranchState(pi, ctx, state, nextState, summaryModelPreference);
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
		setCurrentUiState(ctx);
		notify(
			ctx,
			`Brainstorm mode started${topic ? `: ${topic}` : ""}. Ask questions freely. Use /brainstorm to finish or /brainstorm cancel to discard.`,
		);
	};

	const stopBrainstorm = (
		action: Exclude<BrainstormAction, "start">,
		ctx: ExtensionContext,
		options?: { savedPath?: string; summary?: string; summaryInContext?: boolean },
	) => {
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
			savedPath: options?.savedPath,
			summary: options?.summary,
			summaryInContext: options?.summaryInContext,
		});

		pi.setActiveTools(previousTools);
		state = inactiveState();
		setCurrentUiState(ctx);
	};

	const finishBrainstorm = async (ctx: ExtensionCommandContext) => {
		if (!state.active) {
			notify(ctx, "Brainstorm mode is not active.", "warning");
			return;
		}

		await ensureSummaryModelPreferenceLoaded(ctx);
		const summary = await generateSummary(state, summaryModelPreference, ctx);
		if (summary === null) {
			notify(ctx, "Summary cancelled. Brainstorm mode is still active.", "info");
			return;
		}

		const reviewedSummary = await ctx.ui.editor("Review brainstorm brief", summary);
		if (reviewedSummary === undefined) {
			notify(ctx, "Finish cancelled. Brainstorm mode is still active.", "info");
			return;
		}

		const nextAction = await ctx.ui.select("Finish brainstorm", [
			SUMMARY_TO_CONTEXT_OPTION,
			SUMMARY_TO_MARKDOWN_OPTION,
			SUMMARY_TO_MARKDOWN_AND_CONTEXT_OPTION,
			CONTINUE_BRAINSTORMING_OPTION,
			EXIT_OPTION,
		]);

		if (!nextAction || nextAction === CONTINUE_BRAINSTORMING_OPTION) {
			notify(ctx, "Brainstorm mode is still active.", "info");
			return;
		}

		if (nextAction === EXIT_OPTION) {
			stopBrainstorm("finish", ctx);
			notify(ctx, "Brainstorm finished.", "info");
			return;
		}

		if (nextAction === SUMMARY_TO_CONTEXT_OPTION) {
			stopBrainstorm("finish", ctx, { summary: reviewedSummary, summaryInContext: true });
			notify(ctx, "Brainstorm finished. Transcript replaced by the reviewed brief in context.", "info");
			return;
		}

		const savedPath = await saveSummaryToFile(reviewedSummary, state, ctx);
		if (!savedPath) {
			notify(ctx, "Save cancelled. Brainstorm mode is still active.", "info");
			return;
		}

		if (nextAction === SUMMARY_TO_MARKDOWN_AND_CONTEXT_OPTION) {
			stopBrainstorm("finish", ctx, { savedPath, summary: reviewedSummary, summaryInContext: true });
			notify(ctx, `Brainstorm brief saved to ${savedPath}. Transcript replaced by the reviewed brief in context.`, "info");
			return;
		}

		stopBrainstorm("finish", ctx, { savedPath });
		notify(ctx, `Brainstorm brief saved to ${savedPath}`, "info");
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

	const openSummaryModelSelector = async (ctx: ExtensionCommandContext) => {
		const availableModels = ctx.modelRegistry
			.getAvailable()
			.slice()
			.sort((a, b) => formatModelRef(a.provider, a.id).localeCompare(formatModelRef(b.provider, b.id)));

		const optionMap = new Map<string, SummaryModelPreference | null>();
		const options: string[] = [];

		const defaultLabel = summaryModelPreference
			? "Use active model (default fallback)"
			: "Use active model (default fallback) ✓";
		optionMap.set(defaultLabel, null);
		options.push(defaultLabel);

		for (const model of availableModels) {
			const preference = { provider: model.provider, modelId: model.id };
			const labelBase = typeof model.name === "string" && model.name && model.name !== model.id
				? `${formatSummaryModelPreference(preference)} — ${model.name}`
				: formatSummaryModelPreference(preference);
			const isCurrent =
				!!summaryModelPreference &&
				summaryModelPreference.provider === preference.provider &&
				summaryModelPreference.modelId === preference.modelId;
			const label = isCurrent ? `${labelBase} ✓` : labelBase;
			optionMap.set(label, preference);
			options.push(label);
		}

		if (
			summaryModelPreference &&
			!availableModels.some(
				(model) =>
					model.provider === summaryModelPreference!.provider && model.id === summaryModelPreference!.modelId,
			)
		) {
			const unavailableLabel = `${formatSummaryModelPreference(summaryModelPreference)} (saved, unavailable) ✓`;
			optionMap.set(unavailableLabel, summaryModelPreference);
			options.splice(1, 0, unavailableLabel);
		}

		const choice = await ctx.ui.select("Brainstorm summary model", options);
		if (!choice || !optionMap.has(choice)) {
			return;
		}

		const nextPreference = optionMap.get(choice) ?? null;
		const saved = await updateSummaryModelPreference(nextPreference, ctx);
		if (!saved) {
			return;
		}

		if (!nextPreference) {
			notify(ctx, "Brainstorm summaries will use the active model by default.", "info");
			return;
		}

		notify(
			ctx,
			`Brainstorm summaries will prefer ${formatSummaryModelPreference(nextPreference)} and fall back to the active model when needed.`,
			"info",
		);
	};

	const handleSummaryModelCommand = async (args: string, ctx: ExtensionCommandContext) => {
		await ensureSummaryModelPreferenceLoaded(ctx);
		const trimmed = args.trim();

		if (!trimmed) {
			if (!ctx.hasUI) {
				notify(
					ctx,
					`Brainstorm summary model: ${summaryModelPreference ? formatSummaryModelPreference(summaryModelPreference) : "active model (default)"}`,
					"info",
				);
				return;
			}

			await openSummaryModelSelector(ctx);
			return;
		}

		if (SUMMARY_MODEL_CLEAR_ARGS.has(trimmed.toLowerCase())) {
			const saved = await updateSummaryModelPreference(null, ctx);
			if (saved) {
				notify(ctx, "Cleared the brainstorm summary model override. The active model will be used by default.", "info");
			}
			return;
		}

		const preference = parseSummaryModelPreference(trimmed);
		if (!preference) {
			notify(ctx, `Usage: /${SUMMARY_MODEL_COMMAND} [provider/model | clear]`, "warning");
			return;
		}

		const model = ctx.modelRegistry.find(preference.provider, preference.modelId);
		if (!model) {
			notify(ctx, `Model ${formatSummaryModelPreference(preference)} was not found.`, "warning");
			return;
		}

		const saved = await updateSummaryModelPreference(preference, ctx);
		if (!saved) {
			return;
		}

		const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
		if (!auth.ok || !auth.apiKey) {
			notify(
				ctx,
				`Saved ${formatSummaryModelPreference(preference)} as the summary model, but it is not currently authenticated. Pi will fall back to the active model until it becomes available.`,
				"warning",
			);
			return;
		}

		notify(
			ctx,
			`Saved ${formatSummaryModelPreference(preference)} as the brainstorm summary model.`,
			"info",
		);
	};

	pi.registerCommand("brainstorm", {
		description: "Start or finish read-only brainstorm mode",
		handler: handleBrainstormCommand,
	});

	pi.registerCommand(SUMMARY_MODEL_COMMAND, {
		description: "Configure the optional model used for brainstorm summaries",
		handler: handleSummaryModelCommand,
	});

	pi.registerShortcut(Key.ctrlAlt("b"), {
		description: "Start or finish read-only brainstorm mode",
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
			systemPrompt: `${event.systemPrompt}\n\nYou are in brainstorm mode. This is a read-only ideation session.\n\nRules:\n- Answer the user's questions directly.\n- Help compare ideas, sharpen tradeoffs, and refine thinking.\n- Do not suggest implementation steps, code changes, tasks, or action plans unless the user explicitly asks for them.\n- Do not volunteer to edit files, write code, or create plans.\n- If the user asks for the best option, choose one and explain why.\n- Avoid empty neutrality. Do not stop at \"it depends\"; still make a recommendation when the user wants one.\n- Be engaged and opinionated, but not pushy.\n- Keep answers concise unless the user asks for depth.\n- You may use the read tool when the user asks about an existing file or referenced context.\n- Do not use any tools other than read in brainstorm mode.\n${topicLine ? `- ${topicLine}` : ""}`,
		};
	});

	pi.on("context", async (_event, ctx) => {
		const messages = buildBrainstormAwareContextMessages(ctx.sessionManager.getBranch());
		if (!messages) {
			return;
		}

		return { messages };
	});

	pi.on("tool_call", async (event) => {
		if (!state.active) {
			return;
		}

		if (event.toolName === "read") {
			return;
		}

		return {
			block: true,
			reason: "Brainstorm mode is read-only. Only the read tool is allowed until you finish or cancel /brainstorm.",
		};
	});

	pi.on("session_start", async (_event, ctx) => {
		await ensureSummaryModelPreferenceLoaded(ctx);
		syncStateFromBranch(ctx);
	});

	pi.on("session_tree", async (_event, ctx) => {
		syncStateFromBranch(ctx);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		setBrainstormUi(ctx, inactiveState(), summaryModelPreference);
	});
}
