# Database migrations

Forward-only, numbered SQL migrations (`001_enums.sql`, `002_ledger_core.sql`, …)
implementing the full DDL from the blueprint, §9:
<https://github.com/mehedihasan8827-dotcom/zikr-light/blob/main/docs/pure-foodmart-erp-blueprint.md>

Arrives in **Batch B1** together with the seed (chart of accounts §3,
posting rules §4.7, fiscal periods). Never edit an applied migration —
add a new one.
