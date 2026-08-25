import { closestRampPosition, colorMetricLightness, deltaEOK, OKLCH_JND } from "./color";
import { resolveThemeGraph } from "./theme-resolver";
import type { Diagnostic, LayoutProperty, StyleflowProjectSource } from "./types";
import {
  ANCHOR_POSITIONS,
  DENSITIES,
  INTERACTION_STATES,
  LAYOUT_ROLES,
  SURFACE_ROLES,
} from "./types";

function problem(
  code: string,
  path: string,
  message: string,
  suggestion?: string,
  themeIds: string[] = [],
): Diagnostic {
  return {
    code,
    severity: "error",
    blocking: true,
    path,
    themeIds,
    message,
    ...(suggestion ? { suggestion } : {}),
  };
}

function duplicates(path: string, ids: string[]): Diagnostic[] {
  const seen = new Set<string>();
  return ids.flatMap((id, index) => {
    if (seen.has(id))
      return [
        problem(
          "SF_DUPLICATE_ID",
          `/${path}/${index}`,
          `Duplicate public identifier "${id}".`,
          "Use a stable, unique public identifier.",
        ),
      ];
    seen.add(id);
    return [];
  });
}

const LAYOUT_PROPERTY_SCALE: Record<
  LayoutProperty,
  keyof StyleflowProjectSource["layout"]["scales"]
> = {
  gap: "gap",
  paddingInline: "paddingInline",
  paddingBlock: "paddingBlock",
  radius: "radius",
  borderWidth: "stroke",
  containerMaxWidth: "containerWidth",
};

function hasConcrete(value: unknown): value is { scaleEntryId: string } {
  return Boolean(value && typeof value === "object" && "scaleEntryId" in value);
}

function validateCore(source: StyleflowProjectSource): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const collections: Array<[string, string[]]> = [
    ["themes", source.themes.map((item) => item.id)],
    ["colors/ramps", source.colors.ramps.map((item) => item.id)],
    ["colors/intensityProfiles", source.colors.intensityProfiles.map((item) => item.toneId)],
    ["colors/onColors", source.colors.onColors.map((item) => item.backgroundRef)],
    ["colors/surfaces", source.colors.surfaces.map((item) => `${item.toneId}:${item.intensity}`)],
    [
      "colors/interactions/priorities",
      source.colors.interactions.priorities.map((item) => item.id),
    ],
    ["colors/interactions/recipes", source.colors.interactions.recipes.map((item) => item.id)],
    [
      "colors/interactions/mappings",
      source.colors.interactions.mappings.map(
        (item) => `${item.themeId}:${item.contextBackgroundRef}:${item.priorityId}`,
      ),
    ],
    ["layout/recipes", source.layout.recipes.map((item) => `${item.role}:${item.density}`)],
    ["layout/scales/breakpoints", source.layout.scales.breakpoints.map((item) => item.id)],
    ["typography/fontSlots", source.typography.fontSlots.map((item) => item.id)],
    ["typography/types", source.typography.types.map((item) => item.id)],
    ["typography/weights", source.typography.weights.map((item) => item.id)],
    [
      "typography/recipes",
      source.typography.recipes.map((item) => `${item.tyId}:${item.variantId}:${item.weightId}`),
    ],
  ];
  for (const [path, ids] of collections) diagnostics.push(...duplicates(path, ids));
  for (const [scaleName, rawEntries] of Object.entries(source.layout.scales)) {
    if (scaleName === "breakpoints") continue;
    const entries = rawEntries as Array<{ id: string }>;
    diagnostics.push(
      ...duplicates(
        `layout/scales/${scaleName}`,
        entries.map((item) => item.id),
      ),
    );
    if (entries.length === 0)
      diagnostics.push(
        problem(
          "SF_SCALE_EMPTY",
          `/layout/scales/${scaleName}`,
          `Scale "${scaleName}" must contain at least one entry.`,
        ),
      );
  }
  if (source.themes.length === 0)
    diagnostics.push(
      problem("SF_THEME_REQUIRED", "/themes", "A project must contain at least one theme."),
    );
  if (source.colors.interactions.priorities.length === 0)
    diagnostics.push(
      problem(
        "SF_INTERACTION_PRIORITY_REQUIRED",
        "/colors/interactions/priorities",
        "At least one interaction priority is required.",
      ),
    );
  if (
    source.typography.fontSlots.length === 0 ||
    source.typography.types.length === 0 ||
    source.typography.weights.length === 0
  )
    diagnostics.push(
      problem(
        "SF_TYPOGRAPHY_AXIS_EMPTY",
        "/typography",
        "Font slots, types and weights must each contain at least one active item.",
      ),
    );
  return diagnostics;
}

