import { materializeIntermediateStop, parseHexColor } from "./color";
import type {
  CompiledProject,
  Diagnostic,
  InteractionState,
  LayoutProperty,
  StyleflowProjectSource,
  SurfaceRole,
  TokenReference,
  TypographyTextCase,
} from "./types";
import { BORDER_ROLES, FOREGROUND_ROLES, INTERACTION_STATES, SURFACE_ROLES } from "./types";

export const FIGMA_PROJECTION_VERSION = "2.1.0" as const;
export const FIGMA_PROJECTION_PATH = "targets/figma-vnext.json" as const;

export type FigmaVariableType = "COLOR" | "FLOAT" | "STRING" | "BOOLEAN";
export type FigmaVariableScope =
  | "FRAME_FILL"
  | "SHAPE_FILL"
  | "TEXT_FILL"
  | "STROKE_COLOR"
  | "GAP"
  | "CORNER_RADIUS"
  | "STROKE_FLOAT"
  | "OPACITY";
export type FigmaProjectedValue =
  | { kind: "alias"; variablePath: string }
  | { kind: "color"; r: number; g: number; b: number; a: number }
  | { kind: "float"; value: number }
  | { kind: "string"; value: string }
  | { kind: "boolean"; value: boolean }
  | { kind: "unset" };

export interface FigmaModeSpec {
  id: string;
  name: string;
}

export interface FigmaVariableSpec {
  path: string;
  name: string;
  type: FigmaVariableType;
  scopes: FigmaVariableScope[];
  valuesByMode: Record<string, FigmaProjectedValue>;
}

export interface FigmaCollectionSpec {
  id: string;
  name: string;
  modes: FigmaModeSpec[];
  variables: FigmaVariableSpec[];
}

export interface FigmaTextStyleSpec {
  id: string;
  name: string;
  fontFamily: string;
  fontStyle: string;
  textCase: TypographyTextCase;
  variablePaths: {
    fontSize: string;
    lineHeight: string;
    letterSpacing: string;
  };
}

export interface FigmaProjection {
  formatVersion: typeof FIGMA_PROJECTION_VERSION;
  project: StyleflowProjectSource["project"];
  sourceRevision: number;
  contentHash: string;
  axes: {
    theme: FigmaModeSpec[];
    tone: FigmaModeSpec[];
    intensity: FigmaModeSpec[];
    layoutRole: FigmaModeSpec[];
    density: FigmaModeSpec[];
    breakpoint: FigmaModeSpec[];
  };
  modeCollections: Record<keyof FigmaProjection["axes"], string[]>;
  availability: {
    intensityByTone: Record<string, string[]>;
    modeIdsByCollection: Record<string, string[]>;
  };
  collections: FigmaCollectionSpec[];
  textStyles: FigmaTextStyleSpec[];
  bindings: {
    color: {
      background: string;
      foreground: Record<string, string>;
      border: Record<string, string>;
      surfaces: Record<string, string>;
      interactions: Record<string, Record<string, string>>;
    };
    layout: Record<string, string>;
    typography: Record<string, string>;
  };
  diagnostics: Diagnostic[];
}

export interface FigmaTargetEvaluation {
  status: "supported" | "unsupported";
  reasons: string[];
  diagnostics: Diagnostic[];
}

const COLLECTIONS = {
  primitive: { id: "primitive", name: "Styleflow / Primitives" },
  theme: { id: "theme", name: "Styleflow / Theme" },
  intensity: { id: "intensity", name: "Styleflow / Color · Intensity" },
  breakpoint: { id: "breakpoint", name: "Styleflow / Breakpoint" },
  density: { id: "density", name: "Styleflow / Layout Density" },
  layoutRole: { id: "layout-role", name: "Styleflow / Layout · Role" },
} as const;

const LAYOUT_PROPERTIES: LayoutProperty[] = [
  "gap",
  "paddingInline",
  "paddingBlock",
  "radius",
  "borderWidth",
  "containerMaxWidth",
];

function modes<T extends { id: string; label?: string }>(items: T[]): FigmaModeSpec[] {
  return items.map((item) => ({ id: item.id, name: item.label ?? item.id }));
}

function title(value: string): string {
  return value
    .split(/[./_-]/)
    .filter(Boolean)
    .map((part) => `${part[0]?.toUpperCase() ?? ""}${part.slice(1)}`)
    .join(" / ");
}

function kebab(value: string): string {
  return value.replace(/([a-z])([A-Z])/g, "$1-$2").toLowerCase();
}

function variable(
  collectionId: string,
  path: string,
  type: FigmaVariableType,
  valuesByMode: Record<string, FigmaProjectedValue>,
): FigmaVariableSpec {
  return { path, name: title(path), type, scopes: scopesFor(collectionId, path), valuesByMode };
}

