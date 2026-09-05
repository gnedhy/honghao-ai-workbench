# Procurement ledger surface brief

- Surface: procurement workbench / material ledger and material detail drawer.
- Change type: evolve; medium impact; existing Honghao workbench design remains authoritative.
- Goal: keep 137+ materials usable through an internally scrolling ledger, an optional saved pagination mode, and safer identity/price editing.
- Interaction: ledger toolbar and header remain visible; pagination supports 25/50/100 and 10–200 custom sizes; identity edits require a before/after confirmation; forms use a drawer-bottom panel.
- Responsive: validate at 1440px, 1024px, 390px, and a 110% zoom-equivalent viewport; tables scroll locally and mobile detail uses the full viewport.
- Constraints: no global-shell changes, no new UI library or date picker, no production data mutation during visual review, and no commit before user confirmation.
- Verification: backend tests, frontend tests, typecheck, production build, security gate, browser console, internal scrolling, pagination, mobile overflow, and drawer form spacing.
