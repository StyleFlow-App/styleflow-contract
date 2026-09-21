import { FORMAT_VERSION, type StyleflowProjectSource, type TypographyFontSource } from "./types";
import { deriveTypographyGeneratorFromRecipes } from "./typography-generator";

export interface TypographyV1MigrationResult {
  source: StyleflowProjectSource;
  warnings: string[];
}

type JsonRecord = Record<string, unknown>;

function record(value: unknown, label: string): JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(`Invalid legacy ${label}`);
  return value as JsonRecord;
}

function array(value: unknown, label: string): JsonRecord[] {
  if (!Array.isArray(value)) throw new Error(`Invalid legacy ${label}`);
  return value.map((item) => record(item, label));
}

function fontsource(id: string, family: string, file: string, axes: TypographyFontSource["faces"][number]["axes"]): TypographyFontSource {
  return {
    kind: "fontsource",
    id,
    family,
    version: "5.3.0",
    faces: [
      {
        style: "normal",
        weight: {
          min: axes.find((axis) => axis.tag === "wght")?.min ?? 400,
          max: axes.find((axis) => axis.tag === "wght")?.max ?? 700,
        },
        url: `https://cdn.jsdelivr.net/npm/@fontsource-variable/${id}@5.3.0/files/${file}`,
        format: "woff2",
        axes,
      },
    ],
  };
}

function migrateFontSource(slot: JsonRecord, warnings: string[]): TypographyFontSource {
  const familyStack = Array.isArray(slot.familyStack)
    ? slot.familyStack.filter((item): item is string => typeof item === "string")
    : [];
  const family = familyStack[0] ?? String(slot.label ?? slot.id ?? "Local font");
  if (family === "Manrope Variable")
    return fontsource("manrope", family, "manrope-latin-wght-normal.woff2", [
      { tag: "wght", min: 200, max: 800, default: 400, step: 1 },
    ]);
  if (family === "Bricolage Grotesque Variable")
    return fontsource(
      "bricolage-grotesque",
      family,
      "bricolage-grotesque-latin-standard-normal.woff2",
      [
        { tag: "opsz", min: 12, max: 96, default: 14, step: 0.1 },
        { tag: "wght", min: 200, max: 800, default: 400, step: 1 },
        { tag: "wdth", min: 75, max: 100, default: 100, step: 0.1 },
      ],
    );
  if (family === "JetBrains Mono Variable") {
    const source = fontsource(
      "jetbrains-mono",
      family,
      "jetbrains-mono-latin-wght-normal.woff2",
      [
        { tag: "ital", min: 0, max: 1, default: 0, step: 1 },
        { tag: "wght", min: 100, max: 800, default: 400, step: 1 },
      ],
    );
    if (source.kind === "fontsource")
      source.faces.push({
        ...structuredClone(source.faces[0]!),
        style: "italic",
        url: "https://cdn.jsdelivr.net/npm/@fontsource-variable/jetbrains-mono@5.3.0/files/jetbrains-mono-latin-wght-italic.woff2",
      });
    return source;
  }
  warnings.push(`Font "${family}" converted to local; verify availability on every consumer.`);
  return {
    kind: "local",
    family,
    localName: family.replace(/ Variable$/, ""),
    faces: [{ style: "normal", weight: { min: 1, max: 1000 }, axes: [] }],
  };
}

function defaultTagMappings(
  types: StyleflowProjectSource["typography"]["types"],
  weightIds: string[],
) {
  const defaults = [
    { tag: "h1", tyId: "heading", variantId: "1", weightId: "strong" },
    { tag: "h2", tyId: "heading", variantId: "2", weightId: "strong" },
    { tag: "h3", tyId: "heading", variantId: "3", weightId: "strong" },
    { tag: "h4", tyId: "heading", variantId: "3", weightId: "strong" },
    { tag: "h5", tyId: "heading", variantId: "3", weightId: "default" },
    { tag: "h6", tyId: "heading", variantId: "3", weightId: "default" },
    { tag: "p", tyId: "body", variantId: "md", weightId: "default" },
    { tag: "li", tyId: "body", variantId: "md", weightId: "default" },
    { tag: "blockquote", tyId: "body", variantId: "lg", weightId: "default" },
    { tag: "small", tyId: "body", variantId: "sm", weightId: "default" },
    { tag: "strong", weightId: "strong" },
    { tag: "em", weightId: "default" },
    { tag: "code", tyId: "code", variantId: "sm", weightId: "default" },
    { tag: "label", tyId: "label", variantId: "md", weightId: "default" },
    { tag: "button", tyId: "label", variantId: "md", weightId: "strong" },
  ] as StyleflowProjectSource["typography"]["tagMappings"];
  return defaults.filter((mapping) => {
    const type = mapping.tyId ? types.find((item) => item.id === mapping.tyId) : undefined;
    if (mapping.tyId && !type) return false;
    if (mapping.variantId && !type?.variants.some((item) => item.id === mapping.variantId))
      return false;
    return !mapping.weightId || weightIds.includes(mapping.weightId);
  });
}

const LEGACY_LENGTH = /^(\d+(?:\.\d+)?|\.\d+)(px|rem)$/;

function lengthInPx(value: string): number | undefined {
  const match = LEGACY_LENGTH.exec(value.trim());
  if (!match) return undefined;
  const numeric = Number(match[1]);
  return match[2] === "rem" ? numeric * 16 : numeric;
}

function remFromPx(value: number): string {
  return `${Number((value / 16).toFixed(6))}rem`;
}