function validateColors(source: StyleflowProjectSource): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const rampIds = new Set(source.colors.ramps.map((item) => item.id));
  if (!rampIds.has("main"))
    diagnostics.push(
      problem(
        "SF_MAIN_TONE_REQUIRED",
        "/colors/ramps",
        'The required public tone "main" is missing.',
      ),
    );
  for (const [index, ramp] of source.colors.ramps.entries()) {
    const positions = ramp.stops.map((stop) => stop.position);
    diagnostics.push(...duplicates(`colors/ramps/${index}/stops`, positions));
    const missing = ANCHOR_POSITIONS.filter((position) => !positions.includes(position));
    if (missing.length)
      diagnostics.push(
        problem(
          "SF_RAMP_ANCHOR_MISSING",
          `/colors/ramps/${index}/stops`,
          `Ramp "${ramp.id}" is missing anchor positions: ${missing.join(", ")}.`,
          "Restore all 13 canonical anchors.",
        ),
      );
    const rampPath = `/colors/ramps/${index}`;
    let baseMetric: number | null = null;
    try {
      baseMetric = colorMetricLightness(ramp.baseColor.value, ramp.generator.mode);
    } catch {
      baseMetric = null;
    }
    if (ramp.generator.lightnessMin >= ramp.generator.lightnessMax)
      diagnostics.push(
        problem(
          "SF_RAMP_LIGHTNESS_BOUNDS_INVALID",
          `${rampPath}/generator`,
          `Ramp "${ramp.id}" must use a lightness minimum lower than its maximum.`,
          "Choose increasing lightness bounds before regenerating the ramp.",
        ),
      );
    else if (
      baseMetric !== null &&
      (baseMetric < ramp.generator.lightnessMin || baseMetric > ramp.generator.lightnessMax)
    )
      diagnostics.push(
        problem(
          "SF_RAMP_BASE_OUTSIDE_BOUNDS",
          `${rampPath}/generator`,
          `Ramp "${ramp.id}" lightness bounds do not contain its authored Base color.`,
          "Expand the bounds to include Base before regenerating the ramp.",
        ),
      );
    else {
      const expectedBase = closestRampPosition(ramp.baseColor, ramp.generator);
      if (expectedBase !== ramp.generator.basePosition)
        diagnostics.push(
          problem(
            "SF_RAMP_BASE_POSITION_INVALID",
            `${rampPath}/generator/basePosition`,
            `Ramp "${ramp.id}" Base belongs at anchor ${expectedBase}, not ${ramp.generator.basePosition}.`,
            "Review regeneration to align Base with its measured lightness.",
          ),
        );
    }
    const baseStop = ramp.stops.find((stop) => stop.position === ramp.generator.basePosition);
    if (!baseStop)
      diagnostics.push(
        problem(
          "SF_RAMP_BASE_MISSING",
          `${rampPath}/stops`,
          `Ramp "${ramp.id}" is missing its Base anchor ${ramp.generator.basePosition}.`,
        ),
      );
    else if (baseStop.value.toLowerCase() !== ramp.baseColor.value.toLowerCase())
      diagnostics.push(
        problem(
          "SF_RAMP_BASE_MISMATCH",
          `${rampPath}/stops/${ramp.generator.basePosition}`,
          `Ramp "${ramp.id}" does not preserve its authored Base color at anchor ${ramp.generator.basePosition}.`,
          "Review ramp regeneration so Base remains the authored color.",
        ),
      );

    const sortedStops = ANCHOR_POSITIONS.flatMap((position) => {
      const stop = ramp.stops.find((item) => item.position === position);
      return stop ? [stop] : [];
    });
    for (let stopIndex = 1; stopIndex < sortedStops.length; stopIndex += 1) {
      const previous = sortedStops[stopIndex - 1]!;
      const current = sortedStops[stopIndex]!;
      const previousLightness = colorMetricLightness(previous.value, ramp.generator.mode);
      const currentLightness = colorMetricLightness(current.value, ramp.generator.mode);
      if (currentLightness > previousLightness + 0.000001) {
        const manual = Boolean(previous.overridden || current.overridden);
        diagnostics.push({
          code: "SF_RAMP_LIGHTNESS_NON_MONOTONIC",
          severity: manual ? "warning" : "error",
          blocking: !manual,
          path: `${rampPath}/stops/${current.position}`,
          themeIds: [],
          message: `Ramp "${ramp.id}" becomes lighter between ${previous.position} and ${current.position}.`,
          suggestion: manual
            ? "Review or reset the manual override."
            : "Regenerate the ramp with valid bounds.",
        });
      }
      const difference = deltaEOK(previous.value, current.value);
      if (difference !== null && difference < OKLCH_JND)
        diagnostics.push({
          code: "SF_RAMP_ADJACENT_COLLAPSE",
          severity: "warning",
          blocking: false,
          path: `${rampPath}/stops/${current.position}`,
          themeIds: [],
          message: `Ramp "${ramp.id}" anchors ${previous.position} and ${current.position} differ by only ${difference.toFixed(4)} ΔEOK.`,
          suggestion: "Increase the available lightness range or adjust one of the stops.",
        });
    }
  }
  const onColorRefs = new Set(source.colors.onColors.map((item) => item.backgroundRef));
  const themeIds = new Set(source.themes.map((item) => item.id));
  for (const [index, profile] of source.colors.intensityProfiles.entries()) {
    if (!rampIds.has(profile.toneId))
      diagnostics.push(
        problem(
          "SF_INTENSITY_TONE_MISSING",
          `/colors/intensityProfiles/${index}/toneId`,
          `Intensity profile references missing tone "${profile.toneId}".`,
        ),
      );
    if (profile.levels.length === 0)
      diagnostics.push(
        problem(
          "SF_INTENSITY_LEVEL_REQUIRED",
          `/colors/intensityProfiles/${index}/levels`,
          `Profile "${profile.toneId}" must keep at least one level.`,
        ),
      );
    diagnostics.push(
      ...duplicates(
        `colors/intensityProfiles/${index}/levels`,
        profile.levels.map((item) => item.id),
      ),
    );
    const levelIdsInProfile = profile.levels.map((item) => item.id);
    if (!levelIdsInProfile.includes("base"))
      diagnostics.push(
        problem(
          "SF_INTENSITY_BASE_REQUIRED",
          `/colors/intensityProfiles/${index}/levels`,
          `Profile "${profile.toneId}" must keep the core Base intensity.`,
        ),
      );
    for (const side of ["soft", "strong"] as const) {
      const numbers = profile.levels
        .filter((item) => item.id.startsWith(`${side}-`))
        .map((item) => Number(item.id.split("-")[1]))
        .sort((left, right) => left - right);
      if (numbers.some((value, numberIndex) => value !== numberIndex + 1))
        diagnostics.push(
          problem(
            "SF_INTENSITY_SEQUENCE_INVALID",
            `/colors/intensityProfiles/${index}/levels`,
            `${side === "soft" ? "Soft" : "Strong"} intensities must be contiguous: ${side}-1, ${side}-2, and so on.`,
            "Keep lower numbers closest to Base and add or remove the outermost level.",
          ),
        );
    }
    const canonicalIds = [...profile.levels]
      .sort((left, right) => {
        const rank = (id: string) => {
          if (id === "base") return 0;
          const number = Number(id.split("-")[1]);
          return id.startsWith("soft-") ? -number : number;
        };
        return rank(left.id) - rank(right.id);
      })
      .map((item) => item.id);
    for (const level of profile.levels) {
      const expectedLabel =
        level.id === "base"
          ? "Base"
          : `${level.id.startsWith("soft-") ? "Soft" : "Strong"} ${level.id.split("-")[1]}`;
      if (level.label !== expectedLabel || level.order !== canonicalIds.indexOf(level.id))
        diagnostics.push(
          problem(
            "SF_INTENSITY_DEFINITION_INVALID",
            `/colors/intensityProfiles/${index}/levels/${level.id}`,
            `Intensity "${level.id}" must use label "${expectedLabel}" and its canonical distance order.`,
            "Keep Soft N above Base and Strong N below Base; lower numbers stay closest.",
          ),
        );
    }
    const levelIds = new Set(profile.levels.map((item) => item.id));
    const ramp = source.colors.ramps.find((item) => item.id === profile.toneId);
    for (const theme of source.themes) {
      const mapping = profile.mappingByTheme[theme.id];
      const missing = profile.levels
        .filter((level) => !mapping?.[level.id])
        .map((level) => level.id);
      if (missing.length)
        diagnostics.push(
          problem(
            "SF_INTENSITY_MAPPING_INCOMPLETE",
            `/colors/intensityProfiles/${index}/mappingByTheme/${theme.id}`,
            `Profile "${profile.toneId}" is missing mappings for ${missing.join(", ")}.`,
            "Map every active intensity for every theme.",
            [theme.id],
          ),
        );
      if (mapping?.base && ramp && mapping.base !== ramp.generator.basePosition)
        diagnostics.push(
          problem(
            "SF_INTENSITY_BASE_MAPPING_INVALID",
            `/colors/intensityProfiles/${index}/mappingByTheme/${theme.id}/base`,
            `Base in ${theme.label} must resolve to the authored ${ramp.generator.basePosition} anchor.`,
            "Review the atomic Base alignment; use Soft or Strong levels for theme-specific distance.",
            [theme.id],
          ),
        );
      if (ramp) {
        const baseIndex = ANCHOR_POSITIONS.indexOf(ramp.generator.basePosition);
        const dark = theme.polarity === "dark" || theme.parentId === "dark";
        const softAvailable = dark ? ANCHOR_POSITIONS.length - baseIndex - 1 : baseIndex;
        const strongAvailable = dark ? baseIndex : ANCHOR_POSITIONS.length - baseIndex - 1;
        const softRequired = profile.levels.filter((level) => level.id.startsWith("soft-")).length;
        const strongRequired = profile.levels.filter((level) =>
          level.id.startsWith("strong-"),
        ).length;
        if (softRequired > softAvailable || strongRequired > strongAvailable)
          diagnostics.push({
            code: "SF_RAMP_BASE_HEADROOM",
            severity: "warning",
            blocking: false,
            path: `/colors/intensityProfiles/${index}/mappingByTheme/${theme.id}`,
            message: `Ramp "${ramp.id}" has limited anchor headroom around Base ${ramp.generator.basePosition} in ${theme.label}.`,
            suggestion: "Reduce the intensity count or review repeated extreme mappings.",
            themeIds: [theme.id],
          });
      }
      for (const key of Object.keys(mapping ?? {}))
        if (!levelIds.has(key))
          diagnostics.push(
            problem(
              "SF_INTENSITY_LEVEL_MISSING",
              `/colors/intensityProfiles/${index}/mappingByTheme/${theme.id}/${key}`,
              `Mapping references missing intensity "${key}".`,
              undefined,
              [theme.id],
            ),
          );
    }
    for (const themeId of Object.keys(profile.mappingByTheme))
      if (!themeIds.has(themeId))
        diagnostics.push(
          problem(
            "SF_INTENSITY_THEME_MISSING",
            `/colors/intensityProfiles/${index}/mappingByTheme/${themeId}`,
            `Mapping references missing theme "${themeId}".`,
          ),
        );
    for (const level of profile.levels) {
      const reference = `color.${profile.toneId}.${level.id}`;
      if (!onColorRefs.has(reference as never))
        diagnostics.push(
          problem(
            "SF_ON_COLOR_CONTRACT_MISSING",
            "/colors/onColors",
            `Usable background "${reference}" has no on-color contract.`,
          ),
        );
      const surface = source.colors.surfaces.find(
        (item) => item.toneId === profile.toneId && item.intensity === level.id,
      );
      if (!surface)
        diagnostics.push(
          problem(
            "SF_SURFACE_RECIPE_MISSING",
            "/colors/surfaces",
            `Tone/intensity "${profile.toneId}.${level.id}" has no explicit surface recipe.`,
          ),
        );
      else
        for (const role of SURFACE_ROLES)
          if (!surface.backgrounds[role])
            diagnostics.push(
              problem(
                "SF_SURFACE_ROLE_MISSING",
                `/colors/surfaces/${profile.toneId}:${level.id}/${role}`,
                `Surface role "${role}" is missing.`,
              ),
            );
    }
  }
  return diagnostics;
}

