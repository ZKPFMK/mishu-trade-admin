# MiShu Trade Admin

- This is an independent repository. Never import a sibling repository at runtime or directly open the business platform database.
- Keep source orders, ownership and journal mutations in the source service. Projections are read models. Real-source commands require explicit deployment enablement, separate credentials, two-person approval and authoritative transactional validation.
- Preserve integer precision, application boundaries, immutable journals, two-person approval and command idempotency.
- Run meaningful isolated checks after each completed change and commit locally. Report commit hashes. Do not push unless explicitly requested.
- Never commit `.env`, `.local`, database files, credentials, backups, exports or logs. Tests use temporary schemas and synthetic data.
- Follow the MiShu color, typography and theme conventions in `docs/admin-ui.md`.
