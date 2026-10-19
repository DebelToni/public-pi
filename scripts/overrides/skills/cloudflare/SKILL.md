---
name: cloudflare
description: Entry point for upstream official Cloudflare skills. Use for Cloudflare, Wrangler, Workers, R2, D1, Durable Objects, Turnstile, Cloudflare One, and related tasks.
---

# Cloudflare

Use this as an entry point. Load only the relevant upstream skill, then retrieve current Cloudflare documentation because commands, APIs, limits, and configuration change.

Official skills are maintained at https://github.com/cloudflare/skills and are not bundled here. Obtain them separately from that upstream repository. The paths below assume a separately provisioned `official-skills/` directory alongside this file; otherwise resolve the equivalent paths in your upstream checkout. Do not assume that directory exists.

## Nested Official Skills

Load only the relevant official skill by path from the separately obtained upstream repository.

- Broad platform routing: `official-skills/cloudflare/SKILL.md`
- CLI, configuration, deployment, and resource management: `official-skills/wrangler/SKILL.md`
- Workers authoring/review: `official-skills/workers-best-practices/SKILL.md`
- Stateful compute: `official-skills/durable-objects/SKILL.md`
- AI agents: `official-skills/agents-sdk/SKILL.md`
- Sandboxed execution: `official-skills/sandbox-sdk/SKILL.md`
- Email: `official-skills/cloudflare-email-service/SKILL.md`
- Zero Trust/SASE: `official-skills/cloudflare-one/SKILL.md`
- Zero Trust migrations: `official-skills/cloudflare-one-migrations/SKILL.md`
- Turnstile setup: `official-skills/turnstile-spin/SKILL.md`
- Browser performance audits: `official-skills/web-perf/SKILL.md`

If uncertain, read the broad platform skill. For Wrangler work, read its skill before running commands. Resolve these paths relative to this file.

## Live Sources

- Agent setup: https://developers.cloudflare.com/agent-setup/prompt.md
- Wrangler: https://developers.cloudflare.com/workers/wrangler/
- R2: https://developers.cloudflare.com/r2/
- Official skills: https://github.com/cloudflare/skills
- MCP: https://github.com/cloudflare/mcp and https://github.com/cloudflare/mcp-server-cloudflare