function scopesFor(collectionId: string, path: string): FigmaVariableScope[] {
  if (collectionId === COLLECTIONS.intensity.id) {
    if (
      path === "semantic/color/background" ||
      path.startsWith("semantic/surface/") ||
      (path.startsWith("semantic/interaction/") && path.endsWith("/background"))
    )
      return ["FRAME_FILL"];
    if (path.includes("/foreground/") || path.endsWith("/foreground"))
      return ["TEXT_FILL", "SHAPE_FILL"];
    if (path.includes("/border/") || path.endsWith("/border") || path.endsWith("/focus-ring"))
      return ["STROKE_COLOR"];
    if (path.endsWith("/control-opacity")) return ["OPACITY"];
  }
  if (collectionId === COLLECTIONS.layoutRole.id) {
    if (path.endsWith("/gap") || path.endsWith("/paddingInline") || path.endsWith("/paddingBlock"))
      return ["GAP"];
    if (path.endsWith("/radius")) return ["CORNER_RADIUS"];
    if (path.endsWith("/borderWidth")) return ["STROKE_FLOAT"];
  }
  return [];
}

function alias(variablePath: string): FigmaProjectedValue {
  return { kind: "alias", variablePath };
}

function unset(): FigmaProjectedValue {
  return { kind: "unset" };
}

function color(value: string): FigmaProjectedValue {
  const parsed = parseHexColor(value);
  if (!parsed) return unset();
  return { kind: "color", ...parsed };
}

function colorWithOpacity(value: string, opacity: number): FigmaProjectedValue {
  const parsed = parseHexColor(value);
  if (!parsed) return unset();
  return { kind: "color", ...parsed, a: Number((parsed.a * opacity).toFixed(6)) };
}

function float(value: number): FigmaProjectedValue {
  return { kind: "float", value: Number(value.toFixed(6)) };
}

function intensityAxis(source: StyleflowProjectSource): {
  items: Array<{ id: string; label: string }>;
  conflict: boolean;
} {
  const firstSeen = new Map<string, number>();
  const labels = new Map<string, string>();
  const edges = new Map<string, Set<string>>();
  let cursor = 0;
  for (const profile of source.colors.intensityProfiles) {
    const levels = [...profile.levels].sort(
      (left, right) => left.order - right.order || left.id.localeCompare(right.id),
    );
    for (const level of levels) {
      if (!firstSeen.has(level.id)) firstSeen.set(level.id, cursor++);
      if (!labels.has(level.id)) labels.set(level.id, level.label);
      if (!edges.has(level.id)) edges.set(level.id, new Set());
    }
    for (let index = 1; index < levels.length; index += 1)
      edges.get(levels[index - 1]!.id)!.add(levels[index]!.id);
  }

  const incoming = new Map([...edges.keys()].map((id) => [id, 0]));
  for (const targets of edges.values())
    for (const target of targets) incoming.set(target, (incoming.get(target) ?? 0) + 1);
  const ready = [...incoming]
    .filter(([, count]) => count === 0)
    .map(([id]) => id)
    .sort(
      (left, right) => firstSeen.get(left)! - firstSeen.get(right)! || left.localeCompare(right),
    );
  const ordered: string[] = [];
  while (ready.length > 0) {
    const id = ready.shift()!;
    ordered.push(id);
    for (const target of edges.get(id) ?? []) {
      const count = incoming.get(target)! - 1;
      incoming.set(target, count);
      if (count === 0) {
        ready.push(target);
        ready.sort(
          (left, right) =>
            firstSeen.get(left)! - firstSeen.get(right)! || left.localeCompare(right),
        );
      }
    }
  }
  return {
    items: ordered.map((id) => ({ id, label: labels.get(id) ?? id })),
    conflict: ordered.length !== edges.size,
  };
}

function activeTokenCoordinates(source: StyleflowProjectSource): Array<{
  toneId: string;
  intensityId: string;
}> {
  return source.colors.intensityProfiles.flatMap((profile) =>
    [...profile.levels]
      .sort((left, right) => left.order - right.order)
      .map((level) => ({ toneId: profile.toneId, intensityId: level.id })),
  );
}

function diagnostic(reasons: string[]): Diagnostic[] {
  if (reasons.length === 0) return [];
  return [
    {
      code: "SF_TARGET_FIGMA_CAPABILITY",
      severity: "warning",
      blocking: false,
      path: "/settings/targets",
      themeIds: [],
      target: "figma-vnext",
      message: "The project cannot be projected to Figma without loss.",
      suggestion: `Resolve the Figma target diagnostics: ${reasons.join(", ")}.`,
    },
  ];
}

function pushModeReason(reasons: string[], count: number, limit: number, code: string): void {
  if (count > limit) reasons.push(code);
}

