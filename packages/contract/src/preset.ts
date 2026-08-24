import { closestRampPosition, generateColorRamp, oklchSourceFromHex } from "./color";
import type {
  ColorRamp,
  Density,
  InteractionDefaultRecipe,
  IntensityProfile,
  LayoutRecipe,
  LayoutRecipeBreakpointValues,
  LayoutRole,
  OnColorContract,
  ScaleEntry,
  StyleflowProjectSource,
  TokenReference,
  TypographyRecipe,
  TypographyRecipeBreakpointValues,
} from "./types";
import {
  ANCHOR_POSITIONS,
  DEFAULT_BREAKPOINTS,
  DEFAULT_INTERACTION_PRIORITIES,
  DENSITIES,
  INTERACTION_STATES,
  LAYOUT_ROLES,
} from "./types";

const INTENSITIES = [
  { id: "soft-2", label: "Soft 2", order: 0, status: "active" },
  { id: "soft-1", label: "Soft 1", order: 1, status: "active" },
  { id: "base", label: "Base", order: 2, status: "active" },
  { id: "strong-1", label: "Strong 1", order: 3, status: "active" },
  { id: "strong-2", label: "Strong 2", order: 4, status: "active" },
] as const;

function ramp(id: string, label: string, values: string[]): ColorRamp {
  const authoredStops = ANCHOR_POSITIONS.map((position, index) => {
    const value = values[index] ?? "#000000";
    return { position, value, source: oklchSourceFromHex(value), generated: true };
  });
  const base = authoredStops.find((stop) => stop.position === "500") ?? authoredStops[0]!;
  const baseColor = { value: base.value, source: structuredClone(base.source) };
  const generatorInput = {
    algorithm: "styleflow-ramp-v2",
    mode: "perceived",
    interpolation: "shorter-hue",
    gamutMapping: "css-oklch-local-minde-v1",
    lightnessMin: 0,
    lightnessMax: 1,
    saturationAdjustment: 0,
  } satisfies Omit<ColorRamp["generator"], "basePosition">;
  const generator: ColorRamp["generator"] = {
    ...generatorInput,
    basePosition: closestRampPosition(baseColor, generatorInput),
  };
  const generated = generateColorRamp(baseColor, generator);
  return {
    id,
    label,
    baseColor,
    generator,
    stops: generated.stops,
    status: "active",
  };
}

function defaultProfile(ramp: ColorRamp): IntensityProfile {
  const mappings = (dark: boolean) => {
    const base = Number(ramp.generator.basePosition);
    const position = (direction: number, distance: number) => {
      const candidates = [...ANCHOR_POSITIONS]
        .filter((item) => (Number(item) - base) * direction > 0)
        .sort((left, right) => Math.abs(Number(left) - base) - Math.abs(Number(right) - base));
      return (
        candidates[Math.min(distance - 1, Math.max(0, candidates.length - 1))] ??
        ramp.generator.basePosition
      );
    };
    const softDirection = dark ? 1 : -1;
    return {
      "soft-2": position(softDirection, 2),
      "soft-1": position(softDirection, 1),
      base: ramp.generator.basePosition,
      "strong-1": position(-softDirection, 1),
      "strong-2": position(-softDirection, 2),
    };
  };
  return {
    toneId: ramp.id,
    levels: INTENSITIES.map((level) => ({ ...level })),
    mappingByTheme: {
      light: mappings(false),
      dark: mappings(true),
      "high-contrast": mappings(true),
    },
  };
}

function semantic(tone: string, intensity: string): TokenReference {
  return `color.${tone}.${intensity}` as TokenReference;
}

function onColor(backgroundRef: TokenReference, darkBackground: boolean): OnColorContract {
  const foregroundTone = darkBackground ? "soft" : "strong";
  const backgroundTone = backgroundRef.split(".")[1] ?? "main";
  return {
    backgroundRef,
    foreground: {
      primary: semantic("neutral", `${foregroundTone}-2`),
      secondary: semantic("neutral", `${foregroundTone}-1`),
      tertiary: semantic("neutral", `${foregroundTone}-1`),
      muted: semantic("neutral", `${foregroundTone}-1`),
      accent: semantic(darkBackground ? "accent" : "main", `${foregroundTone}-1`),
    },
    border: {
      default: semantic(backgroundTone, darkBackground ? "soft-1" : "strong-1"),
      soft: semantic(backgroundTone, darkBackground ? "soft-2" : "base"),
      strong: semantic(backgroundTone, "strong-2"),
    },
    borderSoftDecorative: true,
    provenance: "generated",
  };
}

