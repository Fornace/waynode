const gdpr = "https://eur-lex.europa.eu/eli/reg/2016/679/oj/eng";

export function PrivacyPolicyContent() {
  return <>
    <section id="scope">
      <h2>Who this notice covers</h2>
      <p>
        Waynode Cloud is operated under the public trading name <strong>Fornace</strong>
        from Italy. Privacy questions and requests go to <a href="mailto:info@fornacestudio.com">info@fornacestudio.com</a>.
        This notice covers the managed Waynode Cloud service and its public website.
      </p>
      <p>
        A self-hosted Waynode installation is a separate boundary. Its operator chooses
        the server, model provider, repository providers, logging, backups, and retention.
        Self-hosted product data is not sent to Fornace by default.
      </p>
    </section>

    <section id="data">
      <h2>Data Waynode Cloud processes</h2>
      <div className="trust-table-wrap"><table>
        <thead><tr><th>Data</th><th>Why it is used</th><th>Typical source</th></tr></thead>
        <tbody>
          <tr><td>GitHub or GitLab account ID, handle, display name, avatar, and OAuth access or refresh token</td><td>Sign-in, repository discovery, cloning, pulling, and user-approved Git operations</td><td>You and the selected Git provider</td></tr>
          <tr><td>Organization membership, repository URL and branch, cloned source, worktree state, diffs, and encrypted workspace secrets</td><td>Create and operate the durable worktree you request</td><td>You, teammates, and connected repositories</td></tr>
          <tr><td>Session titles, prompts, model responses, tool activity, run state, and persisted agent session files</td><td>Run the coding agent, preserve continuity, and show review evidence</td><td>You and the configured model/runtime</td></tr>
          <tr><td>Plan, subscription status, Stripe customer/subscription identifiers, and signed billing event identifiers</td><td>Checkout, entitlement, limits, renewal, cancellation, accounting, and dispute handling</td><td>You and Stripe; Waynode does not store full card numbers</td></tr>
          <tr><td>Session cookie, IP and request metadata, authentication/security events, and application or infrastructure errors</td><td>Keep sessions signed in, prevent abuse, diagnose failures, and protect the service</td><td>Your client and service infrastructure</td></tr>
          <tr><td>Support messages and attachments you choose to send</td><td>Answer the request and keep a support record</td><td>You</td></tr>
        </tbody>
      </table></div>
    </section>

    <section id="basis">
      <h2>Purposes and legal bases</h2>
      <p>
        Account, workspace, agent, and billing processing is necessary to provide the
        service you request and administer its contract. Security, fraud prevention,
        service diagnosis, and limited operational logging support Fornace’s legitimate
        interest in running a reliable service. Tax, accounting, consumer, and lawful
        disclosure records are kept where a legal obligation applies. Where processing
        relies on consent, you may withdraw it without affecting earlier processing.
      </p>
      <p>
        Fornace does not use customer source code or prompts to train a Waynode model and
        does not use them for advertising. Context needed for an agent turn is sent to
        the configured model service; that provider’s terms and data controls also apply.
      </p>
    </section>

    <section id="sharing">
      <h2>Recipients and processing locations</h2>
      <p>Data is shared only as needed with these recipients or service categories:</p>
      <ul>
        <li>GitHub or GitLab for OAuth and repository operations you initiate;</li>
        <li>Stripe for checkout, payment, invoices, subscriptions, and its customer portal;</li>
        <li>hosting, storage, networking, backup, and security-log providers;</li>
        <li>the model/API provider needed to perform an agent request; and</li>
        <li>support or legal advisers when needed to answer a request or comply with law.</li>
      </ul>
      <p>
        Some providers may process data outside Italy or the EEA under their own service
        terms and applicable transfer mechanisms. Ask the privacy contact for the current
        provider list and relevant safeguards before placing export-controlled or specially
        regulated material in Waynode Cloud.
      </p>
    </section>

    <section id="retention">
      <h2>Retention and deletion controls</h2>
      <ul>
        <li>The browser session cookie expires after at most seven days; signing out destroys the server session.</li>
        <li>Account, organization, worktree, source, and session data remain while the relevant account or organization needs them. In-product deletion removes live data subject to organization-admin safeguards.</li>
        <li>OAuth tokens are removed with the user record. Workspace secrets and OAuth tokens are encrypted at rest.</li>
        <li>Deployment tooling defaults local managed-backup rotation to 14 days when that schedule is enabled. Deleted live data can remain in protected backup copies until rotation.</li>
        <li>Billing and transaction evidence may remain for applicable tax, accounting, fraud, chargeback, and consumer-law periods.</li>
        <li>Security, error, and support records remain only as long as needed for diagnosis, abuse prevention, or the open request, then follow the relevant provider’s rotation.</li>
      </ul>
      <p>
        There is no hidden delete shortcut: a final organization administrator must
        transfer administration before deleting an account so team work and billing are
        not orphaned. Contact support if an in-product deletion is blocked.
      </p>
    </section>

    <section id="rights">
      <h2>Your choices and rights</h2>
      <p>
        Depending on the circumstances, you may request access, correction, deletion,
        restriction, portability, or object to processing. You may withdraw consent where
        it is the basis. Email the privacy contact with the account identifier and request;
        identity verification may be required before data is disclosed or changed.
      </p>
      <p>
        You may also complain to the Italian data-protection authority or your local EEA
        authority. The rights framework is in the <a href={gdpr}>EU General Data Protection Regulation</a>.
        Waynode does not create advertising profiles or make solely automated decisions
        intended to produce legal or similarly significant effects about users.
      </p>
    </section>

    <section id="cookies">
      <h2>Cookies and changes</h2>
      <p>
        Waynode uses a necessary, HTTP-only session cookie and short-lived OAuth state for
        sign-in security. The current product does not install advertising cookies. This
        notice will be updated when processing materially changes; the effective date at
        the top identifies this version.
      </p>
    </section>
  </>;
}
