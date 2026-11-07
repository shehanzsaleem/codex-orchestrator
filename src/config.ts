// Configuration for codex-agent

export const config = {
  // Default model
  model: "gpt-6-luna",

  // Oldest Codex CLI that knows the default model (its minimal_client_version)
  minCodexVersion: "0.155.0",

  // Reasoning effort levels
  reasoningEfforts: ["low", "medium", "high", "xhigh"] as const,
  defaultReasoningEffort: "low" as const,

  // Sandbox modes
  sandboxModes: ["read-only", "workspace-write", "danger-full-access"] as const,
  defaultSandbox: "workspace-write" as const,

  // Job storage directory
  jobsDir: `${process.env.HOME}/.codex-agent/jobs`,
  jobsIndexFile: `${process.env.HOME}/.codex-agent/jobs/index.json`,

  // Default inactivity timeout in minutes for running jobs
  defaultTimeout: 60,

  // Agent logs grow for the whole session; exit info (token usage, resume id)
  // is printed at the end, so parsers read only this many bytes from the tail.
  logTailBytes: 256 * 1024,

  // Default number of jobs to show in listings
  jobsListLimit: 20,

  // tmux session prefix
  tmuxPrefix: "codex-agent",

};

export type ReasoningEffort = typeof config.reasoningEfforts[number];
export type SandboxMode = typeof config.sandboxModes[number];
