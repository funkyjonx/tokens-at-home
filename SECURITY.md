# Security Policy

## Reporting a vulnerability

Please **do not** file a public GitHub issue for security vulnerabilities.

Report them privately via [GitHub's private vulnerability reporting](https://github.com/funkyjonx/tokens-at-home/security/advisories/new) or by emailing the maintainer directly.

Include:
- A description of the vulnerability and its potential impact
- Steps to reproduce
- Any suggested fix, if you have one

You'll receive a response within a few days. We'll coordinate a fix and disclosure timeline with you before anything is made public.

## Scope

The coordinator server and the worker process are the most security-sensitive components, as the worker executes code and the coordinator handles auth tokens. Reports in those areas are especially appreciated.
