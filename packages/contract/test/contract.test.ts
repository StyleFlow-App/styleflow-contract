import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { unzipSync, zipSync } from "fflate";
import { describe, expect, it } from "vitest";

import goldenBundle from "./fixtures/golden-release.json";
import { FigmaBundleImportError, importFigmaBundle } from "../src/figma";

import {
  affectedPaths,
  applyDraftOperations,
  buildBundle,
  BundleImportError,
  closestRampPosition,
  compileProject,
  contrastRatio,
  createPresetSource,
  evaluateFigmaTarget,
  generateColorRamp,
  importBundle,
  INTERACTION_STATES,
  interpolateOklch,
  materializeIntermediateStop,
  oklchSourceFromHex,
  parseDraftOperationBatch,
  stableStringify,
  validateProjectSource,
  type BreakpointDefinition,
  type ColorRamp,
  type StyleflowProjectSource,
} from "../src";

function rewriteFigmaProjection(
  bytes: Uint8Array,
  mutate: (projection: Record<string, unknown>) => void,
): Uint8Array {
  const files = unzipSync(bytes);
  const encoder = new TextEncoder();
  const projectionPath = "targets/figma-vnext.json";
  const manifestPath = "styleflow.manifest.json";
  const projection = JSON.parse(new TextDecoder().decode(files[projectionPath]!)) as Record<
    string,
    unknown
  >;
  mutate(projection);
  files[projectionPath] = encoder.encode(stableStringify(projection));
  const manifest = JSON.parse(new TextDecoder().decode(files[manifestPath]!)) as {
    files: Array<{ path: string; bytes: number; sha256: string }>;
  };
  const entry = manifest.files.find((item) => item.path === projectionPath)!;
  entry.bytes = files[projectionPath]!.byteLength;
  entry.sha256 = bytesToHex(sha256(files[projectionPath]!));
  files[manifestPath] = encoder.encode(stableStringify(manifest));
  const payloadPaths = Object.keys(files)
    .filter((path) => path !== "checksums.sha256")
    .sort();
  files["checksums.sha256"] = encoder.encode(
    `${payloadPaths.map((path) => `${bytesToHex(sha256(files[path]!))}  ${path}`).join("\n")}\n`,
  );
  return zipSync(files);
}

describe("Styleflow project source", () => {
  it("validates the production preset and its complete matrices", () => {
    const source = createPresetSource();
    const result = validateProjectSource(source);
    expect(result.valid).toBe(true);
    expect(result.diagnostics).toEqual([]);
    expect(source.layout.scales.breakpoints.map((item) => [item.id, item.minWidth])).toEqual([
      ["xs", 0],
      ["sm", 640],
      ["md", 768],
      ["lg", 1024],
      ["xl", 1280],
      ["2xl", 1536],
    ]);
    expect(source.layout.recipes).toHaveLength(30);
    expect(source.colors.surfaces).toHaveLength(20);
    for (const profile of source.colors.intensityProfiles) {
      const ramp = source.colors.ramps.find((item) => item.id === profile.toneId)!;
      expect(Object.values(profile.mappingByTheme).map((mapping) => mapping.base)).toEqual([
        ramp.generator.basePosition,
        ramp.generator.basePosition,
        ramp.generator.basePosition,
      ]);
    }
  });

  it("rejects duplicate IDs, missing mappings and cyclic themes", () => {
    const source = createPresetSource();
    source.colors.ramps.push(structuredClone(source.colors.ramps[0]!));
    delete source.colors.intensityProfiles[0]!.mappingByTheme.light!.base;
    source.themes[0]!.parentId = "high-contrast";
    source.themes[1]!.parentId = "light";
    const result = validateProjectSource(source);
    expect(result.valid).toBe(false);
    expect(result.diagnostics.map((item) => item.code)).toEqual(
      expect.arrayContaining([
        "SF_DUPLICATE_ID",
        "SF_INTENSITY_MAPPING_INCOMPLETE",
        "SF_THEME_CYCLE",
      ]),
    );
  });

  it("marks Figma unsupported over ten breakpoints without truncating the contract", () => {
    const source = createPresetSource();
    for (let index = 6; index < 11; index += 1) {
      const breakpoint: BreakpointDefinition = {
        id: `bp-${index}`,
        label: `BP ${index}`,
        minWidth: 1600 + index * 100,
        order: index,
        status: "active",
      };
      source.layout.scales.breakpoints.push(breakpoint);
      for (const recipe of source.layout.recipes)
        recipe.valuesByBreakpoint[breakpoint.id] = {
          gap: { inherit: true },
          paddingInline: { inherit: true },
          paddingBlock: { inherit: true },
          radius: { inherit: true },
          borderWidth: { inherit: true },
          containerMaxWidth: { inherit: true },
        };
      for (const recipe of source.typography.recipes)
        recipe.valuesByBreakpoint[breakpoint.id] = {
          fontSize: { inherit: true },
          lineHeight: { inherit: true },
          letterSpacing: { inherit: true },
          textCase: { inherit: true },
        };
    }
    const compiled = compileProject(source);
    expect(compiled.capabilities.breakpointCount).toBe(11);
    expect(compiled.source.layout.scales.breakpoints).toHaveLength(11);
    expect(compiled.targets["figma-vnext"]).toEqual({
      status: "unsupported",
      reasons: ["BREAKPOINT_MODE_LIMIT_EXCEEDED"],
    });
  });
});

describe("granular operation boundary", () => {
  it("accepts current granular operations and rejects removed monolithic operations", () => {
    expect(
      parseDraftOperationBatch([
        {
          type: "set-layout-cell",
          edit: {
            role: "panel",
            density: "regular",
            breakpointId: "md",
            property: "gap",
            value: { scaleEntryId: "lg" },
          },
        },
        {
          type: "set-interaction-mappings",
          mappings: [
            {
              themeId: "dark",
              contextBackgroundRef: "color.main.base",
              priorityId: "primary",
              recipeId: "primary-default",
              provenance: "manual",
            },
          ],
        },
      ]).success,
    ).toBe(true);
    expect(parseDraftOperationBatch([{ type: "set-layout-scales", scales: {} }]).success).toBe(
      false,
    );
    expect(parseDraftOperationBatch([{ type: "set-typography", typography: {} }]).success).toBe(
      false,
    );
    expect(
      parseDraftOperationBatch([
        {
          type: "set-figma-font-mapping",
          fontSlotId: "main",
          mapping: {
            family: "Manrope",
            stylesByWeight: { default: "Regular", strong: "Bold" },
          },
        },
      ]).success,
    ).toBe(true);
  });

  it("requires an explicit theme for every on-color authoring operation", () => {
    const operation = {
      type: "set-on-color",
      backgroundRefs: ["color.main.base"],
      target: { group: "foreground", role: "primary" },
      tokenRef: "color.neutral.strong-2",
      provenance: "manual",
    };
    expect(parseDraftOperationBatch([operation]).success).toBe(false);
    expect(parseDraftOperationBatch([{ ...operation, themeId: "dark" }]).success).toBe(true);
  });

  it("reports precise affected paths for cell and contextual changes", () => {
    expect(
      affectedPaths({
        type: "set-layout-cell",
        edit: {
          role: "panel",
          density: "regular",
          breakpointId: "md",
          property: "gap",
          value: { scaleEntryId: "lg" },
        },
      }),
    ).toEqual(["/layout/recipes/panel:regular/md/gap"]);
    expect(
      affectedPaths({
        type: "set-interaction-mappings",
        mappings: [
          {
            themeId: "dark",
            contextBackgroundRef: "color.main.base",
            priorityId: "primary",
            recipeId: "primary-default",
            provenance: "manual",
          },
        ],
      }),
    ).toEqual(["/colors/interactions/mappings/dark:color.main.base:primary"]);
  });
});

