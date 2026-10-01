# Security policy

Please report security issues privately through
[GitHub security advisories](https://github.com/dino-cosic/flagrm/security/advisories/new),
not in a public issue. You should get a reply within a week.

flagrm runs the build and test commands from `flagrm.config.yaml` in your shell,
and `flagrm init` installs a Claude Code Stop hook that runs `flagrm hook stop`.
Review both before using flagrm in a repository you don't trust.
