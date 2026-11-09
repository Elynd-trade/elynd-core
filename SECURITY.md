# Security policy

Elynd agents trade real funds. We take reports seriously and respond quickly.

## Reporting a vulnerability

Email **support@elynd.trade** with the subject `SECURITY`. Please include:

- what is affected (package, file, contract function or live endpoint);
- steps to reproduce or a proof of concept;
- the impact you expect (loss of funds, bypass of a risk limit, key exposure, denial of service, and so on).

Please do **not** open a public issue, pull request or discussion for a vulnerability, and do not test against
accounts or agents that are not yours.

## What to expect

- Acknowledgement within 72 hours.
- An initial assessment and severity within 7 days.
- Coordinated disclosure: we fix first, then credit you publicly if you wish.

## Scope

In scope:

- the code in this repository, in particular the risk engine (`packages/risk`), the decision loop and key handling
  (`packages/runner`), order signing (`packages/hyperliquid`) and receipt encoding (`packages/agenthub`);
- the AgentHub contract on Elysium at `0xea1e18e625E9c728C70ad569d20c6CcC9Add7333`;
- the hosted service at elynd.trade.

Especially valuable: any way to make an agent trade outside its risk limits, trade on an account that did not approve
it, exfiltrate or misuse an agent API wallet key, forge or suppress receipts, or buy a listing whose strategy differs
from the one reviewed.

Out of scope: findings that require a compromised user wallet or machine, social engineering, volumetric denial of
service, and issues in third-party services (Hyperliquid, Elysium, model providers) unless Elynd's use of them is the
cause.

## Safe harbor

We will not pursue legal action for good-faith research that follows this policy, avoids privacy violations and
service disruption, and gives us reasonable time to fix the issue before disclosure.