describe("theme-scoped on-color authoring", () => {
  it("changes foreground and border only in the selected theme", () => {
    const source = createPresetSource();
    const backgroundRef = "color.main.base" as const;
    const baseline = compileProject(source);
    const lightBefore = baseline.themes
      .find((theme) => theme.id === "light")!
      .onColors.find((contract) => contract.backgroundRef === backgroundRef)!;
    const darkBefore = baseline.themes
      .find((theme) => theme.id === "dark")!
      .onColors.find((contract) => contract.backgroundRef === backgroundRef)!;
    const changed = applyDraftOperations(source, [
      {
        type: "set-on-color",
        themeId: "dark",
        backgroundRefs: [backgroundRef],
        target: { group: "foreground", role: "primary" },
        tokenRef: "color.accent.base",
        provenance: "manual",
      },
      {
        type: "set-on-color",
        themeId: "dark",
        backgroundRefs: [backgroundRef],
        target: { group: "border", role: "strong" },
        tokenRef: "color.accent.strong-2",
        provenance: "manual",
      },
    ]);
    const compiled = compileProject(changed);
    const lightAfter = compiled.themes
      .find((theme) => theme.id === "light")!
      .onColors.find((contract) => contract.backgroundRef === backgroundRef)!;
    const darkAfter = compiled.themes
      .find((theme) => theme.id === "dark")!
      .onColors.find((contract) => contract.backgroundRef === backgroundRef)!;

    expect(lightAfter.foreground.primary.reference).toBe(lightBefore.foreground.primary.reference);
    expect(lightAfter.border.strong.reference).toBe(lightBefore.border.strong.reference);
    expect(darkAfter.foreground.primary.reference).toBe("color.accent.base");
    expect(darkAfter.border.strong.reference).toBe("color.accent.strong-2");
    expect(darkAfter.foreground.primary.reference).not.toBe(
      darkBefore.foreground.primary.reference,
    );
    expect(changed.colors.onColors.find((item) => item.backgroundRef === backgroundRef)).toEqual(
      expect.objectContaining({
        foreground: source.colors.onColors.find((item) => item.backgroundRef === backgroundRef)!
          .foreground,
        themeOverrides: {
          dark: expect.objectContaining({
            foreground: { primary: "color.accent.base" },
            border: { strong: "color.accent.strong-2" },
            provenance: "manual",
          }),
        },
      }),
    );
  });

  it("resets only the selected theme override and rejects stale theme IDs", () => {
    const source = createPresetSource();
    const backgroundRefs = ["color.main.base" as const];
    const changed = applyDraftOperations(source, [
      {
        type: "set-on-color",
        themeId: "dark",
        backgroundRefs,
        target: { group: "foreground", role: "primary" },
        tokenRef: "color.accent.base",
        provenance: "manual",
      },
      { type: "reset-on-color", themeId: "dark", backgroundRefs },
    ]);
    expect(
      changed.colors.onColors.find((item) => item.backgroundRef === backgroundRefs[0])
        ?.themeOverrides,
    ).toBeUndefined();
    expect(() =>
      applyDraftOperations(source, [
        {
          type: "set-on-color",
          themeId: "missing",
          backgroundRefs,
          target: { group: "foreground", role: "primary" },
          tokenRef: "color.accent.base",
          provenance: "manual",
        },
      ]),
    ).toThrow(/Unknown theme/);
  });
});

