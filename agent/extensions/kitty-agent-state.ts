import { execFile } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, resolve } from "node:path";
interface ExtensionAPI { on(event: string, handler: (event: unknown, ctx: PiContext) => unknown): void; }
interface PiContextUi { setTitle(title: string): void; }
interface PiSessionManager { getSessionFile?: () => string | null | undefined; }
interface PiContext { cwd: string; hasUI: boolean; ui: PiContextUi; sessionManager?: PiSessionManager; }
interface TitleConfig { enabled: boolean; workingPrefix: string; blockedPrefix: string; baseTitle: string; }
interface NotificationsConfig { enabled: boolean; states: Status[]; }
interface BlockedDetectionConfig { inputTools: string[]; riskyBashPatterns: string[]; }
interface LoggingConfig { path: string; }
interface Config { enabled: boolean; title: TitleConfig; notifications: NotificationsConfig; blockedDetection: BlockedDetectionConfig; logging: LoggingConfig; }
interface SessionState { status: Status; baseTitle: string; cwd: string; project: string; blockedToolIds: Set<string>; }
interface ToolEventShape { toolCallId?: unknown; id?: unknown; toolName?: unknown; name?: unknown; input?: unknown; args?: unknown; tool?: { name?: unknown; input?: unknown }; }
const STATUS = {
	IDLE: "idle",
	WORKING: "working",
	BLOCKED: "blocked",
} as const;
type Status = (typeof STATUS)[keyof typeof STATUS];
const DEFAULT_LOG_PATH = resolve(homedir(), ".local", "state", "kitty-agent-state", "debug.log");
const DEFAULT_CONFIG_PATH = resolve(homedir(), ".config", "kitty-agent-state", "config.json");
const DEFAULT_RISKY_BASH_PATTERNS = [
	String.raw`\brm\s+-(?:[^\n;]*r[^\n;]*f|[^\n;]*f[^\n;]*r)`,
	String.raw`\bgit\s+reset\s+--hard\b`,
	String.raw`\bgit\s+clean\b(?=[^\n]*(?:-[^\n]*f|--force))`,
	String.raw`\bnpm\s+publish\b`,
	String.raw`\bdd\s+if=`,
	String.raw`\/dev\/(?:sd[a-z]|nvme\d+n\d+)`,
	String.raw`\bchmod\s+-R\s+777\b`,
	String.raw`\bchown\s+-R\b`,
];
const DEFAULT_CONFIG: Config = {
	enabled: true,
	title: {
		enabled: true,
		workingPrefix: "● working —",
		blockedPrefix: "● blocked —",
		baseTitle: "",
	},
	notifications: {
		enabled: true,
		states: [STATUS.WORKING, STATUS.BLOCKED, STATUS.IDLE],
	},
	blockedDetection: {
		inputTools: ["ask", "askuserquestion", "select", "confirm", "prompt", "requestuserinput"],
		riskyBashPatterns: DEFAULT_RISKY_BASH_PATTERNS,
	},
	logging: {
		path: DEFAULT_LOG_PATH,
	},
};
const TOKYO_NIGHT_COLORS: Record<Status, string> = {
	idle: "9ece6a",
	working: "7aa2f7",
	blocked: "f7768e",
};
const SOUND_PATHS: Record<Status, string> = {
	idle: "/usr/share/sounds/freedesktop/stereo/complete.oga",
	working: "/usr/share/sounds/freedesktop/stereo/message.oga",
	blocked: "/usr/share/sounds/freedesktop/stereo/dialog-warning.oga",
};
const sessions = new Map<string, SessionState>();
let config = DEFAULT_CONFIG;
let configLoaded = false;
let disabled = false;
function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
function asString(value: unknown, fallback: string): string {
	return typeof value === "string" ? value : fallback;
}
function asBoolean(value: unknown, fallback: boolean): boolean {
	return typeof value === "boolean" ? value : fallback;
}
function asStringArray(value: unknown, fallback: string[]): string[] {
	if (!Array.isArray(value)) return [...fallback];
	const parsed = value.filter(
		(item): item is string => typeof item === "string",
	);
	return parsed.length > 0 ? [...fallback, ...parsed] : [...fallback];
}
function asStatusArray(value: unknown, fallback: Status[]): Status[] {
	if (!Array.isArray(value)) return [...fallback];
	const parsed = value.filter((item): item is Status =>
		[STATUS.IDLE, STATUS.WORKING, STATUS.BLOCKED].includes(item as Status),
	);
	return parsed.length > 0 ? parsed : [...fallback];
}
function formatError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
function debugLog(message: string): void {
	try {
		const logPath = config.logging.path || DEFAULT_LOG_PATH;
		mkdirSync(dirname(logPath), { recursive: true });
		appendFileSync(logPath, `${new Date().toISOString()} ${message}\n`, "utf8");
	} catch {}
}
function configPath(): string {
	return process.env.KITTY_AGENT_STATE_CONFIG?.trim() || DEFAULT_CONFIG_PATH;
}
function mergeConfig(raw: unknown): Config {
	if (!isRecord(raw)) return DEFAULT_CONFIG;
	const rawTitle = isRecord(raw.title) ? raw.title : {};
	const rawNotifications = isRecord(raw.notifications) ? raw.notifications : {};
	const rawBlocked = isRecord(raw.blockedDetection) ? raw.blockedDetection : {};
	const rawLogging = isRecord(raw.logging) ? raw.logging : {};
	return {
		enabled: asBoolean(raw.enabled, DEFAULT_CONFIG.enabled),
		title: {
			enabled: asBoolean(rawTitle.enabled, DEFAULT_CONFIG.title.enabled),
			workingPrefix: asString(
				rawTitle.workingPrefix,
				DEFAULT_CONFIG.title.workingPrefix,
			),
			blockedPrefix: asString(
				rawTitle.blockedPrefix,
				DEFAULT_CONFIG.title.blockedPrefix,
			),
			baseTitle: asString(rawTitle.baseTitle, DEFAULT_CONFIG.title.baseTitle),
		},
		notifications: {
			enabled: asBoolean(
				rawNotifications.enabled,
				DEFAULT_CONFIG.notifications.enabled,
			),
			states: asStatusArray(
				rawNotifications.states,
				DEFAULT_CONFIG.notifications.states,
			),
		},
		blockedDetection: {
			inputTools: asStringArray(
				rawBlocked.inputTools,
				DEFAULT_CONFIG.blockedDetection.inputTools,
			),
			riskyBashPatterns: asStringArray(
				rawBlocked.riskyBashPatterns,
				DEFAULT_CONFIG.blockedDetection.riskyBashPatterns,
			),
		},
		logging: {
			path: asString(rawLogging.path, DEFAULT_CONFIG.logging.path),
		},
	};
}
function loadConfig(): void {
	if (configLoaded) return;
	configLoaded = true;
	const path = configPath();
	try {
		if (!existsSync(path)) {
			debugLog(`config missing at ${path}; using defaults`);
			return;
		}
		config = mergeConfig(JSON.parse(readFileSync(path, "utf8")) as unknown);
		debugLog(`config loaded from ${path}`);
	} catch (error) {
		config = DEFAULT_CONFIG;
		debugLog(
			`config load failed at ${path}; using defaults: ${formatError(error)}`,
		);
	}
}
function isDisabledByEnvironment(): boolean {
	return (
		process.env.KITTY_AGENT_STATE === "0" ||
		process.env.PI_SUBAGENT_CHILD === "1" ||
		process.env.HERDR_ENV === "1"
	);
}
function ensureEnabled(): boolean {
	if (disabled) return false;
	if (isDisabledByEnvironment()) {
		disabled = true;
		debugLog("disabled by environment guard");
		return false;
	}
	loadConfig();
	if (!config.enabled) {
		disabled = true;
		debugLog("disabled by config");
		return false;
	}
	return true;
}
function sessionKey(ctx: PiContext): string {
	try {
		const file = ctx.sessionManager?.getSessionFile?.();
		if (file) return file;
	} catch (error) {
		debugLog(`session key lookup failed: ${formatError(error)}`);
	}
	return ctx.cwd || "default";
}
function projectLabel(ctx: PiContext): string {
	const name = basename(resolve(ctx.cwd || "."));
	return name && name !== "." ? name : ctx.cwd || "pi";
}
function sessionState(ctx: PiContext): SessionState {
	const key = sessionKey(ctx);
	const existing = sessions.get(key);
	if (existing) return existing;
	const project = projectLabel(ctx);
	const created: SessionState = {
		status: STATUS.IDLE,
		baseTitle: config.title.baseTitle.trim() || project,
		cwd: ctx.cwd,
		project,
		blockedToolIds: new Set<string>(),
	};
	sessions.set(key, created);
	return created;
}
function activeTitle(status: Status, baseTitle: string): string {
	if (status === STATUS.IDLE) return baseTitle;
	const prefix =
		status === STATUS.WORKING
			? config.title.workingPrefix
			: config.title.blockedPrefix;
	return baseTitle ? `${prefix.trimEnd()} ${baseTitle}` : prefix.trimEnd();
}
function publishTitle(ctx: PiContext, state: SessionState): void {
	if (!config.title.enabled || !ctx.hasUI) return;
	try {
		ctx.ui.setTitle(activeTitle(state.status, state.baseTitle));
	} catch (error) {
		debugLog(`title update failed: ${formatError(error)}`);
	}
}
function notificationBody(state: SessionState): string {
	const project = state.project || "Pi";
	if (state.status === STATUS.BLOCKED)
		return `🔴 Pi necesita atención — ${project}`;
	if (state.status === STATUS.WORKING) return `🔵 Pi trabajando — ${project}`;
	return `🟢 Pi terminó — ${project}`;
}
function playNotificationSound(state: SessionState): void {
	if (state.status === STATUS.WORKING) return;
	const soundPath = SOUND_PATHS[state.status];
	if (!existsSync(soundPath)) return;
	try {
		execFile("paplay", [soundPath], (error) => {
			if (error) debugLog(`sound failed: ${formatError(error)}`);
		});
	} catch (error) {
		debugLog(`sound spawn failed: ${formatError(error)}`);
	}
}
function publishNotification(state: SessionState): void {
	if (
		!config.notifications.enabled ||
		!config.notifications.states.includes(state.status)
	)
		return;
	playNotificationSound(state);
	try {
		execFile(
			"hyprctl",
			[
				"notify",
				"3",
				"5000",
				`rgba(${TOKYO_NIGHT_COLORS[state.status]}ff)`,
				"kitty-agent-state",
				notificationBody(state),
			],
			(error) => {
				if (error) debugLog(`notification failed: ${formatError(error)}`);
			},
		);
	} catch (error) {
		debugLog(`notification spawn failed: ${formatError(error)}`);
	}
}
function transitionTo(ctx: PiContext, next: Status): void {
	if (!ensureEnabled()) return;
	const state = sessionState(ctx);
	if (state.status === next) return;
	state.status = next;
	if (next === STATUS.IDLE) state.blockedToolIds.clear();
	publishTitle(ctx, state);
	publishNotification(state);
}
function normalizeToolName(name: string): string {
	return name.toLowerCase().replace(/[^a-z0-9]/g, "");
}
function toolName(event: unknown): string {
	if (!isRecord(event)) return "";
	const shape = event as ToolEventShape;
	const value = shape.toolName ?? shape.name ?? shape.tool?.name;
	return typeof value === "string" ? value : "";
}
function toolCallId(event: unknown): string {
	if (!isRecord(event)) return "";
	const shape = event as ToolEventShape;
	const value = shape.toolCallId ?? shape.id;
	return typeof value === "string" ? value : "";
}
function commandInput(event: unknown): string {
	if (!isRecord(event)) return "";
	const shape = event as ToolEventShape;
	const input = shape.input ?? shape.args ?? shape.tool?.input;
	if (typeof input === "string") return input;
	if (!isRecord(input)) return "";
	const command = input.command ?? input.script ?? input.text ?? input.value;
	return typeof command === "string" ? command : "";
}
function toolNameTokens(name: string): string[] {
	return name
		.toLowerCase()
		.split(/[^a-z0-9]+/)
		.filter(Boolean);
}
function isInputTool(name: string): boolean {
	const normalized = normalizeToolName(name);
	const tokens = toolNameTokens(name);
	return config.blockedDetection.inputTools.some((candidate) => {
		const normalizedCandidate = normalizeToolName(candidate);
		return Boolean(
			normalizedCandidate &&
				(normalized === normalizedCandidate ||
					tokens.includes(normalizedCandidate) ||
					(normalizedCandidate.length >= 8 &&
						normalized.endsWith(normalizedCandidate))),
		);
	});
}
function isBashTool(name: string): boolean {
	const normalized = normalizeToolName(name);
	return (
		normalized === "bash" ||
		normalized.endsWith("bash") ||
		normalized === "shell"
	);
}
function isRiskyCommand(command: string): boolean {
	return config.blockedDetection.riskyBashPatterns.some((source) => {
		try {
			return new RegExp(source, "i").test(command);
		} catch (error) {
			debugLog(
				`invalid risky command pattern ignored: ${source}: ${formatError(error)}`,
			);
			return false;
		}
	});
}
function shouldMarkBlocked(event: unknown): boolean {
	const name = toolName(event);
	if (isInputTool(name)) return true;
	return isBashTool(name) && isRiskyCommand(commandInput(event));
}
const IDLESS_BLOCKED_TOOL = "__kitty_agent_state_idless_blocked_tool__";
function handleToolObservation(event: unknown, ctx: PiContext): void {
	if (!ensureEnabled()) return;
	const state = sessionState(ctx);
	if (state.status !== STATUS.WORKING || !shouldMarkBlocked(event)) return;
	state.blockedToolIds.add(toolCallId(event) || IDLESS_BLOCKED_TOOL);
	transitionTo(ctx, STATUS.BLOCKED);
}
function handleToolCompletion(event: unknown, ctx: PiContext): void {
	if (!ensureEnabled()) return;
	const state = sessionState(ctx);
	if (state.status !== STATUS.BLOCKED) return;
	const id = toolCallId(event) || IDLESS_BLOCKED_TOOL;
	if (!state.blockedToolIds.has(id)) return;
	state.blockedToolIds.delete(id);
	if (state.blockedToolIds.size === 0) transitionTo(ctx, STATUS.WORKING);
}
export default function (pi: ExtensionAPI) {
	pi.on("session_start", (_event, ctx) => {
		if (!ensureEnabled()) return;
		const state = sessionState(ctx);
		publishTitle(ctx, state);
		debugLog(`initialized for ${state.project} at ${state.cwd}`);
	});
	pi.on("agent_start", (_event, ctx) => transitionTo(ctx, STATUS.WORKING));
	pi.on("agent_end", (_event, ctx) => transitionTo(ctx, STATUS.IDLE));
	pi.on("session_shutdown", (_event, ctx) => {
		transitionTo(ctx, STATUS.IDLE);
		debugLog(`shutdown for ${sessionKey(ctx)}`);
		sessions.delete(sessionKey(ctx));
	});
	pi.on("tool_call", handleToolObservation);
	pi.on("tool_execution_start", handleToolObservation);
	pi.on("tool_execution_update", () => undefined);
	pi.on("tool_result", handleToolCompletion);
	pi.on("tool_execution_end", handleToolCompletion);
}
