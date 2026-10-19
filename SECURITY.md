# Security policy

## Reporting a vulnerability

Please **don't** open a public issue. Report it privately through [GitHub's private vulnerability reporting](https://github.com/getcockpit/cockpit/security/advisories/new).

You'll get an answer within 3 working days. Once a fix ships, you'll be credited in the release notes unless you'd rather not be.

## Supported versions

Only the latest release gets security fixes.

## Scope

Cockpit runs your local Claude Code with your permissions. Issues we especially care about:
- anything that could expose Claude credentials or session content outside your machine
- approvals that show something different from what actually runs
- the sidecar, the IPC surface, or the self-update and self-build paths running unintended code
