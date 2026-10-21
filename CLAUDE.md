# CLAUDE.md

@AGENTS.md
@docs/DESIGN.md

## Claude Code notes

- Chat replies to the user may use Caveman style (terse). Everything written to files stays in
  normal, complete English: code, comments, docs, `AGENTS.md`, `CLAUDE.md`, `PROGRESS.md`, the
  spec files and commit messages.
- Never run `caveman-compress` on spec files (`AGENTS.md`, `CLAUDE.md`, `PROGRESS.md`,
  `docs/**`). Never use `caveman-commit` for commit messages.
- Do not start a user story until the user says go; stop after each story for review
  (`AGENTS.md` §2).
- The user works only in cloud sessions on the GitHub repository. For frontend stories, send
  the screenshots and videos with `SendUserFile` and give the story's browser check steps.
- Cloud tooling: `.claude/hooks/session-start.sh` installs the plugins (Caveman,
  frontend-design, Playwright MCP, Context7, TypeScript and Pyright language servers). Context7
  works only if `mcp.context7.com` is in the environment's allowed domains.
