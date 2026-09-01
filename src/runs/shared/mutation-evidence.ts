import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ArtifactPaths, RegisteredOutputInspection, TimeoutRecoveryProjection, TimeoutRecoverySummary, TrackedMutationEvidence, TrackedMutationFingerprint, TrackedMutationSnapshot } from "../../shared/types.ts";

const MAX_TRACKED_PATHS = 500;
const MAX_HASH_BYTES = 1024 * 1024;
const MAX_TIMEOUT_FILES = 20;

function gitArguments(args: string[]): string[] {
	// Mutation evidence must not block child startup on a stale fsmonitor daemon.
	return ["-c", "core.fsmonitor=false", ...args];
}

function gitOutput(cwd: string, args: string[], maxBuffer = MAX_HASH_BYTES): string {
	return execFileSync("git", gitArguments(args), { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"], maxBuffer, windowsHide: true });
}

function splitNul(output: string): string[] {
	return output.split("\0").filter((part) => part.length > 0);
}

function hashLargeDiff(cwd: string, relativePath: string): string {
	const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-tracked-diff-"));
	const diffPath = path.join(tempDir, "diff.patch");
	try {
		execFileSync("git", gitArguments(["diff", "--no-ext-diff", "--binary", `--output=${diffPath}`, "HEAD", "--", relativePath]), { cwd, stdio: "ignore", windowsHide: true });
		const hash = createHash("sha256");
		const buffer = Buffer.allocUnsafe(64 * 1024);
		const fd = fs.openSync(diffPath, "r");
		try {
			for (;;) {
				const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, null);
				if (bytesRead === 0) break;
				hash.update(buffer.subarray(0, bytesRead));
			}
		} finally {
			fs.closeSync(fd);
		}
		return hash.digest("hex");
	} finally {
		fs.rmSync(tempDir, { recursive: true, force: true });
	}
}

function listChangedTrackedFiles(cwd: string): { paths: string[]; truncated: boolean } {
	const paths = splitNul(gitOutput(cwd, ["diff", "--no-ext-diff", "--name-only", "-z", "HEAD", "--"], MAX_HASH_BYTES));
	return { paths: paths.slice(0, MAX_TRACKED_PATHS), truncated: paths.length > MAX_TRACKED_PATHS };
}

function fingerprintPath(cwd: string, relativePath: string): TrackedMutationFingerprint {
	try {
		const diff = gitOutput(cwd, ["diff", "--no-ext-diff", "--binary", "HEAD", "--", relativePath], MAX_HASH_BYTES);
		return { kind: "diff", digest: createHash("sha256").update(diff).digest("hex") };
	} catch {
		return { kind: "diff", digest: hashLargeDiff(cwd, relativePath) };
	}
}

function sameFingerprint(left: TrackedMutationFingerprint | undefined, right: TrackedMutationFingerprint): boolean {
	if (!left || left.kind !== "diff" || right.kind !== "diff") return false;
	return left.digest === right.digest;
}

export function snapshotTrackedMutations(cwd: string): TrackedMutationSnapshot {
	try {
		const changed = listChangedTrackedFiles(cwd);
		const fingerprints: Record<string, TrackedMutationFingerprint> = {};
		for (const file of changed.paths) fingerprints[file] = fingerprintPath(cwd, file);
		return { source: "tracked-files", trackedOnly: true, cwd, dirtyFiles: changed.paths, fingerprints, truncated: changed.truncated };
	} catch (error) {
		return { source: "tracked-files", trackedOnly: true, cwd, dirtyFiles: [], fingerprints: {}, unavailable: error instanceof Error ? error.message : String(error) };
	}
}

export function collectTrackedMutationEvidence(snapshot: TrackedMutationSnapshot, cwd = snapshot.cwd): TrackedMutationEvidence {
	if (snapshot.unavailable) {
		return { source: "tracked-files", trackedOnly: true, changedFiles: [], attemptedMutation: false, unavailable: snapshot.unavailable };
	}
	try {
		const current = listChangedTrackedFiles(cwd);
		const startDirty = new Set(snapshot.dirtyFiles);
		const candidates = new Set([...snapshot.dirtyFiles, ...current.paths]);
		const changedFiles: string[] = [];
		for (const file of candidates) {
			if (!startDirty.has(file)) {
				if (!snapshot.truncated) changedFiles.push(file);
				continue;
			}
			if (!sameFingerprint(snapshot.fingerprints[file], fingerprintPath(cwd, file))) changedFiles.push(file);
		}
		changedFiles.sort();
		return {
			source: "tracked-files",
			trackedOnly: true,
			changedFiles,
			attemptedMutation: changedFiles.length > 0,
			truncated: snapshot.truncated || current.truncated || undefined,
		};
	} catch (error) {
		return { source: "tracked-files", trackedOnly: true, changedFiles: [], attemptedMutation: false, unavailable: error instanceof Error ? error.message : String(error) };
	}
}

function formatPathList(paths: string[]): string {
	if (paths.length === 0) return "none";
	const shown = paths.slice(0, MAX_TIMEOUT_FILES).join(", ");
	return paths.length > MAX_TIMEOUT_FILES ? `${shown}, ... (${paths.length - MAX_TIMEOUT_FILES} more)` : shown;
}

function projectOutputInspection(value: unknown): RegisteredOutputInspection | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const source = value as Record<string, unknown>;
	const status = source.status === "missing"
		|| source.status === "unreadable"
		|| source.status === "empty"
		|| source.status === "unchanged"
		|| source.status === "usable-partial"
		? source.status
		: undefined;
	if (!status) return undefined;
	const size = typeof source.size === "number" && Number.isFinite(source.size) && source.size >= 0 ? source.size : undefined;
	if (status === "missing") return { status };
	if (status === "unreadable") {
		const error = typeof source.error === "string" ? source.error.slice(0, 500) : "Registered output could not be inspected.";
		return { status, ...(size !== undefined ? { size } : {}), error };
	}
	if (size === undefined) return undefined;
	if (status === "empty") return size === 0 ? { status, size: 0 } : undefined;
	return { status, size };
}

