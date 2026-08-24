import { contrastRatio, OKLCH_JND, parseHexColor, renderOklchSource } from "./color";
import { validateProjectSemantics } from "./semantic-validator";
import { resolveThemeGraph } from "./theme-resolver";
import type {
  BorderRole,
  CompiledProject,
  Diagnostic,
  ForegroundRole,
  InteractionState,
  InteractionStateRecipe,
  LayoutProperty,
  ResolvedInteraction,
  ResolvedInteractionState,
  ResolvedLayoutRecipe,
  ResolvedOnColor,
  ResolvedSurface,
  StyleflowProjectSource,
  SurfaceRole,
  TokenReference,
  TypographyRecipeBreakpointValues,
  TypographyToken,
} from "./types";
import { BORDER_ROLES, FOREGROUND_ROLES, INTERACTION_STATES, SURFACE_ROLES } from "./types";

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

function missingReference(reference: string, path: string, themeId: string): Diagnostic {
  return {
    code: "SF_REFERENCE_MISSING",
    severity: "error",
    blocking: true,
    path,
    themeIds: [themeId],
    message: `Token reference "${reference}" cannot be resolved in theme "${themeId}".`,
    suggestion: "Map the semantic token to an existing ramp position.",
  };
}

function contrastDiagnostic(
  path: string,
  themeId: string,
  role: string,
  ratio: number,
  threshold: number,
  blocking: boolean,
  severity?: Diagnostic["severity"],
): Diagnostic {
  return {
    code:
      role.startsWith("border") || role.includes("focus") || role.includes("context")
        ? "SF_CONTRAST_NON_TEXT"
        : "SF_CONTRAST_TEXT",
    severity: severity ?? (blocking ? "error" : "warning"),
    blocking: severity === "info" ? false : blocking,
    path,
    themeIds: [themeId],
    message: `${role} reaches ${ratio.toFixed(2)}:1; the configured target is ${threshold.toFixed(1)}:1.`,
    suggestion: "Choose a stronger token or use Auto solve.",
    standardRef: role.includes("disabled")
      ? undefined
      : role.startsWith("border") || role.includes("focus") || role.includes("context")
        ? "WCAG22-1.4.11"
        : "WCAG22-1.4.3",
  };
}

function collectTokenPaths(source: StyleflowProjectSource): TokenReference[] {
  const primitive = source.colors.ramps.flatMap((ramp) =>
    ramp.stops.map((stop) => `color.${ramp.id}.${stop.position}` as TokenReference),
  );
  const semantic = source.colors.intensityProfiles.flatMap((profile) =>
    profile.levels.map((level) => `color.${profile.toneId}.${level.id}` as TokenReference),
  );
  return [...new Set([...primitive, ...semantic])].sort();
}

function alphaNeedsCanvas(...values: Array<string | undefined>): boolean {
  return values.some((value) => value && (parseHexColor(value)?.a ?? 1) < 1);
}

function ratioOrZero(
  foreground: string | undefined,
  background: string | undefined,
  canvas: string | undefined,
): number {
  if (!foreground || !background || (alphaNeedsCanvas(foreground, background) && !canvas)) return 0;
  return contrastRatio(foreground, background, canvas ?? "#000000") ?? 0;
}

function resolveSurfaces(
  source: StyleflowProjectSource,
  themeId: string,
  resolveToken: (reference: TokenReference) => string | null,
  diagnostics: Diagnostic[],
): ResolvedSurface[] {
  return source.colors.surfaces.map((recipe, recipeIndex) => ({
    toneId: recipe.toneId,
    intensity: recipe.intensity,
    backgrounds: Object.fromEntries(
      SURFACE_ROLES.map((role) => {
        const reference = recipe.backgrounds[role];
        const value = resolveToken(reference);
        if (!value)
          diagnostics.push(
            missingReference(
              reference,
              `/colors/surfaces/${recipeIndex}/backgrounds/${role}`,
              themeId,
            ),
          );
        return [role, { reference, value: value ?? "#00000000" }];
      }),
    ) as Record<SurfaceRole, { reference: TokenReference; value: string }>,
  }));
}

