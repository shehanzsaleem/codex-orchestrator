import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { buildCodexArgs, capturePane, sendMessage, sessionExists } from "./tmux.ts";

describe("codex launch args", () => {
  test("read-only sandbox is launched truthfully without bypass", () => {
    const args = buildCodexArgs({
      model: "gpt-5.5",
      reasoningEffort: "low",
      sandbox: "read-only",
      notifyHook: "/tmp/notify-hook.ts",
      jobId: "job-readonly",
    });

    expect(args).toContain("--sandbox 'read-only'");
    expect(args).toContain("--ask-for-approval 'never'");
    expect(args).not.toContain("--dangerously-bypass-approvals-and-sandbox");
  });

  test("workspace-write sandbox is launched truthfully without bypass", () => {
    const args = buildCodexArgs({
      model: "gpt-5.5",
      reasoningEffort: "medium",
      sandbox: "workspace-write",
      notifyHook: "/tmp/notify-hook.ts",
      jobId: "job-write",
    });

    expect(args).toContain("--sandbox 'workspace-write'");
    expect(args).not.toContain("--dangerously-bypass-approvals-and-sandbox");
  });

  test("disables TUI animations so idle redraws do not burn CPU", () => {
    const args = buildCodexArgs({
      model: "gpt-5.5",
      reasoningEffort: "low",
      sandbox: "workspace-write",
      notifyHook: "/tmp/notify-hook.ts",
      jobId: "job-anim",
    });

    expect(args).toContain("-c 'tui.animations=false'");
  });

  test("disables the startup update prompt that would block unattended agents", () => {
    const args = buildCodexArgs({
      model: "gpt-6-luna",
      reasoningEffort: "low",
      sandbox: "workspace-write",
      notifyHook: "/tmp/notify-hook.ts",
      jobId: "job-update",
    });

    expect(args).toContain("-c 'check_for_update_on_startup=false'");
    // Not a Codex setting; it was silently ignored.
    expect(args).not.toContain("skip_update_check");
  });

  test("rejects malicious model text before building a shell command", () => {
    expect(() =>
      buildCodexArgs({
        model: `gpt-5.5"; touch /tmp/codex-agent-pwn #`,
        reasoningEffort: "low",
        sandbox: "workspace-write",
        notifyHook: "/tmp/notify-hook.ts",
        jobId: "job-pwn",
      }),
    ).toThrow(/Invalid Codex model name/);
  });
});

const hasTmux = Bun.which("tmux") !== null;

describe("sendMessage", () => {
  const saved = { TMUX_TMPDIR: process.env.TMUX_TMPDIR, TMUX: process.env.TMUX };

  beforeEach(() => {
    // Private tmux server so the test never touches the user's sessions.
    process.env.TMUX_TMPDIR = mkdtempSync(join(tmpdir(), "codex-agent-tmux-"));
    delete process.env.TMUX;
  });

  afterEach(() => {
    spawnSync("tmux", ["kill-server"]);
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  test.skipIf(!hasTmux)("types messages literally, even key names and leading dashes", async () => {
    const session = "codex-agent-sendtest";
    // `cat -v` prints each submitted line, showing control keys as ^[ etc.
    expect(spawnSync("tmux", ["new-session", "-d", "-s", session, "-x", "120", "cat -v"]).status).toBe(0);

    const messages = ["Escape", "- fix the tests\n- then rerun them", "C-c", "-l"];
    for (const message of messages) {
      expect(sendMessage(session, message)).toBe(true);
    }
    await Bun.sleep(200);

    const pane = capturePane(session) ?? "";
    expect(pane).toContain("Escape");
    expect(pane).toContain("- fix the tests");
    expect(pane).toContain("C-c");
    expect(pane).toContain("-l");
    expect(pane).not.toContain("^[");
    // C-c as a keystroke would have killed cat and with it the session.
    expect(sessionExists(session)).toBe(true);
  });
});
