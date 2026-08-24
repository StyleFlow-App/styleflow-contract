export const CONTRACT_PACKAGE_NAME = "@styleflow.app/contract" as const;
export const CONTRACT_VERSION = "1.0.0-beta.0" as const;
export const FORMAT_VERSION = "1.0.0" as const;
export const BUNDLE_VERSION = "1.0.0" as const;
export const OPERATION_PROTOCOL_VERSION = "1.0.0" as const;

export const ANCHOR_POSITIONS = [
  "000",
  "050",
  "100",
  "200",
  "300",
  "400",
  "500",
  "600",
  "700",
  "800",
  "900",
  "950",
  "1000",
] as const;
export const INTERMEDIATE_POSITIONS = [
  "150",
  "250",
  "350",
  "450",
  "550",
  "650",
  "750",
  "850",
] as const;
export const INTENSITY_PRESETS = [1, 3, 5, 7, 9] as const;
export const FOREGROUND_ROLES = ["primary", "secondary", "tertiary", "muted", "accent"] as const;
export const BORDER_ROLES = ["default", "soft", "strong"] as const;
export const SURFACE_ROLES = ["default", "raised", "sunken"] as const;
export const INTERACTION_STATES = [
  "default",
  "hover",
  "active",
  "focus-visible",
  "disabled",
] as const;
export const LAYOUT_ROLES = [
  "none",
  "control",
  "chip",
  "item",
  "stack",
  "tile",
  "panel",
  "section",
  "region",
  "container",
] as const;
export const DENSITIES = ["compact", "regular", "comfortable"] as const;
export const TYPOGRAPHY_TEXT_CASES = ["original", "uppercase", "lowercase", "title"] as const;
export const DEFAULT_INTERACTION_PRIORITIES = [
  { id: "primary", label: "Primary", order: 0, status: "active" },
  { id: "secondary", label: "Secondary", order: 1, status: "active" },
  { id: "tertiary", label: "Tertiary", order: 2, status: "active" },
] as const;
export const DEFAULT_BREAKPOINTS = [
  { id: "xs", label: "XS", minWidth: 0, order: 0, status: "active" },
  { id: "sm", label: "SM", minWidth: 640, order: 1, status: "active" },
  { id: "md", label: "MD", minWidth: 768, order: 2, status: "active" },
  { id: "lg", label: "LG", minWidth: 1024, order: 3, status: "active" },
  { id: "xl", label: "XL", minWidth: 1280, order: 4, status: "active" },
  { id: "2xl", label: "2XL", minWidth: 1536, order: 5, status: "active" },
] as const;

export type AnchorPosition = (typeof ANCHOR_POSITIONS)[number];
export type IntermediatePosition = (typeof INTERMEDIATE_POSITIONS)[number];
export type RampPosition = AnchorPosition | IntermediatePosition;
export type ForegroundRole = (typeof FOREGROUND_ROLES)[number];
export type BorderRole = (typeof BORDER_ROLES)[number];
export type SurfaceRole = (typeof SURFACE_ROLES)[number];
export type InteractionState = (typeof INTERACTION_STATES)[number];
export type LayoutRole = (typeof LAYOUT_ROLES)[number];
export type Density = (typeof DENSITIES)[number];
export type TypographyTextCase = (typeof TYPOGRAPHY_TEXT_CASES)[number];
export type AccessibilityLevel = "AA" | "AAA";
export type AccessibilityPolicy = "warning" | "block";
export type ThemePolarity = "light" | "dark" | "custom";
export type DiagnosticSeverity = "info" | "warning" | "error";
export type EntityStatus = "active" | "deprecated";
export type Provenance = "generated" | "parent" | "bulk" | "manual";
export type TokenReference = `color.${string}.${string}`;
export type CssLength = string;

export interface ProjectIdentity {
  id: string;
  slug: string;
  name: string;
  description?: string;
}
export interface AccessibilitySettings {
  level: AccessibilityLevel;
  policy: AccessibilityPolicy;
}
export interface TargetSettings {
  figmaModeLimit: number;
  styleflowCli: "vnext";
}
export interface AuthoringSettings {
  setupStatus: "incomplete" | "complete";
  defaultIntensityPreset: (typeof INTENSITY_PRESETS)[number];
}

