import { compileProject, listCandidateTokenReferences } from "./compiler";
import { contrastRatio, generateColorRamp, renderOklchSource } from "./color";
import { createPresetSource, DEFAULT_INTENSITY_LEVELS } from "./preset";
import type {
  ColorRamp,
  DraftOperation,
  IntensityProfile,
  InteractionStateRecipe,
  LayoutProperty,
  LayoutRecipe,
  LayoutScaleName,
  OnColorContract,
  OnColorRolePath,
  RampPosition,
  StyleflowProjectSource,
  TokenReference,
  TypographyRecipe,
} from "./types";
import {
  ANCHOR_POSITIONS,
  BORDER_ROLES,
  FOREGROUND_ROLES,
  INTERACTION_STATES,
  SURFACE_ROLES,
} from "./types";

const PROPERTY_SCALE: Record<LayoutProperty, LayoutScaleName> = {
  gap: "gap",
  paddingInline: "paddingInline",
  paddingBlock: "paddingBlock",
  radius: "radius",
  borderWidth: "stroke",
  containerMaxWidth: "containerWidth",
};

function setRole(
  contract: OnColorContract,
  target: OnColorRolePath,
  tokenRef: TokenReference,
): void {
  if (target.group === "foreground") contract.foreground[target.role] = tokenRef;
  else contract.border[target.role] = tokenRef;
}

function chooseBestCandidate(
  source: StyleflowProjectSource,
  backgroundRef: TokenReference,
  target: OnColorRolePath,
): TokenReference | null {
  const compiled = compileProject(source);
  const candidates = listCandidateTokenReferences(source);
  let best: { reference: TokenReference; minimumRatio: number } | null = null;
  for (const reference of candidates) {
    let minimumRatio = Number.POSITIVE_INFINITY;
    for (const theme of compiled.themes) {
      const background = theme.tokens[backgroundRef];
      const foreground = theme.tokens[reference];
      const canvasRef = source.themes.find((item) => item.id === theme.id)?.canvasToken;
      const canvas = canvasRef ? theme.tokens[canvasRef] : undefined;
      if (
        !background ||
        !foreground ||
        (!canvas && (background.length === 9 || foreground.length === 9))
      ) {
        minimumRatio = 0;
        break;
      }
      minimumRatio = Math.min(minimumRatio, contrastRatio(foreground, background, canvas) ?? 0);
    }
    const targetRatio = target.group === "foreground" ? 4.5 : 3;
    const candidatePasses = minimumRatio >= targetRatio;
    const bestPasses = (best?.minimumRatio ?? 0) >= targetRatio;
    if (
      !best ||
      (candidatePasses && !bestPasses) ||
      (candidatePasses === bestPasses && minimumRatio > best.minimumRatio)
    ) {
      best = { reference, minimumRatio };
    }
  }
  return best?.reference ?? null;
}

function orderedLevelIds(source: StyleflowProjectSource, toneId: string): string[] {
  return [...(source.colors.intensityProfiles.find((item) => item.toneId === toneId)?.levels ?? [])]
    .sort((left, right) => left.order - right.order)
    .map((level) => level.id);
}

function relativeReference(
  source: StyleflowProjectSource,
  backgroundRef: TokenReference,
  offset: number,
  toneId?: string,
): TokenReference | null {
  const [, backgroundTone, key] = backgroundRef.split(".");
  const targetTone = toneId ?? backgroundTone;
  if (!targetTone || !key) return null;
  const keys = orderedLevelIds(source, targetTone);
  if (keys.length === 0) return null;
  const sourceIndex = Math.max(0, keys.indexOf(key));
  const nextIndex = Math.max(0, Math.min(keys.length - 1, sourceIndex + offset));
  return `color.${targetTone}.${keys[nextIndex]}` as TokenReference;
}

function interpolateReferences(
  source: StyleflowProjectSource,
  backgroundRefs: TokenReference[],
  startRef: TokenReference,
  endRef: TokenReference,
): TokenReference[] {
  const [, startTone, startKey] = startRef.split(".");
  const [, endTone, endKey] = endRef.split(".");
  if (!startTone || startTone !== endTone || !startKey || !endKey)
    throw new Error("Interpolation endpoints must belong to the same tone");
  const keys = orderedLevelIds(source, startTone);
  const startIndex = keys.indexOf(startKey);
  const endIndex = keys.indexOf(endKey);
  if (startIndex === -1 || endIndex === -1)
    throw new Error("Interpolation endpoints are outside the active intensity profile");
  return backgroundRefs.map((_, index) => {
    const progress = backgroundRefs.length === 1 ? 0 : index / (backgroundRefs.length - 1);
    return `color.${startTone}.${keys[Math.round(startIndex + (endIndex - startIndex) * progress)]}` as TokenReference;
  });
}

function upsert<T>(items: T[], predicate: (item: T) => boolean, value: T): void {
  const index = items.findIndex(predicate);
  if (index === -1) items.push(structuredClone(value));
  else items[index] = structuredClone(value);
}

function defaultOnColor(backgroundRef: TokenReference, dark: boolean): OnColorContract {
  const toneId = backgroundRef.split(".")[1] ?? "main";
  const opposite = dark ? "soft" : "strong";
  return {
    backgroundRef,
    foreground: {
      primary: `color.neutral.${opposite}-2`,
      secondary: `color.neutral.${opposite}-1`,
      tertiary: `color.neutral.${opposite}-1`,
      muted: `color.neutral.${opposite}-1`,
      accent: `color.${dark ? "accent" : "main"}.${opposite}-1`,
    },
    border: {
      default: `color.${toneId}.${dark ? "soft-1" : "strong-1"}`,
      soft: `color.${toneId}.${dark ? "soft-2" : "base"}`,
      strong: `color.${toneId}.strong-2`,
    },
    borderSoftDecorative: true,
    provenance: "generated",
  };
}

function regenerateRamp(ramp: ColorRamp): void {
  const generated = generateColorRamp(ramp.baseColor, ramp.generator, ramp.stops);
  ramp.generator.basePosition = generated.basePosition;
  ramp.stops = generated.stops;
}