describe("color CRUD and dependency remap", () => {
  it("places a deep navy Base by measured lightness and maps semantic dependencies around it", () => {
    const source = createPresetSource();
    const template = structuredClone(source.colors.ramps[0]!) as ColorRamp;
    template.id = "navy";
    template.label = "Navy";
    template.baseColor = { value: "#052851", source: oklchSourceFromHex("#052851") };
    template.generator.mode = "perceived";
    template.stops = [];

    const perceived = applyDraftOperations(source, [{ type: "create-color-ramp", ramp: template }]);
    const ramp = perceived.colors.ramps.find((item) => item.id === "navy")!;
    const profile = perceived.colors.intensityProfiles.find((item) => item.toneId === "navy")!;
    expect(ramp.generator.basePosition).toBe("900");
    expect(ramp.stops.find((stop) => stop.position === "900")?.value).toBe("#052851");
    expect(profile.mappingByTheme.light).toMatchObject({
      base: "900",
      "soft-1": "800",
      "strong-1": "950",
    });
    expect(profile.mappingByTheme.dark).toMatchObject({
      base: "900",
      "soft-1": "950",
      "strong-1": "800",
    });

    const linear = applyDraftOperations(perceived, [
      {
        type: "update-color-ramp",
        toneId: "navy",
        patch: { generator: { ...ramp.generator, mode: "linear" } },
        regenerate: true,
      },
    ]);
    expect(linear.colors.ramps.find((item) => item.id === "navy")?.generator.basePosition).toBe(
      "950",
    );
    for (const mapping of Object.values(
      linear.colors.intensityProfiles.find((item) => item.toneId === "navy")!.mappingByTheme,
    ))
      expect(mapping.base).toBe("950");
  });

  it("creates a complete tone atomically and preserves the original source", () => {
    const source = createPresetSource();
    const template = structuredClone(source.colors.ramps[1]!) as ColorRamp;
    template.id = "success";
    template.label = "Success";
    template.baseColor = { value: "#198754", source: oklchSourceFromHex("#198754") };
    const next = applyDraftOperations(source, [{ type: "create-color-ramp", ramp: template }]);
    expect(source.colors.ramps.some((item) => item.id === "success")).toBe(false);
    expect(next.colors.ramps.find((item) => item.id === "success")?.stops).toHaveLength(13);
    expect(
      next.colors.intensityProfiles.find((item) => item.toneId === "success")?.mappingByTheme,
    ).toHaveProperty("high-contrast.base");
    expect(
      next.colors.onColors.filter((item) => item.backgroundRef.startsWith("color.success.")),
    ).toHaveLength(5);
    expect(next.colors.surfaces.filter((item) => item.toneId === "success")).toHaveLength(5);
  });

  it("deletes an unreferenced generated tone together with its interaction contexts", () => {
    const source = createPresetSource();
    const template = structuredClone(source.colors.ramps[0]!) as ColorRamp;
    template.id = "temporary";
    template.label = "Temporary";
    const created = applyDraftOperations(source, [{ type: "create-color-ramp", ramp: template }]);
    const deleted = applyDraftOperations(created, [
      { type: "delete-color-ramp", toneId: "temporary", replacementToneId: "main" },
    ]);

    expect(deleted.colors.ramps.some((item) => item.id === "temporary")).toBe(false);
    expect(JSON.stringify(deleted)).not.toContain("color.temporary.");
  });

  it("requires Replace & delete for referenced tones and remaps atomically", () => {
    const source = createPresetSource();
    expect(() =>
      applyDraftOperations(source, [{ type: "delete-color-ramp", toneId: "accent" }]),
    ).toThrow(/Replace & delete/);
    const next = applyDraftOperations(source, [
      { type: "delete-color-ramp", toneId: "accent", replacementToneId: "main" },
    ]);
    expect(next.colors.ramps.some((item) => item.id === "accent")).toBe(false);
    expect(JSON.stringify(next)).not.toContain("color.accent.");
    expect(() =>
      applyDraftOperations(source, [
        { type: "delete-color-ramp", toneId: "main", replacementToneId: "accent" },
      ]),
    ).toThrow(/main tone/);
  });

  it("edits non-base intensity mappings as independent cells", () => {
    const next = applyDraftOperations(createPresetSource(), [
      {
        type: "set-intensity-mapping",
        toneId: "main",
        themeId: "dark",
        levelId: "soft-1",
        position: "700",
      },
    ]);
    expect(
      next.colors.intensityProfiles.find((item) => item.toneId === "main")?.mappingByTheme.dark?.[
        "soft-1"
      ],
    ).toBe("700");
  });

  it("keeps the ramp base authored and intensity names canonical", () => {
    const source = createPresetSource();
    const main = source.colors.ramps.find((item) => item.id === "main")!;
    expect(() =>
      applyDraftOperations(source, [
        {
          type: "set-ramp-stop",
          toneId: "main",
          stop: main.stops.find((item) => item.position === main.generator.basePosition)!,
        },
      ]),
    ).toThrow(/Base color/);
    const staleBase = structuredClone(source);
    const staleMain = staleBase.colors.ramps.find((item) => item.id === "main")!;
    const staleStop = staleMain.stops.find(
      (item) => item.position === staleMain.generator.basePosition,
    )!;
    staleStop.value = "#000000";
    staleStop.overridden = true;
    const regenerated = applyDraftOperations(staleBase, [
      { type: "update-color-ramp", toneId: "main", patch: {}, regenerate: true },
    ]);
    expect(
      regenerated.colors.ramps
        .find((item) => item.id === "main")
        ?.stops.find((item) => item.position === main.generator.basePosition)?.value,
    ).toBe(main.baseColor.value);
    expect(() =>
      applyDraftOperations(source, [
        {
          type: "set-intensity-mapping",
          toneId: "main",
          themeId: "dark",
          levelId: "base",
          position: "700",
        },
      ]),
    ).not.toThrow();
    expect(() =>
      applyDraftOperations(source, [
        {
          type: "upsert-intensity-level",
          toneId: "main",
          level: { id: "vivid", label: "Vivid", order: 5, status: "active" },
        },
      ]),
    ).toThrow(/base, soft-N or strong-N/);
  });

  it("preserves manual ramp overrides and can reset them to generated", () => {
    const source = createPresetSource();
    const main = source.colors.ramps.find((item) => item.id === "main")!;
    const sourceValue = oklchSourceFromHex("#abcdef");
    const overridden = applyDraftOperations(source, [
      {
        type: "set-ramp-stop",
        toneId: "main",
        stop: {
          position: "300",
          value: "#abcdef",
          source: sourceValue,
          generated: false,
          overridden: true,
        },
      },
      { type: "update-color-ramp", toneId: "main", patch: {}, regenerate: true },
    ]);
    expect(
      overridden.colors.ramps
        .find((item) => item.id === "main")
        ?.stops.find((item) => item.position === "300")?.value,
    ).toBe("#abcdef");

    const reset = applyDraftOperations(overridden, [
      { type: "reset-ramp-stop", toneId: "main", position: "300" },
    ]);
    const resetStop = reset.colors.ramps
      .find((item) => item.id === "main")
      ?.stops.find((item) => item.position === "300");
    expect(resetStop?.overridden).toBe(false);
    expect(resetStop?.generated).toBe(true);
    expect(resetStop?.value).not.toBe("#abcdef");
    expect(main.stops.find((item) => item.position === "300")?.value).not.toBe("#abcdef");
  });

  it("adds and removes an outer intensity without broken dependencies", () => {
    const source = createPresetSource();
    const profile = source.colors.intensityProfiles.find((item) => item.toneId === "main")!;
    const levels = [
      { id: "soft-3", label: "Soft 3", order: 0, status: "active" as const },
      ...profile.levels.map((level) => ({ ...level, order: level.order + 1 })),
    ];
    const added = applyDraftOperations(
      source,
      levels.map((level) => ({
        type: "upsert-intensity-level" as const,
        toneId: "main",
        level,
      })),
    );
    expect(validateProjectSource(added).valid).toBe(true);
    expect(
      added.colors.intensityProfiles
        .find((item) => item.toneId === "main")
        ?.levels.slice()
        .sort((left, right) => left.order - right.order)[0]?.id,
    ).toBe("soft-3");

    const removed = applyDraftOperations(added, [
      {
        type: "delete-intensity-level",
        toneId: "main",
        levelId: "soft-3",
        replacementLevelId: "soft-2",
      },
      ...profile.levels.map((level) => ({
        type: "upsert-intensity-level" as const,
        toneId: "main",
        level,
      })),
    ]);
    expect(validateProjectSource(removed).valid).toBe(true);
    expect(JSON.stringify(removed)).not.toContain("color.main.soft-3");
  });
});

