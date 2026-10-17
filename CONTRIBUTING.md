# Contributing

InMoment currently targets Windows 11 x64. See [the development guide](docs/DEVELOPMENT.md) for installation, isolated data directories and local checks.

Read [AGENTS.md](AGENTS.md) before changing recording or data handling. Preserve the initial hold/release interaction and hands-free Continue/Pause behavior. All segments remain in one draft.

Use synthetic audio, temporary databases and injected mock clients in tests. Do not access a real microphone, capture another app, download a speech model, or run a real model/API without the human user's explicit approval for that action. Public development dependency downloads are allowed.

Run `pnpm check` and `pnpm test`. Describe the observed problem, expected behavior and validation in the pull request. Include synthetic reproduction steps for bugs. Never attach API keys, personal recordings, screenshots or databases; see [SECURITY.md](SECURITY.md).

Model quality, user research and product impact claims need their own evidence. A passing mock test does not establish real model quality.
