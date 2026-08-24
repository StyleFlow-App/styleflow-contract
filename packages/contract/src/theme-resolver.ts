import { materializeIntermediateStop, renderOklchSource } from "./color";
import type {
  Diagnostic,
  IntensityProfile,
  RampPosition,
  StyleflowProjectSource,
  ThemeDefinition,
  TokenReference,
} from "./types";

export interface ThemeResolution {
  theme: ThemeDefinition;
  overrides: Record<string, string>;
  resolveToken: (reference: TokenReference) => string | null;
}

export interface ThemeGraphResult {
  resolutions: ThemeResolution[];
  diagnostics: Diagnostic[];
}

function structuralDiagnostic(
  code: string,
  path: string,
  message: string,
  themeIds: string[] = [],
  suggestion?: string,
): Diagnostic {
  return {
    code,
    severity: "error",
    blocking: true,
    path,
    themeIds,
    message,
    suggestion,
  };
}

function intensityPosition(
  profile: IntensityProfile,
  theme: ThemeDefinition,
  themes: Map<string, ThemeDefinition>,
  key: string,
): RampPosition | null {
  const visited = new Set<string>();
  let current: ThemeDefinition | undefined = theme;
  while (current && !visited.has(current.id)) {
    visited.add(current.id);
    const position = profile.mappingByTheme[current.id]?.[key];
    if (position) return position;
    current = current.parentId ? themes.get(current.parentId) : undefined;
  }
  return null;
}

export function resolveThemeGraph(source: StyleflowProjectSource): ThemeGraphResult {
  const diagnostics: Diagnostic[] = [];
  const themes = new Map(source.themes.map((theme) => [theme.id, theme]));
  const ramps = new Map(source.colors.ramps.map((ramp) => [ramp.id, ramp]));
  const profiles = new Map(
    source.colors.intensityProfiles.map((profile) => [profile.toneId, profile]),
  );
  const resolvedOverrides = new Map<string, Record<string, string>>();
  const visiting: string[] = [];

  function resolveOverrides(theme: ThemeDefinition): Record<string, string> | null {
    const cached = resolvedOverrides.get(theme.id);
    if (cached) return cached;

    const cycleStart = visiting.indexOf(theme.id);
    if (cycleStart !== -1) {
      const cycle = [...visiting.slice(cycleStart), theme.id];
      diagnostics.push(
        structuralDiagnostic(
          "SF_THEME_CYCLE",
          `/themes/${theme.id}/parentId`,
          `Theme inheritance contains a cycle: ${cycle.join(" -> ")}.`,
          cycle,
          "Choose a parent outside the theme's descendant chain.",
        ),
      );
      return null;
    }

    visiting.push(theme.id);
    let parentOverrides: Record<string, string> = {};
    if (theme.parentId) {
      const parent = themes.get(theme.parentId);
      if (!parent) {
        diagnostics.push(
          structuralDiagnostic(
            "SF_THEME_PARENT_MISSING",
            `/themes/${theme.id}/parentId`,
            `Theme "${theme.id}" references missing parent "${theme.parentId}".`,
            [theme.id],
            "Select an existing parent or remove the parent reference.",
          ),
        );
      } else {
        parentOverrides = resolveOverrides(parent) ?? {};
      }
    }

    visiting.pop();
    const merged = { ...parentOverrides, ...theme.tokenOverrides };
    resolvedOverrides.set(theme.id, merged);
    return merged;
  }

  const resolutions: ThemeResolution[] = source.themes.map((theme) => {
    const overrides = resolveOverrides(theme) ?? { ...theme.tokenOverrides };
    const resolveToken = (reference: TokenReference): string | null => {
      const overridden = overrides[reference];
      if (overridden) return overridden;

      const [, toneId, key] = reference.split(".");
      if (!toneId || !key) return null;
      const ramp = ramps.get(toneId);
      if (!ramp) return null;

      if (/^\d{3,4}$/.test(key)) {
        const exact = ramp.stops.find((stop) => stop.position === key);
        return exact
          ? renderOklchSource(exact.source).value
          : materializeIntermediateStop(ramp.stops, key as RampPosition);
      }

      const profile = profiles.get(toneId);
      if (!profile) return null;
      const position = intensityPosition(profile, theme, themes, key);
      if (!position) return null;
      const exact = ramp.stops.find((stop) => stop.position === position);
      return exact
        ? renderOklchSource(exact.source).value
        : materializeIntermediateStop(ramp.stops, position);
    };

    return { theme, overrides, resolveToken };
  });

  return { resolutions, diagnostics };
}
