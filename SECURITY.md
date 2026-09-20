# Security Policy

## Supported versions

FinMate is **pre-1.0** and has no released versions yet. Only the tip of `main` is supported; there
are no maintenance branches and no backports. Fixes land on `main`.

## Reporting a vulnerability

**Please do not open a public issue for a security problem.**

Two private channels, in order of preference:

1. **GitHub private vulnerability reporting** — the _Security_ tab of this repository →
   _Report a vulnerability_. This keeps the report, the discussion and the fix in one private thread.
2. **Email** — `gjovanovic.st@gmail.com`, with `FinMate security` in the subject.

Please include, as far as you can:

- what the issue is and which component it is in (`apps/api`, `apps/web`, `apps/worker`, a package);
- the version or commit you tested;
- **reproduction steps**, ideally the smallest one that shows the problem;
- the impact you believe it has, and whether it crosses a tenant boundary;
- any suggested fix, and whether you intend to publish.

If you are unsure whether something is in scope, report it anyway — a duplicate is cheaper than a
silent hole.

## What to expect

This is a small project without a paid on-call rotation, so these are honest best-effort targets
rather than an SLA:

| Stage                                                        | Target                                                 |
| ------------------------------------------------------------ | ------------------------------------------------------ |
| Acknowledgement of your report                               | within 3 business days                                 |
| Initial assessment and severity                              | within 10 business days                                |
| Fix or a mitigation plan for a confirmed high/critical issue | as soon as is practical, and you will be told the plan |

We will credit you in the release notes and the fix commit unless you ask us not to. There is no bug
bounty. We will not pursue legal action against researchers who act in good faith: who test only
against their own deployment or data, who do not degrade the service for others, who do not access or
exfiltrate other people's data, and who give us reasonable time to fix the issue before publishing.

## Scope

Reports are especially wanted for anything that breaks one of the project's non-negotiables:

- **Tenancy** — any way to read or write another Household's rows, or to make a household-scoped
  query run without a `TenantContext` (ADR-008).
- **Money and the ledger** — any way to make a balance, total or budget wrong, including through the
  AI path; a violation of invariants `I-1`–`I-12` (docs/03).
- **Authentication and sessions** — signup/login/refresh, the refresh-token rotation and theft
  detection, password reset, email verification, TOTP/emailed-code two-factor and recovery codes,
  the app lock and its wrapped-key lifecycle.
- **AI data egress** — any path where Household data reaches a non-EEA, non-local endpoint without a
  recorded per-Household consent, or where redaction fails to remove what it claims to remove
  (ADR-007, ADR-031, docs/08 §6).
- **The offline store** — any way to read persisted data without the app lock being armed, or to
  recover plaintext from the encrypted store.
- **File handling** — presigned URL scope, object-storage key traversal, or serving an uploaded file
  in a way that lets it execute.
- **Injection and deserialization** — SQL, GraphQL, template, or untrusted input reaching a shell or
  an evaluator.

Third-party services and dependencies are in scope for reporting, but the fix may belong upstream.

## Known and accepted limitations

These are **documented, deliberate** states of the pre-1.0 build, not vulnerabilities. Reporting them
is fine, but they will not be treated as new findings:

- **Uploaded files are not virus-scanned.** The scanner seam exists but is inert: an accepted upload
  is recorded as `SKIPPED` (_not scanned_), never `CLEAN`. Magic-byte sniffing and content
  re-encoding are unbuilt (docs/08 §9.4).
- **AI is inert by default.** With no provider configured, classification is rules-only, and the
  assistant/OCR seams answer `unavailable` rather than reaching a network.
- **The local vision sidecar is a developer tool.** It is opt-in via `pnpm dev:ai`, binds to the
  developer's own machine, and is not hardened for exposure. Do not run it on a public interface.
- **The development stack is not production-hardened.** `infra/docker/compose.dev.yml` and
  `.env.example` use well-known development credentials on purpose. They are not secrets and must
  never be used for a deployment.
- **A production deployment path for `apps/api` does not exist yet**, and neither does a hosting
  decision (docs/14 Q-7). Anything running today is a development deployment.
- **Known product risks are recorded, not hidden** — the naming/trademark gap (R-28), the local OCR
  latency budget (R-31), and the rest are in
  [`docs/14-decisions-and-risks.md`](docs/14-decisions-and-risks.md).
