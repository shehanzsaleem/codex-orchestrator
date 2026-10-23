// tmux helper functions for codex-agent

import { execSync, spawnSync } from "child_process";
import { config } from "./config.ts";
import { resolveCodexCommand } from "./codex-bin.ts";

export interface TmuxSession {
  name: string;
  attached: boolean;
  windows: number;
  created: string;
}

const SESSION_COMPLETE_MARKER = "[codex-agent: Session complete";
const MODEL_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function validateModelName(model: string): string {
  if (!MODEL_NAME_PATTERN.test(model)) {
    throw new Error("Invalid Codex model name");
  }

  return model;
}

export function buildCodexArgs(options: {
  model: string;
  reasoningEffort: string;
  sandbox: string;
  notifyHook: string;
  jobId: string;
}): string {
  const model = validateModelName(options.model);
  const notifyConfig = `notify=${JSON.stringify([
    "bun",
    "run",
    options.notifyHook,
    options.jobId,
  ])}`;

  return [
    `-c`, shellQuote(`model="${model}"`),
    `-c`, shellQuote(`model_reasoning_effort="${options.reasoningEffort}"`),
    // Otherwise a new Codex release stops every agent at an "Update available"
    // prompt with "Update now" preselected, and the next `send` would accept it.
    `-c`, shellQuote("check_for_update_on_startup=false"),
    // Spinner/shimmer redraws cost CPU in codex, script and tmux and bloat the log.
    `-c`, shellQuote("tui.animations=false"),
    `-c`, shellQuote(notifyConfig),
    `--sandbox`, shellQuote(options.sandbox),
    `--ask-for-approval`, shellQuote("never"),
  ].join(" ");
}

/**
 * Run a tmux subcommand without a shell. These calls sit on polling paths, so
 * avoiding the extra /bin/sh per call halves the processes spawned.
 */
function runTmux(args: string[], maxBuffer?: number): { ok: boolean; stdout: string } {
  const result = spawnSync("tmux", args, {
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "ignore"],
    ...(maxBuffer ? { maxBuffer } : {}),
  });
  return { ok: result.status === 0, stdout: result.stdout ?? "" };
}

function listManagedSessionNames(): string[] {
  const prefixPattern = `${config.tmuxPrefix}-*`;

  try {
    const output = execSync(
      `tmux list-sessions -F "#{session_name}" -f "#{m:${prefixPattern},#{session_name}}" 2>/dev/null`,
      { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }
    ).trim();

    return output ? output.split("\n").filter(Boolean) : [];
  } catch {
    try {
      const output = execSync(
        `tmux list-sessions -F "#{session_name}" 2>/dev/null`,
        { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }
      );

      return output
        .trim()
        .split("\n")
        .filter((line) => line.startsWith(`${config.tmuxPrefix}-`));
    } catch {
      return [];
    }
  }
}

/**
 * Get tmux session name for a job
 */
export function getSessionName(jobId: string): string {
  return `${config.tmuxPrefix}-${jobId}`;
}

/**
 * Check if tmux is available
 */