function mergedInteractionRecipe(
  source: StyleflowProjectSource,
  themeId: string,
  contextBackgroundRef: TokenReference,
  priorityId: string,
  state: InteractionState,
): { recipe: InteractionStateRecipe; provenance: ResolvedInteractionState["provenance"] } | null {
  const fallback = source.colors.interactions.defaults.find(
    (item) => item.priorityId === priorityId,
  )?.states[state];
  if (!fallback) return null;
  const override = source.colors.interactions.overrides.find(
    (item) =>
      item.themeId === themeId &&
      item.contextBackgroundRef === contextBackgroundRef &&
      item.priorityId === priorityId &&
      item.state === state,
  );
  return {
    recipe: { ...structuredClone(fallback), ...structuredClone(override?.values ?? {}) },
    provenance: override?.provenance ?? "generated",
  };
}

function resolveInteractions(
  source: StyleflowProjectSource,
  themeId: string,
  canvas: string | undefined,
  resolveToken: (reference: TokenReference) => string | null,
  onColorByBackground: Map<TokenReference, ResolvedOnColor>,
  diagnostics: Diagnostic[],
): ResolvedInteraction[] {
  const blocking = source.settings.accessibility.policy === "block";
  const textThreshold = source.settings.accessibility.level === "AAA" ? 7 : 4.5;
  const contexts = [...new Set(source.colors.onColors.map((item) => item.backgroundRef))];
  const resolved: ResolvedInteraction[] = [];
  for (const contextBackgroundRef of contexts) {
    const contextBackground = resolveToken(contextBackgroundRef) ?? undefined;
    for (const priority of [...source.colors.interactions.priorities].sort(
      (left, right) => left.order - right.order,
    )) {
      const states = {} as Record<InteractionState, ResolvedInteractionState>;
      for (const state of INTERACTION_STATES) {
        const merged = mergedInteractionRecipe(
          source,
          themeId,
          contextBackgroundRef,
          priority.id,
          state,
        );
        if (!merged) continue;
        const { recipe, provenance } = merged;
        const path = `/colors/interactions/resolved/${themeId}/${contextBackgroundRef}/${priority.id}/${state}`;
        const background = resolveToken(recipe.backgroundRef) ?? undefined;
        if (!background)
          diagnostics.push(
            missingReference(recipe.backgroundRef, `${path}/backgroundRef`, themeId),
          );
        const onColor = onColorByBackground.get(recipe.backgroundRef);
        const foregroundRef =
          recipe.foregroundOverrideRef ?? onColor?.foreground[recipe.foregroundRole].reference;
        const borderRef = recipe.borderOverrideRef ?? onColor?.border[recipe.borderRole].reference;
        const foreground = foregroundRef ? (resolveToken(foregroundRef) ?? undefined) : undefined;
        const border = borderRef ? (resolveToken(borderRef) ?? undefined) : undefined;
        if (!foregroundRef || !foreground)
          diagnostics.push(
            missingReference(
              foregroundRef ?? `${recipe.backgroundRef}.on-color`,
              `${path}/foreground`,
              themeId,
            ),
          );
        if (!borderRef || !border)
          diagnostics.push(
            missingReference(
              borderRef ?? `${recipe.backgroundRef}.border`,
              `${path}/border`,
              themeId,
            ),
          );
        const foregroundRatio = ratioOrZero(foreground, background, canvas);
        const borderRatio = ratioOrZero(border, background, canvas);
        const backgroundContextRatio = ratioOrZero(background, contextBackground, canvas);
        const borderContextRatio = ratioOrZero(border, contextBackground, canvas);
        const isDisabled = state === "disabled";
        if (foreground && background && foregroundRatio < textThreshold)
          diagnostics.push(
            contrastDiagnostic(
              `${path}/foreground`,
              themeId,
              isDisabled ? "disabled foreground (informational)" : "foreground",
              foregroundRatio,
              textThreshold,
              blocking,
              isDisabled ? "info" : undefined,
            ),
          );
        if (
          !isDisabled &&
          ["default", "hover", "active", "focus-visible"].includes(state) &&
          Math.max(backgroundContextRatio, borderContextRatio) < 3
        )
          diagnostics.push(
            contrastDiagnostic(
              `${path}/context`,
              themeId,
              "control against context",
              Math.max(backgroundContextRatio, borderContextRatio),
              3,
              blocking,
            ),
          );
        let focusRing: ResolvedInteractionState["focusRing"];
        if (recipe.focusRing) {
          const value = resolveToken(recipe.focusRing.colorRef) ?? undefined;
          if (!value)
            diagnostics.push(
              missingReference(recipe.focusRing.colorRef, `${path}/focusRing/colorRef`, themeId),
            );
          const controlRatio = ratioOrZero(value, background, canvas);
          const contextRatio = ratioOrZero(value, contextBackground, canvas);
          if (value && Math.min(controlRatio, contextRatio) < 3)
            diagnostics.push(
              contrastDiagnostic(
                `${path}/focusRing`,
                themeId,
                "focus ring against control and context",
                Math.min(controlRatio, contextRatio),
                3,
                blocking,
              ),
            );
          focusRing = {
            reference: recipe.focusRing.colorRef,
            value: value ?? "#00000000",
            width: recipe.focusRing.width,
            offset: recipe.focusRing.offset,
            controlRatio,
            contextRatio,
          };
        }
        states[state] = {
          background: { reference: recipe.backgroundRef, value: background ?? "#00000000" },
          contextBackground: {
            reference: contextBackgroundRef,
            value: contextBackground ?? "#00000000",
          },
          foreground: {
            reference: foregroundRef ?? recipe.backgroundRef,
            value: foreground ?? "#00000000",
            role: recipe.foregroundRole,
            ratio: foregroundRatio,
          },
          border: {
            reference: borderRef ?? recipe.backgroundRef,
            value: border ?? "#00000000",
            role: recipe.borderRole,
            ratio: borderRatio,
            contextRatio: borderContextRatio,
          },
          backgroundContextRatio,
          ...(focusRing ? { focusRing } : {}),
          ...(recipe.opacity === undefined ? {} : { opacity: recipe.opacity }),
          provenance,
        };
      }
      resolved.push({ themeId, contextBackgroundRef, priorityId: priority.id, states });
    }
  }

  const priorityOrder = [...source.colors.interactions.priorities].sort(
    (left, right) => left.order - right.order,
  );
  for (const contextBackgroundRef of contexts)
    for (const state of INTERACTION_STATES.filter((item) => item !== "disabled")) {
      const rows = priorityOrder.map(
        (priority) =>
          resolved.find(
            (item) =>
              item.contextBackgroundRef === contextBackgroundRef && item.priorityId === priority.id,
          )?.states[state],
      );
      for (let index = 0; index < rows.length - 1; index += 1) {
        const higher = rows[index];
        const lower = rows[index + 1];
        if (!higher || !lower) continue;
        const higherScore = Math.max(higher.backgroundContextRatio, higher.border.contextRatio);
        const lowerScore = Math.max(lower.backgroundContextRatio, lower.border.contextRatio);
        if (higherScore + 0.01 < lowerScore)
          diagnostics.push({
            code: "SF_INTERACTION_SALIENCE_ORDER",
            severity: "warning",
            blocking: false,
            path: `/colors/interactions/resolved/${themeId}/${contextBackgroundRef}/${priorityOrder[index]!.id}/${state}`,
            themeIds: [themeId],
            message: `Priority "${priorityOrder[index]!.id}" is less distinguishable than "${priorityOrder[index + 1]!.id}" in this context.`,
            suggestion: "Increase fill or border contrast, or create a contextual override.",
          });
      }
    }
  return resolved;
}

