import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  closestRampPosition,
  colorMetricLightness,
  contrastRatio,
  generateColorRamp,
  interpolateOklch,
  oklchSourceFromHex,
  stableStringify,
  type ColorRamp,
} from "../src";

const channel = fc.integer({ min: 0, max: 255 });
const color = fc
  .tuple(channel, channel, channel)
  .map((channels) => `#${channels.map((value) => value.toString(16).padStart(2, "0")).join("")}`);

describe("contract properties", () => {
  it("keeps generated ramps complete, monotonic, deterministic and exact at Base", () => {
    fc.assert(
      fc.property(
        color,
        fc.constantFrom("perceived" as const, "linear" as const),
        (value, mode) => {
          const baseColor = { value, source: oklchSourceFromHex(value) };
          const generatorInput = {
            algorithm: "styleflow-ramp-v2",
            mode,
            interpolation: "shorter-hue",
            gamutMapping: "css-oklch-local-minde-v1",
            lightnessMin: 0,
            lightnessMax: 1,
            saturationAdjustment: 0,
          } satisfies Omit<ColorRamp["generator"], "basePosition">;
          const generator: ColorRamp["generator"] = {
            ...generatorInput,
            basePosition: closestRampPosition(baseColor, generatorInput),
          };
          const first = generateColorRamp(baseColor, generator);
          const second = generateColorRamp(baseColor, generator);
          expect(first).toEqual(second);
          expect(first.stops).toHaveLength(13);
          expect(first.stops.find((stop) => stop.position === first.basePosition)?.value).toBe(
            value,
          );
          expect(first.stops.every((stop) => /^#[0-9a-f]{6}$/i.test(stop.value))).toBe(true);
          const lightness = first.stops.map((stop) => colorMetricLightness(stop.value, mode));
          expect(
            lightness.every((item, index) => index === 0 || item <= lightness[index - 1]!),
          ).toBe(true);
        },
      ),
      { numRuns: 100 },
    );
  });

  it("keeps OKLCH interpolation deterministic and inside the serializable gamut", () => {
    fc.assert(
      fc.property(color, color, fc.double({ min: 0, max: 1, noNaN: true }), (from, to, amount) => {
        const first = interpolateOklch(from, to, amount);
        const second = interpolateOklch(from, to, amount);

        expect(first).toBe(second);
        expect(first).toMatch(/^#[0-9a-f]{6}$/);
      }),
      { numRuns: 300 },
    );
  });

  it("calculates symmetric contrast for opaque colors", () => {
    fc.assert(
      fc.property(color, color, (left, right) => {
        expect(contrastRatio(left, right)).toBe(contrastRatio(right, left));
      }),
      { numRuns: 300 },
    );
  });

  it("canonicalizes object keys independently from insertion order", () => {
    fc.assert(
      fc.property(
        fc.dictionary(fc.string({ minLength: 1, maxLength: 8 }), fc.integer()),
        (value) => {
          const reversed = Object.fromEntries(Object.entries(value).reverse());
          expect(stableStringify(value)).toBe(stableStringify(reversed));
        },
      ),
      { numRuns: 200 },
    );
  });
});
