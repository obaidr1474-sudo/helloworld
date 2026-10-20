# Latest LeadVolt delivery

[Download the company-controls upgrade](https://github.com/obaidr1474-sudo/helloworld/raw/refs/heads/codex/leadvolt-business-routing/leadvolt-delivery/leadvolt-company-upgrade.zip).

[Read the saved handover and remaining work](../leadvolt/NEXT_SESSION.md). The user requested finalization because credits were exhausted; this preserves the exact continuation point. The source, tests, screenshots, migrations and operator instructions are included. Private environment files, installed dependencies and database backups are excluded.

Final build and 91 automated checks passed. The three browser suites covered 36 scenarios. Dedicated booking-review UI and the live Bayut connector remain pending. Earlier ZIPs are preserved below.

---

# LeadVolt downloads

[Download the latest CRM workflow upgrade](https://github.com/obaidr1474-sudo/helloworld/raw/refs/heads/codex/leadvolt-business-routing/leadvolt-delivery/leadvolt-routing-upgrade.zip).

Extract the ZIP and open `leadvolt/README.md`. The full source, database migrations, tests, screenshots, integration contract and deployment guide are included. Installed dependencies, private environment files and database backups are excluded.

[Read the workflow and validation report](../leadvolt/docs/BUSINESS_UPGRADE.md).

The upgrade implements listing responsibility separately from the Bayut publisher, administrator resolution of unassigned enquiries and daily agent accountability. It passed 71 automated checks and 26 browser scenarios; production containers and backup recovery were exercised using fictional data. Live Bayut delivery still needs the admin-confirmed method and provider acceptance.

`leadvolt-routing-upgrade.json` records the source commit and ZIP checksum. The previous `leadvolt-improved.zip` remains available as the earlier delivery.
