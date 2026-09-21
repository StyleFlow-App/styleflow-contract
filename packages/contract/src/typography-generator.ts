import type {
  CssLength,
  StyleflowProjectSource,
  TypographyGeneratorSettings,
  TypographyRecipe,
  TypographyRecipeBreakpointValues,
  TypographyScaleAnchor,
} from "./types";

const LENGTH = /^(-?(?:\d+|\d*\.\d+))(px|rem)$/;

function parseLength(value: CssLength): { value: number; unit: "px" | "rem" } {
  const match = LENGTH.exec(value.trim());
  if (!match) throw new Error(`Typography generator supports px and rem anchors; received "${value}".`);
  return { value: Number(match[1]), unit: match[2] as "px" | "rem" };
}

function format(value: number, unit: "px" | "rem"): CssLength {
  return `${Number(value.toFixed(6))}${unit}`;
}

export function interpolateTypographyScale(
  max: CssLength,
  min: CssLength,
  count: number,
): CssLength[] {
  if (count < 1) return [];
  const high = parseLength(max);
  const low = parseLength(min);
  if (high.unit !== low.unit) throw new Error("Typography scale anchors must use the same unit.");
  if (high.value <= 0 || low.value <= 0)
    throw new Error("Typography scale anchors must be greater than zero.");
  if (high.value < low.value)
    throw new Error("Typography scale max must be greater than or equal to min.");
  if (count === 1) return [format(high.value, high.unit)];
  return Array.from({ length: count }, (_, index) =>
    format(high.value * (low.value / high.value) ** (index / (count - 1)), high.unit),
  );
}

function toPx(length: CssLength): number {
  const parsed = parseLength(length);
  return parsed.unit === "rem" ? parsed.value * 16 : parsed.value;
}

/** Rebuilds variant order and stepped anchors from existing resolved recipe sizes. */
export function deriveTypographyGeneratorFromRecipes(
  source: StyleflowProjectSource,
): StyleflowProjectSource {
  const next = structuredClone(source);
  const breakpoints = [...next.layout.scales.breakpoints].sort(
    (left, right) => left.order - right.order,
  );
  const byType: TypographyGeneratorSettings["byType"] = {};
  for (const type of next.typography.types) {
    const weightId = type.enabledWeightIds.includes("default")
      ? "default"
      : type.enabledWeightIds[0];
    const sizeByVariant = new Map<string, Record<string, CssLength>>();
    for (const variant of type.variants) {
      const recipe = next.typography.recipes.find(
        (item) =>
          item.tyId === type.id && item.variantId === variant.id && item.weightId === weightId,
      );
      let previous: CssLength = "1rem";
      sizeByVariant.set(
        variant.id,
        Object.fromEntries(
          breakpoints.map((breakpoint) => {
            const value = recipe?.valuesByBreakpoint[breakpoint.id]?.fontSize;
            if (value && "value" in value) previous = value.value;
            return [breakpoint.id, previous];
          }),
        ),
      );
    }
    const firstBreakpointId = breakpoints[0]?.id;
    type.variants = [...type.variants]
      .sort((left, right) => {
        if (!firstBreakpointId) return left.order - right.order;
        const leftSize = sizeByVariant.get(left.id)?.[firstBreakpointId] ?? "1rem";
        const rightSize = sizeByVariant.get(right.id)?.[firstBreakpointId] ?? "1rem";
        return toPx(rightSize) - toPx(leftSize) || left.order - right.order;
      })
      .map((variant, order) => ({ ...variant, order }));
    byType[type.id] = {
      mode: "stepped",
      anchorsByBreakpoint: Object.fromEntries(
        breakpoints.map((breakpoint) => {
          const sizes = type.variants.map((variant) =>
            toPx(sizeByVariant.get(variant.id)?.[breakpoint.id] ?? "1rem"),
          );
          return [
            breakpoint.id,
            {
              max: format(Math.max(...sizes) / 16, "rem"),
              min: format(Math.min(...sizes) / 16, "rem"),
            },
          ];
        }),
      ),
    };
  }
  next.typography.generator = {
    ...next.typography.generator,
    byType,
  };
  return next;
}