function cssLength(value: string, baseSize: number): number | null | undefined {
  const normalized = value.trim().toLowerCase();
  if (normalized === "none") return null;
  if (normalized === "0") return 0;
  const match = /^(-?(?:\d+|\d*\.\d+))(px|rem)$/.exec(normalized);
  if (!match) return undefined;
  const number = Number(match[1]);
  return match[2] === "rem" ? number * baseSize : number;
}

function fontSize(value: string, baseSize: number): number | undefined {
  const result = cssLength(value, baseSize);
  return typeof result === "number" ? result : undefined;
}

function lineHeight(value: string, baseSize: number): number | undefined {
  const normalized = value.trim().toLowerCase();
  if (/^-?(?:\d+|\d*\.\d+)$/.test(normalized)) return Number(normalized) * 100;
  return fontSize(normalized, baseSize);
}

function letterSpacing(value: string, baseSize: number): number | undefined {
  const normalized = value.trim().toLowerCase();
  if (normalized === "0") return 0;
  const em = /^(-?(?:\d+|\d*\.\d+))em$/.exec(normalized);
  if (em) return Number(em[1]) * 100;
  return fontSize(normalized, baseSize);
}

function effectiveTextCases(
  source: StyleflowProjectSource,
  recipe: StyleflowProjectSource["typography"]["recipes"][number],
): TypographyTextCase[] {
  let current: TypographyTextCase | undefined;
  const values: TypographyTextCase[] = [];
  for (const breakpoint of [...source.layout.scales.breakpoints].sort(
    (left, right) => left.order - right.order,
  )) {
    const candidate = recipe.valuesByBreakpoint[breakpoint.id]?.textCase;
    if (candidate && "value" in candidate) current = candidate.value;
    if (current) values.push(current);
  }
  return values;
}

export function evaluateFigmaTarget(source: StyleflowProjectSource): FigmaTargetEvaluation {
  const reasons: string[] = [];
  const limit = source.settings.targets.figmaModeLimit;
  const toneIds = source.colors.intensityProfiles.map((item) => item.toneId);
  const intensity = intensityAxis(source);
  const intensityIds = intensity.items.map((item) => item.id);
  const roles = [...new Set(source.layout.recipes.map((item) => item.role))];
  const densities = [...new Set(source.layout.recipes.map((item) => item.density))];
  const breakpoints = source.layout.scales.breakpoints;

  pushModeReason(reasons, source.themes.length, limit, "THEME_MODE_LIMIT_EXCEEDED");
  pushModeReason(reasons, toneIds.length, limit, "TONE_MODE_LIMIT_EXCEEDED");
  pushModeReason(reasons, intensityIds.length, limit, "INTENSITY_MODE_LIMIT_EXCEEDED");
  pushModeReason(reasons, roles.length, limit, "LAYOUT_ROLE_MODE_LIMIT_EXCEEDED");
  pushModeReason(reasons, densities.length, limit, "DENSITY_MODE_LIMIT_EXCEEDED");
  pushModeReason(reasons, breakpoints.length, limit, "BREAKPOINT_MODE_LIMIT_EXCEEDED");

  if (intensity.conflict) reasons.push("INTENSITY_AXIS_ORDER_CONFLICT");

  const mappings = source.settings.targets.figmaFontMappings ?? {};
  const referencedSlotIds = new Set(source.typography.types.map((item) => item.fontSlotId));
  for (const slotId of referencedSlotIds) {
    const mapping = mappings[slotId];
    if (!mapping?.family.trim()) {
      reasons.push("FIGMA_FONT_MAPPING_MISSING");
      break;
    }
    if (source.typography.weights.some((weight) => !mapping.stylesByWeight[weight.id]?.trim())) {
      reasons.push("FIGMA_FONT_MAPPING_MISSING");
      break;
    }
  }

  const baseSize = source.typography.generator.baseSize;
  const layoutScaleEntries = [
    ...source.layout.scales.gap,
    ...source.layout.scales.paddingInline,
    ...source.layout.scales.paddingBlock,
    ...source.layout.scales.radius,
    ...source.layout.scales.stroke,
    ...source.layout.scales.containerWidth,
  ];
  if (layoutScaleEntries.some((entry) => cssLength(entry.value, baseSize) === undefined))
    reasons.push("FIGMA_VALUE_UNSUPPORTED");

  for (const recipe of source.typography.recipes) {
    const cases = effectiveTextCases(source, recipe);
    if (new Set(cases).size > 1) reasons.push("FIGMA_TEXT_CASE_RESPONSIVE_UNSUPPORTED");
    for (const values of Object.values(recipe.valuesByBreakpoint)) {
      if (
        ("value" in values.fontSize && fontSize(values.fontSize.value, baseSize) === undefined) ||
        ("value" in values.lineHeight &&
          lineHeight(values.lineHeight.value, baseSize) === undefined) ||
        ("value" in values.letterSpacing &&
          letterSpacing(values.letterSpacing.value, baseSize) === undefined)
      )
        reasons.push("FIGMA_VALUE_UNSUPPORTED");
    }
  }
  if (
    source.colors.interactions.recipes.some((recipe) =>
      INTERACTION_STATES.some((state) => {
        const ring = recipe.states[state].focusRing;
        return Boolean(
          ring &&
          (cssLength(ring.width, baseSize) === undefined ||
            cssLength(ring.offset, baseSize) === undefined),
        );
      }),
    )
  )
    reasons.push("FIGMA_VALUE_UNSUPPORTED");

  const unique = [...new Set(reasons)];
  return {
    status: unique.length === 0 ? "supported" : "unsupported",
    reasons: unique,
    diagnostics: diagnostic(unique),
  };
}

