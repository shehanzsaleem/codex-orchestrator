import { chmodSync, mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, test } from "bun:test";
import { isCodexVersionAtLeast, resolveCodexCommand } from "./codex-bin.ts";

const TRIPLE = "x86_64-unknown-linux-musl";

function writeFile(path: string, content: string, mode?: number): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
  if (mode !== undefined) chmodSync(path, mode);
}

// Lay out a global npm install: prefix/bin/codex -> lib/node_modules/@openai/codex/bin/codex.js
function makeNpmInstall(options: { platformPackage: "nested" | "hoisted" | "none" }) {
  const prefix = realpathSync(mkdtempSync(join(tmpdir(), "codex-bin-")));
  const packageRoot = join(prefix, "lib", "node_modules", "@openai", "codex");
  const wrapper = join(packageRoot, "bin", "codex.js");
  writeFile(join(packageRoot, "package.json"), JSON.stringify({ name: "@openai/codex" }));
  writeFile(wrapper, "#!/usr/bin/env node\n", 0o755);

  const shim = join(prefix, "bin", "codex");
  mkdirSync(dirname(shim), { recursive: true });
  symlinkSync(wrapper, shim);

  let binary: string | null = null;
  if (options.platformPackage !== "none") {
    const platformRoot =
      options.platformPackage === "nested"
        ? join(packageRoot, "node_modules", "@openai", "codex-linux-x64")
        : join(prefix, "lib", "node_modules", "@openai", "codex-linux-x64");
    writeFile(join(platformRoot, "package.json"), JSON.stringify({ name: "@openai/codex-linux-x64" }));
    binary = join(platformRoot, "vendor", TRIPLE, "bin", "codex");
    writeFile(binary, "#!/bin/sh\n", 0o755);
  }

  return { prefix, packageRoot, shim, binary };
}

const linux = { platform: "linux", arch: "x64" };

describe("codex binary resolution", () => {
  test.each(["nested", "hoisted"] as const)(
    "launches the native binary from a %s npm platform package",
    (platformPackage) => {
      const install = makeNpmInstall({ platformPackage });
      const command = resolveCodexCommand({ ...linux, env: {}, which: () => install.shim });

      expect(command).toEqual({
        path: install.binary!,
        env: { CODEX_MANAGED_PACKAGE_ROOT: install.packageRoot, CODEX_MANAGED_BY_NPM: "1" },
      });
    }
  );

  test("falls back to the wrapper when the platform binary is missing", () => {
    const install = makeNpmInstall({ platformPackage: "none" });
    const command = resolveCodexCommand({ ...linux, env: {}, which: () => install.shim });

    expect(command).toEqual({ path: "codex", env: {} });
  });

  test("falls back on platforms the wrapper mapping does not cover", () => {
    const install = makeNpmInstall({ platformPackage: "nested" });
    const command = resolveCodexCommand({
      platform: "freebsd",
      arch: "x64",
      env: {},
      which: () => install.shim,
    });

    expect(command).toEqual({ path: "codex", env: {} });
  });

  test("uses a codex that is already native as is", () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "codex-bin-native-")));
    const native = join(dir, "codex");
    writeFile(native, "#!/bin/sh\n", 0o755);

    expect(resolveCodexCommand({ ...linux, env: {}, which: () => native })).toEqual({
      path: "codex",
      env: {},
    });
    expect(resolveCodexCommand({ ...linux, env: {}, which: () => null })).toEqual({
      path: "codex",
      env: {},
    });
  });

  test("CODEX_AGENT_CODEX_BIN overrides resolution", () => {
    const install = makeNpmInstall({ platformPackage: "nested" });
    const command = resolveCodexCommand({
      ...linux,
      env: { CODEX_AGENT_CODEX_BIN: "/opt/codex/bin/codex" },
      which: () => install.shim,
    });

    expect(command).toEqual({ path: "/opt/codex/bin/codex", env: {} });
  });
});

describe("codex version check", () => {
  test.each([
    ["codex-cli 0.164.0", true],
    ["codex-cli 0.155.0", true],
    ["codex-cli 0.154.9", false],
    ["codex-cli 0.99.0", false],
    ["codex-cli 1.0.0", true],
    ["codex-cli 0.155.0-alpha.3", true],
  ] as const)("%s against 0.155.0 -> %p", (output, expected) => {
    expect(isCodexVersionAtLeast(output, "0.155.0")).toBe(expected);
  });

  test("returns null when the output has no version", () => {
    expect(isCodexVersionAtLeast("command not found", "0.155.0")).toBeNull();
  });
});
