// Resolve which codex executable to launch for an agent.
//
// The npm package's `codex` is a Node script (bin/codex.js) that spawns the
// native Rust binary and then stays resident for the whole session just to
// forward signals. Launching the native binary directly saves one Node
// process per agent. We mirror the env the wrapper would set so the binary
// behaves identically, and fall back to plain `codex` whenever the layout
// isn't the one we recognize.

import { accessSync, constants, realpathSync } from "fs";
import { createRequire } from "module";
import { dirname, join, sep } from "path";

export interface CodexCommand {
  path: string;
  env: Record<string, string>;
}

// Same mapping as @openai/codex bin/codex.js (tmux-capable platforms only).
const TARGET_TRIPLES: Record<string, string> = {
  "linux-x64": "x86_64-unknown-linux-musl",
  "linux-arm64": "aarch64-unknown-linux-musl",
  "darwin-x64": "x86_64-apple-darwin",
  "darwin-arm64": "aarch64-apple-darwin",
};

const NPM_WRAPPER_SUFFIX = `${sep}${join("@openai", "codex", "bin", "codex.js")}`;
const PLAIN_CODEX: CodexCommand = { path: "codex", env: {} };

function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function resolveCodexCommand(
  options: {
    env?: NodeJS.ProcessEnv;
    platform?: string;
    arch?: string;
    which?: (bin: string) => string | null;
  } = {}
): CodexCommand {
  const env = options.env ?? process.env;
  const override = env.CODEX_AGENT_CODEX_BIN?.trim();
  if (override) return { path: override, env: {} };

  const which = options.which ?? ((bin: string) => Bun.which(bin, { PATH: env.PATH ?? "" }));
  const onPath = which("codex");
  if (!onPath) return PLAIN_CODEX;

  let wrapperPath: string;
  try {
    wrapperPath = realpathSync(onPath);
  } catch {
    return PLAIN_CODEX;
  }
  // Already a native binary (Homebrew, cargo, standalone install) - use as is.
  if (!wrapperPath.endsWith(NPM_WRAPPER_SUFFIX)) return PLAIN_CODEX;

  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const triple = TARGET_TRIPLES[`${platform}-${arch}`];
  if (!triple) return PLAIN_CODEX;

  const packageRoot = dirname(dirname(wrapperPath));
  const vendorRoots: string[] = [];
  try {
    // Resolve the platform package the same way the wrapper does.
    const pkgJson = createRequire(wrapperPath).resolve(`@openai/codex-${platform}-${arch}/package.json`);
    vendorRoots.push(join(dirname(pkgJson), "vendor"));
  } catch {
    // Not installed as a separate package; try the bundled vendor dir below.
  }
  vendorRoots.push(join(packageRoot, "vendor"));

  for (const vendorRoot of vendorRoots) {
    const binary = join(vendorRoot, triple, "bin", "codex");
    if (!isExecutable(binary)) continue;

    // The wrapper only uses the package manager flag for update hints.
    const managedBy = wrapperPath.includes(`${sep}.bun${sep}install${sep}global${sep}`)
      ? "CODEX_MANAGED_BY_BUN"
      : "CODEX_MANAGED_BY_NPM";
    return {
      path: binary,
      env: { CODEX_MANAGED_PACKAGE_ROOT: packageRoot, [managedBy]: "1" },
    };
  }

  return PLAIN_CODEX;
}
