const withdrawal = "https://europa.eu/youreurope/citizens/consumers/shopping/returns/index_en.htm";
const consumerSummary = "https://eur-lex.europa.eu/EN/legal-content/summary/consumer-information-right-of-withdrawal-and-other-consumer-rights.html";

export function TermsContent() {
  return <>
    <section id="service"><h2>The service and operator</h2><p>
      These terms govern Waynode Cloud, operated under the public trading name
      <strong> Fornace</strong> from Italy. Contact <a href="mailto:info@fornacestudio.com">info@fornacestudio.com</a>.
      Waynode Cloud keeps a cloned Git worktree and coding-agent session on managed
      infrastructure so you can direct and review work across devices. The separately
      self-hosted software is offered under its repository license and is operated by you.
    </p></section>

    <section id="accounts"><h2>Accounts, teams, and repositories</h2><ul>
      <li>You must provide accurate account information and protect access to your Git provider and Waynode session.</li>
      <li>You must have authority to connect a repository, invite organization members, and request changes to its source.</li>
      <li>Organization administrators control membership, plan selection, billing access, and deletion or transfer safeguards.</li>
      <li>You remain responsible for reviewing agent output, diffs, commands, commits, and pushes before relying on them.</li>
    </ul></section>

    <section id="subscription"><h2>Trial, subscription, renewal, and cancellation</h2><ul>
      <li>The current hosted trial lasts 15 days and may be claimed once per user. A trial can expire without a purchase.</li>
      <li>A paid subscription begins only through an explicit Stripe checkout. The exact price, currency, taxes where applicable, billing period, trial treatment, and renewal terms shown before confirmation control the purchase.</li>
      <li>Subscriptions renew for the period shown at checkout until cancelled. Manage or cancel through the organization billing portal or contact support if the portal is unavailable.</li>
      <li>Cancellation stops future renewal. Access and effective cancellation timing follow the period and status shown in Stripe’s portal or checkout confirmation.</li>
      <li>Plan limits can cover seats, stored worktree data, and model-token use. The product shows the applicable plan and current entitlement; inactive or expired service can block new agent work while preserving account access needed to manage it.</li>
    </ul></section>

    <section id="withdrawal"><h2>EU consumer withdrawal and refunds</h2><p>
      If you are an EU consumer entering a distance service contract, you generally have
      14 days from conclusion of the contract to withdraw without giving a reason. To
      exercise that right, email a clear statement to <a href="mailto:info@fornacestudio.com">info@fornacestudio.com</a>
      with the account and purchase details. See the EU’s <a href={withdrawal}>withdrawal guidance</a> and
      <a href={consumerSummary}> consumer-rights summary</a>.
    </p><p>
      Starting service during that period does not automatically remove the right. Where
      applicable law permits, a consumer who expressly asks performance to begin may owe
      a proportionate amount for service supplied before withdrawal. Any exception for a
      fully performed service or digital content applies only when its legal conditions
      and required express acknowledgements are actually met; Fornace does not assume
      that exception applies merely because an account or worktree was created.
    </p><p>
      Statutory refunds are returned using the legally required method and timing. Other
      refund requests are reviewed through support against the checkout terms and facts;
      these terms do not reduce mandatory consumer remedies.
    </p></section>

    <section id="use"><h2>Acceptable use</h2><p>You may not use Waynode to:</p><ul>
      <li>access repositories, systems, credentials, or data without authorization;</li>
      <li>distribute malware, abuse service infrastructure, evade plan controls, or interfere with other users;</li>
      <li>violate law or third-party intellectual-property, privacy, confidentiality, or contractual rights; or</li>
      <li>place data in the service that requires controls Waynode Cloud has not expressly agreed to provide.</li>
    </ul><p>Fornace may restrict abusive or unsafe activity and will use proportionate measures where practical.</p></section>

    <section id="ownership"><h2>Your material and the software</h2><p>
      You retain rights in repositories, prompts, and outputs to the extent those rights
      exist. You give Fornace the limited permission needed to host, copy, transmit, and
      process that material to provide Waynode Cloud. Third-party code and model output
      can carry separate licenses or rights; review them before use. The open-source
      Waynode code remains governed by its repository license.
    </p></section>

    <section id="availability"><h2>Availability, security, and changes</h2><p>
      Waynode is an agent workspace, not a substitute for source control, professional
      review, or your own recovery plan. Agent output can be incomplete or harmful. The
      public <a href="/status">status page</a> reports current readiness only; no uptime
      SLA or certification is promised. Material subscription changes will be presented
      before they take effect where law requires. Security practices and reporting are
      described at <a href="/security">/security</a>.
    </p></section>

    <section id="ending"><h2>Ending service and mandatory rights</h2><p>
      You can cancel a subscription and delete an eligible account in product. Team
      administration may need transfer first. Fornace may suspend or end access for
      material breach, unlawful use, security risk, or non-payment, while preserving
      mandatory notice and remedy rights. Italian law applies to the extent permitted;
      consumers keep mandatory protections and forums available in their country. Nothing
      here excludes a right or liability that applicable law does not allow to be excluded.
    </p></section>
  </>;
}
