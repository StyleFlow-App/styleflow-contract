import { describe, expect, it } from "vitest";

import {
  applyDraftOperations,
  compileProject,
  createPresetSource,
  evaluateFigmaTarget,
  fluidClamp,
  generateTypographyRecipes,
  interpolateTypographyScale,
  migrateTypographyV1,
  validateProjectSource,
} from "../src";

function legacySource(): unknown {
  const source = structuredClone(createPresetSource()) as unknown as Record<string, unknown>;
  source.formatVersion = "1.0.0";
  const typography = source.typography as Record<string, unknown>;
  typography.generator = {
    baseSize: 16,
    minRatio: 1.125,
    maxRatio: 1.25,
    minViewport: 360,
    maxViewport: 1440,
    lineHeightStrategy: "tight-display-relaxed-body",
  };
  delete typography.tagMappings;
  typography.fontSlots = (typography.fontSlots as Array<Record<string, unknown>>).map((slot) => {
    const { source: _source, enabled: _enabled, ...legacy } = slot;
    return { ...legacy, status: "active" };
  });
  typography.types = (typography.types as Array<Record<string, unknown>>).map((type) => ({
    ...type,
    enabled: undefined,
    enabledWeightIds: undefined,
    status: "active",
    variants: (type.variants as Array<Record<string, unknown>>).map((variant) => ({
      ...variant,
      enabled: undefined,
      status: "active",
    })),
  }));
  typography.weights = (typography.weights as Array<Record<string, unknown>>).map((weight) => ({
    ...weight,
    enabled: undefined,
    status: "active",
  }));
  typography.recipes = (typography.recipes as Array<Record<string, unknown>>).map((recipe) => ({
    ...recipe,
    valuesByBreakpoint: Object.fromEntries(
      Object.entries(recipe.valuesByBreakpoint as Record<string, Record<string, unknown>>).map(
        ([id, values]) => {
          const { fontVariationSettings: _axes, ...legacy } = values;
          return [id, legacy];
        },
      ),
    ),
  }));
  return JSON.parse(JSON.stringify(source));
}

