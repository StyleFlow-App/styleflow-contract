# Styleflow Contract

Public source for `@styleflow.app/contract`, the pure Styleflow vNext model,
validator, compiler and deterministic bundle implementation.

The package contains no Studio application code and no legacy compatibility
layer. DTCG token files and resolved outputs are projections of the canonical
vNext source.

## Development

```sh
corepack enable
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm build
```

Node.js 22 or newer and pnpm 10.30.3 are required.

## Release

Release tags use `contract-v<package-version>`. GitHub Actions verifies the
tag against `packages/contract/package.json`, reruns all gates and publishes
with npm provenance. Prereleases use the `next` dist-tag; stable releases use
`latest`.

## License

MIT.
