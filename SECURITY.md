# Security policy

## Supported versions

Security fixes are made on the latest release and the current `main` branch.
Self-hosted operators should update to the newest release before reporting an
issue that may already be fixed.

## Reporting a vulnerability

Please do not open a public issue for a suspected vulnerability. Email
`info@fornacestudio.com` with:

- the affected version or commit;
- whether the issue affects hosted Waynode, self-hosted Waynode, or both;
- reproduction steps and the expected security boundary;
- any logs or proof of concept with credentials and personal data removed.

We will acknowledge the report and coordinate validation, remediation, and
responsible disclosure directly with the reporter. Do not access other users'
data or disrupt production while testing.

## Scope

The most important boundaries are authentication and OAuth state, encrypted
credentials, repository authorization, Git credential isolation, hosted
sandboxing, billing entitlements, terminal access, and account deletion.
