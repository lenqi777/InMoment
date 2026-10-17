# InMoment development rules

- Windows desktop MVP. Preserve the agreed interaction: initial right-button hold records, release pauses; clicking Continue thereafter records hands-free and the Pause button pauses. All segments belong to one draft.
- Never call a real model/API during development or tests without the human user's explicit approval for that call. Reading public documentation and downloading public development dependencies is permitted. Tests use injected mock fetch and synthetic audio only.
- Never copy credentials from chat into source, examples, fixtures, logs, screenshots, or build artifacts. Each app user supplies their own key through local settings. OS-protected key material and all user data must stay outside tracked source.
- Before Complete, keep capture data local and provisional. Discard invalidates callbacks first, then clears screenshots, audio, metadata, and temporary files. Saved/committing records and draft cleanup must not race.
- Do not silently record, take desktop-wide screenshots, download speech models, or upload data. A permission or capability failure must remain visible.
- `pnpm test` and `pnpm check` run locally without API calls. Do not publish a GitHub repository or release without a direct user request.
