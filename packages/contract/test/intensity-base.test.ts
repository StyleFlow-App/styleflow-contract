import { describe, expect, it } from "vitest";
import {
  affectedPaths,
  applyDraftOperations,
  buildBundle,
  compileProject,
  contrastRatio,
  createPresetSource,
  importBundle,
  materializeIntermediateStop,
  oklchSourceFromHex,
  validateProjectSource,
  type RampPosition,
  type StyleflowProjectSource,
} from "../src";
import { importFigmaBundle } from "../src/figma";

const profile = (source: StyleflowProjectSource) =>
  source.colors.intensityProfiles.find((item) => item.toneId === "main")!;
const ramp = (source: StyleflowProjectSource) =>
  source.colors.ramps.find((item) => item.id === "main")!;
const setBase = (source: StyleflowProjectSource, themeId: string, position: RampPosition) =>
  applyDraftOperations(source, [
    { type: "set-intensity-mapping", toneId: "main", themeId, levelId: "base", position },
  ]);
const regenerate = (source: StyleflowProjectSource, hex: string) =>
  applyDraftOperations(source, [
    {
      type: "update-color-ramp",
      toneId: "main",
      patch: { baseColor: { value: hex, source: oklchSourceFromHex(hex) } },
      regenerate: true,
    },
  ]);

