import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { config } from "./config.ts";
import { isMainThreadTurn, updateJobTurn } from "./watcher.ts";

const MAIN_THREAD = "01a168a0-dcbe-7582-8880-e59a6577a64a";
const TITLE_THREAD = "01a168a0-dd59-7520-bfb1-4f6d33039cde";
const PROMPT = "Fix the flaky login test.\n\nKeep the change small.";
const TITLE_INPUT = "Generate a concise, single-line task title of at most 36 characters.";

const originalJobsDir = config.jobsDir;
const originalJobsIndexFile = config.jobsIndexFile;
const originalCodexHome = process.env.CODEX_HOME;
let home: string;

function writeJob(id: string, extra: Record<string, unknown> = {}): void {
  writeFileSync(
    join(config.jobsDir, `${id}.json`),
    JSON.stringify({ id, status: "running", turnState: "working", ...extra }),
  );
  // createSession writes the prompt file; codex receives it via "$(cat file)".
  writeFileSync(join(config.jobsDir, `${id}.prompt`), `${PROMPT}\n`);
}

function writeSession(threadId: string, threadSource: string): void {
  const dir = join(home, ".codex", "sessions", "2026", "10", "23");
  mkdirSync(dir, { recursive: true });
  const meta = { type: "session_meta", payload: { id: threadId, source: "cli", thread_source: threadSource } };
  writeFileSync(join(dir, `rollout-2026-10-23T11-58-55-${threadId}.jsonl`), `${JSON.stringify(meta)}\n`);
}

function readJob(id: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(config.jobsDir, `${id}.json`), "utf-8"));
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "codex-agent-watcher-"));
  config.jobsDir = join(home, ".codex-agent", "jobs");
  config.jobsIndexFile = join(config.jobsDir, "index.json");
  mkdirSync(config.jobsDir, { recursive: true });
  process.env.CODEX_HOME = join(home, ".codex");
});

afterEach(() => {
  config.jobsDir = originalJobsDir;
  config.jobsIndexFile = originalJobsIndexFile;
  if (originalCodexHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = originalCodexHome;
});

describe("main thread turn filter", () => {
  test("ignores Codex's title-generation thread", () => {
    writeJob("job");
    expect(isMainThreadTurn("job", TITLE_THREAD, [TITLE_INPUT])).toBe(false);
  });

  test("accepts the thread whose first input is the job prompt", () => {
    writeJob("job");
    expect(isMainThreadTurn("job", MAIN_THREAD, [PROMPT])).toBe(true);
  });

  test("only the recorded thread counts once a turn has been recorded", () => {
    writeJob("job");
    updateJobTurn("job", {
      turnId: "turn-1",
      threadId: MAIN_THREAD,
      lastAgentMessage: "Done.",
      timestamp: new Date().toISOString(),
    });

    expect(readJob("job").codexThreadId).toBe(MAIN_THREAD);
    expect(isMainThreadTurn("job", MAIN_THREAD, [PROMPT, "follow-up"])).toBe(true);
    expect(isMainThreadTurn("job", TITLE_THREAD, [TITLE_INPUT])).toBe(false);
  });

  test("falls back to a user-started session when the input does not match", () => {
    writeJob("job");
    writeSession(MAIN_THREAD, "user");
    expect(isMainThreadTurn("job", MAIN_THREAD, ["prompt as rewritten by codex"])).toBe(true);
  });

  test("does not take a sub-agent session for the main thread", () => {
    writeJob("job");
    writeSession(MAIN_THREAD, "subagent");
    expect(isMainThreadTurn("job", MAIN_THREAD, ["delegated task"])).toBe(false);
  });

  test("accepts payloads from Codex versions without thread ids", () => {
    writeJob("job");
    expect(isMainThreadTurn("job", null, undefined)).toBe(true);
  });
});

describe("notify hook", () => {
  function runHook(payload: Record<string, unknown>) {
    return Bun.spawnSync({
      cmd: [process.execPath, "src/notify-hook.ts", "job", JSON.stringify(payload)],
      env: { ...process.env, HOME: home, CODEX_HOME: join(home, ".codex") },
      stdout: "pipe",
      stderr: "pipe",
    });
  }

  test("a title turn finishing first neither signals nor counts as the agent's turn", () => {
    writeJob("job");

    runHook({
      type: "agent-turn-complete",
      "thread-id": TITLE_THREAD,
      "turn-id": "title-turn",
      "input-messages": [TITLE_INPUT],
      "last-assistant-message": "Fix flaky login test",
    });
    expect(existsSync(join(config.jobsDir, "job.turn-complete"))).toBe(false);
    expect(readJob("job").turnsCompleted).toBeUndefined();

    runHook({
      type: "agent-turn-complete",
      "thread-id": MAIN_THREAD,
      "turn-id": "main-turn",
      "input-messages": [PROMPT],
      "last-assistant-message": "Fixed the race in the login test.",
    });
    const job = readJob("job");
    expect(job.turnsCompleted).toBe(1);
    expect(job.lastAgentMessage).toBe("Fixed the race in the login test.");
    expect(job.codexThreadId).toBe(MAIN_THREAD);
    expect(JSON.parse(readFileSync(join(config.jobsDir, "job.turn-complete"), "utf-8")).lastAgentMessage).toBe(
      "Fixed the race in the login test.",
    );
  });
});