describe("Typography vNext", () => {
  it("migrates v1 once, deterministically, and rejects the legacy source at runtime", () => {
    const legacy = legacySource() as Record<string, any>;
    const legacyRecipes = legacy.typography.recipes as Array<Record<string, any>>;
    legacyRecipes.find(
      (item) => item.tyId === "code" && item.variantId === "md" && item.weightId === "default",
    )!.valuesByBreakpoint.xs.fontSize = { value: "0.75rem" };
    legacyRecipes.find(
      (item) => item.tyId === "code" && item.variantId === "sm" && item.weightId === "default",
    )!.valuesByBreakpoint.xs.fontSize = { value: "0.9375rem" };
    expect(validateProjectSource(legacy).valid).toBe(false);
    const first = migrateTypographyV1(legacy);
    const second = migrateTypographyV1(legacy);
    expect(first).toEqual(second);
    expect(validateProjectSource(first.source).diagnostics).toEqual([]);
    expect(() => migrateTypographyV1(first.source)).toThrow(/Expected legacy formatVersion/);
    expect(first.source.typography.types.every((type) => type.enabledWeightIds.length === 3)).toBe(
      true,
    );
    expect(first.source.typography.types.find((type) => type.id === "code")!.variants).toMatchObject([
      { id: "sm", order: 0 },
      { id: "md", order: 1 },
    ]);
    expect(first.source.typography.generator.byType.code!.anchorsByBreakpoint.xs).toEqual({
      max: "0.9375rem",
      min: "0.75rem",
    });
  });

  it("models every variable axis without assuming a fixed axis list", () => {
    const source = createPresetSource();
    source.typography.fontSlots[0]!.source = {
      kind: "fontsource",
      id: "instrument-sans",
      family: "Instrument Sans",
      version: "5.3.0",
      faces: [
        {
          style: "normal",
          weight: { min: 400, max: 700 },
          url: "https://cdn.jsdelivr.net/npm/@fontsource-variable/instrument-sans@5.3.0/files/instrument-sans-latin-standard-normal.woff2",
          format: "woff2",
          axes: [
            { tag: "wght", min: 400, max: 700, default: 400, step: 1 },
            { tag: "wdth", min: 75, max: 100, default: 100, step: 0.1 },
            { tag: "ital", min: 0, max: 1, default: 0, step: 1 },
          ],
        },
      ],
    };
    const recipe = source.typography.recipes.find((item) => item.tyId === "body")!;
    recipe.valuesByBreakpoint.xs!.fontVariationSettings = {
      wght: { value: 530 },
      wdth: { value: 87.5 },
      ital: { value: 1 },
    };
    expect(validateProjectSource(source).valid).toBe(true);
    const token = compileProject(source).themes[0]!.typography.find(
      (item) => item.id === `${recipe.tyId}-${recipe.variantId}-${recipe.weightId}`,
    )!;
    expect(token.valuesByBreakpoint.xs!.fontVariationSettings).toEqual({
      ital: 1,
      wdth: 87.5,
      wght: 530,
    });
  });

  it("rejects unpinned provider URLs and undeclared or out-of-range axes", () => {
    const source = createPresetSource();
    source.typography.fontSlots[0]!.source.faces[0]!.url =
      "https://example.com/manrope-latest.woff2";
    const recipe = source.typography.recipes.find((item) => item.tyId === "body")!;
    recipe.valuesByBreakpoint.xs!.fontVariationSettings = {
      wght: { value: 9999 },
      TEST: { value: 1 },
    };
    const codes = validateProjectSource(source).diagnostics.map((item) => item.code);
    expect(codes).toEqual(
      expect.arrayContaining([
        "SF_TYPOGRAPHY_REMOTE_URL_INVALID",
        "SF_TYPOGRAPHY_AXIS_VALUE_OUT_OF_RANGE",
        "SF_TYPOGRAPHY_AXIS_MISSING",
      ]),
    );
  });

  it("interpolates largest to smallest and emits piecewise fluid clamps", () => {
    expect(interpolateTypographyScale("4rem", "1rem", 3)).toEqual(["4rem", "2rem", "1rem"]);
    expect(fluidClamp("1rem", "2rem", 0, 640)).toBe(
      "clamp(1rem, calc(1rem + 2.5vw), 2rem)",
    );
    const source = createPresetSource();
    source.typography.generator.byType.body!.mode = "fluid";
    source.typography.generator.byType.body!.anchorsByBreakpoint.sm = {
      max: "2rem",
      min: "1rem",
    };
    const generated = generateTypographyRecipes(source);
    const bodyLarge = generated.find(
      (item) => item.tyId === "body" && item.variantId === "lg" && item.weightId === "default",
    )!;
    expect(bodyLarge.valuesByBreakpoint.xs!.fontSize).toEqual({
      value: "clamp(1.125rem, calc(1.125rem + 2.1875vw), 2rem)",
    });
    expect(bodyLarge.valuesByBreakpoint["2xl"]!.fontSize).toEqual({ value: "2rem" });
    expect(evaluateFigmaTarget(source)).toMatchObject({
      status: "supported-with-warnings",
      reasons: ["FIGMA_FLUID_TYPOGRAPHY_MATERIALIZED_AT_BREAKPOINTS"],
    });
  });

  it("preserves manual recipes when generated recipes are applied", () => {
    const source = createPresetSource();
    source.typography.recipes[0]!.provenance = "manual";
    source.typography.recipes[0]!.valuesByBreakpoint.xs!.fontSize = { value: "9rem" };
    const next = applyDraftOperations(source, [
      {
        type: "set-typography-generator",
        generator: source.typography.generator,
        generatedRecipes: generateTypographyRecipes(source),
      },
    ]);
    expect(next.typography.recipes[0]!.valuesByBreakpoint.xs!.fontSize).toEqual({ value: "9rem" });
  });
});