function tokenParts(reference: TokenReference): { toneId: string; intensityId: string } | null {
  const [, toneId, intensityId] = reference.split(".");
  return toneId && intensityId ? { toneId, intensityId } : null;
}

function themeColorPath(toneId: string, intensityId: string): string {
  return `theme/color/${toneId}/${intensityId}`;
}

function primitiveColorPath(toneId: string, position: string): string {
  return `primitive/color/${toneId}/${position}`;
}

function themePrimitiveValue(
  source: StyleflowProjectSource,
  compiled: CompiledProject,
  themeId: string,
  toneId: string,
  intensityId: string,
): FigmaProjectedValue {
  const reference = `color.${toneId}.${intensityId}` as TokenReference;
  const themes = new Map(source.themes.map((theme) => [theme.id, theme]));
  const visited = new Set<string>();
  let current = themes.get(themeId);
  while (current && !visited.has(current.id)) {
    visited.add(current.id);
    if (Object.hasOwn(current.tokenOverrides, reference)) {
      const resolved = compiled.themes.find((theme) => theme.id === themeId)?.tokens[reference];
      return color(resolved ?? current.tokenOverrides[reference]!);
    }
    current = current.parentId ? themes.get(current.parentId) : undefined;
  }
  const position = source.colors.intensityProfiles.find((profile) => profile.toneId === toneId)
    ?.mappingByTheme[themeId]?.[intensityId];
  return position ? alias(primitiveColorPath(toneId, position)) : unset();
}

function themeReferenceAlias(
  reference: TokenReference,
  intensityIds: ReadonlySet<string>,
): FigmaProjectedValue {
  const parts = tokenParts(reference);
  if (!parts) return unset();
  return alias(
    intensityIds.has(parts.intensityId)
      ? themeColorPath(parts.toneId, parts.intensityId)
      : primitiveColorPath(parts.toneId, parts.intensityId),
  );
}

function resolvedSurfaceReference(
  compiled: CompiledProject,
  themeId: string,
  toneId: string,
  intensityId: string,
  surfaceRole: SurfaceRole,
): TokenReference | null {
  const surface = compiled.themes
    .find((item) => item.id === themeId)
    ?.surfaces.find((item) => item.toneId === toneId && item.intensity === intensityId);
  return surface?.backgrounds[surfaceRole].reference ?? null;
}

function interactionKey(surfaceRole: string, priorityId: string, state: InteractionState): string {
  return `${surfaceRole}/${priorityId}/${state}`;
}

function addVariable(
  collection: FigmaCollectionSpec,
  path: string,
  type: FigmaVariableType,
  valuesByMode: Record<string, FigmaProjectedValue>,
): void {
  collection.variables.push(variable(collection.id, path, type, valuesByMode));
}

function filterBindingMap(
  bindings: Record<string, string>,
  materializedPaths: Set<string>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(bindings).filter(([, path]) => materializedPaths.has(path)),
  );
}