function initialPosition(index: number, count: number, dark: boolean): RampPosition {
  const normal = ["100", "300", "600", "800", "950"] as const;
  const reversed = ["950", "800", "600", "300", "100"] as const;
  const choices = dark ? reversed : normal;
  return choices[Math.round((index / Math.max(1, count - 1)) * (choices.length - 1))]!;
}

function initialIntensityPosition(
  profile: IntensityProfile,
  ramp: ColorRamp,
  theme: StyleflowProjectSource["themes"][number],
  levelId: string,
  fallbackOrder: number,
): RampPosition {
  const match = /^(soft|strong)-([1-9][0-9]*)$/.exec(levelId);
  if (!match)
    return initialPosition(fallbackOrder, profile.levels.length, theme.polarity === "dark");
  const side = match[1]!;
  const distance = Number(match[2]);
  const closerId = distance === 1 ? "base" : `${side}-${distance - 1}`;
  const closerPosition = profile.mappingByTheme[theme.id]?.[closerId];
  if (!closerPosition)
    return initialPosition(fallbackOrder, profile.levels.length, theme.polarity === "dark");
  const base = Number(ramp.generator.basePosition);
  const closer = Number(closerPosition);
  const defaultDirection =
    side === "soft" ? (theme.polarity === "dark" ? 1 : -1) : theme.polarity === "dark" ? -1 : 1;
  const direction = closer === base ? defaultDirection : Math.sign(closer - base);
  const next = [...ANCHOR_POSITIONS]
    .filter((position) => (Number(position) - closer) * direction > 0)
    .sort((left, right) => Math.abs(Number(left) - closer) - Math.abs(Number(right) - closer))[0];
  return (
    next ?? (direction < 0 ? ANCHOR_POSITIONS[0]! : ANCHOR_POSITIONS[ANCHOR_POSITIONS.length - 1]!)
  );
}

function defaultPositionAroundBase(
  ramp: ColorRamp,
  theme: StyleflowProjectSource["themes"][number],
  levelId: string,
): RampPosition {
  if (levelId === "base") return ramp.generator.basePosition;
  const match = /^(soft|strong)-([1-9][0-9]*)$/.exec(levelId);
  if (!match) return ramp.generator.basePosition;
  const dark = theme.polarity === "dark" || theme.parentId === "dark";
  const softDirection = dark ? 1 : -1;
  const direction = match[1] === "soft" ? softDirection : -softDirection;
  const distance = Number(match[2]);
  const base = Number(ramp.generator.basePosition);
  const candidates = [...ANCHOR_POSITIONS]
    .filter((position) => (Number(position) - base) * direction > 0)
    .sort((left, right) => Math.abs(Number(left) - base) - Math.abs(Number(right) - base));
  return (
    candidates[Math.min(distance - 1, Math.max(0, candidates.length - 1))] ??
    ramp.generator.basePosition
  );
}

function createToneDependencies(source: StyleflowProjectSource, ramp: ColorRamp): void {
  const levels = DEFAULT_INTENSITY_LEVELS.map((level) => ({ ...level }));
  source.colors.intensityProfiles.push({
    toneId: ramp.id,
    levels,
    mappingByTheme: Object.fromEntries(
      source.themes.map((theme) => [
        theme.id,
        Object.fromEntries(
          levels.map((level) => [level.id, defaultPositionAroundBase(ramp, theme, level.id)]),
        ),
      ]),
    ),
  });
  for (const [index, level] of levels.entries()) {
    const reference = `color.${ramp.id}.${level.id}` as TokenReference;
    source.colors.onColors.push(defaultOnColor(reference, index >= Math.ceil(levels.length / 2)));
    source.colors.surfaces.push({
      toneId: ramp.id,
      intensity: level.id,
      backgrounds: {
        default: reference,
        raised: `color.${ramp.id}.${levels[Math.max(0, index - 1)]!.id}`,
        sunken: `color.${ramp.id}.${levels[Math.min(levels.length - 1, index + 1)]!.id}`,
      },
    });
  }
}

function replaceToneRef(reference: TokenReference, from: string, to: string): TokenReference {
  return reference.startsWith(`color.${from}.`)
    ? (reference.replace(`color.${from}.`, `color.${to}.`) as TokenReference)
    : reference;
}

function remapRecipeReferences(recipe: InteractionStateRecipe, from: string, to: string): void {
  recipe.backgroundRef = replaceToneRef(recipe.backgroundRef, from, to);
  if (recipe.foregroundOverrideRef)
    recipe.foregroundOverrideRef = replaceToneRef(recipe.foregroundOverrideRef, from, to);
  if (recipe.borderOverrideRef)
    recipe.borderOverrideRef = replaceToneRef(recipe.borderOverrideRef, from, to);
  if (recipe.focusRing)
    recipe.focusRing.colorRef = replaceToneRef(recipe.focusRing.colorRef, from, to);
}