function validateInteractions(source: StyleflowProjectSource): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const priorityIds = new Set(source.colors.interactions.priorities.map((item) => item.id));
  const recipeIds = new Set(source.colors.interactions.recipes.map((item) => item.id));
  const themeIds = new Set(source.themes.map((item) => item.id));
  const onColorRefs = new Set(source.colors.onColors.map((item) => item.backgroundRef));
  const contextRefs = new Set(
    source.colors.surfaces.flatMap((surface) => Object.values(surface.backgrounds)),
  );
  const priorityOrders = source.colors.interactions.priorities.map((item) => item.order);
  const recipeOrders = source.colors.interactions.recipes.map((item) => item.order);
  if (new Set(priorityOrders).size !== priorityOrders.length)
    diagnostics.push(
      problem(
        "SF_INTERACTION_ORDER_DUPLICATE",
        "/colors/interactions/priorities",
        "Interaction priority order values must be unique.",
      ),
    );
  if (new Set(recipeOrders).size !== recipeOrders.length)
    diagnostics.push(
      problem(
        "SF_INTERACTION_RECIPE_ORDER_DUPLICATE",
        "/colors/interactions/recipes",
        "Interaction recipe order values must be unique.",
      ),
    );
  for (const [recipeIndex, recipe] of source.colors.interactions.recipes.entries()) {
    for (const state of INTERACTION_STATES) {
      const stateRecipe = recipe.states[state];
      if (!stateRecipe)
        diagnostics.push(
          problem(
            "SF_INTERACTION_STATE_MISSING",
            `/colors/interactions/recipes/${recipeIndex}/states/${state}`,
            `Interaction recipe "${recipe.id}" does not cover state "${state}".`,
          ),
        );
      else if (state === "focus-visible" && recipe.status === "active" && !stateRecipe.focusRing)
        diagnostics.push(
          problem(
            "SF_INTERACTION_FOCUS_RING_REQUIRED",
            `/colors/interactions/recipes/${recipeIndex}/states/focus-visible/focusRing`,
            `Active recipe "${recipe.id}" requires a focus-visible indicator.`,
          ),
        );
      if (
        stateRecipe?.background.kind === "token" &&
        !onColorRefs.has(stateRecipe.background.reference)
      )
        diagnostics.push(
          problem(
            "SF_INTERACTION_BACKGROUND_CONTRACT_MISSING",
            `/colors/interactions/recipes/${recipeIndex}/states/${state}/background/reference`,
            `Control background "${stateRecipe.background.reference}" has no on-color contract.`,
          ),
        );
    }
  }
  for (const [index, mapping] of source.colors.interactions.mappings.entries()) {
    if (!themeIds.has(mapping.themeId))
      diagnostics.push(
        problem(
          "SF_INTERACTION_MAPPING_THEME_MISSING",
          `/colors/interactions/mappings/${index}/themeId`,
          `Mapping references missing theme "${mapping.themeId}".`,
        ),
      );
    if (!priorityIds.has(mapping.priorityId))
      diagnostics.push(
        problem(
          "SF_INTERACTION_MAPPING_PRIORITY_MISSING",
          `/colors/interactions/mappings/${index}/priorityId`,
          `Mapping references missing priority "${mapping.priorityId}".`,
        ),
      );
    if (!recipeIds.has(mapping.recipeId))
      diagnostics.push(
        problem(
          "SF_INTERACTION_MAPPING_RECIPE_MISSING",
          `/colors/interactions/mappings/${index}/recipeId`,
          `Mapping references missing recipe "${mapping.recipeId}".`,
        ),
      );
    if (!contextRefs.has(mapping.contextBackgroundRef))
      diagnostics.push(
        problem(
          "SF_INTERACTION_CONTEXT_MISSING",
          `/colors/interactions/mappings/${index}/contextBackgroundRef`,
          `Context background "${mapping.contextBackgroundRef}" is not referenced by a surface.`,
        ),
      );
  }
  const mappingKeys = new Set(
    source.colors.interactions.mappings.map(
      (mapping) => `${mapping.themeId}:${mapping.contextBackgroundRef}:${mapping.priorityId}`,
    ),
  );
  for (const theme of source.themes.filter((item) => item.status === "active"))
    for (const contextBackgroundRef of contextRefs)
      for (const priority of source.colors.interactions.priorities.filter(
        (item) => item.status === "active",
      )) {
        const key = `${theme.id}:${contextBackgroundRef}:${priority.id}`;
        if (!mappingKeys.has(key))
          diagnostics.push(
            problem(
              "SF_INTERACTION_MAPPING_MISSING",
              `/colors/interactions/mappings/${key}`,
              `Interaction mapping "${key}" is required.`,
              "Assign one recipe explicitly before publishing.",
              [theme.id],
            ),
          );
      }
  return diagnostics;
}