describe("theme-specific intensity base", () => {
  it("changes only the selected theme's semantic base, without changing ramp or other levels", () => {
    const source = createPresetSource();
    const before = structuredClone(source);
    const next = setBase(source, "dark", "400");
    expect(validateProjectSource(next).valid).toBe(true);
    expect(source).toEqual(before);
    expect(ramp(next)).toEqual(ramp(source));
    expect(profile(next).mappingByTheme).toEqual({
      ...profile(source).mappingByTheme,
      dark: { ...profile(source).mappingByTheme.dark, base: "400" },
    });
    const compiled = compileProject(next);
    const light = compiled.themes.find((theme) => theme.id === "light")!;
    const dark = compiled.themes.find((theme) => theme.id === "dark")!;
    expect(light.tokens["color.main.base"]).toBe(ramp(source).baseColor.value);
    expect(dark.tokens["color.main.base"]).toBe(dark.tokens["color.main.400"]);
    expect(dark.tokens["color.main.base"]).not.toBe(light.tokens["color.main.base"]);
    const onColor = dark.onColors.find((item) => item.backgroundRef === "color.main.base")!;
    expect(onColor.background).toBe(dark.tokens["color.main.base"]);
    expect(onColor.foreground.primary.ratio).toBe(
      contrastRatio(
        onColor.foreground.primary.value,
        onColor.background,
        dark.tokens[next.themes.find((theme) => theme.id === "dark")!.canvasToken]!,
      ),
    );
  });

  it("preserves custom bases on regeneration and follows the ramp only for linked themes", () => {
    const source = setBase(createPresetSource(), "dark", "400");
    const next = regenerate(source, "#052851");
    expect(ramp(next).generator.basePosition).toBe("900");
    expect(profile(next).mappingByTheme.dark?.base).toBe("400");
    expect(profile(next).mappingByTheme.light?.base).toBe("900");
    expect(profile(next).mappingByTheme["high-contrast"]?.base).toBe("900");
    expect(profile(next).mappingByTheme.dark?.["soft-1"]).toBe(
      profile(source).mappingByTheme.dark?.["soft-1"],
    );
    expect(ramp(next).stops.find((stop) => stop.position === "900")?.value).toBe("#052851");
  });

  it("resets one theme to the ramp and resumes following subsequent regenerations", () => {
    const customized = setBase(setBase(createPresetSource(), "dark", "400"), "light", "300");
    const reset = setBase(customized, "dark", ramp(customized).generator.basePosition);
    expect(profile(reset).mappingByTheme.light).toEqual(profile(customized).mappingByTheme.light);
    const next = regenerate(reset, "#052851");
    expect(profile(next).mappingByTheme.dark?.base).toBe("900");
    expect(profile(next).mappingByTheme.light?.base).toBe("300");
  });

  it("treats a custom anchor that meets the new ramp base as linked again", () => {
    const source = setBase(createPresetSource(), "dark", "900");
    const aligned = regenerate(source, "#052851");
    expect(profile(aligned).mappingByTheme.dark?.base).toBe(ramp(aligned).generator.basePosition);
    const next = regenerate(aligned, "#4f72fa");
    expect(profile(next).mappingByTheme.dark?.base).toBe(ramp(next).generator.basePosition);
  });

  it("uses the theme base for the direction of newly added levels", () => {
    // The neighboring soft level is darker than the ramp base but lighter than
    // the theme base. A new soft level must move toward the theme's light canvas.
    const source = setBase(createPresetSource(), "light", "900");
    profile(source).mappingByTheme.light!["soft-2"] = "700";
    const levels = [
      { id: "soft-3", label: "Soft 3", order: 0, status: "active" as const },
      ...profile(source).levels.map((level) => ({ ...level, order: level.order + 1 })),
    ];
    const next = applyDraftOperations(
      source,
      levels.map((level) => ({
        type: "upsert-intensity-level" as const,
        toneId: "main",
        level,
      })),
    );
    expect(profile(next).mappingByTheme.light?.["soft-3"]).toBe("600");
    expect(profile(next).mappingByTheme.light?.base).toBe("900");
  });

  it("retains complete mappings for new child themes and isolates later parent edits", () => {
    const source = setBase(createPresetSource(), "dark", "400");
    const next = applyDraftOperations(source, [
      {
        type: "upsert-theme",
        theme: {
          ...source.themes.find((theme) => theme.id === "dark")!,
          id: "dim",
          label: "Dim",
          parentId: "dark",
        },
      },
    ]);
    expect(profile(next).mappingByTheme.dim).toEqual(profile(next).mappingByTheme.dark);
    const changed = setBase(next, "dark", "300");
    expect(profile(changed).mappingByTheme.dim?.base).toBe("400");
    expect(validateProjectSource(changed).valid).toBe(true);
  });

  it("supports intermediate bases and computes headroom from the semantic base", () => {
    const source = setBase(createPresetSource(), "dark", "450");
    expect(validateProjectSource(source).valid).toBe(true);
    const dark = compileProject(source).themes.find((theme) => theme.id === "dark")!;
    expect(dark.tokens["color.main.base"]).toBe(
      materializeIntermediateStop(ramp(source).stops, "450"),
    );
    const extreme = setBase(source, "dark", "1000");
    expect(validateProjectSource(extreme).diagnostics).toContainEqual(
      expect.objectContaining({
        code: "SF_RAMP_BASE_HEADROOM",
        themeIds: ["dark"],
        blocking: false,
      }),
    );
  });

  it("reports reversed semantic emphasis without normalizing mappings or hiding contrast failures", () => {
    const source = setBase(createPresetSource(), "light", "1000");
    source.settings.accessibility.policy = "block";
    const before = structuredClone(source);
    const compiled = compileProject(source);
    expect(source).toEqual(before);
    expect(compiled.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "SF_INTENSITY_ORDER_NON_MONOTONIC",
        themeIds: ["light"],
        blocking: false,
      }),
    );
    expect(
      compiled.diagnostics.some((item) => item.blocking && item.code.includes("CONTRAST")),
    ).toBe(true);
  });

  it("still rejects missing/invalid coordinates and preserves per-theme conflict paths", () => {
    const source = createPresetSource();
    expect(() => setBase(source, "missing", "400")).toThrow(/Unknown theme/);
    profile(source).mappingByTheme.dark!.base = "425" as RampPosition;
    expect(validateProjectSource(source).valid).toBe(false);
    delete profile(source).mappingByTheme.dark!.base;
    expect(validateProjectSource(source).diagnostics).toContainEqual(
      expect.objectContaining({
        code: "SF_INTENSITY_MAPPING_INCOMPLETE",
        blocking: true,
      }),
    );
    expect(
      affectedPaths({
        type: "set-intensity-mapping",
        toneId: "main",
        themeId: "dark",
        levelId: "base",
        position: "400",
      }),
    ).toEqual(["/colors/intensityProfiles/main/mappingByTheme/dark/base"]);
  });

  it("round-trips deterministic source, resolved colors and Figma aliases with distinct bases", () => {
    const source = setBase(createPresetSource(), "dark", "400");
    const options = { kind: "preview" as const, sourceRevision: 42 };
    const bundle = buildBundle(source, options);
    const imported = importBundle(bundle.bytes);
    expect(imported.source).toEqual(source);
    expect(buildBundle(imported.source, options).bytes).toEqual(bundle.bytes);
    const figma = importFigmaBundle(bundle.bytes);
    expect(figma.projection.formatVersion).toBe("2.1.0");
    const base = figma.projection.collections
      .flatMap((collection) => collection.variables)
      .find((variable) => variable.path === "theme/color/main/base")!;
    expect(base.valuesByMode.light).toEqual({
      kind: "alias",
      variablePath: "primitive/color/main/500",
    });
    expect(base.valuesByMode.dark).toEqual({
      kind: "alias",
      variablePath: "primitive/color/main/400",
    });
    expect(base.valuesByMode["high-contrast"]).toEqual(base.valuesByMode.light);
  });
});
