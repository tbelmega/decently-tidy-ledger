# Decently Tidy Ledger

Decently Tidy Ledger is a web UI for a Decently Coordinated Loops data repo.
It renders the board, item details, and Outbox. Optionally, if used with a fleet of worker computers, it can display the fleet status.

**Read-only UI:** The UI looks like a typical task tracking board, but it is not. You will not be able to update ticket status through drop-down menus, drag card do a different column or anything like that. Items are updated by agents according to the workflow defined in Decently Coordinated Loops (DCL), during autonomous agent work or direct user prompts.
Decently Tidy Ledger is a mere graphical representation of the current state of your data repo.

DCL owns the data contract. This project consumes DCL's versioned item, validation, preflight,
and Outbox modules rather than maintaining copies of them.

## Where is the documentation?

There is none. You don't need any. 
- Start your coding agent of choice in this project
- Ask it
  - "What is this project?"
  - "Install and configure it for me"
  - "How do I start the UI?"
- Your agent will figure it out.

## Run

Install dependencies, copy the settings template, and configure your local DCL data repo:

```sh
bun install
cp settings.template.json settings.local.json
```

Edit `settings.local.json`, then start the Ledger with the simple project command:

```sh
bun run board
```

`settings.local.json` is ignored by Git. Its `dataRepo` may be absolute or relative to the Ledger
project directory. The server always binds to `127.0.0.1`; configure its port in the settings file.

Outbox answers are read-only by default. To enable them, first stop every other process or editor
that can write `OUTBOX.md`, then set `outboxWrites` to `"exclusive"` and run `bun run board`.

The server rejects answer requests without its same-origin session token. Exclusive mode is still
an operator promise: DCL's file lock cannot serialize an editor that ignores it.

## Checks

```sh
bun run typecheck
bun test
bun run test:ui
```

The test suites use the committed synthetic data repo under `test/fixtures/`.

## Optional presence

No fleet worker provider is bundled or active by default. The Workers panel stays hidden when no
provider is registered. A local wrapper can create a `PresenceProviderRegistry`, register one
provider, and pass the registry to `startServer`. `fleet-snapshot.ts` supplies a generic validated
snapshot reader that such a local provider may compose, but it contains no machine-specific path
or provider registration.

## License

Decently Tidy Ledger is licensed under the [MIT License](LICENSE). The fonts vendored in
`public/fonts/` have separate copyright notices and license terms in
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). Exact upstream revisions, source paths,
checksums, and recorded transformations for vendored assets are in
[ASSET_PROVENANCE.md](ASSET_PROVENANCE.md).