function validateLayout(source: StyleflowProjectSource): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const breakpoints = [...source.layout.scales.breakpoints].sort(
    (left, right) => left.order - right.order,
  );
  if (breakpoints.length === 0)
    return [
      problem(
        "SF_BREAKPOINT_REQUIRED",
        "/layout/scales/breakpoints",
        "At least one breakpoint is required.",
      ),
    ];
  if (breakpoints[0]!.minWidth !== 0)
    diagnostics.push(
      problem(
        "SF_BREAKPOINT_BASE_REQUIRED",
        "/layout/scales/breakpoints/0/minWidth",
        "The first breakpoint must start at 0px.",
      ),
    );
  if (
    breakpoints.some(
      (item, index) => index > 0 && item.minWidth <= breakpoints[index - 1]!.minWidth,
    )
  )
    diagnostics.push(
      problem(
        "SF_BREAKPOINT_ORDER_INVALID",
        "/layout/scales/breakpoints",
        "Breakpoints must have unique, strictly increasing pixel values.",
      ),
    );
  const orderValues = breakpoints.map((item) => item.order);
  if (new Set(orderValues).size !== orderValues.length)
    diagnostics.push(
      problem(
        "SF_BREAKPOINT_ORDER_DUPLICATE",
        "/layout/scales/breakpoints",
        "Breakpoint order values must be unique.",
      ),
    );
  for (const role of LAYOUT_ROLES)
    for (const density of DENSITIES) {
      const recipe = source.layout.recipes.find(
        (item) => item.role === role && item.density === density,
      );
      if (!recipe) {
        diagnostics.push(
          problem(
            "SF_LAYOUT_RECIPE_MISSING",
            "/layout/recipes",
            `Layout coordinate "${role}.${density}" is missing.`,
          ),
        );
        continue;
      }
      for (const [breakpointIndex, breakpoint] of breakpoints.entries()) {
        const values = recipe.valuesByBreakpoint[breakpoint.id];
        if (!values) {
          diagnostics.push(
            problem(
              "SF_LAYOUT_BREAKPOINT_MISSING",
              `/layout/recipes/${role}:${density}/valuesByBreakpoint/${breakpoint.id}`,
              `Layout coordinate is missing breakpoint "${breakpoint.id}".`,
            ),
          );
          continue;
        }
        for (const [property, scaleName] of Object.entries(LAYOUT_PROPERTY_SCALE) as Array<
          [LayoutProperty, keyof typeof source.layout.scales]
        >) {
          const value = values[property];
          if (breakpointIndex === 0 && !hasConcrete(value))
            diagnostics.push(
              problem(
                "SF_LAYOUT_BASE_INHERIT",
                `/layout/recipes/${role}:${density}/valuesByBreakpoint/${breakpoint.id}/${property}`,
                "The first breakpoint must use a concrete scale reference.",
              ),
            );
          if (hasConcrete(value)) {
            const entries = source.layout.scales[scaleName];
            if (!Array.isArray(entries) || !entries.some((item) => item.id === value.scaleEntryId))
              diagnostics.push(
                problem(
                  "SF_LAYOUT_SCALE_REFERENCE_MISSING",
                  `/layout/recipes/${role}:${density}/valuesByBreakpoint/${breakpoint.id}/${property}`,
                  `Scale reference "${value.scaleEntryId}" does not exist in "${scaleName}".`,
                ),
              );
          }
        }
      }
    }
  return diagnostics;
}

