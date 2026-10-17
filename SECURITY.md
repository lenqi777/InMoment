# Reporting a security issue

Do not publish API keys, voice recordings, screenshots, private window titles, or databases in GitHub issues or pull requests. Reproduce problems with synthetic data and redact diagnostics.

If a repository maintainer enables GitHub private vulnerability reporting, use that channel for security-sensitive findings. Otherwise contact the maintainer through a private channel they explicitly provide.

Development tests must not contact a real model endpoint without a human user's explicit approval for that request. Use mock fetch implementations and `INMOMENT_DISABLE_NETWORK=1` for desktop automation.