/** Keep status and completion details to bounded routing evidence, not raw output or effects. */
export function projectTimeoutRecovery(value: unknown): TimeoutRecoveryProjection | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const source = value as Record<string, unknown>;
	const termination = source.termination === "timed-out" || source.termination === "stopped" ? source.termination : undefined;
	if (!termination || !Array.isArray(source.changedFiles)) return undefined;
	const allChangedFiles = source.changedFiles.filter((file): file is string => typeof file === "string");
	const changedFiles = allChangedFiles.slice(0, MAX_TIMEOUT_FILES);
	const reportStatus = source.reportStatus === "missing"
		|| source.reportStatus === "written"
		|| source.reportStatus === "not-requested"
		|| source.reportStatus === "unknown"
		? source.reportStatus
		: undefined;
	const outputClassification = source.outputClassification === "no-usable-output"
		|| source.outputClassification === "usable-partial-output"
		? source.outputClassification
		: undefined;
	const outputInspection = projectOutputInspection(source.outputInspection);
	return {
		termination,
		changedFiles,
		...(source.truncated === true || allChangedFiles.length > changedFiles.length ? { truncated: true } : {}),
		...(source.recoveryNeeded === true ? { recoveryNeeded: true } : {}),
		...(source.reason === "timed-out-with-dirty-worktree" ? { reason: source.reason } : {}),
		...(reportStatus ? { reportStatus } : {}),
		...(outputClassification ? { outputClassification } : {}),
		...(outputInspection ? { outputInspection } : {}),
	};
}

/** Render only the bounded recovery route needed by a parent/operator. */
export function formatTimeoutRecoveryLines(value: unknown, indent = ""): string[] {
	const recovery = projectTimeoutRecovery(value);
	if (!recovery) return [];
	const usablePartialOutput = recovery.outputClassification === "usable-partial-output";
	if (!recovery.recoveryNeeded && !usablePartialOutput) return [];
	const changedFiles = recovery.changedFiles.length > 0
		? `${recovery.changedFiles.join(", ")}${recovery.truncated ? ", …" : ""}`
		: "none";
	const changedFileCount = recovery.changedFiles.length > 0 ? `${recovery.changedFiles.length}${recovery.truncated ? "+" : ""}` : "0";
	return [
		usablePartialOutput
			? `${indent}Usable partial output: inspect the registered output and partial changes before resuming.`
			: `${indent}Recovery needed: review the diff and artifacts before resuming or launching dependent stages.`,
		`${indent}Recovery evidence: requested report: ${recovery.reportStatus ?? "unknown"}; registered output: ${recovery.outputInspection?.status ?? "not-requested"}; changed tracked files: ${changedFiles} (${changedFileCount}); classification: ${recovery.reason ?? recovery.outputClassification ?? recovery.termination}`,
	];
}