export interface ThemeDefinition {
  id: string;
  label: string;
  parentId?: string;
  polarity: ThemePolarity;
  canvasToken: TokenReference;
  tokenOverrides: Record<string, string>;
  status: EntityStatus;
}

export interface OklchColorValue {
  colorSpace: "oklch";
  lightness: number;
  chroma: number;
  hue: number;
  alpha: number;
}

export interface AuthoredColorValue {
  value: string;
  source: OklchColorValue;
}
export interface RampStop extends AuthoredColorValue {
  position: RampPosition;
  generated?: boolean;
  overridden?: boolean;
}

export interface RampGeneratorSettings {
  algorithm: "styleflow-ramp-v2";
  mode: "perceived" | "linear";
  interpolation: "shorter-hue";
  gamutMapping: "css-oklch-local-minde-v1";
  basePosition: AnchorPosition;
  lightnessMin: number;
  lightnessMax: number;
  saturationAdjustment: number;
}

export interface ColorRamp {
  id: string;
  label: string;
  baseColor: AuthoredColorValue;
  generator: RampGeneratorSettings;
  stops: RampStop[];
  status: EntityStatus;
}

export interface IntensityLevelDefinition {
  id: string;
  label: string;
  order: number;
  status: EntityStatus;
}
export interface IntensityProfile {
  toneId: string;
  levels: IntensityLevelDefinition[];
  mappingByTheme: Record<string, Record<string, RampPosition>>;
}

export interface OnColorContract {
  backgroundRef: TokenReference;
  foreground: Record<ForegroundRole, TokenReference>;
  border: Record<BorderRole, TokenReference>;
  borderSoftDecorative: boolean;
  compositeOn?: TokenReference;
  provenance: Exclude<Provenance, "parent">;
}

export interface SurfaceRecipe {
  toneId: string;
  intensity: string;
  backgrounds: Record<SurfaceRole, TokenReference>;
}

export interface FocusRingRecipe {
  colorRef: TokenReference;
  width: CssLength;
  offset: CssLength;
}
export interface InteractionStateRecipe {
  backgroundRef: TokenReference;
  foregroundRole: ForegroundRole;
  borderRole: BorderRole;
  foregroundOverrideRef?: TokenReference;
  borderOverrideRef?: TokenReference;
  focusRing?: FocusRingRecipe;
  opacity?: number;
}

export interface InteractionPriorityDefinition {
  id: string;
  label: string;
  order: number;
  status: EntityStatus;
}
export interface InteractionDefaultRecipe {
  priorityId: string;
  states: Record<InteractionState, InteractionStateRecipe>;
}
export interface InteractionContextOverride {
  themeId: string;
  contextBackgroundRef: TokenReference;
  priorityId: string;
  state: InteractionState;
  values: Partial<InteractionStateRecipe>;
  provenance: Exclude<Provenance, "parent">;
}
export interface InteractionSettings {
  priorities: InteractionPriorityDefinition[];
  defaults: InteractionDefaultRecipe[];
  overrides: InteractionContextOverride[];
}

export interface BreakpointDefinition {
  id: string;
  label: string;
  minWidth: number;
  order: number;
  status: EntityStatus;
}
export interface ScaleEntry {
  id: string;
  label: string;
  value: CssLength;
  order: number;
  status: EntityStatus;
}
export type LayoutScaleName =
  "gap" | "paddingInline" | "paddingBlock" | "radius" | "stroke" | "containerWidth";
export interface LayoutScales {
  gap: ScaleEntry[];
  paddingInline: ScaleEntry[];
  paddingBlock: ScaleEntry[];
  radius: ScaleEntry[];
  stroke: ScaleEntry[];
  containerWidth: ScaleEntry[];
  breakpoints: BreakpointDefinition[];
}
export type LayoutValueReference = { scaleEntryId: string } | { inherit: true };
export interface LayoutRecipeBreakpointValues {
  gap: LayoutValueReference;
  paddingInline: LayoutValueReference;
  paddingBlock: LayoutValueReference;
  radius: LayoutValueReference;
  borderWidth: LayoutValueReference;
  containerMaxWidth: LayoutValueReference;
}
export type LayoutProperty = keyof LayoutRecipeBreakpointValues;
export interface LayoutRecipe {
  role: LayoutRole;
  density: Density;
  valuesByBreakpoint: Record<string, LayoutRecipeBreakpointValues>;
}