function remapToneReferences(source: StyleflowProjectSource, from: string, to: string): void {
  for (const theme of source.themes) {
    theme.canvasToken = replaceToneRef(theme.canvasToken, from, to);
    theme.tokenOverrides = Object.fromEntries(
      Object.entries(theme.tokenOverrides).map(([key, value]) => [
        key.startsWith(`color.${from}.`) ? key.replace(`color.${from}.`, `color.${to}.`) : key,
        value,
      ]),
    );
  }
  for (const contract of source.colors.onColors) {
    contract.backgroundRef = replaceToneRef(contract.backgroundRef, from, to);
    for (const role of FOREGROUND_ROLES)
      contract.foreground[role] = replaceToneRef(contract.foreground[role], from, to);
    for (const role of BORDER_ROLES)
      contract.border[role] = replaceToneRef(contract.border[role], from, to);
    if (contract.compositeOn) contract.compositeOn = replaceToneRef(contract.compositeOn, from, to);
  }
  for (const surface of source.colors.surfaces)
    for (const role of SURFACE_ROLES)
      surface.backgrounds[role] = replaceToneRef(surface.backgrounds[role], from, to);
  for (const interaction of source.colors.interactions.defaults)
    for (const state of INTERACTION_STATES)
      remapRecipeReferences(interaction.states[state], from, to);
  for (const override of source.colors.interactions.overrides) {
    override.contextBackgroundRef = replaceToneRef(override.contextBackgroundRef, from, to);
    const recipe = override.values as Partial<InteractionStateRecipe>;
    if (recipe.backgroundRef) recipe.backgroundRef = replaceToneRef(recipe.backgroundRef, from, to);
    if (recipe.foregroundOverrideRef)
      recipe.foregroundOverrideRef = replaceToneRef(recipe.foregroundOverrideRef, from, to);
    if (recipe.borderOverrideRef)
      recipe.borderOverrideRef = replaceToneRef(recipe.borderOverrideRef, from, to);
    if (recipe.focusRing)
      recipe.focusRing.colorRef = replaceToneRef(recipe.focusRing.colorRef, from, to);
  }
}

function toneHasExternalReferences(source: StyleflowProjectSource, toneId: string): boolean {
  const clone = structuredClone(source);
  clone.colors.ramps = clone.colors.ramps.filter((item) => item.id !== toneId);
  clone.colors.intensityProfiles = clone.colors.intensityProfiles.filter(
    (item) => item.toneId !== toneId,
  );
  clone.colors.onColors = clone.colors.onColors.filter(
    (item) => !item.backgroundRef.startsWith(`color.${toneId}.`),
  );
  clone.colors.surfaces = clone.colors.surfaces.filter((item) => item.toneId !== toneId);
  return JSON.stringify(clone).includes(`color.${toneId}.`);
}

function resetOnColors(source: StyleflowProjectSource, backgroundRefs: TokenReference[]): void {
  const preset = createPresetSource();
  for (const contract of source.colors.onColors) {
    if (!backgroundRefs.includes(contract.backgroundRef)) continue;
    const presetContract = preset.colors.onColors.find(
      (item) => item.backgroundRef === contract.backgroundRef,
    );
    if (presetContract) Object.assign(contract, structuredClone(presetContract));
    else {
      for (const role of FOREGROUND_ROLES) {
        const candidate = chooseBestCandidate(source, contract.backgroundRef, {
          group: "foreground",
          role,
        });
        if (candidate) contract.foreground[role] = candidate;
      }
      for (const role of BORDER_ROLES) {
        const candidate = chooseBestCandidate(source, contract.backgroundRef, {
          group: "border",
          role,
        });
        if (candidate) contract.border[role] = candidate;
      }
      contract.provenance = "generated";
    }
  }
}

function recipeFor(
  source: StyleflowProjectSource,
  role: LayoutRecipe["role"],
  density: LayoutRecipe["density"],
): LayoutRecipe {
  const recipe = source.layout.recipes.find(
    (item) => item.role === role && item.density === density,
  );
  if (!recipe) throw new Error(`Unknown layout recipe "${role}:${density}"`);
  return recipe;
}

function remapTypographyRecipe(
  recipe: TypographyRecipe,
  key: "tyId" | "variantId" | "weightId",
  from: string,
  to: string,
): void {
  if (recipe[key] === from) recipe[key] = to;
}

function typographyRecipeKey(recipe: TypographyRecipe): string {
  return `${recipe.tyId}:${recipe.variantId}:${recipe.weightId}`;
}

function dedupeTypographyRecipes(source: StyleflowProjectSource): void {
  const recipes = new Map<string, TypographyRecipe>();
  for (const recipe of source.typography.recipes) {
    const key = typographyRecipeKey(recipe);
    const current = recipes.get(key);
    if (!current || (current.provenance !== "manual" && recipe.provenance === "manual"))
      recipes.set(key, recipe);
  }
  source.typography.recipes = [...recipes.values()];
}

function createTypographyRecipe(
  source: StyleflowProjectSource,
  tyId: string,
  variantId: string,
  weightId: string,
): TypographyRecipe {
  const template =
    source.typography.recipes.find((item) => item.tyId === tyId && item.weightId === weightId) ??
    source.typography.recipes.find((item) => item.weightId === weightId) ??
    source.typography.recipes[0];
  if (template)
    return { ...structuredClone(template), tyId, variantId, weightId, provenance: "generated" };
  const breakpoints = [...source.layout.scales.breakpoints].sort(
    (left, right) => left.order - right.order,
  );
  return {
    tyId,
    variantId,
    weightId,
    provenance: "generated",
    valuesByBreakpoint: Object.fromEntries(
      breakpoints.map((breakpoint, index) => [
        breakpoint.id,
        index === 0
          ? {
              fontSize: { value: "1rem" },
              lineHeight: { value: "1.5" },
              letterSpacing: { value: "0em" },
              textCase: { value: "original" },
            }
          : {
              fontSize: { inherit: true },
              lineHeight: { inherit: true },
              letterSpacing: { inherit: true },
              textCase: { inherit: true },
            },
      ]),
    ),
  };
}

