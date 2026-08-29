# Decently Confusing Tool Suite

- **Decently Coordinated Loops** (DCL) is an open-source workflow project providing agent skills and command-line tools for coordinating workstreams.
- Today, DCL uses a Git-backed filesystem data repository containing Markdown and configuration files as its supported tracking and persistence model.
- The longer-term vision is for DCL to support additional tracking and persistence systems through explicit adapters. That adapter layer does not exist yet, so alternative backends are a direction rather than a current capability.
- **Decently Tidy Ledger** (DTL, this project) is currently an optional UI for DCL's filesystem data repository. It uses DCL-owned parsers, types, validation, configuration, and Outbox functions where available, while reading the repository files directly.

## Hard rules

- This project is published as open source project. Do not document or reference any user specific or project specific content here. Anything instance specific belongs into the DCL data repo. `settings.local.json` is a git-ignored config file that may contain personal data like folder paths.
- DCL owns the coordination data contract. For the current filesystem backend, use DCL-owned contract modules where they exist and isolate DTL's direct filesystem access from presentation logic. Do not infer contract rules from one user's local data.
- Future persistence backends should enter through an explicit DCL-owned adapter contract. Do not add one-off backend integrations to DTL or describe an adapter as supported before that contract exists.

## Worktrees and branching

Work on branch master in the main checkout. Do not create any branches or worktrees unless prompted by the user.

This project is local, presentation only and low stakes - nothing depends on it. Do not overthink changes that we are making.