function interaction(priorityId: string, tone: string): InteractionDefaultRecipe {
  const role = priorityId === "primary" ? "primary" : "accent";
  return {
    priorityId,
    states: {
      default: {
        backgroundRef: semantic(tone, priorityId === "primary" ? "base" : "soft-2"),
        foregroundRole: role,
        borderRole: "default",
      },
      hover: {
        backgroundRef: semantic(tone, priorityId === "primary" ? "strong-1" : "soft-1"),
        foregroundRole: role,
        borderRole: "strong",
      },
      active: {
        backgroundRef: semantic(tone, "strong-2"),
        foregroundRole: "primary",
        borderRole: "strong",
      },
      "focus-visible": {
        backgroundRef: semantic(tone, priorityId === "primary" ? "base" : "soft-2"),
        foregroundRole: role,
        borderRole: "strong",
        focusRing: { colorRef: semantic("accent", "strong-1"), width: "2px", offset: "2px" },
      },
      disabled: {
        backgroundRef: semantic("neutral", "soft-1"),
        foregroundRole: "muted",
        borderRole: "soft",
        opacity: 0.62,
      },
    },
  };
}

function scale(values: Record<string, string>): ScaleEntry[] {
  return Object.entries(values).map(([id, value], order) => ({
    id,
    label: id,
    value,
    order,
    status: "active",
  }));
}

function concrete(scaleEntryId: string) {
  return { scaleEntryId };
}
function inherited() {
  return { inherit: true } as const;
}

function layoutBase(role: LayoutRole, density: Density): LayoutRecipeBreakpointValues {
  const densityIndex = DENSITIES.indexOf(density);
  const spacious = ["section", "region", "container"].includes(role);
  return {
    gap: concrete(spacious ? ["md", "lg", "xl"][densityIndex]! : ["xs", "sm", "md"][densityIndex]!),
    paddingInline: concrete(
      spacious ? ["lg", "xl", "2xl"][densityIndex]! : ["xs", "sm", "md"][densityIndex]!,
    ),
    paddingBlock: concrete(
      spacious ? ["lg", "xl", "2xl"][densityIndex]! : ["2xs", "xs", "sm"][densityIndex]!,
    ),
    radius: concrete(role === "chip" ? "pill" : role === "none" ? "none" : spacious ? "lg" : "md"),
    borderWidth: concrete(role === "none" ? "none" : "hairline"),
    containerMaxWidth: concrete(role === "container" ? "content" : "none"),
  };
}

function layoutRecipe(role: LayoutRole, density: Density): LayoutRecipe {
  return {
    role,
    density,
    valuesByBreakpoint: Object.fromEntries(
      DEFAULT_BREAKPOINTS.map((breakpoint, index) => [
        breakpoint.id,
        index === 0
          ? layoutBase(role, density)
          : {
              gap: inherited(),
              paddingInline: inherited(),
              paddingBlock: inherited(),
              radius: inherited(),
              borderWidth: inherited(),
              containerMaxWidth: inherited(),
            },
      ]),
    ),
  };
}

function typographyValues(
  size: number,
  group: string,
  breakpointIndex: number,
): TypographyRecipeBreakpointValues {
  const responsiveSize = Math.round(size * (1 + breakpointIndex * 0.035) * 100) / 100;
  const lineHeight = group === "display" ? 1.1 : group === "code" ? 1.55 : 1.5;
  return {
    fontSize: { value: `${responsiveSize / 16}rem` },
    lineHeight: { value: String(lineHeight) },
    letterSpacing: {
      value: group === "display" ? "-0.025em" : group === "label" ? "0.01em" : "0em",
    },
    textCase: { value: "original" },
  };
}

function typographyRecipe(
  tyId: string,
  variantId: string,
  weightId: string,
  size: number,
  group: string,
): TypographyRecipe {
  return {
    tyId,
    variantId,
    weightId,
    valuesByBreakpoint: Object.fromEntries(
      DEFAULT_BREAKPOINTS.map((breakpoint, index) => [
        breakpoint.id,
        index === 0 || group === "display"
          ? typographyValues(size, group, index)
          : {
              fontSize: inherited(),
              lineHeight: inherited(),
              letterSpacing: inherited(),
              textCase: inherited(),
            },
      ]),
    ),
    provenance: "generated",
  };
}