describe("contextual interactions", () => {
  it("supports reusable recipes and exact theme/background mappings", () => {
    const source = createPresetSource();
    const base = structuredClone(source.colors.interactions.recipes[0]!);
    base.id = "critical-action";
    base.label = "Critical action";
    base.order = 3;
    base.states.hover.background = {
      kind: "token",
      reference: "color.critical.strong-2",
      opacity: 1,
    };
    const contextBackgroundRef = "color.neutral.soft-2" as const;
    const withPriority = applyDraftOperations(source, [
      { type: "upsert-interaction-recipe", recipe: base },
      {
        type: "upsert-interaction-priority",
        priority: { id: "quaternary", label: "Quaternary", order: 3, status: "active" },
      },
      {
        type: "set-interaction-mappings",
        mappings: [
          {
            themeId: "dark",
            contextBackgroundRef,
            priorityId: "primary",
            recipeId: "critical-action",
            provenance: "manual",
          },
        ],
      },
    ]);
    const compiled = compileProject(withPriority);
    const dark = compiled.themes
      .find((item) => item.id === "dark")!
      .interactions.find(
        (item) =>
          item.contextBackgroundRef === contextBackgroundRef && item.priorityId === "primary",
      )!;
    const light = compiled.themes
      .find((item) => item.id === "light")!
      .interactions.find(
        (item) =>
          item.contextBackgroundRef === contextBackgroundRef && item.priorityId === "primary",
      )!;
    expect(dark.states.hover.background?.reference).toBe("color.critical.strong-2");
    expect(dark.states.hover.recipeId).toBe("critical-action");
    expect(dark.states.hover.provenance).toBe("manual");
    expect(light.states.hover.background?.reference).toBe("color.main.strong-1");
    expect(compiled.themes[0]!.interactions).toHaveLength(
      new Set(withPriority.colors.surfaces.flatMap((item) => Object.values(item.backgrounds)))
        .size * 4,
    );
  });

  it("resolves transparent controls from the parent on-color contract", () => {
    const source = createPresetSource();
    const plain = structuredClone(source.colors.interactions.recipes[0]!);
    plain.id = "plain";
    plain.label = "Plain";
    plain.order = 3;
    for (const state of INTERACTION_STATES) {
      plain.states[state].background = { kind: "none" };
      plain.states[state].border = { kind: "none" };
    }
    const contextBackgroundRef = "color.neutral.soft-2" as const;
    const next = applyDraftOperations(source, [
      { type: "upsert-interaction-recipe", recipe: plain },
      {
        type: "set-interaction-mappings",
        mappings: [
          {
            themeId: "light",
            contextBackgroundRef,
            priorityId: "tertiary",
            recipeId: "plain",
            provenance: "manual",
          },
        ],
      },
    ]);
    const resolved = compileProject(next).themes[0]!.interactions.find(
      (item) =>
        item.contextBackgroundRef === contextBackgroundRef && item.priorityId === "tertiary",
    )!.states.default;
    expect(resolved.background).toBeNull();
    expect(resolved.border).toBeNull();
    expect(resolved.roleSourceBackgroundRef).toBe(contextBackgroundRef);
    expect(resolved.foreground.reference).toBe(
      compileProject(next).themes[0]!.onColors.find(
        (item) => item.backgroundRef === contextBackgroundRef,
      )!.foreground.primary.reference,
    );
  });

  it("enforces foreground contrast for deliberately transparent borderless controls", () => {
    const source = createPresetSource();
    const plain = structuredClone(source.colors.interactions.recipes[0]!);
    plain.id = "transparent-failure";
    plain.order = 3;
    plain.states.default.background = { kind: "none" };
    plain.states.default.border = { kind: "none" };
    plain.states.default.foregroundOverrideRef = "color.neutral.soft-2";
    const next = applyDraftOperations(source, [
      { type: "upsert-interaction-recipe", recipe: plain },
      {
        type: "set-interaction-mappings",
        mappings: [
          {
            themeId: "light",
            contextBackgroundRef: "color.neutral.soft-2",
            priorityId: "tertiary",
            recipeId: plain.id,
            provenance: "manual",
          },
        ],
      },
    ]);
    const compiled = compileProject(next);

    expect(compiled.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "SF_CONTRAST_TEXT",
          path: expect.stringContaining("color.neutral.soft-2/tertiary/default/foreground"),
        }),
      ]),
    );
    expect(compiled.diagnostics).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: expect.stringContaining("color.neutral.soft-2/tertiary/default/context"),
        }),
      ]),
    );
  });

  it("remaps recipe deletion, removes priority dimensions and clones theme mappings", () => {
    const source = createPresetSource();
    expect(() =>
      applyDraftOperations(source, [
        { type: "delete-interaction-recipe", recipeId: "primary-default" },
      ]),
    ).toThrow(/Replace & delete/);

    const nextTheme = structuredClone(source.themes[0]!);
    nextTheme.id = "light-alt";
    nextTheme.label = "Light alt";
    nextTheme.parentId = "light";
    const withTheme = applyDraftOperations(source, [{ type: "upsert-theme", theme: nextTheme }]);
    const cloned = withTheme.colors.interactions.mappings.filter(
      (mapping) => mapping.themeId === "light-alt",
    );
    expect(cloned).toHaveLength(
      new Set(withTheme.colors.surfaces.flatMap((surface) => Object.values(surface.backgrounds)))
        .size * 3,
    );
    expect(cloned.every((mapping) => mapping.provenance === "generated")).toBe(true);

    const changed = applyDraftOperations(withTheme, [
      {
        type: "delete-interaction-recipe",
        recipeId: "primary-default",
        replacementRecipeId: "secondary-default",
      },
      { type: "delete-interaction-priority", priorityId: "tertiary" },
    ]);
    expect(
      changed.colors.interactions.recipes.some((recipe) => recipe.id === "primary-default"),
    ).toBe(false);
    expect(
      changed.colors.interactions.mappings.some(
        (mapping) => mapping.recipeId === "primary-default",
      ),
    ).toBe(false);
    expect(
      changed.colors.interactions.mappings.some((mapping) => mapping.priorityId === "tertiary"),
    ).toBe(false);
    expect(validateProjectSource(changed).valid).toBe(true);
  });

  it("rejects incomplete mappings and invalid opacity combinations", () => {
    const source = createPresetSource();
    source.colors.interactions.mappings.pop();
    expect(validateProjectSource(source).diagnostics).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "SF_INTERACTION_MAPPING_MISSING" })]),
    );
    const invalid = createPresetSource() as unknown as Record<string, unknown>;
    const interactions = (invalid.colors as StyleflowProjectSource["colors"]).interactions;
    interactions.recipes[0]!.states.default.background = {
      kind: "token",
      reference: "color.main.base",
      opacity: 0,
    };
    expect(validateProjectSource(invalid).valid).toBe(false);

    const legacy = createPresetSource() as unknown as Record<string, unknown>;
    const legacyColors = legacy.colors as Record<string, unknown>;
    legacyColors.interactions = { priorities: [], defaults: [], overrides: [] };
    expect(validateProjectSource(legacy).valid).toBe(false);
  });

  it("materializes every state and contextual contrast metrics", () => {
    const interaction = compileProject(createPresetSource()).themes[0]!.interactions[0]!;
    expect(Object.keys(interaction.states)).toEqual([
      "default",
      "hover",
      "active",
      "focus-visible",
      "disabled",
    ]);
    expect(interaction.states.default.contextBackground.value).toMatch(/^#/);
    expect(interaction.states.default.backgroundContextRatio).toBeGreaterThanOrEqual(1);
    expect(interaction.states.default.background?.compositedValue).toMatch(/^#/);
    expect(interaction.states["focus-visible"].focusRing).toEqual(
      expect.objectContaining({
        controlRatio: expect.any(Number),
        contextRatio: expect.any(Number),
      }),
    );
  });
});

