# Security Policy

The usertrust project takes security seriously. As a financial governance SDK,
we hold ourselves to a high standard for protecting the integrity of the
software and the safety of our users.

## Supported Versions

| Version | Supported          |
| ------- | ------------------ |
| 1.2.x   | Yes                |
| 1.1.x   | Security fixes only |
| 1.0.x   | No                 |

## Reporting a Vulnerability

**Do not open a public GitHub issue for security vulnerabilities.**

Instead, please report vulnerabilities by email to:

**security@usertrust.ai**

### What to Include

To help us triage and respond quickly, please include as much of the following
as possible:

- A clear description of the vulnerability and its potential impact.
- Step-by-step instructions to reproduce the issue.
- The affected package(s) and version(s).
- Any proof-of-concept code or logs.
- Your assessment of severity (e.g., low, medium, high, critical).
- Whether you believe the issue is being actively exploited.

### Response Timeline

- **Acknowledgment:** We will acknowledge receipt of your report within
  **48 hours**.
- **Initial assessment:** We will provide an initial severity assessment and
  next steps within **5 business days**.
- **Disclosure window:** We follow a **90-day coordinated disclosure** window.
  We will work with you to coordinate public disclosure after a fix is
  available, or after 90 days, whichever comes first.

If we need more time to develop a fix, we will communicate that to you and
request a mutually agreed-upon extension.

## Scope

### In Scope

- `usertrust` (core SDK)
- `usertrust-verify` (verification package)
- `usertrust-openclaw` (OpenClaw integration)
- The usertrust CLI
- All code in the [usertrust repository](https://github.com/usertools-ai/usertrust)

### Out of Scope

- The documentation website and marketing site
- Third-party dependencies (please report these to the upstream maintainer,
  though we appreciate a heads-up)
- Social engineering attacks against maintainers or users

## Safe Harbor

We consider security research conducted in good faith to be authorized and
welcome it. We will not pursue legal action against researchers who:

- Make a good-faith effort to avoid privacy violations, data destruction, and
  disruption of service.
- Only interact with accounts they own or with explicit permission from the
  account holder.
- Report vulnerabilities through the process described above.
- Allow us a reasonable timeframe to address the issue before public disclosure.

We ask that you do not:

- Access, modify, or delete data belonging to other users.
- Perform denial-of-service attacks.
- Conduct testing against production systems in a way that could impact other
  users.

## Acknowledgments

We are grateful to the security researchers who help keep usertrust and its
users safe. With your permission, we will acknowledge your contribution in
our release notes.

## Contact

For security-related inquiries: **security@usertrust.ai**

For general questions, use [GitHub Issues](https://github.com/usertools-ai/usertrust/issues)
or [GitHub Discussions](https://github.com/usertools-ai/usertrust/discussions).
