# hudson-hs-parents — operating preferences

## Run things yourself; don't delegate to me

When a task requires running a command, executing a script, parsing
data, hitting an API, or otherwise performing concrete work, **do it
yourself** using the tools available (Bash, Supabase MCP, browser-bridge,
WebFetch, etc.). "Run this on your end" should be a last resort, only
when:

- A tool genuinely cannot reach the resource (e.g. an interactive OAuth
  login, a credential I have to type physically), AND
- You have already tried and ruled out at least one workaround
  (different tool, different credential location, MCP equivalent, etc.).

Before declaring you can't run something, check:

- `~/.claude/projects/c--realestate/memory/` for stored secrets references
- `.env` / `.env.example` files in the project tree
- `gh secret list -R adam567/hudson-hs-parents` for GitHub repo secrets
- The MCP server's own auth — the Supabase MCP has full DB access without
  the local service-role key, so loaders that use the REST/service-role
  path can be reimplemented via `mcp__supabase__execute_sql` with chunked
  multi-row `INSERT … VALUES (…), (…)` or staging-table COPY patterns
- `[System.Environment]::GetEnvironmentVariable(...)` for Windows user env

If you still can't proceed, tell me **what you tried and why each path
failed** before asking me to run anything.