describe("responsive layout and typography", () => {
  it("applies atomic bulk layout edits and resolves chained inheritance", () => {
    const source = createPresetSource();
    const next = applyDraftOperations(source, [
      {
        type: "bulk-set-layout-cells",
        edits: [
          {
            role: "panel",
            density: "regular",
            breakpointId: "xs",
            property: "gap",
            value: { scaleEntryId: "lg" },
          },
          {
            role: "panel",
            density: "regular",
            breakpointId: "sm",
            property: "gap",
            value: { inherit: true },
          },
          {
            role: "panel",
            density: "regular",
            breakpointId: "md",
            property: "gap",
            value: { inherit: true },
          },
        ],
      },
    ]);
    const resolved = compileProject(next).themes[0]!.layout.recipes.find(
      (item) => item.role === "panel" && item.density === "regular",
    )!;
    expect(resolved.valuesByBreakpoint.xs!.gap).toBe("1.5rem");
    expect(resolved.valuesByBreakpoint.md!.gap).toBe("1.5rem");
  });

  it("remaps scale dependencies before deletion", () => {
    const source = createPresetSource();
    expect(() =>
      applyDraftOperations(source, [
        { type: "delete-layout-scale-entry", scale: "gap", entryId: "md" },
      ]),
    ).toThrow(/Replace & delete/);
    const next = applyDraftOperations(source, [
      { type: "delete-layout-scale-entry", scale: "gap", entryId: "md", replacementEntryId: "lg" },
    ]);
    expect(next.layout.scales.gap.some((item) => item.id === "md")).toBe(false);
    expect(
      next.layout.recipes.some((recipe) =>
        Object.values(recipe.valuesByBreakpoint).some(
          (values) => "scaleEntryId" in values.gap && values.gap.scaleEntryId === "md",
        ),
      ),
    ).toBe(false);
  });

  it("supports arbitrary typography axes and preserves manual recipes during regeneration", () => {
    const source = createPresetSource();
    const manual = structuredClone(source.typography.recipes[0]!);
    manual.provenance = "manual";
    manual.valuesByBreakpoint.xs!.fontSize = { value: "9rem" };
    const edited = applyDraftOperations(source, [
      { type: "set-typography-recipe", recipe: manual },
    ]);
    const generated = edited.typography.recipes.map((item) => ({
      ...structuredClone(item),
      provenance: "generated" as const,
    }));
    const next = applyDraftOperations(edited, [
      {
        type: "set-typography-generator",
        generator: { ...edited.typography.generator, maxRatio: 1.333 },
        generatedRecipes: generated,
      },
    ]);
    expect(
      next.typography.recipes.find(
        (item) =>
          item.tyId === manual.tyId &&
          item.variantId === manual.variantId &&
          item.weightId === manual.weightId,
      )?.valuesByBreakpoint.xs?.fontSize,
    ).toEqual({ value: "9rem" });
    expect(next.typography.generator.maxRatio).toBe(1.333);
  });

  it("creates and removes a breakpoint with complete inherited layout and type cells", () => {
    const source = createPresetSource();
    const created = applyDraftOperations(source, [
      {
        type: "upsert-breakpoint",
        breakpoint: { id: "3xl", label: "3XL", minWidth: 1800, order: 6, status: "active" },
      },
    ]);
    expect(validateProjectSource(created).valid).toBe(true);
    expect(
      created.layout.recipes.every(
        (item) =>
          item.valuesByBreakpoint["3xl"]?.gap && "inherit" in item.valuesByBreakpoint["3xl"]!.gap,
      ),
    ).toBe(true);
    expect(
      created.typography.recipes.every(
        (item) =>
          item.valuesByBreakpoint["3xl"]?.fontSize &&
          "inherit" in item.valuesByBreakpoint["3xl"]!.fontSize,
      ),
    ).toBe(true);
    const removed = applyDraftOperations(created, [
      { type: "delete-breakpoint", breakpointId: "3xl" },
    ]);
    expect(validateProjectSource(removed).valid).toBe(true);
    expect(removed.layout.scales.breakpoints.some((item) => item.id === "3xl")).toBe(false);
  });

  it("materializes recipes for arbitrary types, variants and weights then dependency-remaps deletion", () => {
    const source = createPresetSource();
    const created = applyDraftOperations(source, [
      {
        type: "upsert-typography-type",
        typographyType: {
          id: "metric",
          label: "Metric",
          group: "numbers",
          fontSlotId: "main",
          status: "active",
          variants: [{ id: "hero", label: "Hero", order: 0, status: "active" }],
        },
      },
      {
        type: "upsert-typography-variant",
        typeId: "metric",
        variant: { id: "compact", label: "Compact", order: 1, status: "active" },
      },
      {
        type: "upsert-typography-weight",
        weight: {
          id: "emphasis",
          label: "Emphasis",
          order: 3,
          status: "active",
          stylesByFontSlot: Object.fromEntries(
            source.typography.fontSlots.map((item) => [
              item.id,
              { fontWeight: 620, fontStyle: "normal" },
            ]),
          ),
        },
      },
    ]);
    expect(validateProjectSource(created).valid).toBe(true);
    expect(
      created.typography.recipes.some(
        (item) =>
          item.tyId === "metric" && item.variantId === "compact" && item.weightId === "emphasis",
      ),
    ).toBe(true);
    const removed = applyDraftOperations(created, [
      { type: "delete-typography-type", typeId: "metric", replacementTypeId: "body" },
    ]);
    expect(validateProjectSource(removed).valid).toBe(true);
    expect(removed.typography.recipes.some((item) => item.tyId === "metric")).toBe(false);
  });
});

describe("color engine", () => {
  it("generates the golden deep-navy ramps in perceived and linear modes", () => {
    const baseColor = { value: "#052851", source: oklchSourceFromHex("#052851") };
    const settingsInput = {
      algorithm: "styleflow-ramp-v2",
      mode: "perceived",
      interpolation: "shorter-hue",
      gamutMapping: "css-oklch-local-minde-v1",
      lightnessMin: 0,
      lightnessMax: 1,
      saturationAdjustment: 0,
    } satisfies Omit<ColorRamp["generator"], "basePosition">;
    const settings: ColorRamp["generator"] = {
      ...settingsInput,
      basePosition: closestRampPosition(baseColor, settingsInput),
    };
    const perceived = generateColorRamp(baseColor, settings);
    const linear = generateColorRamp(baseColor, { ...settings, mode: "linear" });

    expect(perceived.basePosition).toBe("900");
    expect(linear.basePosition).toBe("950");
    expect(Object.fromEntries(perceived.stops.map((stop) => [stop.position, stop.value]))).toEqual({
      "000": "#ffffff",
      "050": "#edf6ff",
      "100": "#d9eaff",
      "200": "#b9d3f5",
      "300": "#98bae7",
      "400": "#7aa1d5",
      "500": "#5e88c0",
      "600": "#4470a9",
      "700": "#2e598f",
      "800": "#1a4275",
      "900": "#052851",
      "950": "#001534",
      "1000": "#000000",
    });
    expect(linear.stops.find((stop) => stop.position === "950")?.value).toBe("#052851");
  });

  it("calculates contrast after alpha compositing and interpolates deterministically", () => {
    expect(contrastRatio("#00000080", "#ffffff", "#ffffff")).toBeCloseTo(3.95, 1);
    const stops = [
      { position: "100" as const, value: "#dfe8ff" },
      { position: "200" as const, value: "#c3d3ff" },
    ];
    expect(materializeIntermediateStop(stops, "150")).toBe(
      materializeIntermediateStop(stops, "150"),
    );
    expect(interpolateOklch("#000000", "#ffffff", 0.5)).toBe("#636363");
  });
});