export function fluidClamp(
  start: CssLength,
  end: CssLength,
  startViewport: number,
  endViewport: number,
): CssLength {
  if (endViewport <= startViewport) throw new Error("Fluid breakpoint viewports must increase.");
  const startPx = toPx(start);
  const endPx = toPx(end);
  const slope = ((endPx - startPx) / (endViewport - startViewport)) * 100;
  const intercept = (startPx - (slope * startViewport) / 100) / 16;
  const minimum = Math.min(startPx, endPx) / 16;
  const maximum = Math.max(startPx, endPx) / 16;
  return `clamp(${format(minimum, "rem")}, calc(${format(intercept, "rem")} + ${Number(slope.toFixed(6))}vw), ${format(maximum, "rem")})`;
}

function resolvedAnchors(
  settings: TypographyGeneratorSettings["byType"][string],
  breakpoints: StyleflowProjectSource["layout"]["scales"]["breakpoints"],
): TypographyScaleAnchor[] {
  let previous: TypographyScaleAnchor | undefined;
  return breakpoints.map((breakpoint) => {
    const value = settings?.anchorsByBreakpoint[breakpoint.id];
    if (value && "max" in value) previous = value;
    if (!previous) throw new Error(`Type generator requires concrete anchors at "${breakpoint.id}".`);
    return previous;
  });
}

function defaultValues(fontSize: CssLength): TypographyRecipeBreakpointValues {
  return {
    fontSize: { value: fontSize },
    lineHeight: { value: "1.5" },
    letterSpacing: { value: "0em" },
    textCase: { value: "original" },
    fontVariationSettings: {},
  };
}

/** Builds a complete enabled type × variant × weight matrix. Apply through the operation layer to preserve manual recipes. */
export function generateTypographyRecipes(
  source: StyleflowProjectSource,
  generator: TypographyGeneratorSettings = source.typography.generator,
): TypographyRecipe[] {
  const breakpoints = [...source.layout.scales.breakpoints].sort(
    (left, right) => left.order - right.order,
  );
  const existing = new Map(
    source.typography.recipes.map((recipe) => [
      `${recipe.tyId}:${recipe.variantId}:${recipe.weightId}`,
      recipe,
    ]),
  );
  const generated: TypographyRecipe[] = [];
  for (const type of source.typography.types.filter((item) => item.enabled)) {
    const settings = generator.byType[type.id];
    if (!settings) throw new Error(`Missing typography generator settings for type "${type.id}".`);
    const variants = [...type.variants]
      .filter((item) => item.enabled)
      .sort((left, right) => left.order - right.order);
    const anchors = resolvedAnchors(settings, breakpoints);
    const scales = anchors.map((anchor) =>
      interpolateTypographyScale(anchor.max, anchor.min, variants.length),
    );
    for (const [variantIndex, variant] of variants.entries())
      for (const weightId of type.enabledWeightIds) {
        const prior = existing.get(`${type.id}:${variant.id}:${weightId}`);
        const valuesByBreakpoint = Object.fromEntries(
          breakpoints.map((breakpoint, breakpointIndex) => {
            const currentSize = scales[breakpointIndex]![variantIndex]!;
            const nextSize = scales[breakpointIndex + 1]?.[variantIndex];
            const fontSize =
              settings.mode === "fluid" && nextSize
                ? fluidClamp(
                    currentSize,
                    nextSize,
                    breakpoint.minWidth,
                    breakpoints[breakpointIndex + 1]!.minWidth,
                  )
                : currentSize;
            const previousValues = prior?.valuesByBreakpoint[breakpoint.id];
            return [
              breakpoint.id,
              previousValues
                ? { ...structuredClone(previousValues), fontSize: { value: fontSize } }
                : defaultValues(fontSize),
            ];
          }),
        );
        generated.push({
          tyId: type.id,
          variantId: variant.id,
          weightId,
          valuesByBreakpoint,
          provenance: "generated",
        });
      }
  }
  return generated;
}