export interface TypographyWeightStyle {
  fontWeight: number;
  fontStyle: "normal" | "italic" | "oblique";
}
export interface TypographyFontSlot {
  id: string;
  label: string;
  familyStack: string[];
  status: EntityStatus;
}
export interface TypographyVariantDefinition {
  id: string;
  label: string;
  order: number;
  status: EntityStatus;
}
export interface TypographyTypeDefinition {
  id: string;
  label: string;
  group: string;
  fontSlotId: string;
  variants: TypographyVariantDefinition[];
  status: EntityStatus;
}
export interface TypographyWeightDefinition {
  id: string;
  label: string;
  order: number;
  stylesByFontSlot: Record<string, TypographyWeightStyle>;
  status: EntityStatus;
}
export type ResponsiveValue<T> = { value: T } | { inherit: true };
export interface TypographyRecipeBreakpointValues {
  fontSize: ResponsiveValue<CssLength>;
  lineHeight: ResponsiveValue<string>;
  letterSpacing: ResponsiveValue<CssLength>;
  textCase: ResponsiveValue<TypographyTextCase>;
}
export interface TypographyRecipe {
  tyId: string;
  variantId: string;
  weightId: string;
  valuesByBreakpoint: Record<string, TypographyRecipeBreakpointValues>;
  provenance: Exclude<Provenance, "parent">;
}
export interface TypographyGeneratorSettings {
  baseSize: number;
  minRatio: number;
  maxRatio: number;
  minViewport: number;
  maxViewport: number;
  lineHeightStrategy: "tight-display-relaxed-body" | "proportional";
}
export interface TypographySettings {
  generator: TypographyGeneratorSettings;
  fontSlots: TypographyFontSlot[];
  types: TypographyTypeDefinition[];
  weights: TypographyWeightDefinition[];
  recipes: TypographyRecipe[];
}

export interface AgentPolicy {
  disallowRawValues: boolean;
  allowedAxes: string[];
  prohibitedProperties: string[];
  defaults: {
    layoutRole: LayoutRole;
    density: Density;
    typography: { ty: string; v: string; w: string };
  };
}

export interface StyleflowProjectSource {
  formatVersion: typeof FORMAT_VERSION;
  project: ProjectIdentity;
  settings: {
    accessibility: AccessibilitySettings;
    targets: TargetSettings;
    authoring: AuthoringSettings;
  };
  themes: ThemeDefinition[];
  colors: {
    ramps: ColorRamp[];
    intensityProfiles: IntensityProfile[];
    onColors: OnColorContract[];
    surfaces: SurfaceRecipe[];
    interactions: InteractionSettings;
  };
  layout: { scales: LayoutScales; recipes: LayoutRecipe[] };
  typography: TypographySettings;
  agentPolicy: AgentPolicy;
}

export interface Diagnostic {
  code: string;
  severity: DiagnosticSeverity;
  blocking: boolean;
  path: string;
  themeIds: string[];
  message: string;
  suggestion?: string;
  standardRef?: string;
  target?: string;
}

export interface ResolvedOnColor {
  backgroundRef: TokenReference;
  background: string;
  foreground: Record<ForegroundRole, { reference: TokenReference; value: string; ratio: number }>;
  border: Record<BorderRole, { reference: TokenReference; value: string; ratio: number }>;
  borderSoftDecorative: boolean;
  provenance: OnColorContract["provenance"];
}
export interface ResolvedSurface {
  toneId: string;
  intensity: string;
  backgrounds: Record<SurfaceRole, { reference: TokenReference; value: string }>;
}
export interface ResolvedInteractionState {
  background: { reference: TokenReference; value: string };
  contextBackground: { reference: TokenReference; value: string };
  foreground: { reference: TokenReference; value: string; role: ForegroundRole; ratio: number };
  border: {
    reference: TokenReference;
    value: string;
    role: BorderRole;
    ratio: number;
    contextRatio: number;
  };
  backgroundContextRatio: number;
  focusRing?: {
    reference: TokenReference;
    value: string;
    width: CssLength;
    offset: CssLength;
    controlRatio: number;
    contextRatio: number;
  };
  opacity?: number;
  provenance: Provenance;
}
export interface ResolvedInteraction {
  themeId: string;
  contextBackgroundRef: TokenReference;
  priorityId: string;
  states: Record<InteractionState, ResolvedInteractionState>;
}
export interface ResolvedLayoutRecipe {
  role: LayoutRole;
  density: Density;
  valuesByBreakpoint: Record<string, Record<LayoutProperty, CssLength>>;
}
export interface TypographyToken {
  id: string;
  ty: string;
  v: string;
  w: string;
  fontFamily: string;
  fontStyle: TypographyWeightStyle["fontStyle"];
  fontWeight: number;
  valuesByBreakpoint: Record<
    string,
    {
      fontSize: CssLength;
      lineHeight: string;
      letterSpacing: CssLength;
      textCase: TypographyTextCase;
    }
  >;
  provenance: Provenance;
}
export interface ResolvedTheme {
  id: string;
  label: string;
  polarity: ThemePolarity;
  parentId?: string;
  tokens: Record<string, string>;
  onColors: ResolvedOnColor[];
  surfaces: ResolvedSurface[];
  interactions: ResolvedInteraction[];
  layout: { scales: LayoutScales; recipes: ResolvedLayoutRecipe[] };
  typography: TypographyToken[];
  diagnostics: Diagnostic[];
}