export function isTmuxAvailable(): boolean {
  try {
    execSync("which tmux", { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

/**
 * Check if a tmux session exists
 */
export function sessionExists(sessionName: string): boolean {
  return runTmux(["has-session", "-t", sessionName]).ok;
}

/**
 * Create a new tmux session running codex (interactive mode)
 */
export function createSession(options: {
  jobId: string;
  prompt: string;
  model: string;
  reasoningEffort: string;
  sandbox: string;
  cwd: string;
}): { sessionName: string; success: boolean; error?: string } {
  const sessionName = getSessionName(options.jobId);
  const logFile = `${config.jobsDir}/${options.jobId}.log`;
  const jobFile = `${config.jobsDir}/${options.jobId}.json`;
  const notifyHook = `${import.meta.dir}/notify-hook.ts`;

  // Write prompt to a file so the shell command can read it without escaping issues
  const promptFile = `${config.jobsDir}/${options.jobId}.prompt`;
  const fs = require("fs");
  fs.writeFileSync(promptFile, options.prompt);

  try {
    // Build codex args - pass prompt as a CLI argument via $(cat promptFile)
    // so codex starts processing immediately (no fragile tmux send-keys)
    const codexArgs = buildCodexArgs({
      model: options.model,
      reasoningEffort: options.reasoningEffort,
      sandbox: options.sandbox,
      notifyHook,
      jobId: options.jobId,
    });

    const indexFile = `${config.jobsDir}/index.json`;
    const completionScript = [
      `import { readFileSync, writeFileSync, renameSync, openSync, fstatSync, readSync, closeSync } from "fs";`,
      `const jobPath = process.argv[1];`,
      `const exitCode = Number(process.argv[2] ?? "0");`,
      `const indexPath = process.argv[3];`,
      `const logPath = process.argv[4];`,
      `function parseUsage(text) {`,
      `  const pattern = /Token usage:\\s*total=([\\d,]+)\\s+input=([\\d,]+)(?:\\s+\\(\\+\\s*([\\d,]+)\\s+cached\\))?\\s+output=([\\d,]+)/gi;`,
      `  let usage = null;`,
      `  for (const match of text.matchAll(pattern)) {`,
      `    const total = Number.parseInt(match[1].replaceAll(",", ""), 10);`,
      `    const input = Number.parseInt(match[2].replaceAll(",", ""), 10);`,
      `    const cached_input = match[3] ? Number.parseInt(match[3].replaceAll(",", ""), 10) : 0;`,
      `    const output = Number.parseInt(match[4].replaceAll(",", ""), 10);`,
      `    if ([total, input, cached_input, output].every(Number.isFinite)) usage = { total, input, cached_input, output };`,
      `  }`,
      `  return usage;`,
      `}`,
      `function readTail(path, maxBytes) {`,
      `  const fd = openSync(path, "r");`,
      `  try {`,
      `    const size = fstatSync(fd).size;`,
      `    const length = Math.min(size, maxBytes);`,
      `    const buffer = Buffer.alloc(length);`,
      `    readSync(fd, buffer, 0, length, size - length);`,
      `    return buffer.toString("utf-8");`,
      `  } finally {`,
      `    closeSync(fd);`,
      `  }`,
      `}`,
      `try {`,
      `  const job = JSON.parse(readFileSync(jobPath, "utf-8"));`,
      `  if (job.status === "running" || job.status === "pending") {`,
      `    job.status = exitCode === 0 ? "completed" : "failed";`,
      `    job.completedAt = new Date().toISOString();`,
      `    job.turnState = "idle";`,
      `    if (exitCode !== 0 && !job.error) {`,
      `      job.error = \`Codex exited with code \${exitCode}\`;`,
      `    }`,
      `    try {`,
      `      const usage = parseUsage(readTail(logPath, ${config.logTailBytes}));`,
      `      if (usage) job.usage = usage;`,
      `    } catch {}`,
      `    writeFileSync(jobPath, JSON.stringify(job, null, 2));`,
      `  }`,
      `  try {`,
      `    const idx = JSON.parse(readFileSync(indexPath, "utf-8"));`,
      `    if (idx.jobs && idx.jobs[job.id]) {`,
      `      delete idx.jobs[job.id];`,
      `      idx.updatedAt = new Date().toISOString();`,
      `      const tmp = indexPath + "." + process.pid + ".tmp";`,
      `      writeFileSync(tmp, JSON.stringify(idx, null, 2));`,
      `      renameSync(tmp, indexPath);`,
      `    }`,
      `  } catch {}`,
      `} catch {`,
      `  process.exit(0);`,
      `}`,
    ].join(" ");

    const completionHook = [
      `exit_code=$?`,
      `bun -e ${shellQuote(completionScript)} ${shellQuote(jobFile)} "$exit_code" ${shellQuote(indexFile)} ${shellQuote(logFile)}`,
      `echo "\\n\\n[codex-agent: Session complete. Closing in 5s.]"`,
      `sleep 5`,
      `tmux kill-session -t ${shellQuote(sessionName)}`,
    ].join("; ");

    // Pass prompt via $(cat promptFile) so codex receives it at launch.
    // This avoids all fragile tmux send-keys timing issues with the TUI.
    // AI-DEVNOTE (2026-02-14): Platform-aware script command.
    // macOS: script -q <file> <command>
    // Linux: script -q -c "<command>" <file>
    const isLinux = process.platform === "linux";
    const codex = resolveCodexCommand();
    const codexEnv = Object.entries(codex.env)
      .map(([key, value]) => `${key}=${shellQuote(value)}`)
      .join(" ");
    const codexBin = codexEnv ? `env ${codexEnv} ${shellQuote(codex.path)}` : shellQuote(codex.path);
    const codexCmd = `${codexBin} ${codexArgs} "$(cat ${shellQuote(promptFile)})"`;
    const shellCmd = isLinux
      ? `script -q -e -c ${shellQuote(codexCmd)} ${shellQuote(logFile)}; ${completionHook}`
      : `script -q ${shellQuote(logFile)} ${codexCmd}; ${completionHook}`;

    const tmuxResult = spawnSync(
      "tmux",
      ["new-session", "-d", "-s", sessionName, "-c", options.cwd, shellCmd],
      { stdio: "pipe", cwd: options.cwd }
    );
    if (tmuxResult.status !== 0) {
      throw new Error((tmuxResult.stderr || tmuxResult.stdout).toString() || "tmux new-session failed");
    }

    return { sessionName, success: true };
  } catch (err) {
    return {
      sessionName,
      success: false,
      error: (err as Error).message,
    };
  }
}

/**
 * Send a message to a running codex session
 */
export function sendMessage(sessionName: string, message: string): boolean {
  if (!sessionExists(sessionName)) {
    return false;
  }

  try {
    const escapedMessage = message.replace(/'/g, "'\\''");
    execSync(`tmux send-keys -t "${sessionName}" '${escapedMessage}'`, {
      stdio: "pipe",
    });
    // Small delay before Enter for TUI to process
    spawnSync("sleep", ["0.3"]);
    execSync(`tmux send-keys -t "${sessionName}" Enter`, {
      stdio: "pipe",
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Send a control key to a session (like Ctrl+C)
 */
export function sendControl(sessionName: string, key: string): boolean {
  if (!sessionExists(sessionName)) {
    return false;
  }

  try {
    execSync(`tmux send-keys -t "${sessionName}" ${key}`, { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

/**
 * Capture the current pane content
 */
export function capturePane(
  sessionName: string,
  options: { lines?: number; start?: number } = {}
): string | null {
  // capture-pane fails on a missing session, so no separate has-session check.
  const args = ["capture-pane", "-t", sessionName, "-p"];
  if (options.start !== undefined) {
    args.push("-S", String(options.start));
  }

  const { ok, stdout: output } = runTmux(args);
  if (!ok) return null;

  if (options.lines) {
    const allLines = output.split("\n");
    return allLines.slice(-options.lines).join("\n");
  }

  return output;
}

/**
 * Get the full scrollback buffer
 */
export function captureFullHistory(sessionName: string): string | null {
  // Capture from start of history (-S -) to end
  const { ok, stdout } = runTmux(
    ["capture-pane", "-t", sessionName, "-p", "-S", "-"],
    50 * 1024 * 1024
  );
  return ok ? stdout : null;
}

/**
 * Kill a tmux session
 */
export function killSession(sessionName: string): boolean {
  return runTmux(["kill-session", "-t", sessionName]).ok;
}

/**
 * List all codex-agent sessions
 */
export function listSessions(): TmuxSession[] {
  try {
    const output = execSync(
      `tmux list-sessions -F "#{session_name}|#{session_attached}|#{session_windows}|#{session_created}" 2>/dev/null`,
      { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }
    );

    return output
      .trim()
      .split("\n")
      .filter((line) => line.startsWith(config.tmuxPrefix))
      .map((line) => {
        const [name, attached, windows, created] = line.split("|");
        return {
          name,
          attached: attached === "1",
          windows: parseInt(windows, 10),
          created: new Date(parseInt(created, 10) * 1000).toISOString(),
        };
      });
  } catch {
    return [];
  }
}

/**
 * Kill codex-agent sessions already sitting on the completion banner
 */
export function cleanupCompletedSessions(): string[] {
  const killed: string[] = [];

  for (const sessionName of listManagedSessionNames()) {
    const output = capturePane(sessionName, { lines: 20 });
    if (!output || !output.includes(SESSION_COMPLETE_MARKER)) {
      continue;
    }

    if (killSession(sessionName)) {
      killed.push(sessionName);
    }
  }

  return killed;
}

/**
 * Kill codex-agent tmux sessions that do not belong to active jobs.
 * Sessions younger than 30s are skipped to avoid racing with startJob().
 */
export function cleanupOrphanedSessions(activeSessionNames: Iterable<string>): string[] {
  const active = new Set(activeSessionNames);
  const killed: string[] = [];
  const now = Date.now();

  for (const sessionName of listManagedSessionNames()) {
    if (active.has(sessionName)) {
      continue;
    }

    // Skip young sessions - they may still be in the startup window
    // where the job JSON hasn't recorded tmuxSession yet.
    try {
      const created = execSync(
        `tmux display-message -t "${sessionName}" -p "#{session_created}"`,
        { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }
      ).trim();
      const ageMs = now - parseInt(created, 10) * 1000;
      if (ageMs < 30_000) continue;
    } catch {
      // If we can't read session age, skip it to be safe
      continue;
    }

    if (killSession(sessionName)) {
      killed.push(sessionName);
    }
  }

  return killed;
}

/**
 * Get the command to attach to a session (for display to user)
 */
export function getAttachCommand(sessionName: string): string {
  return `tmux attach -t "${sessionName}"`;
}

/**
 * Check if the session's codex process is still running
 */
export function isSessionActive(sessionName: string): boolean {
  try {
    // Check if the pane has a running process
    const { ok, stdout } = runTmux(["list-panes", "-t", sessionName, "-F", "#{pane_pid}"]);
    const pid = stdout.trim();

    if (!ok || !pid) return false;

    // Check if that process is still running
    process.kill(parseInt(pid, 10), 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Watch a session's output (returns a stream of updates)
 * This is for programmatic watching - for interactive use, just attach
 */
export function watchSession(
  sessionName: string,
  callback: (content: string) => void,
  intervalMs: number = 1000
): { stop: () => void } {
  let lastContent = "";
  let running = true;

  const interval = setInterval(() => {
    if (!running) return;

    const content = capturePane(sessionName, { lines: 100 });
    if (content && content !== lastContent) {
      // Only send the new lines
      const newContent = content.replace(lastContent, "").trim();
      if (newContent) {
        callback(newContent);
      }
      lastContent = content;
    }

    // Check if session still exists
    if (!sessionExists(sessionName)) {
      running = false;
      clearInterval(interval);
    }
  }, intervalMs);

  return {
    stop: () => {
      running = false;
      clearInterval(interval);
    },
  };
}