export function buildTimeoutRecoverySummary(input: {
	termination: "timed-out" | "stopped";
	evidence: TrackedMutationEvidence;
	requiredOutputMissing?: boolean;
	outputInspection?: RegisteredOutputInspection;
	currentTool?: string;
	currentToolArgs?: string;
	currentPath?: string;
	sessionFile?: string;
	transcriptPath?: string;
	artifactPaths?: ArtifactPaths;
}): TimeoutRecoverySummary {
	const outputClassification = input.outputInspection?.status === "usable-partial"
		? "usable-partial-output" as const
		: input.outputInspection
			? "no-usable-output" as const
			: undefined;
	const warning = outputClassification === "usable-partial-output"
		? "Inspect the usable partial output and partial changes before retrying or resuming the child."
		: "Inspect partial changes before retrying or resuming the child.";
	const changedFiles = input.evidence.changedFiles.slice(0, MAX_TIMEOUT_FILES);
	let reportStatus: "missing" | "written" | "not-requested" = "not-requested";
	if (input.requiredOutputMissing === true) reportStatus = "missing";
	else if (input.requiredOutputMissing === false) reportStatus = "written";
	const recoveryNeeded = input.termination === "timed-out"
		&& reportStatus === "missing"
		&& outputClassification !== "usable-partial-output"
		&& input.evidence.changedFiles.length > 0;
	const lines = [
		"Recovery summary:",
		`- termination: ${input.termination}`,
		`- changed tracked files: ${input.evidence.unavailable ? `unavailable (${input.evidence.unavailable})` : formatPathList(input.evidence.changedFiles)}`,
	];
	if (input.requiredOutputMissing !== undefined) lines.push(`- requested report: ${reportStatus}`);
	if (input.outputInspection) {
		const size = "size" in input.outputInspection ? `${input.outputInspection.size} bytes` : "unknown size";
		lines.push(`- registered output: ${input.outputInspection.status} (${size})`);
		lines.push(`- output classification: ${outputClassification}`);
	}
	if (recoveryNeeded) lines.push("- Recovery needed: review the diff and artifacts before resuming or launching dependent stages.");
	if (input.currentTool) lines.push(`- active tool: ${input.currentTool}${input.currentToolArgs ? ` — ${input.currentToolArgs}` : ""}`);
	if (input.currentPath) lines.push(`- active path: ${input.currentPath}`);
	if (input.sessionFile) lines.push(`- session file: ${input.sessionFile}`);
	if (input.transcriptPath) lines.push(`- transcript: ${input.transcriptPath}`);
	if (input.artifactPaths?.outputPath) lines.push(`- output artifact: ${input.artifactPaths.outputPath}`);
	if (input.artifactPaths?.metadataPath) lines.push(`- metadata artifact: ${input.artifactPaths.metadataPath}`);
	lines.push(`Warning: ${warning}`);
	return {
		termination: input.termination,
		changedFiles,
		truncated: input.evidence.changedFiles.length > changedFiles.length || input.evidence.truncated || undefined,
		...(recoveryNeeded ? { recoveryNeeded: true, reason: "timed-out-with-dirty-worktree" as const } : {}),
		reportStatus,
		outputClassification,
		outputInspection: input.outputInspection,
		currentTool: input.currentTool,
		currentToolArgs: input.currentToolArgs,
		currentPath: input.currentPath,
		sessionFile: input.sessionFile,
		transcriptPath: input.transcriptPath,
		artifactPaths: input.artifactPaths,
		warning,
		message: lines.join("\n"),
	};
}