export type TargetStatus =
  "supported" | "supported-with-warnings" | "unsupported" | "not-evaluated";
export interface TargetResult {
  status: TargetStatus;
  reasons: string[];
}

export interface StyleflowSemanticContract {
  formatVersion: typeof FORMAT_VERSION;
  project: ProjectIdentity;
  themes: string[];
  axes: {
    color: {
      tones: string[];
      intensitiesByTone: Record<string, string[]>;
      surfaces: SurfaceRole[];
      foregrounds: ForegroundRole[];
    };
    layout: {
      roles: LayoutRole[];
      densities: Density[];
      breakpoints: Array<{ id: string; minWidth: number }>;
    };
    typography: {
      types: string[];
      variantsByType: Record<string, string[]>;
      weights: string[];
    };
    interaction: {
      priorities: string[];
      states: InteractionState[];
    };
  };
  capabilities: CompiledProject["capabilities"];
  agentPolicy: AgentPolicy;
}

export interface StyleflowResolvedThemeContract extends StyleflowSemanticContract {
  activeTheme: string;
  resolved: {
    tokens: Record<string, string>;
    onColors: ResolvedOnColor[];
    surfaces: ResolvedSurface[];
    interactions: ResolvedInteraction[];
    layout: ResolvedTheme["layout"];
    typography: TypographyToken[];
  };
}

export interface DtcgTokenDocument {
  [key: string]: unknown;
}

export interface CompiledProject {
  source: StyleflowProjectSource;
  themes: ResolvedTheme[];
  diagnostics: Diagnostic[];
  agentContract: {
    axes: StyleflowSemanticContract["axes"];
    examples: string[];
    prohibitedProperties: string[];
  };
  capabilities: {
    themeCount: number;
    maxIntensityCount: number;
    customThemes: boolean;
    asymmetricIntensity: boolean;
    contextualInteractions: boolean;
    fluidTypography: boolean;
    breakpointCount: number;
    typographyTokenCount: number;
  };
  targets: {
    "styleflow-cli-vnext": TargetResult;
    "styleflow-cli-0.3": TargetResult;
    "figma-vnext": TargetResult;
  };
}

export type OnColorRolePath =
  { group: "foreground"; role: ForegroundRole } | { group: "border"; role: BorderRole };
export interface LayoutCellEdit {
  role: LayoutRole;
  density: Density;
  breakpointId: string;
  property: LayoutProperty;
  value: LayoutValueReference;
}

