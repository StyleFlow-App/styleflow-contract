# AGENTS.md

This public repository contains only the Styleflow vNext contract package.

- Keep the contract deterministic, offline-validatable and free of legacy
  adapters.
- Update types, JSON Schema, compiler/import/export behavior and tests together.
- Every public payload must pass its included schema, checksum validation and
  deterministic recompilation where applicable.
- Run `pnpm typecheck`, `pnpm test`, `pnpm build` and `git diff --check`
  before release.
- Do not add Studio application code, credentials, generated `dist` files or
  consumer packages.