export function createPresetSource(): StyleflowProjectSource {
  const ramps = [
    ramp("main", "Cobalt", [
      "#f7f9ff",
      "#eef3ff",
      "#dfe8ff",
      "#c3d3ff",
      "#9bb5ff",
      "#7193ff",
      "#4f72fa",
      "#315bf5",
      "#2347d8",
      "#203bad",
      "#213787",
      "#172252",
      "#0c122b",
    ]),
    ramp("accent", "Verdigris", [
      "#f1fffb",
      "#e5fbf5",
      "#c9f5e9",
      "#9cebd7",
      "#66d9c1",
      "#36bea5",
      "#1ba088",
      "#12816e",
      "#106759",
      "#115247",
      "#103f38",
      "#092c28",
      "#061d1b",
    ]),
    ramp("neutral", "Graphite", [
      "#ffffff",
      "#f5f7fa",
      "#e8ecf2",
      "#d3d9e3",
      "#b4bdcb",
      "#8e99aa",
      "#6d788a",
      "#505b6e",
      "#3b4558",
      "#2b3445",
      "#202737",
      "#171d2a",
      "#0c111c",
    ]),
    ramp("critical", "Coral", [
      "#fff9f7",
      "#fff0ec",
      "#ffe0d9",
      "#ffc5b9",
      "#f99d8b",
      "#ee7662",
      "#d95a45",
      "#bb4230",
      "#963323",
      "#76291e",
      "#5c211a",
      "#3d1713",
      "#260e0c",
    ]),
  ];
  const types = [
    {
      id: "body",
      label: "Body",
      group: "body",
      fontSlotId: "main",
      sizes: [
        ["sm", 14],
        ["md", 16],
        ["lg", 18],
      ] as const,
    },
    {
      id: "heading",
      label: "Heading",
      group: "display",
      fontSlotId: "display",
      sizes: [
        ["1", 48],
        ["2", 36],
        ["3", 28],
      ] as const,
    },
    {
      id: "label",
      label: "Label",
      group: "label",
      fontSlotId: "main",
      sizes: [
        ["sm", 12],
        ["md", 14],
      ] as const,
    },
    {
      id: "code",
      label: "Code",
      group: "code",
      fontSlotId: "mono",
      sizes: [
        ["sm", 13],
        ["md", 15],
      ] as const,
    },
  ];
  const weights = [
    { id: "light", label: "Light", order: 0, fontWeight: 350 },
    { id: "default", label: "Default", order: 1, fontWeight: 500 },
    { id: "strong", label: "Strong", order: 2, fontWeight: 700 },
  ];
  const typographyRecipes = types.flatMap((type) =>
    type.sizes.flatMap(([variantId, size]) =>
      weights.map((weight) => typographyRecipe(type.id, variantId, weight.id, size, type.group)),
    ),
  );

  return {
    formatVersion: "1.0.0",
    project: {
      id: "styleflow-foundation",
      slug: "styleflow-foundation",
      name: "Styleflow Foundation",
      description: "A semantic design system authored in Styleflow Studio.",
    },
    settings: {
      accessibility: { level: "AA", policy: "warning" },
      targets: { figmaModeLimit: 10, styleflowCli: "vnext" },
      authoring: { setupStatus: "complete", defaultIntensityPreset: 5 },
    },
    themes: [
      {
        id: "light",
        label: "Light",
        polarity: "light",
        canvasToken: semantic("neutral", "soft-2"),
        tokenOverrides: {},
        status: "active",
      },
      {
        id: "dark",
        label: "Dark",
        polarity: "dark",
        canvasToken: semantic("neutral", "soft-2"),
        tokenOverrides: {},
        status: "active",
      },
      {
        id: "high-contrast",
        label: "High contrast",
        parentId: "dark",
        polarity: "custom",
        canvasToken: semantic("neutral", "soft-2"),
        tokenOverrides: { "color.main.600": "#4f72ff" },
        status: "active",
      },
    ],
    colors: {
      ramps,
      intensityProfiles: ramps.map(defaultProfile),
      onColors: ramps.flatMap((item) =>
        INTENSITIES.map((level, index) => onColor(semantic(item.id, level.id), index >= 2)),
      ),
      surfaces: ramps.flatMap((item) =>
        INTENSITIES.map((level) => ({
          toneId: item.id,
          intensity: level.id,
          backgrounds: {
            default: semantic(item.id, level.id),
            raised: semantic(
              item.id,
              level.order === 0 ? level.id : INTENSITIES[level.order - 1]!.id,
            ),
            sunken: semantic(
              item.id,
              level.order === INTENSITIES.length - 1 ? level.id : INTENSITIES[level.order + 1]!.id,
            ),
          },
        })),
      ),
      interactions: {
        priorities: DEFAULT_INTERACTION_PRIORITIES.map((item) => ({ ...item })),
        defaults: [
          interaction("primary", "main"),
          interaction("secondary", "main"),
          interaction("tertiary", "accent"),
        ],
        overrides: [],
      },
    },
    layout: {
      scales: {
        gap: scale({
          none: "0",
          "2xs": "0.25rem",
          xs: "0.5rem",
          sm: "0.75rem",
          md: "1rem",
          lg: "1.5rem",
          xl: "2rem",
        }),
        paddingInline: scale({
          none: "0",
          "2xs": "0.25rem",
          xs: "0.5rem",
          sm: "0.75rem",
          md: "1rem",
          lg: "1.5rem",
          xl: "2rem",
          "2xl": "3rem",
        }),
        paddingBlock: scale({
          none: "0",
          "2xs": "0.25rem",
          xs: "0.5rem",
          sm: "0.75rem",
          md: "1rem",
          lg: "1.5rem",
          xl: "2rem",
          "2xl": "3rem",
        }),
        radius: scale({ none: "0", sm: "0.375rem", md: "0.625rem", lg: "0.875rem", pill: "999px" }),
        stroke: scale({ none: "0", hairline: "1px", strong: "2px" }),
        containerWidth: scale({ none: "none", reading: "44rem", content: "72rem", wide: "90rem" }),
        breakpoints: DEFAULT_BREAKPOINTS.map((item) => ({ ...item })),
      },
      recipes: LAYOUT_ROLES.flatMap((role) =>
        DENSITIES.map((density) => layoutRecipe(role, density)),
      ),
    },
    typography: {
      generator: {
        baseSize: 16,
        minRatio: 1.125,
        maxRatio: 1.25,
        minViewport: 360,
        maxViewport: 1440,
        lineHeightStrategy: "tight-display-relaxed-body",
      },
      fontSlots: [
        {
          id: "main",
          label: "Main",
          familyStack: ["Manrope Variable", "sans-serif"],
          status: "active",
        },
        {
          id: "display",
          label: "Display",
          familyStack: ["Bricolage Grotesque Variable", "sans-serif"],
          status: "active",
        },
        {
          id: "mono",
          label: "Mono",
          familyStack: ["JetBrains Mono Variable", "monospace"],
          status: "active",
        },
      ],
      types: types.map((type) => ({
        id: type.id,
        label: type.label,
        group: type.group,
        fontSlotId: type.fontSlotId,
        status: "active",
        variants: type.sizes.map(([id], order) => ({
          id,
          label: id.toUpperCase(),
          order,
          status: "active",
        })),
      })),
      weights: weights.map((weight) => ({
        id: weight.id,
        label: weight.label,
        order: weight.order,
        status: "active",
        stylesByFontSlot: Object.fromEntries(
          ["main", "display", "mono"].map((slotId) => [
            slotId,
            { fontWeight: weight.fontWeight, fontStyle: "normal" },
          ]),
        ),
      })),
      recipes: typographyRecipes,
    },
    agentPolicy: {
      disallowRawValues: true,
      allowedAxes: [
        "tone",
        "intensity",
        "surface",
        "foreground",
        "layoutRole",
        "density",
        "ty",
        "v",
        "w",
        "interactivePriority",
        "contextBackground",
      ],
      prohibitedProperties: [
        "background",
        "color",
        "border-color",
        "padding",
        "gap",
        "border-radius",
        "font-family",
        "font-size",
        "font-weight",
        "line-height",
      ],
      defaults: {
        layoutRole: "none",
        density: "regular",
        typography: { ty: "body", v: "md", w: "default" },
      },
    },
  };
}

export { INTENSITIES as DEFAULT_INTENSITY_LEVELS };
