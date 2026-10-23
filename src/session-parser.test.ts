import { describe, expect, test } from "bun:test";
import { extractSessionId } from "./session-parser.ts";

describe("session id extraction", () => {
  test("reads the resume hint the interactive TUI prints on exit", () => {
    // Tail of a real codex-cli 0.164.0 log written by `script`.
    const log =
      "Token usage: total=240 input=200 output=40\r\n" +
      "To continue this session, run:\r\n" +
      "  \x1b[36mcodex resume 01a16886-a7e6-7d90-b19a-d80521ddb461\x1b[39m\r\n\n" +
      'Script done on 2026-10-23 11:33:30+00:00 [COMMAND_EXIT_CODE="0"]\n';

    expect(extractSessionId(log)).toBe("01a16886-a7e6-7d90-b19a-d80521ddb461");
  });

  test("still reads the exec-mode header", () => {
    expect(extractSessionId("session id: 0199aaaa-bbbb-cccc-dddd-eeeeffff0000\n")).toBe(
      "0199aaaa-bbbb-cccc-dddd-eeeeffff0000",
    );
  });
});
