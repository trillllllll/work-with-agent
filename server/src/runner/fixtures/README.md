# CLI stdout fixtures

`codex-exec.jsonl` and `claude-stream.jsonl` are shaped from the public Codex CLI and Claude Code stream-json docs. They are not captures from a real dispatch.

Replace both files with redacted `stdout.jsonl` from one real Codex dispatch and one real Claude Code dispatch before treating the numbers as checked against those CLIs. Drop prompts, source, and secrets. The phase-1 plan calls this out as a manual acceptance step.