export type DraftOperation =
  | { type: "replace-source"; source: StyleflowProjectSource; reason: "import" | "restore" }
  | { type: "set-project-metadata"; name: string; description?: string }
  | { type: "set-accessibility"; level: AccessibilityLevel; policy: AccessibilityPolicy }
  | { type: "set-authoring-status"; status: AuthoringSettings["setupStatus"] }
  | { type: "create-color-ramp"; ramp: ColorRamp }
  | {
      type: "update-color-ramp";
      toneId: string;
      patch: Partial<Pick<ColorRamp, "label" | "baseColor" | "generator" | "status">>;
      regenerate: boolean;
    }
  | { type: "delete-color-ramp"; toneId: string; replacementToneId?: string }
  | { type: "set-ramp-stop"; toneId: string; stop: RampStop }
  | { type: "reset-ramp-stop"; toneId: string; position: RampPosition }
  | { type: "upsert-intensity-level"; toneId: string; level: IntensityLevelDefinition }
  | { type: "delete-intensity-level"; toneId: string; levelId: string; replacementLevelId?: string }
  | {
      type: "set-intensity-mapping";
      toneId: string;
      themeId: string;
      levelId: string;
      position: RampPosition;
    }
  | { type: "upsert-theme"; theme: ThemeDefinition }
  | { type: "delete-theme"; themeId: string; reparentChildrenTo?: string }
  | {
      type: "set-on-color";
      backgroundRefs: TokenReference[];
      target: OnColorRolePath;
      tokenRef: TokenReference;
      provenance: OnColorContract["provenance"];
    }
  | { type: "auto-solve-on-color"; backgroundRefs: TokenReference[]; target: OnColorRolePath }
  | {
      type: "relative-on-color";
      backgroundRefs: TokenReference[];
      target: OnColorRolePath;
      offset: number;
      toneId?: string;
    }
  | {
      type: "interpolate-on-color";
      backgroundRefs: TokenReference[];
      target: OnColorRolePath;
      startRef: TokenReference;
      endRef: TokenReference;
    }
  | {
      type: "copy-on-color-roles";
      sourceBackgroundRef: TokenReference;
      backgroundRefs: TokenReference[];
      groups: Array<"foreground" | "border">;
    }
  | { type: "reset-on-color"; backgroundRefs: TokenReference[] }
  | { type: "set-theme-override"; themeId: string; tokenRef: TokenReference; value: string | null }
  | { type: "set-surface-recipe"; recipe: SurfaceRecipe }
  | {
      type: "upsert-interaction-priority";
      priority: InteractionPriorityDefinition;
      defaultRecipe?: InteractionDefaultRecipe;
    }
  | { type: "delete-interaction-priority"; priorityId: string; replacementPriorityId?: string }
  | {
      type: "set-interaction-default";
      priorityId: string;
      state: InteractionState;
      recipe: InteractionStateRecipe;
    }
  | { type: "set-interaction-override"; override: InteractionContextOverride }
  | {
      type: "delete-interaction-override";
      themeId: string;
      contextBackgroundRef: TokenReference;
      priorityId: string;
      state: InteractionState;
    }
  | { type: "upsert-layout-scale-entry"; scale: LayoutScaleName; entry: ScaleEntry }
  | {
      type: "delete-layout-scale-entry";
      scale: LayoutScaleName;
      entryId: string;
      replacementEntryId?: string;
    }
  | { type: "upsert-breakpoint"; breakpoint: BreakpointDefinition }
  | { type: "delete-breakpoint"; breakpointId: string }
  | { type: "set-layout-cell"; edit: LayoutCellEdit }
  | { type: "bulk-set-layout-cells"; edits: LayoutCellEdit[] }
  | { type: "upsert-font-slot"; fontSlot: TypographyFontSlot }
  | { type: "delete-font-slot"; fontSlotId: string; replacementFontSlotId?: string }
  | { type: "upsert-typography-type"; typographyType: TypographyTypeDefinition }
  | { type: "delete-typography-type"; typeId: string; replacementTypeId?: string }
  | { type: "upsert-typography-variant"; typeId: string; variant: TypographyVariantDefinition }
  | {
      type: "delete-typography-variant";
      typeId: string;
      variantId: string;
      replacementVariantId?: string;
    }
  | { type: "upsert-typography-weight"; weight: TypographyWeightDefinition }
  | { type: "delete-typography-weight"; weightId: string; replacementWeightId?: string }
  | {
      type: "set-typography-generator";
      generator: TypographyGeneratorSettings;
      generatedRecipes: TypographyRecipe[];
    }
  | { type: "set-typography-recipe"; recipe: TypographyRecipe }
  | { type: "set-agent-policy"; policy: AgentPolicy };

export interface DraftOperationEnvelope {
  protocolVersion: typeof OPERATION_PROTOCOL_VERSION;
  expectedRevision: number;
  operationId: string;
  operations: DraftOperation[];
}
export interface DraftSnapshot {
  projectId: string;
  organizationId: string;
  revision: number;
  updatedAt: string;
  source: StyleflowProjectSource;
}