function resolveLayout(source: StyleflowProjectSource): ResolvedLayoutRecipe[] {
  const breakpoints = [...source.layout.scales.breakpoints].sort(
    (left, right) => left.order - right.order,
  );
  return source.layout.recipes.map((recipe) => {
    const previous = {} as Record<LayoutProperty, string>;
    const valuesByBreakpoint = Object.fromEntries(
      breakpoints.map((breakpoint) => {
        const values = recipe.valuesByBreakpoint[breakpoint.id];
        const resolved = {} as Record<LayoutProperty, string>;
        for (const [property, scaleName] of Object.entries(LAYOUT_PROPERTY_SCALE) as Array<
          [LayoutProperty, keyof typeof source.layout.scales]
        >) {
          const reference = values?.[property];
          if (reference && "scaleEntryId" in reference) {
            const scale = source.layout.scales[scaleName] as Array<{ id: string; value: string }>;
            resolved[property] =
              scale.find((entry) => entry.id === reference.scaleEntryId)?.value ?? "";
          } else resolved[property] = previous[property] ?? "";
        }
        Object.assign(previous, resolved);
        return [breakpoint.id, resolved];
      }),
    );
    return { role: recipe.role, density: recipe.density, valuesByBreakpoint };
  });
}

function concreteTypography<T>(
  value: { value: T } | { inherit: true } | undefined,
  previous: T,
): T {
  return value && "value" in value ? value.value : previous;
}

