import { zipSync } from "fflate";
import { afterEach, describe, expect, it, vi } from "vitest";

import { buildBundle, createPresetSource } from "../src";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe("Figma sandbox runtime", () => {
  it("loads and imports bundles without a global TextDecoder", async () => {
    const bundle = buildBundle(createPresetSource(), {
      kind: "preview",
      sourceRevision: 15,
    });
    vi.stubGlobal("TextDecoder", undefined);
    vi.resetModules();

    const { importFigmaBundle } = await import("../src/figma");

    expect(importFigmaBundle(bundle.bytes).projection.sourceRevision).toBe(15);
    expect(() =>
      importFigmaBundle(zipSync({ "checksums.sha256": new Uint8Array([0xc3, 0x28]) })),
    ).toThrowError(expect.objectContaining({ code: "SF_FIGMA_BUNDLE_CHECKSUM_INVALID" }));
  });
});