function materializeProjection(projection: FigmaProjection): FigmaProjection {
  const variables = new Map(
    projection.collections.flatMap((collection) =>
      collection.variables.map((item) => [item.path, item] as const),
    ),
  );
  const materializedPaths = new Set<string>();
  let changed = true;
  while (changed) {
    changed = false;
    for (const item of variables.values()) {
      if (materializedPaths.has(item.path)) continue;
      const materializes = Object.values(item.valuesByMode).some(
        (value) =>
          value.kind !== "unset" &&
          (value.kind !== "alias" || materializedPaths.has(value.variablePath)),
      );
      if (!materializes) continue;
      materializedPaths.add(item.path);
      changed = true;
    }
  }

  const rootPaths = new Set<string>([
    projection.bindings.color.background,
    ...Object.values(projection.bindings.color.foreground),
    ...Object.values(projection.bindings.color.border),
    ...Object.values(projection.bindings.color.surfaces),
    ...Object.values(projection.bindings.color.interactions).flatMap((item) => Object.values(item)),
    ...Object.values(projection.bindings.layout),
    ...projection.textStyles.flatMap((style) => Object.values(style.variablePaths)),
  ]);
  const reachablePaths = new Set<string>();
  const visit = (path: string): void => {
    if (reachablePaths.has(path) || !materializedPaths.has(path)) return;
    reachablePaths.add(path);
    for (const value of Object.values(variables.get(path)?.valuesByMode ?? {}))
      if (value.kind === "alias") visit(value.variablePath);
  };
  for (const path of rootPaths) visit(path);

  const collections = projection.collections
    .map((collection) => ({
      ...collection,
      variables: collection.variables
        .filter((item) => reachablePaths.has(item.path))
        .map((item) => ({
          ...item,
          valuesByMode: Object.fromEntries(
            Object.entries(item.valuesByMode).map(([modeId, value]) => [
              modeId,
              value.kind === "alias" && !reachablePaths.has(value.variablePath) ? unset() : value,
            ]),
          ),
        })),
    }))
    .filter((collection) => collection.variables.length > 0);
  const materializedCollectionIds = new Set(collections.map((collection) => collection.id));
  const modeCollections = Object.fromEntries(
    Object.entries(projection.modeCollections).map(([axis, collectionIds]) => [
      axis,
      collectionIds.filter((collectionId) => materializedCollectionIds.has(collectionId)),
    ]),
  ) as FigmaProjection["modeCollections"];
  for (const [axis, collectionIds] of Object.entries(modeCollections))
    if (collectionIds.length === 0)
      throw new Error(`Figma projection axis "${axis}" has no materialized collection.`);
  const modeIdsByCollection = Object.fromEntries(
    collections
      .filter((collection) =>
        Object.values(modeCollections).some((collectionIds) =>
          collectionIds.includes(collection.id),
        ),
      )
      .map((collection) => [collection.id, collection.modes.map((mode) => mode.id)]),
  );

  const interactions = Object.fromEntries(
    Object.entries(projection.bindings.color.interactions)
      .map(
        ([coordinate, bindings]) =>
          [coordinate, filterBindingMap(bindings, reachablePaths)] as const,
      )
      .filter(([, bindings]) => Object.keys(bindings).length > 0),
  );
  if (!reachablePaths.has(projection.bindings.color.background))
    throw new Error("Figma projection has no materialized background binding.");

  return {
    ...projection,
    collections,
    modeCollections,
    availability: {
      ...projection.availability,
      modeIdsByCollection,
    },
    bindings: {
      ...projection.bindings,
      color: {
        ...projection.bindings.color,
        foreground: filterBindingMap(projection.bindings.color.foreground, reachablePaths),
        border: filterBindingMap(projection.bindings.color.border, reachablePaths),
        surfaces: filterBindingMap(projection.bindings.color.surfaces, reachablePaths),
        interactions,
      },
      layout: filterBindingMap(projection.bindings.layout, reachablePaths),
    },
  };
}

function layoutValue(value: string, baseSize: number): FigmaProjectedValue {
  const parsed = cssLength(value, baseSize);
  return parsed === null ? unset() : float(parsed ?? Number.NaN);
}