function resolveTypography(source: StyleflowProjectSource): TypographyToken[] {
  const breakpoints = [...source.layout.scales.breakpoints].sort(
    (left, right) => left.order - right.order,
  );
  return source.typography.recipes.flatMap((recipe) => {
    const type = source.typography.types.find((item) => item.id === recipe.tyId);
    const fontSlot = source.typography.fontSlots.find((item) => item.id === type?.fontSlotId);
    const weight = source.typography.weights.find((item) => item.id === recipe.weightId);
    const weightStyle = type ? weight?.stylesByFontSlot[type.fontSlotId] : undefined;
    if (!type || !fontSlot || !weight || !weightStyle) return [];
    let previous: TypographyToken["valuesByBreakpoint"][string] = {
      fontSize: "",
      lineHeight: "",
      letterSpacing: "",
      textCase: "original",
    };
    const valuesByBreakpoint = Object.fromEntries(
      breakpoints.map((breakpoint) => {
        const values = recipe.valuesByBreakpoint[breakpoint.id] as
          TypographyRecipeBreakpointValues | undefined;
        const current = {
          fontSize: concreteTypography(values?.fontSize, previous.fontSize),
          lineHeight: concreteTypography(values?.lineHeight, previous.lineHeight),
          letterSpacing: concreteTypography(values?.letterSpacing, previous.letterSpacing),
          textCase: concreteTypography(values?.textCase, previous.textCase),
        };
        previous = current;
        return [breakpoint.id, current];
      }),
    );
    return [
      {
        id: `${recipe.tyId}-${recipe.variantId}-${recipe.weightId}`,
        ty: recipe.tyId,
        v: recipe.variantId,
        w: recipe.weightId,
        fontFamily: fontSlot.familyStack.join(", "),
        fontStyle: weightStyle.fontStyle,
        fontWeight: weightStyle.fontWeight,
        valuesByBreakpoint,
        provenance: recipe.provenance,
      },
    ];
  });
}