function legacyFontSizes(
  recipes: JsonRecord[],
  typeId: unknown,
  variantIds: string[],
  weightId: string | undefined,
  breakpoints: JsonRecord[],
): Record<string, Record<string, number>> {
  return Object.fromEntries(
    variantIds.map((variantId) => {
      const recipe = recipes.find(
        (item) => item.tyId === typeId && item.variantId === variantId && item.weightId === weightId,
      );
      const rawByBreakpoint = recipe
        ? record(recipe.valuesByBreakpoint, "recipe breakpoints")
        : {};
      let previous = 16;
      const byBreakpoint = Object.fromEntries(
        breakpoints.map((breakpoint) => {
          const breakpointId = String(breakpoint.id);
          const rawValues = rawByBreakpoint[breakpointId]
            ? record(rawByBreakpoint[breakpointId], "recipe values")
            : {};
          const rawFontSize = rawValues.fontSize
            ? record(rawValues.fontSize, "font size")
            : {};
          const next =
            typeof rawFontSize.value === "string" ? lengthInPx(rawFontSize.value) : undefined;
          if (next !== undefined) previous = next;
          return [breakpointId, previous];
        }),
      );
      return [variantId, byBreakpoint];
    }),
  );
}

/** One-shot offline migration. Runtime import intentionally accepts only FORMAT_VERSION afterwards. */
export function migrateTypographyV1(input: unknown): TypographyV1MigrationResult {
  const legacy = structuredClone(record(input, "source"));
  if (legacy.formatVersion !== "1.0.0")
    throw new Error(`Expected legacy formatVersion "1.0.0"; received "${String(legacy.formatVersion)}".`);
  const typography = record(legacy.typography, "typography");
  const layout = record(legacy.layout, "layout");
  const scales = record(layout.scales, "layout scales");
  const breakpoints = array(scales.breakpoints, "breakpoints");
  const weights = array(typography.weights, "typography weights");
  const weightIds = weights.map((weight) => String(weight.id));
  const warnings: string[] = [];

  typography.fontSlots = array(typography.fontSlots, "font slots").map((slot) => {
    const { status, ...rest } = slot;
    return { ...rest, source: migrateFontSource(slot, warnings), enabled: status !== "deprecated" };
  });
  typography.weights = weights.map((weight) => {
    const { status, ...rest } = weight;
    return { ...rest, enabled: status !== "deprecated" };
  });
  const recipes = array(typography.recipes, "typography recipes");
  typography.recipes = recipes.map((recipe) => ({
    ...recipe,
    valuesByBreakpoint: Object.fromEntries(
      Object.entries(record(recipe.valuesByBreakpoint, "typography recipe breakpoints")).map(
        ([breakpointId, rawValues]) => [
          breakpointId,
          { ...record(rawValues, "typography recipe values"), fontVariationSettings: {} },
        ],
      ),
    ),
  }));
  const types = array(typography.types, "typography types");
  const firstBreakpoint = String(breakpoints[0]?.id ?? "xs");
  const migratedTypes = types.map((type) => {
    const { status, ...rest } = type;
    const originalVariants = array(type.variants, "typography variants");
    const variantIds = originalVariants.map((variant) => String(variant.id));
    const sizes = legacyFontSizes(
      recipes,
      type.id,
      variantIds,
      weightIds.includes("default") ? "default" : weightIds[0],
      breakpoints,
    );
    const orderedVariants = [...originalVariants].sort((left, right) => {
      const sizeDifference =
        (sizes[String(right.id)]?.[firstBreakpoint] ?? 16) -
        (sizes[String(left.id)]?.[firstBreakpoint] ?? 16);
      return sizeDifference || Number(left.order) - Number(right.order);
    });
    return {
      ...rest,
      enabled: status !== "deprecated",
      enabledWeightIds: [...weightIds],
      variants: orderedVariants.map((variant, order) => {
        const { status: variantStatus, ...variantRest } = variant;
        return { ...variantRest, order, enabled: variantStatus !== "deprecated" };
      }),
    };
  });
  typography.types = migratedTypes;

  typography.generator = {
    lineHeightStrategy:
      record(typography.generator, "typography generator").lineHeightStrategy ??
      "tight-display-relaxed-body",
    byType: Object.fromEntries(
      types.map((type) => {
        const migratedType = migratedTypes.find(
          (item) => String((item as JsonRecord).id) === String(type.id),
        )!;
        const variantIds = migratedType.variants.map((variant) =>
          String((variant as JsonRecord).id),
        );
        const sizes = legacyFontSizes(
          recipes,
          type.id,
          variantIds,
          weightIds.includes("default") ? "default" : weightIds[0],
          breakpoints,
        );
        return [
          String(type.id),
          {
            mode: "stepped",
            anchorsByBreakpoint: Object.fromEntries(
              breakpoints.map((breakpoint) => {
                const breakpointId = String(breakpoint.id);
                const values = variantIds.map(
                  (variantId) => sizes[variantId]?.[breakpointId] ?? 16,
                );
                return [
                  breakpointId,
                  {
                    max: remFromPx(Math.max(...values)),
                    min: remFromPx(Math.min(...values)),
                  },
                ];
              }),
            ),
          },
        ];
      }),
    ),
  };
  typography.tagMappings = defaultTagMappings(
    migratedTypes as StyleflowProjectSource["typography"]["types"],
    weightIds,
  );
  legacy.formatVersion = FORMAT_VERSION;
  return {
    source: deriveTypographyGeneratorFromRecipes(
      legacy as unknown as StyleflowProjectSource,
    ),
    warnings,
  };
}
