import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import type { Job } from "./jobs.ts";

// Fixture timestamps sit shortly before "now" so jobs are never derived as
// STALE (no activity for config.defaultTimeout) when the suite runs later.
const FIXTURE_BASE_MS = Date.now() - 10 * 60 * 1000;
function fixtureTime(seconds: number): string {
  return new Date(FIXTURE_BASE_MS + seconds * 1000).toISOString();
}

function makeHome(): string {
  const home = mkdtempSync(join(tmpdir(), "codex-agent-cli-contract-"));
  mkdirSync(join(home, ".codex-agent", "jobs"), { recursive: true });
  return home;
}

function jobsDir(home: string): string {
  return join(home, ".codex-agent", "jobs");
}

function writeJob(home: string, overrides: Partial<Job> & Pick<Job, "id">): void {
  const job: Job = {
    status: "running",
    prompt: "Test prompt",
    model: "gpt-5.5",
    reasoningEffort: "low",
    sandbox: "workspace-write",
    cwd: "/tmp/project",
    createdAt: fixtureTime(0),
    startedAt: fixtureTime(1),
    turnState: "working",
    ...overrides,
  };
  writeFileSync(join(jobsDir(home), `${job.id}.json`), JSON.stringify(job, null, 2));
}

function runCli(home: string, args: string[]) {
  return Bun.spawnSync({
    cmd: [process.execPath, "src/cli.ts", ...args],
    cwd: process.cwd(),
    env: {
      ...process.env,
      HOME: home,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
}

function text(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

describe("CLI output contract", () => {
  test("human status leads with derived state, process, turn, and next action", () => {
    const home = makeHome();
    writeJob(home, {
      id: "waiting",
      turnState: "idle",
      turnsCompleted: 1,
      lastAgentMessage: "Ready.",
    });

    const result = runCli(home, ["status", "waiting"]);
    const lines = text(result.stdout).trim().split("\n");

    expect(result.exitCode).toBe(0);
    expect(lines.slice(0, 6)).toEqual([
      "State: WAITING",
      "Process: running",
      "Turn: idle",
      "Turns completed: 1",
      "Last message: Ready.",
      "Next: send_or_close",
    ]);
  });

  test("status --json emits the stable wrapper and compact job object", () => {
    const home = makeHome();
    writeJob(home, {
      id: "waiting-json",
      turnState: "idle",
      turnsCompleted: 1,
      lastAgentMessage: "Ready JSON.",
    });

    const result = runCli(home, ["status", "--json", "waiting-json"]);
    const payload = JSON.parse(text(result.stdout));

    expect(result.exitCode).toBe(0);
    expect(payload.schema_version).toBe("codex-agent.job.v1");
    expect(payload.job.orchestration_state).toBe("WAITING");
    expect(payload.job.process_state).toBe("running");
    expect(payload.job.turn_state).toBe("idle");
    expect(payload.job.last_message).toBe("Ready JSON.");
  });

  test("await-turn returns cached WAITING and COMPLETED messages immediately", () => {
    const home = makeHome();
    writeJob(home, {
      id: "waiting",
      turnState: "idle",
      turnsCompleted: 1,
      lastAgentMessage: "Waiting message.",
    });
    writeJob(home, {
      id: "completed",
      status: "completed",
      completedAt: fixtureTime(300),
      turnState: "idle",
      turnsCompleted: 1,
      lastAgentMessage: "Completion message.",
    });

    const waiting = runCli(home, ["await-turn", "waiting"]);
    const completed = runCli(home, ["await-turn", "completed"]);

    expect(waiting.exitCode).toBe(0);
    expect(text(waiting.stdout).trim()).toBe("Waiting message.");
    expect(completed.exitCode).toBe(0);
    expect(text(completed.stdout).trim()).toBe("Completion message.");
  });

  test("await-turn exits non-zero with clear reasons for blocked, failed, cancelled, and stale jobs", () => {
    const home = makeHome();
    writeJob(home, {
      id: "blocked",
      turnState: "blocked",
      blockerKind: "context_limit",
      turnsCompleted: 1,
    });
    writeJob(home, {
      id: "failed",
      status: "failed",
      completedAt: fixtureTime(300),
      error: "Exploded",
    });
    writeJob(home, {
      id: "cancelled",
      status: "failed",
      processState: "cancelled",
      completedAt: fixtureTime(300),
    });
    writeJob(home, {
      id: "stale",
      createdAt: "2000-01-01T00:00:00.000Z",
      startedAt: "2000-01-01T00:00:01.000Z",
      turnState: "working",
    });

    const blocked = runCli(home, ["await-turn", "blocked"]);
    const failed = runCli(home, ["await-turn", "failed"]);
    const cancelled = runCli(home, ["await-turn", "cancelled"]);
    const stale = runCli(home, ["await-turn", "stale"]);

    expect(blocked.exitCode).toBe(2);
    expect(text(blocked.stderr)).toContain("Job is blocked: context_limit");
    expect(failed.exitCode).toBe(1);
    expect(text(failed.stderr)).toContain("Exploded");
    expect(cancelled.exitCode).toBe(1);
    expect(text(cancelled.stderr)).toContain("Job was cancelled");
    expect(stale.exitCode).toBe(2);
    expect(text(stale.stderr)).toContain("Job is stale");
  });

  test("await-turn --json emits a stable object", () => {
    const home = makeHome();
    writeJob(home, {
      id: "completed-json",
      status: "completed",
      completedAt: fixtureTime(300),
      lastAgentMessage: "Done JSON.",
    });

    const result = runCli(home, ["await-turn", "--json", "completed-json"]);
    const payload = JSON.parse(text(result.stdout));

    expect(result.exitCode).toBe(0);
    expect(payload.schema_version).toBe("codex-agent.job.v1");
    expect(payload.outcome).toBe("ready");
    expect(payload.message).toBe("Done JSON.");
    expect(payload.reason).toBeNull();
    expect(payload.job.orchestration_state).toBe("COMPLETED");
  });

  test("await-turn keeps polling WORKING jobs until a turn signal arrives", async () => {
    const home = makeHome();
    writeJob(home, {
      id: "working",
      turnState: "working",
    });

    const proc = Bun.spawn({
      cmd: [process.execPath, "src/cli.ts", "await-turn", "working"],
      cwd: process.cwd(),
      env: {
        ...process.env,
        HOME: home,
      },
      stdout: "pipe",
      stderr: "pipe",
    });

    setTimeout(() => {
      writeFileSync(
        join(jobsDir(home), "working.turn-complete"),
        JSON.stringify({
          turnId: "turn-1",
          lastAgentMessage: "Signal message.",
          timestamp: fixtureTime(240),
        }),
      );
    }, 100);

    const [stdout, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      proc.exited,
    ]);

    expect(exitCode).toBe(0);
    expect(stdout.trim()).toBe("Signal message.");
  });

  test("start --dry-run prints prompt-context accounting without requiring tmux", () => {
    const home = makeHome();
    const cwd = mkdtempSync(join(tmpdir(), "codex-agent-dry-run-"));
    mkdirSync(join(cwd, "docs"));
    writeFileSync(
      join(cwd, "docs", "CODEBASE_MAP.md"),
      ["---", "total_tokens: 9,094", "---", "", "# Map", "Small body."].join("\n"),
    );

    const result = runCli(home, ["start", "Build it", "--map", "--dry-run", "-d", cwd]);
    const stdout = text(result.stdout);

    expect(result.exitCode).toBe(0);
    expect(stdout).toContain("Prompt components:");
    expect(stdout).toContain("Codebase map: included");
    expect(stdout).toContain("Map prompt cost:");
    expect(stdout).toContain("Map metadata total_tokens: 9,094");
  });
});

describe("argument parsing", () => {
  test("rejects unknown options instead of folding their values into the prompt", () => {
    const home = makeHome();
    const result = runCli(home, ["start", "review", "-f", "src/**/*.ts", "--dry-run"]);

    expect(result.exitCode).toBe(1);
    expect(text(result.stderr)).toContain("Unknown option: -f");

    const withValue = runCli(home, ["start", "review", "--model=gpt-6-sol", "--dry-run"]);
    expect(withValue.exitCode).toBe(1);
    expect(text(withValue.stderr)).toContain("Unknown option: --model=gpt-6-sol");
  });

  test("keeps text that starts with a dash", () => {
    const home = makeHome();
    const result = runCli(home, ["start", "- fix the tests", "--dry-run"]);

    expect(result.exitCode).toBe(0);
    expect(text(result.stdout)).toContain("Task prompt: ~4 tokens, 15 bytes");
  });

  test("treats everything after -- as text", () => {
    const home = makeHome();
    const result = runCli(home, ["start", "--dry-run", "--", "-x"]);

    expect(result.exitCode).toBe(0);
    expect(text(result.stdout)).toContain("Task prompt: ~1 tokens, 2 bytes");
  });

  test("send passes a bulleted message through to the job", () => {
    const home = makeHome();
    const result = runCli(home, ["send", "missing", "- fix the tests"]);

    // Reaching the job lookup means the message survived parsing.
    expect(text(result.stderr)).toContain("Could not send to job missing");
  });
});