function buildRawFigmaProjection(
  compiled: CompiledProject,
  identity: { sourceRevision: number; contentHash: string },
): FigmaProjection {
  const source = compiled.source;
  const toneItems = source.colors.ramps.map((item) => ({ id: item.id, label: item.label }));
  const intensityItems = intensityAxis(source).items;
  const intensityByTone = Object.fromEntries(
    toneItems.map((toneItem) => {
      const available = new Set(
        source.colors.intensityProfiles
          .find((profile) => profile.toneId === toneItem.id)
          ?.levels.map((item) => item.id) ?? [],
      );
      return [
        toneItem.id,
        intensityItems.map((item) => item.id).filter((intensityId) => available.has(intensityId)),
      ];
    }),
  );
  const roleItems = [...new Set(source.layout.recipes.map((item) => item.role))].map((id) => ({
    id,
    label: title(id),
  }));
  const densityItems = [...new Set(source.layout.recipes.map((item) => item.density))].map(
    (id) => ({ id, label: title(id) }),
  );
  const breakpointItems = [...source.layout.scales.breakpoints].sort(
    (left, right) => left.order - right.order,
  );
  const themeItems = source.themes.map((item) => ({ id: item.id, label: item.label }));
  const intensityIdSet = new Set(intensityItems.map((item) => item.id));

  const primitive: FigmaCollectionSpec = {
    ...COLLECTIONS.primitive,
    modes: [{ id: "default", name: "Default" }],
    variables: [],
  };
  const theme: FigmaCollectionSpec = {
    ...COLLECTIONS.theme,
    modes: modes(themeItems),
    variables: [],
  };
  const interactionThemeCollections = new Map<string, FigmaCollectionSpec>();
  const toneCollections: FigmaCollectionSpec[] = [];
  const toneCollectionByIntensity = new Map<string, FigmaCollectionSpec>();
  const toneCollectionBySignature = new Map<string, FigmaCollectionSpec>();
  for (const intensityItem of intensityItems) {
    const availableTones = toneItems.filter((toneItem) =>
      intensityByTone[toneItem.id]?.includes(intensityItem.id),
    );
    const signature = availableTones.map((toneItem) => toneItem.id).join("\u0000");
    let collection = toneCollectionBySignature.get(signature);
    if (!collection) {
      const sequence = toneCollections.length + 1;
      collection = {
        id: `tone-${sequence}`,
        name: `Styleflow / Tone / Availability ${sequence}`,
        modes: modes(availableTones),
        variables: [],
      };
      toneCollections.push(collection);
      toneCollectionBySignature.set(signature, collection);
    }
    toneCollectionByIntensity.set(intensityItem.id, collection);
  }
  const intensity: FigmaCollectionSpec = {
    ...COLLECTIONS.intensity,
    modes: modes(intensityItems),
    variables: [],
  };
  const breakpoint: FigmaCollectionSpec = {
    ...COLLECTIONS.breakpoint,
    modes: modes(breakpointItems),
    variables: [],
  };
  const density: FigmaCollectionSpec = {
    ...COLLECTIONS.density,
    modes: modes(densityItems),
    variables: [],
  };
  const layoutRole: FigmaCollectionSpec = {
    ...COLLECTIONS.layoutRole,
    modes: modes(roleItems),
    variables: [],
  };

  for (const ramp of source.colors.ramps) {
    const profile = source.colors.intensityProfiles.find((item) => item.toneId === ramp.id);
    const positions = new Set([
      ...ramp.stops.map((stop) => stop.position),
      ...Object.values(profile?.mappingByTheme ?? {}).flatMap((mapping) => Object.values(mapping)),
    ]);
    for (const position of [...positions].sort((left, right) => Number(left) - Number(right))) {
      const value = materializeIntermediateStop(ramp.stops, position);
      if (value)
        addVariable(primitive, primitiveColorPath(ramp.id, position), "COLOR", {
          default: color(value),
        });
    }
  }

  for (const coordinate of activeTokenCoordinates(source)) {
    const path = themeColorPath(coordinate.toneId, coordinate.intensityId);
    addVariable(
      theme,
      path,
      "COLOR",
      Object.fromEntries(
        compiled.themes.map((resolvedTheme) => {
          return [
            resolvedTheme.id,
            themePrimitiveValue(
              source,
              compiled,
              resolvedTheme.id,
              coordinate.toneId,
              coordinate.intensityId,
            ),
          ];
        }),
      ),
    );
  }

  const colorBindings = {
    background: "semantic/color/background",
    foreground: Object.fromEntries(
      FOREGROUND_ROLES.map((role) => [role, `semantic/on-color/foreground/${role}`]),
    ),
    border: Object.fromEntries(
      BORDER_ROLES.map((role) => [role, `semantic/on-color/border/${role}`]),
    ),
    surfaces: Object.fromEntries(SURFACE_ROLES.map((role) => [role, `semantic/surface/${role}`])),
    interactions: {} as Record<string, Record<string, string>>,
  };

  const colorChannels: Array<{
    suffix: string;
    type: FigmaVariableType;
    themeCollection: FigmaCollectionSpec;
    value: (themeId: string, toneId: string, intensityId: string) => FigmaProjectedValue;
  }> = [
    {
      suffix: "color/background",
      type: "COLOR",
      themeCollection: theme,
      value: (_themeId, toneId, intensityId) => alias(themeColorPath(toneId, intensityId)),
    },
    ...FOREGROUND_ROLES.map((role) => ({
      suffix: `on-color/foreground/${role}`,
      type: "COLOR" as const,
      themeCollection: theme,
      value: (themeId: string, toneId: string, intensityId: string) => {
        const contract = compiled.themes
          .find((item) => item.id === themeId)
          ?.onColors.find((item) => item.backgroundRef === `color.${toneId}.${intensityId}`);
        return contract
          ? themeReferenceAlias(contract.foreground[role].reference, intensityIdSet)
          : unset();
      },
    })),
    ...BORDER_ROLES.map((role) => ({
      suffix: `on-color/border/${role}`,
      type: "COLOR" as const,
      themeCollection: theme,
      value: (themeId: string, toneId: string, intensityId: string) => {
        const contract = compiled.themes
          .find((item) => item.id === themeId)
          ?.onColors.find((item) => item.backgroundRef === `color.${toneId}.${intensityId}`);
        return contract
          ? themeReferenceAlias(contract.border[role].reference, intensityIdSet)
          : unset();
      },
    })),
    ...SURFACE_ROLES.map((role) => ({
      suffix: `surface/${role}`,
      type: "COLOR" as const,
      themeCollection: theme,
      value: (themeId: string, toneId: string, intensityId: string) => {
        const reference = resolvedSurfaceReference(compiled, themeId, toneId, intensityId, role);
        return reference ? themeReferenceAlias(reference, intensityIdSet) : unset();
      },
    })),
  ];

  for (const surfaceRole of SURFACE_ROLES)
    for (const priority of source.colors.interactions.priorities)
      for (const state of INTERACTION_STATES) {
        const key = interactionKey(surfaceRole, priority.id, state);
        const propertyPaths = {
          background: `semantic/interaction/${key}/background`,
          foreground: `semantic/interaction/${key}/foreground`,
          border: `semantic/interaction/${key}/border`,
          controlOpacity: `semantic/interaction/${key}/control-opacity`,
          focusRing: `semantic/interaction/${key}/focus-ring`,
        };
        colorBindings.interactions[key] = propertyPaths;
        for (const [property, path] of Object.entries(propertyPaths)) {
          const isFloat = property.includes("Opacity");
          let interactionThemeCollection = interactionThemeCollections.get(property);
          if (!interactionThemeCollection) {
            interactionThemeCollection = {
              id: `theme-interaction-${kebab(property)}`,
              name: `Styleflow / Theme / Interaction / ${title(property)}`,
              modes: modes(themeItems),
              variables: [],
            };
            interactionThemeCollections.set(property, interactionThemeCollection);
          }
          colorChannels.push({
            suffix: path.replace(/^semantic\//, ""),
            type: isFloat ? "FLOAT" : "COLOR",
            themeCollection: interactionThemeCollection,
            value: (themeId, toneId, intensityId) => {
              const contextRef = resolvedSurfaceReference(
                compiled,
                themeId,
                toneId,
                intensityId,
                surfaceRole,
              );
              const interaction = compiled.themes
                .find((item) => item.id === themeId)
                ?.interactions.find(
                  (item) =>
                    item.contextBackgroundRef === contextRef && item.priorityId === priority.id,
                )?.states[state];
              if (!interaction) return unset();
              if (property === "background")
                return interaction.background
                  ? colorWithOpacity(interaction.background.value, interaction.background.opacity)
                  : unset();
              if (property === "foreground")
                return themeReferenceAlias(interaction.foreground.reference, intensityIdSet);
              if (property === "border")
                return interaction.border
                  ? themeReferenceAlias(interaction.border.reference, intensityIdSet)
                  : unset();
              if (property === "controlOpacity") return float(interaction.controlOpacity);
              if (property === "focusRing")
                return interaction.focusRing
                  ? themeReferenceAlias(interaction.focusRing.reference, intensityIdSet)
                  : unset();
              return unset();
            },
          });
        }
      }

  for (const channel of colorChannels) {
    for (const { toneId, intensityId } of activeTokenCoordinates(source)) {
      addVariable(
        channel.themeCollection,
        `theme/${channel.suffix}/${toneId}/${intensityId}`,
        channel.type,
        Object.fromEntries(
          themeItems.map((item) => [item.id, channel.value(item.id, toneId, intensityId)]),
        ),
      );
    }
    for (const intensityId of intensityItems.map((item) => item.id)) {
      const toneCollection = toneCollectionByIntensity.get(intensityId)!;
      addVariable(
        toneCollection,
        `tone/${channel.suffix}/${intensityId}`,
        channel.type,
        Object.fromEntries(
          toneCollection.modes.map((mode) => [
            mode.id,
            alias(`theme/${channel.suffix}/${mode.id}/${intensityId}`),
          ]),
        ),
      );
    }
    addVariable(
      intensity,
      `semantic/${channel.suffix}`,
      channel.type,
      Object.fromEntries(
        intensityItems.map((item) => [item.id, alias(`tone/${channel.suffix}/${item.id}`)]),
      ),
    );
  }

  const resolvedLayout = compiled.themes[0]?.layout.recipes ?? [];
  const baseSize = source.typography.generator.baseSize;
  for (const role of roleItems)
    for (const densityItem of densityItems) {
      const recipe = resolvedLayout.find(
        (item) => item.role === role.id && item.density === densityItem.id,
      );
      for (const property of LAYOUT_PROPERTIES) {
        const path = `breakpoint/layout/${role.id}/${densityItem.id}/${property}`;
        addVariable(
          breakpoint,
          path,
          "FLOAT",
          Object.fromEntries(
            breakpointItems.map((item) => [
              item.id,
              layoutValue(recipe?.valuesByBreakpoint[item.id]?.[property] ?? "none", baseSize),
            ]),
          ),
        );
      }
    }

  for (const role of roleItems)
    for (const property of LAYOUT_PROPERTIES)
      addVariable(
        density,
        `density/layout/${role.id}/${property}`,
        "FLOAT",
        Object.fromEntries(
          densityItems.map((item) => [
            item.id,
            alias(`breakpoint/layout/${role.id}/${item.id}/${property}`),
          ]),
        ),
      );
  for (const property of LAYOUT_PROPERTIES.filter((item) => item !== "containerMaxWidth"))
    addVariable(
      layoutRole,
      `semantic/layout/${property}`,
      "FLOAT",
      Object.fromEntries(
        roleItems.map((item) => [item.id, alias(`density/layout/${item.id}/${property}`)]),
      ),
    );

  const textStyles: FigmaTextStyleSpec[] = [];
  const typographyBindings: Record<string, string> = {};
  for (const token of compiled.themes[0]?.typography ?? []) {
    const typographyType = source.typography.types.find((item) => item.id === token.ty)!;
    const mapping = source.settings.targets.figmaFontMappings![typographyType.fontSlotId]!;
    const metricPaths = {
      fontSize: `breakpoint/typography/${token.id}/font-size`,
      lineHeight: `breakpoint/typography/${token.id}/line-height`,
      letterSpacing: `breakpoint/typography/${token.id}/letter-spacing`,
    };
    for (const [metric, path] of Object.entries(metricPaths))
      addVariable(
        breakpoint,
        path,
        "FLOAT",
        Object.fromEntries(
          breakpointItems.map((item) => {
            const values = token.valuesByBreakpoint[item.id]!;
            const result =
              metric === "fontSize"
                ? fontSize(values.fontSize, baseSize)
                : metric === "lineHeight"
                  ? lineHeight(values.lineHeight, baseSize)
                  : letterSpacing(values.letterSpacing, baseSize);
            return [item.id, float(result!)];
          }),
        ),
      );
    const styleId = `text-style/${token.id}`;
    textStyles.push({
      id: styleId,
      name: `Styleflow / ${title(token.ty)} / ${title(token.v)} / ${title(token.w)}`,
      fontFamily: mapping.family,
      fontStyle: mapping.stylesByWeight[token.w]!,
      textCase: token.valuesByBreakpoint[breakpointItems[0]!.id]!.textCase,
      variablePaths: metricPaths,
    });
    typographyBindings[token.id] = styleId;
  }

  return {
    formatVersion: FIGMA_PROJECTION_VERSION,
    project: structuredClone(source.project),
    sourceRevision: identity.sourceRevision,
    contentHash: identity.contentHash,
    axes: {
      theme: modes(themeItems),
      tone: modes(toneItems),
      intensity: modes(intensityItems),
      layoutRole: modes(roleItems),
      density: modes(densityItems),
      breakpoint: modes(breakpointItems),
    },
    modeCollections: {
      theme: [
        COLLECTIONS.theme.id,
        ...[...interactionThemeCollections.values()].map((item) => item.id),
      ],
      tone: toneCollections.map((collection) => collection.id),
      intensity: [COLLECTIONS.intensity.id],
      layoutRole: [COLLECTIONS.layoutRole.id],
      density: [COLLECTIONS.density.id],
      breakpoint: [COLLECTIONS.breakpoint.id],
    },
    availability: {
      intensityByTone,
      modeIdsByCollection: Object.fromEntries(
        [
          theme,
          ...interactionThemeCollections.values(),
          ...toneCollections,
          intensity,
          breakpoint,
          density,
          layoutRole,
        ].map((collection) => [collection.id, collection.modes.map((mode) => mode.id)]),
      ),
    },
    collections: [
      primitive,
      theme,
      ...interactionThemeCollections.values(),
      ...toneCollections,
      intensity,
      breakpoint,
      density,
      layoutRole,
    ],
    textStyles,
    bindings: {
      color: colorBindings,
      layout: Object.fromEntries(
        LAYOUT_PROPERTIES.map((property) => [
          property,
          property === "containerMaxWidth"
            ? "density/layout/container/containerMaxWidth"
            : `semantic/layout/${property}`,
        ]),
      ),
      typography: typographyBindings,
    },
    diagnostics: compiled.diagnostics.filter(
      (item) => item.blocking || item.target === "figma-vnext",
    ),
  };
}

export function buildFigmaProjection(
  compiled: CompiledProject,
  identity: { sourceRevision: number; contentHash: string },
): FigmaProjection {
  const evaluation = evaluateFigmaTarget(compiled.source);
  if (evaluation.status !== "supported")
    throw new Error(`Figma target is unsupported: ${evaluation.reasons.join(", ")}`);
  const projection = materializeProjection(buildRawFigmaProjection(compiled, identity));
  const sparse = projection.collections.flatMap((collection) =>
    collection.variables.flatMap((variable) =>
      Object.entries(variable.valuesByMode)
        .filter(([, value]) => value.kind === "unset")
        .map(([modeId]) => `${variable.path}/${modeId}`),
    ),
  );
  if (sparse.length > 0)
    throw new Error(
      `Figma projection contains ${sparse.length} unsupported sparse values; first: ${sparse[0]}.`,
    );
  return projection;
}