export function compileProject(source: StyleflowProjectSource): CompiledProject {
  const graph = resolveThemeGraph(source);
  const diagnostics: Diagnostic[] = [...validateProjectSemantics(source)];
  const allPaths = collectTokenPaths(source);
  const threshold = source.settings.accessibility.level === "AAA" ? 7 : 4.5;
  const contrastIsBlocking = source.settings.accessibility.policy === "block";
  const typography = resolveTypography(source);
  const layout = resolveLayout(source);

  for (const [rampIndex, ramp] of source.colors.ramps.entries())
    for (const [stopIndex, stop] of ramp.stops.entries()) {
      const rendered = renderOklchSource(stop.source);
      if (
        rendered.gamutMapped &&
        rendered.deltaE >= OKLCH_JND &&
        rendered.value.toLowerCase() !== stop.value.toLowerCase()
      )
        diagnostics.push({
          code: "SF_COLOR_GAMUT_MAPPED",
          severity: "warning",
          blocking: false,
          path: `/colors/ramps/${rampIndex}/stops/${stopIndex}`,
          themeIds: [],
          message: `Ramp stop ${ramp.id}.${stop.position} requires the versioned sRGB gamut mapping fallback.`,
          suggestion: "Review the rendered fallback before publishing.",
        });
    }

  const themes = graph.resolutions.map(({ theme, resolveToken }) => {
    const themeDiagnostics: Diagnostic[] = [];
    const tokens = Object.fromEntries(
      allPaths.flatMap((path) => {
        const value = resolveToken(path);
        return value ? [[path, value]] : [];
      }),
    );
    const canvas = resolveToken(theme.canvasToken) ?? undefined;
    if (!canvas)
      themeDiagnostics.push(
        missingReference(theme.canvasToken, `/themes/${theme.id}/canvasToken`, theme.id),
      );
    const onColors: ResolvedOnColor[] = source.colors.onColors.map((contract, contractIndex) => {
      const background = resolveToken(contract.backgroundRef) ?? undefined;
      if (!background)
        themeDiagnostics.push(
          missingReference(
            contract.backgroundRef,
            `/colors/onColors/${contractIndex}/backgroundRef`,
            theme.id,
          ),
        );
      const compositeCanvas = contract.compositeOn
        ? (resolveToken(contract.compositeOn) ?? undefined)
        : canvas;
      const foreground = {} as ResolvedOnColor["foreground"];
      for (const role of FOREGROUND_ROLES) {
        const reference = contract.foreground[role];
        const value = resolveToken(reference) ?? undefined;
        if (!value)
          themeDiagnostics.push(
            missingReference(
              reference,
              `/colors/onColors/${contractIndex}/foreground/${role}`,
              theme.id,
            ),
          );
        const ratio = ratioOrZero(value, background, compositeCanvas);
        foreground[role as ForegroundRole] = { reference, value: value ?? "#00000000", ratio };
        if (value && background && ratio < threshold)
          themeDiagnostics.push(
            contrastDiagnostic(
              `/colors/onColors/${contractIndex}/foreground/${role}`,
              theme.id,
              `foreground.${role}`,
              ratio,
              threshold,
              contrastIsBlocking,
            ),
          );
      }
      const border = {} as ResolvedOnColor["border"];
      for (const role of BORDER_ROLES) {
        const reference = contract.border[role];
        const value = resolveToken(reference) ?? undefined;
        if (!value)
          themeDiagnostics.push(
            missingReference(
              reference,
              `/colors/onColors/${contractIndex}/border/${role}`,
              theme.id,
            ),
          );
        const ratio = ratioOrZero(value, background, compositeCanvas);
        border[role as BorderRole] = { reference, value: value ?? "#00000000", ratio };
        if (!(role === "soft" && contract.borderSoftDecorative) && value && background && ratio < 3)
          themeDiagnostics.push(
            contrastDiagnostic(
              `/colors/onColors/${contractIndex}/border/${role}`,
              theme.id,
              `border.${role}`,
              ratio,
              3,
              contrastIsBlocking,
            ),
          );
      }
      return {
        backgroundRef: contract.backgroundRef,
        background: background ?? "#00000000",
        foreground,
        border,
        borderSoftDecorative: contract.borderSoftDecorative,
        provenance: contract.provenance,
      };
    });
    const onColorByBackground = new Map(onColors.map((item) => [item.backgroundRef, item]));
    const surfaces = resolveSurfaces(source, theme.id, resolveToken, themeDiagnostics);
    const interactions = resolveInteractions(
      source,
      theme.id,
      canvas,
      resolveToken,
      onColorByBackground,
      themeDiagnostics,
    );
    diagnostics.push(...themeDiagnostics);
    return {
      id: theme.id,
      label: theme.label,
      polarity: theme.polarity,
      ...(theme.parentId ? { parentId: theme.parentId } : {}),
      tokens,
      onColors,
      surfaces,
      interactions,
      layout: { scales: structuredClone(source.layout.scales), recipes: structuredClone(layout) },
      typography: structuredClone(typography),
      diagnostics: themeDiagnostics,
    };
  });

  const maxIntensityCount = Math.max(
    0,
    ...source.colors.intensityProfiles.map((profile) => profile.levels.length),
  );
  const breakpointCount = source.layout.scales.breakpoints.length;
  const figmaReasons = [
    ...(breakpointCount > source.settings.targets.figmaModeLimit
      ? ["BREAKPOINT_MODE_LIMIT_EXCEEDED"]
      : []),
    ...(source.themes.length > source.settings.targets.figmaModeLimit
      ? ["THEME_MODE_LIMIT_EXCEEDED"]
      : []),
  ];
  if (figmaReasons.length)
    diagnostics.push({
      code: "SF_TARGET_FIGMA_CAPABILITY",
      severity: "warning",
      blocking: false,
      path: "/settings/targets/figmaModeLimit",
      themeIds: [],
      target: "figma-vnext",
      message:
        "The project exceeds the configured Figma mode matrix limit; the contract remains complete and is not truncated.",
      suggestion: "Reduce active modes for Figma or consume the complete CLI vNext projection.",
    });
  const softStrongCounts = source.colors.intensityProfiles.map((profile) => ({
    soft: profile.levels.filter((item) => item.id.startsWith("soft")).length,
    strong: profile.levels.filter((item) => item.id.startsWith("strong")).length,
  }));
  return {
    source,
    themes,
    diagnostics,
    agentContract: {
      axes: {
        color: {
          tones: source.colors.ramps.map((item) => item.id),
          intensitiesByTone: Object.fromEntries(
            source.colors.intensityProfiles.map((profile) => [
              profile.toneId,
              [...profile.levels]
                .sort((left, right) => left.order - right.order)
                .map((level) => level.id),
            ]),
          ),
          surfaces: [...SURFACE_ROLES],
          foregrounds: [...FOREGROUND_ROLES],
        },
        layout: {
          roles: [...new Set(source.layout.recipes.map((item) => item.role))],
          densities: [...new Set(source.layout.recipes.map((item) => item.density))],
          breakpoints: [...source.layout.scales.breakpoints]
            .sort((a, b) => a.order - b.order)
            .map((item) => ({ id: item.id, minWidth: item.minWidth })),
        },
        typography: {
          types: source.typography.types.map((item) => item.id),
          variantsByType: Object.fromEntries(
            source.typography.types.map((item) => [
              item.id,
              [...item.variants]
                .sort((left, right) => left.order - right.order)
                .map((variant) => variant.id),
            ]),
          ),
          weights: source.typography.weights.map((item) => item.id),
        },
        interaction: {
          priorities: [...source.colors.interactions.priorities]
            .sort((a, b) => a.order - b.order)
            .map((item) => item.id),
          states: [...INTERACTION_STATES],
        },
      },
      examples: [
        "tone=main intensity=base surface=raised",
        "layoutRole=panel density=regular breakpoint=md",
        `ty=${source.agentPolicy.defaults.typography.ty} v=${source.agentPolicy.defaults.typography.v} w=${source.agentPolicy.defaults.typography.w}`,
      ],
      prohibitedProperties: source.agentPolicy.prohibitedProperties,
    },
    capabilities: {
      themeCount: source.themes.length,
      maxIntensityCount,
      customThemes: source.themes.some((theme) => theme.polarity === "custom"),
      asymmetricIntensity: softStrongCounts.some((item) => item.soft !== item.strong),
      contextualInteractions: true,
      fluidTypography: true,
      breakpointCount,
      typographyTokenCount: typography.length,
    },
    targets: {
      "styleflow-cli-vnext": { status: "supported", reasons: [] },
      "styleflow-cli-0.3": {
        status: "unsupported",
        reasons: [
          "CONTRACT_MAJOR_UNSUPPORTED",
          "CONTEXT_INTERACTIONS_UNSUPPORTED",
          "RESPONSIVE_MATRIX_UNSUPPORTED",
        ],
      },
      "figma-vnext": {
        status: figmaReasons.length ? "unsupported" : "supported",
        reasons: figmaReasons,
      },
    },
  };
}

export function listCandidateTokenReferences(source: StyleflowProjectSource): TokenReference[] {
  return collectTokenPaths(source);
}