describe("deterministic bundle", () => {
  it("matches the cross-runtime golden release", () => {
    const bundle = buildBundle(createPresetSource(), {
      kind: "release",
      sourceRevision: goldenBundle.sourceRevision,
      version: goldenBundle.version,
    });
    expect({
      sha256: bundle.sha256,
      byteLength: bundle.bytes.byteLength,
      contentHash: bundle.manifest.release?.contentHash,
      filename: bundle.filename,
    }).toEqual({
      sha256: goldenBundle.sha256,
      byteLength: goldenBundle.byteLength,
      contentHash: goldenBundle.contentHash,
      filename: goldenBundle.filename,
    });
  });

  it("round-trips the complete source and deterministic resolved projections", () => {
    const source = createPresetSource();
    const options = { kind: "preview" as const, sourceRevision: 7 };
    const first = buildBundle(source, options);
    const second = buildBundle(structuredClone(source) as StyleflowProjectSource, options);
    expect(first.bytes).toEqual(second.bytes);
    const entries = unzipSync(first.bytes);
    expect(entries["tokens/layout.tokens.json"]).toBeDefined();
    expect(entries["tokens/typography.tokens.json"]).toBeDefined();
    expect(entries["resolved/light/tokens.tokens.json"]).toBeDefined();
    const manifest = JSON.parse(new TextDecoder().decode(entries["styleflow.manifest.json"])) as {
      compiler: { version: string };
    };
    expect(manifest.compiler.version).toBe("1.0.0-beta.6");
    const imported = importBundle(first.bytes);
    expect(imported.contract.axes.layout.roles).toContain("stack");
    expect(imported.contract.axes.layout.roles).toContain("tile");
    expect(new Set(imported.contract.axes.layout.roles).size).toBe(
      imported.contract.axes.layout.roles.length,
    );
    expect(imported.contract.axes.typography.variantsByType.body).toContain("md");
    expect(imported.contract.axes.color.intensitiesByTone.main).toContain("base");
    expect(imported.resolved.light?.contract.resolved.layout.recipes).toHaveLength(30);
    const resolvedTokens = imported.resolved.light?.tokens as Record<string, unknown>;
    expect(resolvedTokens).toHaveProperty("color");
    expect(resolvedTokens).not.toHaveProperty("layout");
    expect(stableStringify(imported.source)).toBe(stableStringify(source));
    expect(buildBundle(imported.source, options).sha256).toBe(first.sha256);
    const checksums = new TextDecoder().decode(entries["checksums.sha256"]).trim().split("\n");
    for (const line of checksums) {
      const [expectedHash, path] = line.split("  ");
      expect(bytesToHex(sha256(entries[path!]!))).toBe(expectedHash);
    }
  });

  it("canonicalizes object key insertion order before compiling the bundle", () => {
    const source = createPresetSource();
    const reordered = structuredClone(source) as StyleflowProjectSource;
    for (const surface of reordered.colors.surfaces) {
      const { default: defaultBackground, raised, sunken } = surface.backgrounds;
      surface.backgrounds = { raised, sunken, default: defaultBackground };
    }
    const options = { kind: "preview" as const, sourceRevision: 8 };
    const canonicalBundle = buildBundle(source, options);
    const reorderedBundle = buildBundle(reordered, options);

    expect(reorderedBundle.bytes).toEqual(canonicalBundle.bytes);
    expect(() => importBundle(reorderedBundle.bytes)).not.toThrow();
  });

  it("exports and imports a checksummed CSP-safe Figma projection", () => {
    const source = createPresetSource();
    const bundle = buildBundle(source, { kind: "preview", sourceRevision: 12 });
    const files = unzipSync(bundle.bytes);
    expect(files["targets/figma-vnext.json"]).toBeDefined();
    expect(files["schemas/figma.schema.json"]).toBeDefined();

    const imported = importFigmaBundle(bundle.bytes);
    expect(imported.bundleSha256).toBe(bundle.sha256);
    expect(imported.projection.sourceRevision).toBe(12);
    expect(imported.projection.contentHash).toBe(bundle.manifest.preview?.contentHash);
    expect(imported.projection.collections.map((item) => item.id)).toEqual(
      expect.arrayContaining([
        "primitive",
        "theme",
        "theme-interaction-background",
        "intensity",
        "breakpoint",
        "density",
        "layout-role",
      ]),
    );
    expect(imported.projection.modeCollections.theme.length).toBeGreaterThan(1);
    expect(imported.projection.modeCollections.tone.length).toBeGreaterThan(0);
    expect(
      imported.projection.modeCollections.tone.every((collectionId) =>
        collectionId.startsWith("tone-"),
      ),
    ).toBe(true);
    expect(imported.projection.axes.theme.map((item) => item.id)).toEqual([
      "light",
      "dark",
      "high-contrast",
    ]);
    expect(imported.projection.textStyles).toHaveLength(30);
    expect(imported.projection.bindings.color.background).toBe("semantic/color/background");
    expect(imported.projection.bindings.layout.gap).toBe("semantic/layout/gap");
    expect(imported.projection.formatVersion).toBe("2.1.0");
    expect(imported.projection.collections.find((item) => item.id === "intensity")?.name).toBe(
      "Styleflow / Color · Intensity",
    );
    expect(imported.projection.collections.find((item) => item.id === "layout-role")?.name).toBe(
      "Styleflow / Layout · Role",
    );

    const variables = new Map(
      imported.projection.collections.flatMap((collection) =>
        collection.variables.map((variable) => [variable.path, variable] as const),
      ),
    );
    expect(variables.has("theme/interaction/default/primary/default/focus-ring/main/soft-2")).toBe(
      false,
    );
    expect(
      imported.projection.bindings.color.interactions["default/primary/default"],
    ).not.toHaveProperty("focusRing");
    expect(
      imported.projection.bindings.color.interactions["default/primary/focus-visible"],
    ).toHaveProperty("focusRing");
    expect(variables.get("semantic/color/background")?.valuesByMode.base).toEqual({
      kind: "alias",
      variablePath: "tone/color/background/base",
    });
    expect(variables.get("tone/color/background/base")?.valuesByMode.main).toEqual({
      kind: "alias",
      variablePath: "theme/color/background/main/base",
    });
    expect(variables.get("theme/color/background/main/base")?.valuesByMode.light).toEqual({
      kind: "alias",
      variablePath: "theme/color/main/base",
    });
    expect(variables.get("theme/color/main/base")?.valuesByMode.light).toEqual({
      kind: "alias",
      variablePath: "primitive/color/main/500",
    });
    expect(variables.get("primitive/color/main/500")?.valuesByMode.default?.kind).toBe("color");
    expect([...variables.values()].flatMap((item) => Object.values(item.valuesByMode))).not.toEqual(
      expect.arrayContaining([{ kind: "unset" }]),
    );
    expect(variables.get("semantic/color/background")?.scopes).toEqual(["FRAME_FILL"]);
    expect(variables.get("semantic/on-color/foreground/primary")?.scopes).toEqual([
      "TEXT_FILL",
      "SHAPE_FILL",
    ]);
    expect(variables.get("semantic/on-color/border/default")?.scopes).toEqual(["STROKE_COLOR"]);
    expect(variables.get("semantic/layout/gap")?.scopes).toEqual(["GAP"]);
    expect(variables.get("semantic/layout/radius")?.scopes).toEqual(["CORNER_RADIUS"]);
    expect(variables.get("semantic/layout/borderWidth")?.scopes).toEqual(["STROKE_FLOAT"]);
    expect(variables.get("primitive/color/main/500")?.scopes).toEqual([]);
    expect(variables.has("semantic/layout/containerMaxWidth")).toBe(false);
    expect(imported.projection.bindings.layout.containerMaxWidth).toBe(
      "density/layout/container/containerMaxWidth",
    );
    expect(variables.get("density/layout/container/containerMaxWidth")?.scopes).toEqual([]);
    expect([...variables.values()].some((item) => item.path.endsWith("background-opacity"))).toBe(
      false,
    );
    expect(
      imported.projection.collections
        .filter((item) => !["intensity", "layout-role"].includes(item.id))
        .flatMap((item) => item.variables)
        .every((item) => item.scopes.length === 0),
    ).toBe(true);
  });

  it("projects asymmetric intensity profiles as one ordered axis over total collections", () => {
    const source = createPresetSource();
    const neutral = source.colors.intensityProfiles.find((item) => item.toneId === "neutral")!;
    for (const level of neutral.levels) level.order += 1;
    neutral.levels.unshift({
      id: "soft-3",
      label: "Soft 3",
      order: 0,
      status: "active",
    });
    for (const mapping of Object.values(neutral.mappingByTheme)) mapping["soft-3"] = "300";
    const onColor = structuredClone(
      source.colors.onColors.find((item) => item.backgroundRef === "color.neutral.soft-2")!,
    );
    onColor.backgroundRef = "color.neutral.soft-3";
    source.colors.onColors.push(onColor);
    const surface = structuredClone(
      source.colors.surfaces.find(
        (item) => item.toneId === "neutral" && item.intensity === "soft-2",
      )!,
    );
    surface.intensity = "soft-3";
    source.colors.surfaces.push(surface);

    expect(evaluateFigmaTarget(source)).toMatchObject({ status: "supported", reasons: [] });
    const first = importFigmaBundle(
      buildBundle(source, { kind: "preview", sourceRevision: 169 }).bytes,
    ).projection;
    const second = importFigmaBundle(
      buildBundle(structuredClone(source), { kind: "preview", sourceRevision: 169 }).bytes,
    ).projection;
    expect(first.axes.intensity.map((item) => item.id)).toEqual([
      "soft-3",
      "soft-2",
      "soft-1",
      "base",
      "strong-1",
      "strong-2",
    ]);
    expect(first.availability.intensityByTone.neutral).toEqual(
      first.axes.intensity.map((item) => item.id),
    );
    expect(first.availability.intensityByTone.main).not.toContain("soft-3");
    expect(first.modeCollections.tone.length).toBeGreaterThan(1);
    for (const collectionId of first.modeCollections.tone) {
      const collection = first.collections.find((item) => item.id === collectionId)!;
      expect(first.availability.modeIdsByCollection[collectionId]).toEqual(
        collection.modes.map((mode) => mode.id),
      );
      expect(
        collection.variables.every(
          (variable) =>
            Object.keys(variable.valuesByMode).length === collection.modes.length &&
            Object.values(variable.valuesByMode).every((value) => value.kind !== "unset"),
        ),
      ).toBe(true);
    }
    expect(stableStringify(first)).toBe(stableStringify(second));
  });

  it("aliases primitive token references directly instead of materializing sparse theme values", () => {
    const source = createPresetSource();
    const onColor = source.colors.onColors[0]!;
    onColor.themeOverrides ??= {};
    onColor.themeOverrides.dark = {
      ...onColor.themeOverrides.dark,
      foreground: {
        ...onColor.themeOverrides.dark?.foreground,
        primary: "color.main.600",
      },
      provenance: "manual",
    };
    const projection = importFigmaBundle(
      buildBundle(source, { kind: "preview", sourceRevision: 173 }).bytes,
    ).projection;
    const variable = projection.collections
      .flatMap((collection) => collection.variables)
      .find(
        (item) =>
          item.path ===
          `theme/on-color/foreground/primary/${onColor.backgroundRef.slice(6).replace(".", "/")}`,
      );
    expect(variable?.valuesByMode.dark).toEqual({
      kind: "alias",
      variablePath: "primitive/color/main/600",
    });
  });

  it("composes interaction background opacity into the terminal RGBA color", () => {
    const source = createPresetSource();
    const background = source.colors.interactions.recipes[0]!.states.hover.background;
    expect(background.kind).toBe("token");
    if (background.kind === "token") background.opacity = 0.4;
    const projection = importFigmaBundle(
      buildBundle(source, { kind: "preview", sourceRevision: 170 }).bytes,
    ).projection;
    expect(
      projection.collections
        .find((item) => item.id === "theme-interaction-background")
        ?.variables.some((item) =>
          Object.values(item.valuesByMode).some(
            (value) => value.kind === "color" && value.a === 0.4,
          ),
        ),
    ).toBe(true);
    expect(
      projection.collections
        .flatMap((item) => item.variables)
        .some((item) => item.path.endsWith("background-opacity")),
    ).toBe(false);
  });

  it("blocks contradictory intensity ordering and real Figma mode overflow", () => {
    const contradictory = createPresetSource();
    contradictory.colors.intensityProfiles[0]!.levels[0]!.order = 1;
    contradictory.colors.intensityProfiles[0]!.levels[1]!.order = 0;
    expect(evaluateFigmaTarget(contradictory).reasons).toContain("INTENSITY_AXIS_ORDER_CONFLICT");

    const overflow = createPresetSource();
    const profile = overflow.colors.intensityProfiles[0]!;
    for (let index = 0; index < 6; index += 1) {
      const id = `extra-${index}`;
      profile.levels.push({ id, label: `Extra ${index}`, order: 10 + index, status: "active" });
      for (const mapping of Object.values(profile.mappingByTheme)) mapping[id] = "500";
    }
    expect(evaluateFigmaTarget(overflow).reasons).toContain("INTENSITY_MODE_LIMIT_EXCEEDED");
  });

  it("omits a lossy Figma projection and returns stable target reasons", () => {
    const source = createPresetSource();
    delete source.settings.targets.figmaFontMappings?.main;
    const compiled = compileProject(source);
    expect(compiled.targets["figma-vnext"]).toEqual({
      status: "unsupported",
      reasons: ["FIGMA_FONT_MAPPING_MISSING"],
    });
    const bundle = buildBundle(source, { kind: "preview", sourceRevision: 13 });
    expect(unzipSync(bundle.bytes)["targets/figma-vnext.json"]).toBeUndefined();
    expect(() => importFigmaBundle(bundle.bytes)).toThrowError(
      expect.objectContaining({
        code: "SF_FIGMA_TARGET_UNSUPPORTED",
        reasons: ["FIGMA_FONT_MAPPING_MISSING"],
      }),
    );
  });

  it("rejects a tampered Figma projection before parsing it", () => {
    const bundle = buildBundle(createPresetSource(), { kind: "preview", sourceRevision: 14 });
    const files = unzipSync(bundle.bytes);
    files["targets/figma-vnext.json"] = new TextEncoder().encode('{"tampered":true}\n');
    expect(() => importFigmaBundle(zipSync(files))).toThrowError(
      expect.objectContaining({ code: "SF_FIGMA_BUNDLE_CHECKSUM_INVALID" }),
    );
    expect(FigmaBundleImportError).toBeDefined();
  });

  it("rejects hostile v2 scope, availability and reachability payloads", () => {
    const bundle = buildBundle(createPresetSource(), { kind: "preview", sourceRevision: 171 });
    const incompatibleScope = rewriteFigmaProjection(bundle.bytes, (projection) => {
      const collections = projection.collections as Array<{
        variables: Array<{ path: string; scopes: string[] }>;
      }>;
      const background = collections
        .flatMap((collection) => collection.variables)
        .find((variable) => variable.path === "semantic/color/background")!;
      background.scopes = ["GAP"];
    });
    expect(() => importFigmaBundle(incompatibleScope)).toThrowError(
      expect.objectContaining({ code: "SF_FIGMA_PROJECTION_INVALID" }),
    );

    const invalidAvailability = rewriteFigmaProjection(bundle.bytes, (projection) => {
      const availability = projection.availability as {
        intensityByTone: Record<string, string[]>;
        modeIdsByCollection: Record<string, string[]>;
      };
      delete availability.intensityByTone.main;
    });
    expect(() => importFigmaBundle(invalidAvailability)).toThrowError(
      expect.objectContaining({ code: "SF_FIGMA_PROJECTION_INVALID" }),
    );

    const invalidCollectionAvailability = rewriteFigmaProjection(bundle.bytes, (projection) => {
      const availability = projection.availability as {
        modeIdsByCollection: Record<string, string[]>;
      };
      delete availability.modeIdsByCollection[Object.keys(availability.modeIdsByCollection)[0]!];
    });
    expect(() => importFigmaBundle(invalidCollectionAvailability)).toThrowError(
      expect.objectContaining({ code: "SF_FIGMA_PROJECTION_INVALID" }),
    );

    const sparseValue = rewriteFigmaProjection(bundle.bytes, (projection) => {
      const collections = projection.collections as Array<{
        variables: Array<{ valuesByMode: Record<string, unknown> }>;
      }>;
      const variable = collections.find((collection) => collection.variables.length > 0)!
        .variables[0]!;
      variable.valuesByMode[Object.keys(variable.valuesByMode)[0]!] = { kind: "unset" };
    });
    expect(() => importFigmaBundle(sparseValue)).toThrowError(
      expect.objectContaining({ code: "SF_FIGMA_PROJECTION_INVALID" }),
    );

    const missingModeCollections = rewriteFigmaProjection(bundle.bytes, (projection) => {
      const modeCollections = projection.modeCollections as Record<string, string[]>;
      delete modeCollections.intensity;
    });
    expect(() => importFigmaBundle(missingModeCollections)).toThrowError(
      expect.objectContaining({ code: "SF_FIGMA_PROJECTION_INVALID" }),
    );

    const missingColorBindings = rewriteFigmaProjection(bundle.bytes, (projection) => {
      const bindings = projection.bindings as Record<string, unknown>;
      delete bindings.color;
    });
    expect(() => importFigmaBundle(missingColorBindings)).toThrowError(
      expect.objectContaining({ code: "SF_FIGMA_PROJECTION_INVALID" }),
    );

    const unreachable = rewriteFigmaProjection(bundle.bytes, (projection) => {
      const collections = projection.collections as Array<{
        id: string;
        variables: Array<Record<string, unknown>>;
      }>;
      collections
        .find((collection) => collection.id === "primitive")!
        .variables.push({
          path: "primitive/color/unreachable",
          name: "Primitive / Color / Unreachable",
          type: "COLOR",
          scopes: [],
          valuesByMode: {
            default: { kind: "color", r: 0, g: 0, b: 0, a: 1 },
          },
        });
    });
    expect(() => importFigmaBundle(unreachable)).toThrowError(
      expect.objectContaining({ code: "SF_FIGMA_PROJECTION_INVALID" }),
    );
  });

  it("rejects projection v1 with an explicit unsupported-version code", () => {
    const bundle = buildBundle(createPresetSource(), { kind: "preview", sourceRevision: 172 });
    const v1 = rewriteFigmaProjection(bundle.bytes, (projection) => {
      projection.formatVersion = "1.0.0";
    });
    expect(() => importFigmaBundle(v1)).toThrowError(
      expect.objectContaining({ code: "SF_FIGMA_PROJECTION_VERSION_UNSUPPORTED" }),
    );
  });

  it("rejects unsafe Figma bundle paths with a stable importer code", () => {
    expect(() =>
      importFigmaBundle(zipSync({ "../outside.json": new Uint8Array([1]) })),
    ).toThrowError(expect.objectContaining({ code: "SF_FIGMA_BUNDLE_PATH_INVALID" }));
  });

  it("rejects tampering and unsafe paths", () => {
    const bundle = buildBundle(createPresetSource(), { kind: "preview", sourceRevision: 1 });
    const files = unzipSync(bundle.bytes);
    files["source/styleflow.project.json"] = new TextEncoder().encode('{"tampered":true}\n');
    expect(() => importBundle(zipSync(files))).toThrowError(
      expect.objectContaining({ code: "SF_BUNDLE_CHECKSUM_MISMATCH" }),
    );
    expect(() => importBundle(zipSync({ "../outside.json": new Uint8Array([1]) }))).toThrowError(
      expect.objectContaining({ code: "SF_BUNDLE_PATH_INVALID" }),
    );
  });

  it("rejects duplicate case-folded entries and suspicious expansion ratios", () => {
    expect(() =>
      importBundle(zipSync({ "A.json": new Uint8Array([1]), "a.json": new Uint8Array([2]) })),
    ).toThrowError(expect.objectContaining({ code: "SF_BUNDLE_PATH_INVALID" }));
    expect(() => importBundle(zipSync({ "payload.bin": new Uint8Array(2_000_000) }))).toThrowError(
      expect.objectContaining({ code: "SF_BUNDLE_SIZE_LIMIT" }),
    );
    expect(BundleImportError).toBeDefined();
  });
});