export function affectedPaths(operation: DraftOperation): string[] {
  switch (operation.type) {
    case "replace-source":
      return ["/"];
    case "set-project-metadata":
      return ["/project/name", "/project/description"];
    case "set-accessibility":
      return ["/settings/accessibility"];
    case "set-authoring-status":
      return ["/settings/authoring/setupStatus"];
    case "create-color-ramp":
      return [
        `/colors/ramps/${operation.ramp.id}`,
        `/colors/intensityProfiles/${operation.ramp.id}`,
        `/colors/onColors/${operation.ramp.id}`,
        `/colors/surfaces/${operation.ramp.id}`,
      ];
    case "update-color-ramp":
      return Object.keys(operation.patch)
        .map((key) => `/colors/ramps/${operation.toneId}/${key}`)
        .concat(
          operation.regenerate
            ? [
                `/colors/ramps/${operation.toneId}/stops`,
                `/colors/intensityProfiles/${operation.toneId}`,
              ]
            : [],
        );
    case "delete-color-ramp":
      return [
        `/colors/ramps/${operation.toneId}`,
        `/colors/intensityProfiles/${operation.toneId}`,
        `/colors/onColors/${operation.toneId}`,
        `/colors/surfaces/${operation.toneId}`,
      ];
    case "set-ramp-stop":
      return [`/colors/ramps/${operation.toneId}/stops/${operation.stop.position}`];
    case "reset-ramp-stop":
      return [`/colors/ramps/${operation.toneId}/stops/${operation.position}`];
    case "upsert-intensity-level":
      return [`/colors/intensityProfiles/${operation.toneId}/levels/${operation.level.id}`];
    case "delete-intensity-level":
      return [`/colors/intensityProfiles/${operation.toneId}/levels/${operation.levelId}`];
    case "set-intensity-mapping":
      return [
        `/colors/intensityProfiles/${operation.toneId}/mappingByTheme/${operation.themeId}/${operation.levelId}`,
      ];
    case "upsert-theme":
      return [`/themes/${operation.theme.id}`];
    case "delete-theme":
      return [`/themes/${operation.themeId}`];
    case "set-on-color":
    case "auto-solve-on-color":
    case "relative-on-color":
    case "interpolate-on-color":
      return operation.backgroundRefs.map(
        (reference) =>
          `/colors/onColors/${reference}/${operation.target.group}/${operation.target.role}`,
      );
    case "copy-on-color-roles":
    case "reset-on-color":
      return operation.backgroundRefs.map((reference) => `/colors/onColors/${reference}`);
    case "set-theme-override":
      return [`/themes/${operation.themeId}/tokenOverrides/${operation.tokenRef}`];
    case "set-surface-recipe":
      return [`/colors/surfaces/${operation.recipe.toneId}:${operation.recipe.intensity}`];
    case "upsert-interaction-priority":
      return [`/colors/interactions/priorities/${operation.priority.id}`];
    case "delete-interaction-priority":
      return [`/colors/interactions/priorities/${operation.priorityId}`];
    case "set-interaction-default":
      return [`/colors/interactions/defaults/${operation.priorityId}/states/${operation.state}`];
    case "set-interaction-override":
      return [
        `/colors/interactions/overrides/${operation.override.themeId}:${operation.override.contextBackgroundRef}:${operation.override.priorityId}:${operation.override.state}`,
      ];
    case "delete-interaction-override":
      return [
        `/colors/interactions/overrides/${operation.themeId}:${operation.contextBackgroundRef}:${operation.priorityId}:${operation.state}`,
      ];
    case "upsert-layout-scale-entry":
      return [`/layout/scales/${operation.scale}/${operation.entry.id}`];
    case "delete-layout-scale-entry":
      return [`/layout/scales/${operation.scale}/${operation.entryId}`];
    case "upsert-breakpoint":
      return [`/layout/scales/breakpoints/${operation.breakpoint.id}`];
    case "delete-breakpoint":
      return [`/layout/scales/breakpoints/${operation.breakpointId}`];
    case "set-layout-cell":
      return [
        `/layout/recipes/${operation.edit.role}:${operation.edit.density}/${operation.edit.breakpointId}/${operation.edit.property}`,
      ];
    case "bulk-set-layout-cells":
      return operation.edits.map(
        (edit) =>
          `/layout/recipes/${edit.role}:${edit.density}/${edit.breakpointId}/${edit.property}`,
      );
    case "upsert-font-slot":
      return [`/typography/fontSlots/${operation.fontSlot.id}`];
    case "delete-font-slot":
      return [`/typography/fontSlots/${operation.fontSlotId}`];
    case "upsert-typography-type":
      return [`/typography/types/${operation.typographyType.id}`];
    case "delete-typography-type":
      return [`/typography/types/${operation.typeId}`];
    case "upsert-typography-variant":
      return [`/typography/types/${operation.typeId}/variants/${operation.variant.id}`];
    case "delete-typography-variant":
      return [`/typography/types/${operation.typeId}/variants/${operation.variantId}`];
    case "upsert-typography-weight":
      return [`/typography/weights/${operation.weight.id}`];
    case "delete-typography-weight":
      return [`/typography/weights/${operation.weightId}`];
    case "set-typography-generator":
      return ["/typography/generator", "/typography/recipes/generated"];
    case "set-typography-recipe":
      return [
        `/typography/recipes/${operation.recipe.tyId}:${operation.recipe.variantId}:${operation.recipe.weightId}`,
      ];
    case "set-agent-policy":
      return ["/agentPolicy"];
  }
}

