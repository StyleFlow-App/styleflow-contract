import { readFile } from "node:fs/promises";

import { buildBundle, createPresetSource } from "../dist/index.js";

const golden = JSON.parse(
  await readFile(new URL("../test/fixtures/golden-release.json", import.meta.url), "utf8"),
);
const bundle = buildBundle(createPresetSource(), {
  kind: "release",
  sourceRevision: golden.sourceRevision,
  version: golden.version,
});
const actual = {
  sha256: bundle.sha256,
  byteLength: bundle.bytes.byteLength,
  contentHash: bundle.manifest.release?.contentHash,
  filename: bundle.filename,
};
const expected = {
  sha256: golden.sha256,
  byteLength: golden.byteLength,
  contentHash: golden.contentHash,
  filename: golden.filename,
};

if (JSON.stringify(actual) !== JSON.stringify(expected)) {
  throw new Error(
    `Golden release mismatch on ${process.platform}/${process.arch} ${process.version}: ${JSON.stringify({ expected, actual })}`,
  );
}

console.log(
  JSON.stringify({
    event: "contract.golden.verified",
    runtime: process.version,
    platform: process.platform,
    arch: process.arch,
    ...actual,
  }),
);
