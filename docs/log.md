# AI Digest — Session Log

| Date | Task | Status |
|------|------|--------|
| 2026-04-23 10:00 | Fixed Telegram notification URL: repo moved from `pedro-ux` to `pedalmeida`, workflow still sent old link (NOT FOUND). Updated `.github/workflows/daily.yml` + synced local git remote. | ✅ Done |
| 2026-05-06 10:30 | Fixed Daily AI Digest crash via robust JSON extraction | ✅ Done |
| 2026-08-22 | Added optional `/last30days` enrichment stage (`scripts/fetch-last30days.js`) feeding a COMMUNITY_SIGNAL section into the Sonnet prompt. Gated on repo variable `LAST30DAYS_ENABLED`, non-fatal, engine pinned to v3.21.1. Added `REMIX_DRY_RUN=1` to diff the prompt without an API call. Repo un-archived back to `2. Areas/personal-tooling/`. | ✅ Done |