export function applyDraftOperations(
  source: StyleflowProjectSource,
  operations: DraftOperation[],
): StyleflowProjectSource {
  const next = structuredClone(source);
  for (const operation of operations) {
    switch (operation.type) {
      case "replace-source":
        Object.assign(next, structuredClone(operation.source));
        break;
      case "set-project-metadata":
        next.project.name = operation.name;
        if (operation.description === undefined) delete next.project.description;
        else next.project.description = operation.description;
        break;
      case "set-accessibility":
        next.settings.accessibility = { level: operation.level, policy: operation.policy };
        break;
      case "set-authoring-status":
        next.settings.authoring.setupStatus = operation.status;
        break;
      case "create-color-ramp": {
        if (next.colors.ramps.some((item) => item.id === operation.ramp.id))
          throw new Error(`Tone "${operation.ramp.id}" already exists`);
        const ramp = structuredClone(operation.ramp);
        regenerateRamp(ramp);
        next.colors.ramps.push(ramp);
        createToneDependencies(next, ramp);
        break;
      }
      case "update-color-ramp": {
        const ramp = next.colors.ramps.find((item) => item.id === operation.toneId);
        if (!ramp) throw new Error(`Unknown tone "${operation.toneId}"`);
        Object.assign(ramp, structuredClone(operation.patch));
        if (operation.regenerate) {
          regenerateRamp(ramp);
          const profile = next.colors.intensityProfiles.find(
            (item) => item.toneId === operation.toneId,
          );
          if (profile)
            for (const mapping of Object.values(profile.mappingByTheme))
              mapping.base = ramp.generator.basePosition;
        }
        break;
      }
      case "delete-color-ramp": {
        if (operation.toneId === "main") throw new Error("The core main tone cannot be deleted");
        if (next.colors.ramps.length === 1)
          throw new Error("A project must keep at least one color tone");
        if (operation.replacementToneId) {
          if (
            operation.replacementToneId === operation.toneId ||
            !next.colors.ramps.some((item) => item.id === operation.replacementToneId)
          )
            throw new Error("A valid replacement tone is required");
          remapToneReferences(next, operation.toneId, operation.replacementToneId);
        } else if (toneHasExternalReferences(next, operation.toneId)) {
          throw new Error(`Tone "${operation.toneId}" is referenced; use Replace & delete`);
        }
        next.colors.ramps = next.colors.ramps.filter((item) => item.id !== operation.toneId);
        next.colors.intensityProfiles = next.colors.intensityProfiles.filter(
          (item) => item.toneId !== operation.toneId,
        );
        next.colors.onColors = next.colors.onColors.filter(
          (item) => !item.backgroundRef.startsWith(`color.${operation.toneId}.`),
        );
        next.colors.surfaces = next.colors.surfaces.filter(
          (item) => item.toneId !== operation.toneId,
        );
        break;
      }
      case "set-ramp-stop": {
        const ramp = next.colors.ramps.find((item) => item.id === operation.toneId);
        if (!ramp) throw new Error(`Unknown tone "${operation.toneId}"`);
        if (operation.stop.position === ramp.generator.basePosition)
          throw new Error("Edit the ramp Base color instead of overriding its anchor");
        upsert(ramp.stops, (stop) => stop.position === operation.stop.position, {
          ...operation.stop,
          value: renderOklchSource(operation.stop.source).value,
          overridden: true,
        });
        break;
      }
      case "reset-ramp-stop": {
        const ramp = next.colors.ramps.find((item) => item.id === operation.toneId);
        if (!ramp) throw new Error(`Unknown tone "${operation.toneId}"`);
        if (operation.position === ramp.generator.basePosition)
          throw new Error("The authored Base color is already generated from its source");
        const stop = ramp.stops.find((item) => item.position === operation.position);
        if (!stop) throw new Error(`Unknown ramp stop "${operation.position}"`);
        if (!ANCHOR_POSITIONS.includes(operation.position as never)) {
          ramp.stops = ramp.stops.filter((item) => item.position !== operation.position);
          break;
        }
        stop.overridden = false;
        stop.generated = true;
        regenerateRamp(ramp);
        break;
      }
      case "upsert-intensity-level": {
        const profile = next.colors.intensityProfiles.find(
          (item) => item.toneId === operation.toneId,
        );
        if (!profile) throw new Error(`Unknown intensity profile "${operation.toneId}"`);
        if (!/^(base|soft-[1-9][0-9]*|strong-[1-9][0-9]*)$/.test(operation.level.id))
          throw new Error("Intensity IDs must be base, soft-N or strong-N");
        const canonicalLabel =
          operation.level.id === "base"
            ? "Base"
            : `${operation.level.id.startsWith("soft-") ? "Soft" : "Strong"} ${operation.level.id.split("-")[1]}`;
        if (operation.level.label !== canonicalLabel)
          throw new Error(`Intensity "${operation.level.id}" must use label "${canonicalLabel}"`);
        const existing = profile.levels.some((item) => item.id === operation.level.id);
        upsert(profile.levels, (item) => item.id === operation.level.id, operation.level);
        if (!existing) {
          const ramp = next.colors.ramps.find((item) => item.id === operation.toneId);
          if (!ramp) throw new Error(`Unknown tone "${operation.toneId}"`);
          for (const theme of next.themes)
            profile.mappingByTheme[theme.id]![operation.level.id] = initialIntensityPosition(
              profile,
              ramp,
              theme,
              operation.level.id,
              operation.level.order,
            );
          const ref = `color.${operation.toneId}.${operation.level.id}` as TokenReference;
          next.colors.onColors.push(
            defaultOnColor(ref, operation.level.order >= profile.levels.length / 2),
          );
          next.colors.surfaces.push({
            toneId: operation.toneId,
            intensity: operation.level.id,
            backgrounds: { default: ref, raised: ref, sunken: ref },
          });
        }
        break;
      }
      case "delete-intensity-level": {
        let profile = next.colors.intensityProfiles.find(
          (item) => item.toneId === operation.toneId,
        );
        if (!profile) throw new Error(`Unknown intensity profile "${operation.toneId}"`);
        if (operation.levelId === "base") throw new Error("Base is the required core intensity");
        if (profile.levels.length === 1)
          throw new Error("An intensity profile must keep at least one level");
        const ref = `color.${operation.toneId}.${operation.levelId}` as TokenReference;
        const replacement = operation.replacementLevelId
          ? (`color.${operation.toneId}.${operation.replacementLevelId}` as TokenReference)
          : undefined;
        const external = JSON.stringify(next).split(ref).length > 4;
        if (external && !replacement)
          throw new Error(`Intensity "${operation.levelId}" is referenced; use Replace & delete`);
        next.colors.onColors = next.colors.onColors.filter((item) => item.backgroundRef !== ref);
        next.colors.surfaces = next.colors.surfaces.filter(
          (item) => !(item.toneId === operation.toneId && item.intensity === operation.levelId),
        );
        if (replacement) {
          const serialized = JSON.stringify(next).replaceAll(ref, replacement);
          Object.assign(next, JSON.parse(serialized) as StyleflowProjectSource);
          profile = next.colors.intensityProfiles.find((item) => item.toneId === operation.toneId);
          if (!profile) throw new Error(`Unknown intensity profile "${operation.toneId}"`);
        }
        profile.levels = profile.levels.filter((item) => item.id !== operation.levelId);
        for (const mapping of Object.values(profile.mappingByTheme))
          delete mapping[operation.levelId];
        break;
      }
      case "set-intensity-mapping": {
        const profile = next.colors.intensityProfiles.find(
          (item) => item.toneId === operation.toneId,
        );
        if (!profile?.levels.some((item) => item.id === operation.levelId))
          throw new Error("Unknown intensity coordinate");
        if (!next.themes.some((item) => item.id === operation.themeId))
          throw new Error(`Unknown theme "${operation.themeId}"`);
        if (operation.levelId === "base") {
          const ramp = next.colors.ramps.find((item) => item.id === operation.toneId);
          if (operation.position !== ramp?.generator.basePosition)
            throw new Error("Base must resolve to the ramp's authored base color");
        }
        profile.mappingByTheme[operation.themeId] ??= {};
        profile.mappingByTheme[operation.themeId]![operation.levelId] = operation.position;
        break;
      }
      case "upsert-theme": {
        const exists = next.themes.some((theme) => theme.id === operation.theme.id);
        upsert(next.themes, (theme) => theme.id === operation.theme.id, operation.theme);
        if (!exists)
          for (const profile of next.colors.intensityProfiles) {
            const sourceMapping = operation.theme.parentId
              ? profile.mappingByTheme[operation.theme.parentId]
              : Object.values(profile.mappingByTheme)[0];
            profile.mappingByTheme[operation.theme.id] = structuredClone(sourceMapping ?? {});
          }
        break;
      }
      case "delete-theme":
        if (next.themes.length === 1) throw new Error("A project must keep at least one theme");
        next.themes = next.themes.filter((theme) => theme.id !== operation.themeId);
        for (const theme of next.themes)
          if (theme.parentId === operation.themeId) {
            if (operation.reparentChildrenTo) theme.parentId = operation.reparentChildrenTo;
            else delete theme.parentId;
          }
        for (const profile of next.colors.intensityProfiles)
          delete profile.mappingByTheme[operation.themeId];
        next.colors.interactions.overrides = next.colors.interactions.overrides.filter(
          (item) => item.themeId !== operation.themeId,
        );
        break;
      case "set-on-color":
        for (const contract of next.colors.onColors)
          if (operation.backgroundRefs.includes(contract.backgroundRef)) {
            setRole(contract, operation.target, operation.tokenRef);
            contract.provenance = operation.provenance;
          }
        break;
      case "auto-solve-on-color":
        for (const contract of next.colors.onColors)
          if (operation.backgroundRefs.includes(contract.backgroundRef)) {
            const candidate = chooseBestCandidate(next, contract.backgroundRef, operation.target);
            if (candidate) {
              setRole(contract, operation.target, candidate);
              contract.provenance = "bulk";
            }
          }
        break;
      case "relative-on-color":
        for (const contract of next.colors.onColors)
          if (operation.backgroundRefs.includes(contract.backgroundRef)) {
            const candidate = relativeReference(
              next,
              contract.backgroundRef,
              operation.offset,
              operation.toneId,
            );
            if (candidate) {
              setRole(contract, operation.target, candidate);
              contract.provenance = "bulk";
            }
          }
        break;
      case "interpolate-on-color": {
        const references = interpolateReferences(
          next,
          operation.backgroundRefs,
          operation.startRef,
          operation.endRef,
        );
        operation.backgroundRefs.forEach((backgroundRef, index) => {
          const contract = next.colors.onColors.find(
            (item) => item.backgroundRef === backgroundRef,
          );
          if (contract && references[index]) {
            setRole(contract, operation.target, references[index]!);
            contract.provenance = "bulk";
          }
        });
        break;
      }
      case "copy-on-color-roles": {
        const sourceContract = next.colors.onColors.find(
          (item) => item.backgroundRef === operation.sourceBackgroundRef,
        );
        if (!sourceContract)
          throw new Error(`Unknown on-color source "${operation.sourceBackgroundRef}"`);
        for (const contract of next.colors.onColors)
          if (operation.backgroundRefs.includes(contract.backgroundRef)) {
            if (operation.groups.includes("foreground"))
              contract.foreground = structuredClone(sourceContract.foreground);
            if (operation.groups.includes("border"))
              contract.border = structuredClone(sourceContract.border);
            contract.provenance = "bulk";
          }
        break;
      }
      case "reset-on-color":
        resetOnColors(next, operation.backgroundRefs);
        break;
      case "set-theme-override": {
        const theme = next.themes.find((item) => item.id === operation.themeId);
        if (!theme) throw new Error(`Unknown theme "${operation.themeId}"`);
        if (operation.value === null) delete theme.tokenOverrides[operation.tokenRef];
        else theme.tokenOverrides[operation.tokenRef] = operation.value;
        break;
      }
      case "set-surface-recipe":
        upsert(
          next.colors.surfaces,
          (item) =>
            item.toneId === operation.recipe.toneId &&
            item.intensity === operation.recipe.intensity,
          operation.recipe,
        );
        break;
      case "upsert-interaction-priority":
        upsert(
          next.colors.interactions.priorities,
          (item) => item.id === operation.priority.id,
          operation.priority,
        );
        if (operation.defaultRecipe)
          upsert(
            next.colors.interactions.defaults,
            (item) => item.priorityId === operation.priority.id,
            operation.defaultRecipe,
          );
        break;
      case "delete-interaction-priority": {
        if (next.colors.interactions.priorities.length === 1)
          throw new Error("A project must keep at least one interaction priority");
        const referenced = next.colors.interactions.overrides.some(
          (item) => item.priorityId === operation.priorityId,
        );
        if (referenced && !operation.replacementPriorityId)
          throw new Error(`Priority "${operation.priorityId}" is referenced; use Replace & delete`);
        if (operation.replacementPriorityId)
          for (const item of next.colors.interactions.overrides)
            if (item.priorityId === operation.priorityId)
              item.priorityId = operation.replacementPriorityId;
        next.colors.interactions.overrides = [
          ...new Map(
            next.colors.interactions.overrides.map((item) => [
              `${item.themeId}:${item.contextBackgroundRef}:${item.priorityId}:${item.state}`,
              item,
            ]),
          ).values(),
        ];
        next.colors.interactions.priorities = next.colors.interactions.priorities.filter(
          (item) => item.id !== operation.priorityId,
        );
        next.colors.interactions.defaults = next.colors.interactions.defaults.filter(
          (item) => item.priorityId !== operation.priorityId,
        );
        break;
      }
      case "set-interaction-default": {
        const recipe = next.colors.interactions.defaults.find(
          (item) => item.priorityId === operation.priorityId,
        );
        if (!recipe) throw new Error(`Unknown interaction priority "${operation.priorityId}"`);
        recipe.states[operation.state] = structuredClone(operation.recipe);
        break;
      }
      case "set-interaction-override":
        upsert(
          next.colors.interactions.overrides,
          (item) =>
            item.themeId === operation.override.themeId &&
            item.contextBackgroundRef === operation.override.contextBackgroundRef &&
            item.priorityId === operation.override.priorityId &&
            item.state === operation.override.state,
          operation.override,
        );
        break;
      case "delete-interaction-override":
        next.colors.interactions.overrides = next.colors.interactions.overrides.filter(
          (item) =>
            !(
              item.themeId === operation.themeId &&
              item.contextBackgroundRef === operation.contextBackgroundRef &&
              item.priorityId === operation.priorityId &&
              item.state === operation.state
            ),
        );
        break;
      case "upsert-layout-scale-entry":
        upsert(
          next.layout.scales[operation.scale],
          (item) => item.id === operation.entry.id,
          operation.entry,
        );
        break;
      case "delete-layout-scale-entry": {
        const entries = next.layout.scales[operation.scale];
        if (entries.length === 1)
          throw new Error(`Scale "${operation.scale}" must keep at least one entry`);
        const affectedProperties = Object.entries(PROPERTY_SCALE)
          .filter(([, scale]) => scale === operation.scale)
          .map(([property]) => property as LayoutProperty);
        const referenced = next.layout.recipes.some((recipe) =>
          Object.values(recipe.valuesByBreakpoint).some((values) =>
            affectedProperties.some(
              (property) =>
                "scaleEntryId" in values[property] &&
                values[property].scaleEntryId === operation.entryId,
            ),
          ),
        );
        if (referenced && !operation.replacementEntryId)
          throw new Error(`Scale entry "${operation.entryId}" is referenced; use Replace & delete`);
        if (operation.replacementEntryId)
          for (const recipe of next.layout.recipes)
            for (const values of Object.values(recipe.valuesByBreakpoint))
              for (const property of affectedProperties)
                if (
                  "scaleEntryId" in values[property] &&
                  values[property].scaleEntryId === operation.entryId
                )
                  values[property] = { scaleEntryId: operation.replacementEntryId };
        next.layout.scales[operation.scale] = entries.filter(
          (item) => item.id !== operation.entryId,
        );
        break;
      }
      case "upsert-breakpoint": {
        const exists = next.layout.scales.breakpoints.some(
          (item) => item.id === operation.breakpoint.id,
        );
        upsert(
          next.layout.scales.breakpoints,
          (item) => item.id === operation.breakpoint.id,
          operation.breakpoint,
        );
        if (!exists) {
          for (const recipe of next.layout.recipes)
            recipe.valuesByBreakpoint[operation.breakpoint.id] = {
              gap: { inherit: true },
              paddingInline: { inherit: true },
              paddingBlock: { inherit: true },
              radius: { inherit: true },
              borderWidth: { inherit: true },
              containerMaxWidth: { inherit: true },
            };
          for (const recipe of next.typography.recipes)
            recipe.valuesByBreakpoint[operation.breakpoint.id] = {
              fontSize: { inherit: true },
              lineHeight: { inherit: true },
              letterSpacing: { inherit: true },
              textCase: { inherit: true },
            };
        }
        break;
      }
      case "delete-breakpoint": {
        if (next.layout.scales.breakpoints.length === 1)
          throw new Error("A project must keep at least one breakpoint");
        const breakpoint = next.layout.scales.breakpoints.find(
          (item) => item.id === operation.breakpointId,
        );
        if (breakpoint?.minWidth === 0)
          throw new Error("The base 0px breakpoint cannot be deleted");
        next.layout.scales.breakpoints = next.layout.scales.breakpoints.filter(
          (item) => item.id !== operation.breakpointId,
        );
        for (const recipe of next.layout.recipes)
          delete recipe.valuesByBreakpoint[operation.breakpointId];
        for (const recipe of next.typography.recipes)
          delete recipe.valuesByBreakpoint[operation.breakpointId];
        break;
      }
      case "set-layout-cell":
        recipeFor(next, operation.edit.role, operation.edit.density).valuesByBreakpoint[
          operation.edit.breakpointId
        ]![operation.edit.property] = structuredClone(operation.edit.value);
        break;
      case "bulk-set-layout-cells":
        for (const edit of operation.edits)
          recipeFor(next, edit.role, edit.density).valuesByBreakpoint[edit.breakpointId]![
            edit.property
          ] = structuredClone(edit.value);
        break;
      case "upsert-font-slot": {
        const exists = next.typography.fontSlots.some((item) => item.id === operation.fontSlot.id);
        upsert(
          next.typography.fontSlots,
          (item) => item.id === operation.fontSlot.id,
          operation.fontSlot,
        );
        if (!exists)
          for (const weight of next.typography.weights) {
            weight.stylesByFontSlot[operation.fontSlot.id] = structuredClone(
              Object.values(weight.stylesByFontSlot)[0] ?? { fontWeight: 500, fontStyle: "normal" },
            );
          }
        break;
      }
      case "delete-font-slot": {
        if (next.typography.fontSlots.length === 1)
          throw new Error("Typography must keep at least one font slot");
        const referenced = next.typography.types.some(
          (item) => item.fontSlotId === operation.fontSlotId,
        );
        if (referenced && !operation.replacementFontSlotId)
          throw new Error(
            `Font slot "${operation.fontSlotId}" is referenced; use Replace & delete`,
          );
        if (operation.replacementFontSlotId)
          for (const item of next.typography.types)
            if (item.fontSlotId === operation.fontSlotId)
              item.fontSlotId = operation.replacementFontSlotId;
        next.typography.fontSlots = next.typography.fontSlots.filter(
          (item) => item.id !== operation.fontSlotId,
        );
        for (const weight of next.typography.weights)
          delete weight.stylesByFontSlot[operation.fontSlotId];
        break;
      }
      case "upsert-typography-type": {
        const exists = next.typography.types.some(
          (item) => item.id === operation.typographyType.id,
        );
        upsert(
          next.typography.types,
          (item) => item.id === operation.typographyType.id,
          operation.typographyType,
        );
        if (!exists)
          for (const variant of operation.typographyType.variants)
            for (const weight of next.typography.weights) {
              next.typography.recipes.push(
                createTypographyRecipe(next, operation.typographyType.id, variant.id, weight.id),
              );
            }
        break;
      }
      case "delete-typography-type": {
        if (next.typography.types.length === 1)
          throw new Error("Typography must keep at least one type");
        const referenced = next.typography.recipes.some((item) => item.tyId === operation.typeId);
        if (referenced && !operation.replacementTypeId)
          throw new Error(`Type "${operation.typeId}" is referenced; use Replace & delete`);
        if (operation.replacementTypeId) {
          const replacementType = next.typography.types.find(
            (item) => item.id === operation.replacementTypeId,
          );
          if (!replacementType)
            throw new Error(`Unknown replacement type "${operation.replacementTypeId}"`);
          for (const recipe of next.typography.recipes)
            if (recipe.tyId === operation.typeId) {
              recipe.tyId = operation.replacementTypeId;
              if (!replacementType.variants.some((item) => item.id === recipe.variantId)) {
                recipe.variantId = replacementType.variants[0]!.id;
              }
            }
        }
        next.typography.types = next.typography.types.filter(
          (item) => item.id !== operation.typeId,
        );
        next.typography.recipes = next.typography.recipes.filter(
          (item) => item.tyId !== operation.typeId || Boolean(operation.replacementTypeId),
        );
        dedupeTypographyRecipes(next);
        break;
      }
      case "upsert-typography-variant": {
        const type = next.typography.types.find((item) => item.id === operation.typeId);
        if (!type) throw new Error(`Unknown typography type "${operation.typeId}"`);
        const exists = type.variants.some((item) => item.id === operation.variant.id);
        upsert(type.variants, (item) => item.id === operation.variant.id, operation.variant);
        if (!exists)
          for (const weight of next.typography.weights)
            next.typography.recipes.push(
              createTypographyRecipe(next, operation.typeId, operation.variant.id, weight.id),
            );
        break;
      }
      case "delete-typography-variant": {
        const type = next.typography.types.find((item) => item.id === operation.typeId);
        if (!type) throw new Error(`Unknown typography type "${operation.typeId}"`);
        if (type.variants.length === 1)
          throw new Error("A typography type must keep at least one variant");
        const recipes = next.typography.recipes.filter(
          (item) => item.tyId === operation.typeId && item.variantId === operation.variantId,
        );
        if (recipes.length && !operation.replacementVariantId)
          throw new Error(`Variant "${operation.variantId}" is referenced; use Replace & delete`);
        if (operation.replacementVariantId)
          for (const recipe of recipes)
            remapTypographyRecipe(
              recipe,
              "variantId",
              operation.variantId,
              operation.replacementVariantId,
            );
        type.variants = type.variants.filter((item) => item.id !== operation.variantId);
        dedupeTypographyRecipes(next);
        break;
      }
      case "upsert-typography-weight": {
        const exists = next.typography.weights.some((item) => item.id === operation.weight.id);
        upsert(
          next.typography.weights,
          (item) => item.id === operation.weight.id,
          operation.weight,
        );
        if (!exists)
          for (const type of next.typography.types)
            for (const variant of type.variants) {
              next.typography.recipes.push(
                createTypographyRecipe(next, type.id, variant.id, operation.weight.id),
              );
            }
        break;
      }
      case "delete-typography-weight": {
        if (next.typography.weights.length === 1)
          throw new Error("Typography must keep at least one weight");
        const recipes = next.typography.recipes.filter(
          (item) => item.weightId === operation.weightId,
        );
        if (recipes.length && !operation.replacementWeightId)
          throw new Error(`Weight "${operation.weightId}" is referenced; use Replace & delete`);
        if (operation.replacementWeightId)
          for (const recipe of recipes)
            remapTypographyRecipe(
              recipe,
              "weightId",
              operation.weightId,
              operation.replacementWeightId,
            );
        next.typography.weights = next.typography.weights.filter(
          (item) => item.id !== operation.weightId,
        );
        dedupeTypographyRecipes(next);
        break;
      }
      case "set-typography-generator": {
        next.typography.generator = structuredClone(operation.generator);
        const manual = next.typography.recipes.filter((item) => item.provenance !== "generated");
        const manualKeys = new Set(
          manual.map((item) => `${item.tyId}:${item.variantId}:${item.weightId}`),
        );
        next.typography.recipes = [
          ...manual,
          ...operation.generatedRecipes.filter(
            (item) => !manualKeys.has(`${item.tyId}:${item.variantId}:${item.weightId}`),
          ),
        ];
        break;
      }
      case "set-typography-recipe":
        upsert(
          next.typography.recipes,
          (item) =>
            item.tyId === operation.recipe.tyId &&
            item.variantId === operation.recipe.variantId &&
            item.weightId === operation.recipe.weightId,
          operation.recipe,
        );
        break;
      case "set-agent-policy":
        next.agentPolicy = structuredClone(operation.policy);
        break;
    }
  }
  return next;
}
