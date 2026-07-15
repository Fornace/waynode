export function SecurityContent() {
  return <>
    <section id="boundary"><h2>Current Cloud boundary</h2><p>
      Waynode Cloud keeps each worktree as a real cloned repository on managed storage.
      Hosted agent execution is placed in a hardware-isolated sandbox with bounded
      credentials; the interactive workspace terminal is not offered on hosted worktrees.
      Self-hosted operators set their own isolation, network, model, secret, and backup controls.
    </p></section>

    <section id="controls"><h2>Implemented controls</h2><ul>
      <li>GitHub and GitLab OAuth tokens and user-supplied workspace secrets are encrypted at rest with authenticated encryption.</li>
      <li>Browser sessions use HTTP-only cookies; production cookies are secure and cross-site write requests are origin checked.</li>
      <li>OAuth callbacks use short-lived state, and native callback redemption is single-use.</li>
      <li>Organization and worktree authorization is checked server-side; Git credentials are scoped to the repository operation that needs them.</li>
      <li>Hosted work is admitted against subscription, seat, storage, and model-token controls before execution.</li>
      <li>Deployment readiness checks durable data and hosted prerequisites before traffic is accepted; deployment rollback keeps matching source, data, environment, and images together.</li>
    </ul></section>

    <section id="limits"><h2>What is not claimed</h2><p>
      This page is not a certification, penetration-test report, security warranty, or SLA.
      Waynode does not currently publish a formal bug bounty or guaranteed response time.
      No control makes agent-generated code safe without review. Current service readiness
      is at <a href="/status">/status</a>.
    </p></section>

    <section id="report"><h2>Report a vulnerability</h2><p>
      Email <a href="mailto:info@fornacestudio.com?subject=Waynode%20security%20report">info@fornacestudio.com</a> with
      “Waynode security report” in the subject. Include the affected surface, reproducible
      steps, impact, and a safe way to contact you. Do not include live credentials,
      customer source, personal data, or destructive proof-of-concept activity.
    </p><p>
      Please allow time to reproduce and coordinate a fix before public disclosure. We
      review good-faith reports, but this is not a promise of payment, immunity, or a
      specific response or remediation time. For an active compromise, revoke affected
      provider credentials first and say “active incident” in the subject.
    </p></section>
  </>;
}

export function SupportContent() {
  return <>
    <section id="contact"><h2>How to reach support</h2><p>
      For account, privacy, billing, withdrawal, or Waynode Cloud help, email
      <a href="mailto:info@fornacestudio.com"> info@fornacestudio.com</a>. For a security
      issue, use the instructions at <a href="/security">/security</a>. For public,
      non-sensitive self-hosted bugs and documentation, use
      <a href="https://github.com/Fornace/waynode/issues"> GitHub Issues</a>.
    </p><p>
      Support is currently email-based. There is no guaranteed initial-response or
      resolution time. The <a href="/status">status page</a> is the fastest check for
      current Cloud readiness.
    </p></section>

    <section id="include"><h2>What to include</h2><ul>
      <li>the account handle and organization or worktree name involved;</li>
      <li>the device, OS, app or browser version, and approximate time with timezone;</li>
      <li>the action taken, visible error, and whether retry changed the result; and</li>
      <li>for billing, the Stripe invoice or checkout reference—not card details.</li>
    </ul><p>
      Never email OAuth tokens, API keys, recovery codes, full payment-card data, private
      source files, or another person’s personal data. Redact screenshots and logs first.
    </p></section>

    <section id="billing"><h2>Billing, cancellation, and withdrawal</h2><p>
      Organization administrators can open the Stripe billing portal from organization
      settings. If it is unavailable, email support from the account address. EU consumers
      exercising a withdrawal right should use a clear subject such as “Withdrawal from
      Waynode Cloud” and include the account, purchase date, and checkout or invoice reference.
      The applicable information is in the <a href="/terms#withdrawal">Terms</a>.
    </p></section>

    <section id="self-host"><h2>Self-hosted boundary</h2><p>
      Self-hosted installation and operations remain the operator’s responsibility,
      including HTTPS, upgrades, model credentials, network policy, backups, and restore
      drills. Community issue triage is not managed hosting and does not include access to
      your server. Keep private deployment details out of public issues.
    </p></section>
  </>;
}