function validateTypography(source: StyleflowProjectSource): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const fontSlotIds = new Set(source.typography.fontSlots.map((item) => item.id));
  const weightIds = new Set(source.typography.weights.map((item) => item.id));
  const breakpoints = [...source.layout.scales.breakpoints].sort(
    (left, right) => left.order - right.order,
  );
  for (const [typeIndex, type] of source.typography.types.entries()) {
    if (!fontSlotIds.has(type.fontSlotId))
      diagnostics.push(
        problem(
          "SF_TYPOGRAPHY_FONT_SLOT_MISSING",
          `/typography/types/${typeIndex}/fontSlotId`,
          `Type "${type.id}" references missing font slot "${type.fontSlotId}".`,
        ),
      );
    if (type.variants.length === 0)
      diagnostics.push(
        problem(
          "SF_TYPOGRAPHY_VARIANT_REQUIRED",
          `/typography/types/${typeIndex}/variants`,
          `Type "${type.id}" must keep at least one variant.`,
        ),
      );
    diagnostics.push(
      ...duplicates(
        `typography/types/${typeIndex}/variants`,
        type.variants.map((item) => item.id),
      ),
    );
    for (const variant of type.variants)
      for (const weightId of weightIds) {
        const recipe = source.typography.recipes.find(
          (item) =>
            item.tyId === type.id && item.variantId === variant.id && item.weightId === weightId,
        );
        if (!recipe) {
          diagnostics.push(
            problem(
              "SF_TYPOGRAPHY_RECIPE_MISSING",
              "/typography/recipes",
              `Typography coordinate "${type.id}.${variant.id}.${weightId}" is missing.`,
            ),
          );
          continue;
        }
        for (const [breakpointIndex, breakpoint] of breakpoints.entries()) {
          const values = recipe.valuesByBreakpoint[breakpoint.id];
          if (!values) {
            diagnostics.push(
              problem(
                "SF_TYPOGRAPHY_BREAKPOINT_MISSING",
                `/typography/recipes/${type.id}:${variant.id}:${weightId}/${breakpoint.id}`,
                `Typography recipe is missing breakpoint "${breakpoint.id}".`,
              ),
            );
            continue;
          }
          if (breakpointIndex === 0 && Object.values(values).some((value) => "inherit" in value))
            diagnostics.push(
              problem(
                "SF_TYPOGRAPHY_BASE_INHERIT",
                `/typography/recipes/${type.id}:${variant.id}:${weightId}/${breakpoint.id}`,
                "The first typography breakpoint must contain concrete values.",
              ),
            );
        }
      }
  }
  for (const [weightIndex, weight] of source.typography.weights.entries())
    for (const slotId of fontSlotIds)
      if (!weight.stylesByFontSlot[slotId])
        diagnostics.push(
          problem(
            "SF_TYPOGRAPHY_WEIGHT_MAPPING_MISSING",
            `/typography/weights/${weightIndex}/stylesByFontSlot/${slotId}`,
            `Weight "${weight.id}" has no mapping for font slot "${slotId}".`,
          ),
        );
  for (const [recipeIndex, recipe] of source.typography.recipes.entries()) {
    const type = source.typography.types.find((item) => item.id === recipe.tyId);
    if (!type)
      diagnostics.push(
        problem(
          "SF_TYPOGRAPHY_TYPE_MISSING",
          `/typography/recipes/${recipeIndex}/tyId`,
          `Recipe references missing type "${recipe.tyId}".`,
        ),
      );
    else if (!type.variants.some((item) => item.id === recipe.variantId))
      diagnostics.push(
        problem(
          "SF_TYPOGRAPHY_VARIANT_MISSING",
          `/typography/recipes/${recipeIndex}/variantId`,
          `Recipe references missing variant "${recipe.variantId}".`,
        ),
      );
    if (!weightIds.has(recipe.weightId))
      diagnostics.push(
        problem(
          "SF_TYPOGRAPHY_WEIGHT_MISSING",
          `/typography/recipes/${recipeIndex}/weightId`,
          `Recipe references missing weight "${recipe.weightId}".`,
        ),
      );
  }
  return diagnostics;
}

export function validateProjectSemantics(source: StyleflowProjectSource): Diagnostic[] {
  return [
    ...validateCore(source),
    ...validateColors(source),
    ...validateInteractions(source),
    ...validateLayout(source),
    ...validateTypography(source),
    ...resolveThemeGraph(source).diagnostics,
  ];
}
