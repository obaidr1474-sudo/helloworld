# LeadVolt downloads

[Download the latest CRM workflow upgrade](https://github.com/obaidr1474-sudo/helloworld/raw/refs/heads/codex/leadvolt-business-routing/leadvolt-delivery/leadvolt-routing-upgrade.zip).

Extract the ZIP and open `leadvolt/README.md`. The full source, database migrations, tests, screenshots, integration contract and deployment guide are included. Installed dependencies, private environment files and database backups are excluded.

[Read the workflow and validation report](../leadvolt/docs/BUSINESS_UPGRADE.md).

The upgrade implements listing responsibility separately from the Bayut publisher, administrator resolution of unassigned enquiries and daily agent accountability. It passed 71 automated checks and 26 browser scenarios; production containers and backup recovery were exercised using fictional data. Live Bayut delivery still needs the admin-confirmed method and provider acceptance.

`leadvolt-routing-upgrade.json` records the source commit and ZIP checksum. The previous `leadvolt-improved.zip` remains available as the earlier delivery.
