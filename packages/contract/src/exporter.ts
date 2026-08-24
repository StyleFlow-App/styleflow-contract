import { bytesToHex } from "@noble/hashes/utils.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { strToU8, zipSync, type Zippable } from "fflate";

import contractSchema from "../schemas/contract.schema.json";
import diagnosticsSchema from "../schemas/diagnostics.schema.json";
import manifestSchema from "../schemas/manifest.schema.json";
import projectSchema from "../schemas/project.schema.json";
import resolverSchema from "../schemas/resolver.schema.json";
import tokensSchema from "../schemas/tokens.schema.json";
import { compileProject } from "./compiler";
import { parseHexColor } from "./color";
import {
  BUNDLE_VERSION,
  CONTRACT_PACKAGE_NAME,
  CONTRACT_VERSION,
  type CompiledProject,
  type DtcgTokenDocument,
  type Diagnostic,
  type StyleflowResolvedThemeContract,
  type StyleflowSemanticContract,
  type StyleflowProjectSource,
} from "./types";
import {
  validateBundleManifest,
  validateDiagnostics,
  validateDtcgTokens,
  validateProjectSource,
  validateResolverProjection,
  validateSemanticContract,
  type ValidationResult,
} from "./validator";

const encoder = new TextEncoder();
const FIXED_ZIP_DATE = new Date("1980-01-01T00:00:00.000Z");
const JSON_MEDIA_TYPE = "application/json";

export interface BundleFileEntry {
  path: string;
  mediaType: string;
  bytes: number;
  sha256: string;
}

export interface BundleManifest {
  mediaType: "application/vnd.styleflow.bundle+zip";
  bundleVersion: typeof BUNDLE_VERSION;
  kind: "preview" | "release";
  project: StyleflowProjectSource["project"];
  preview?: { sourceRevision: number; contentHash: string };
  release?: { version: string; sourceRevision: number; contentHash: string };
  compiler: { name: typeof CONTRACT_PACKAGE_NAME; version: typeof CONTRACT_VERSION };
  themes: string[];
  accessibility: {
    configuredLevel: "AA" | "AAA";
    configuredPolicy: "warning" | "block";
    status: "passes" | "passes-with-warnings" | "blocked";
    violations: number;
  };
  capabilities: CompiledProject["capabilities"];
  targets: CompiledProject["targets"];
  files: BundleFileEntry[];
}

export type BundleOptions =
  | { kind: "preview"; sourceRevision: number }
  | { kind: "release"; sourceRevision: number; version: string };

export interface BuiltBundle {
  bytes: Uint8Array;
  filename: string;
  sha256: string;
  manifest: BundleManifest;
}

export class BundleBuildError extends Error {
  readonly code: string;
  readonly diagnostics: Diagnostic[];

  constructor(code: string, message: string, diagnostics: Diagnostic[] = []) {
    super(message);
    this.name = "BundleBuildError";
    this.code = code;
    this.diagnostics = diagnostics;
  }
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right, "en"))
        .map(([key, item]) => [key, canonicalize(item)]),
    );
  }
  return value;
}

export function stableStringify(value: unknown): string {
  return `${JSON.stringify(canonicalize(value), null, 2)}\n`;
}

/** Semantic hash input: independent from pretty-printing and ZIP representation. */
export function canonicalStringify(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function hashBytes(bytes: Uint8Array): string {
  return bytesToHex(sha256(bytes));
}

function hashText(text: string): string {
  return hashBytes(encoder.encode(text));
}

function addJson(files: Map<string, Uint8Array>, path: string, value: unknown): void {
  files.set(path, encoder.encode(stableStringify(value)));
}

function assertPublicPayload(path: string, validation: ValidationResult): void {
  if (!validation.valid) {
    throw new BundleBuildError(
      "SF_BUNDLE_GENERATED_SCHEMA_INVALID",
      `Generated bundle entry "${path}" does not satisfy its included schema.`,
      validation.diagnostics.map((diagnostic) => ({ ...diagnostic, path: `${path}${diagnostic.path}` })),
    );
  }
}

function dtcgColor(value: string): unknown {
  const color = parseHexColor(value);
  if (!color) return value;
  return {
    colorSpace: "srgb",
    components: [
      Number(color.r.toFixed(6)),
      Number(color.g.toFixed(6)),
      Number(color.b.toFixed(6)),
    ],
    alpha: Number(color.a.toFixed(6)),
  };
}

function primitivesProjection(source: StyleflowProjectSource): object {
  return {
    color: Object.fromEntries(
      source.colors.ramps.map((ramp) => [
        ramp.id,
        Object.fromEntries(
          ramp.stops.map((stop) => [
            stop.position,
            {
              $type: "color",
              $value: {
                colorSpace: "oklch",
                components: [stop.source.lightness, stop.source.chroma, stop.source.hue],
                alpha: stop.source.alpha,
              },
              $extensions: {
                "app.styleflow.contract": {
                  generated: stop.generated ?? false,
                  overridden: stop.overridden ?? false,
                  srgbFallback: dtcgColor(stop.value),
                  gamutMapping: ramp.generator.gamutMapping,
                },
              },
            },
          ]),
        ),
      ]),
    ),
  };
}

function semanticProjection(source: StyleflowProjectSource): object {
  const defaultThemeId = source.themes[0]?.id;
  return {
    color: Object.fromEntries(
      source.colors.intensityProfiles.map((profile) => {
        const keys = [
          ...new Set(Object.values(profile.mappingByTheme).flatMap((item) => Object.keys(item))),
        ];
        return [
          profile.toneId,
          Object.fromEntries(
            keys.sort().map((key) => {
              const position =
                (defaultThemeId ? profile.mappingByTheme[defaultThemeId]?.[key] : undefined) ??
                "500";
              return [
                key,
                {
                  $type: "color",
                  $value: `{color.${profile.toneId}.${position}}`,
                  $extensions: {
                    "app.styleflow.contract": { semanticIntensity: key },
                  },
                },
              ];
            }),
          ),
        ];
      }),
    ),
  };
}

function themeProjection(source: StyleflowProjectSource, themeId: string): object {
  return {
    color: Object.fromEntries(
      source.colors.intensityProfiles.map((profile) => [
        profile.toneId,
        Object.fromEntries(
          Object.entries(profile.mappingByTheme[themeId] ?? {}).map(([key, position]) => [
            key,
            { $type: "color", $value: `{color.${profile.toneId}.${position}}` },
          ]),
        ),
      ]),
    ),
  };
}

function semanticContract(compiled: CompiledProject): StyleflowSemanticContract {
  return {
    formatVersion: compiled.source.formatVersion,
    project: compiled.source.project,
    axes: compiled.agentContract.axes,
    themes: compiled.themes.map((theme) => theme.id),
    capabilities: compiled.capabilities,
    agentPolicy: compiled.source.agentPolicy,
  };
}

function resolvedThemeContract(
  compiled: CompiledProject,
  theme: CompiledProject["themes"][number],
): StyleflowResolvedThemeContract {
  return {
    ...semanticContract(compiled),
    activeTheme: theme.id,
    resolved: {
      tokens: theme.tokens,
      onColors: theme.onColors,
      surfaces: theme.surfaces,
      interactions: theme.interactions,
      layout: theme.layout,
      typography: theme.typography,
    },
  };
}

function resolvedTokensProjection(theme: CompiledProject["themes"][number]): DtcgTokenDocument {
  const root: Record<string, unknown> = {};
  for (const [path, value] of Object.entries(theme.tokens).sort(([left], [right]) =>
    left.localeCompare(right, "en"),
  )) {
    const segments = path.split(".");
    let group = root;
    for (const segment of segments.slice(0, -1)) {
      const existing = group[segment];
      if (!existing || typeof existing !== "object" || Array.isArray(existing)) group[segment] = {};
      group = group[segment] as Record<string, unknown>;
    }
    const leaf = segments.at(-1);
    if (leaf) {
      group[leaf] = {
        $type: "color",
        $value: dtcgColor(value),
        $extensions: { "app.styleflow.contract": { theme: theme.id, sourcePath: path } },
      };
    }
  }
  return root;
}

function layoutProjection(source: StyleflowProjectSource): object {
  return {
    $extensions: {
      "app.styleflow.contract": {
        axes: ["layoutRole", "density", "breakpoint"],
        scales: source.layout.scales,
        roles: source.layout.recipes,
      },
    },
  };
}

function typographyProjection(compiled: CompiledProject): object {
  const tokens = compiled.themes[0]?.typography ?? [];
  const breakpointOrder = [...compiled.source.layout.scales.breakpoints].sort(
    (left, right) => left.order - right.order,
  );
  return {
    typography: Object.fromEntries(
      tokens.map((token) => [
        token.id,
        (() => {
          const baseBreakpoint = breakpointOrder[0]?.id;
          const base = baseBreakpoint ? token.valuesByBreakpoint[baseBreakpoint] : undefined;
          return {
            $type: "typography",
            $value: {
              fontFamily: token.fontFamily,
              fontSize: base?.fontSize ?? "",
              fontWeight: token.fontWeight,
              letterSpacing: base?.letterSpacing ?? "",
              lineHeight: base?.lineHeight ?? "",
            },
            $extensions: {
              "app.styleflow.contract": {
                coordinate: { ty: token.ty, v: token.v, w: token.w },
                fontStyle: token.fontStyle,
                textCase: base?.textCase ?? "original",
                valuesByBreakpoint: token.valuesByBreakpoint,
                provenance: token.provenance,
              },
            },
          };
        })(),
      ]),
    ),
  };
}

function resolverProjection(source: StyleflowProjectSource): object {
  return {
    version: "2025.10",
    sets: {
      foundation: ["../tokens/primitives.tokens.json"],
      semantics: ["../tokens/semantic.tokens.json"],
      layout: ["../tokens/layout.tokens.json"],
      typography: ["../tokens/typography.tokens.json"],
      themes: Object.fromEntries(
        source.themes.map((theme) => [theme.id, [`../tokens/themes/${theme.id}.tokens.json`]]),
      ),
    },
    resolutionOrder: source.themes.map((theme) => ({
      theme: theme.id,
      parent: theme.parentId ?? null,
      sets: ["foundation", "semantics", "layout", "typography", `themes.${theme.id}`],
    })),
  };
}

function accessibilityStatus(compiled: CompiledProject): BundleManifest["accessibility"] {
  const violations = compiled.diagnostics.filter((diagnostic) =>
    diagnostic.code.startsWith("SF_CONTRAST"),
  );
  const blocked = compiled.diagnostics.some((diagnostic) => diagnostic.blocking);
  return {
    configuredLevel: compiled.source.settings.accessibility.level,
    configuredPolicy: compiled.source.settings.accessibility.policy,
    status: blocked ? "blocked" : violations.length > 0 ? "passes-with-warnings" : "passes",
    violations: violations.length,
  };
}

function fileEntry(path: string, bytes: Uint8Array): BundleFileEntry {
  return {
    path,
    mediaType: JSON_MEDIA_TYPE,
    bytes: bytes.byteLength,
    sha256: hashBytes(bytes),
  };
}

export function buildBundle(source: StyleflowProjectSource, options: BundleOptions): BuiltBundle {
  const validation = validateProjectSource(source);
  if (!validation.valid) {
    throw new BundleBuildError(
      "SF_BUNDLE_SCHEMA_INVALID",
      "The project source does not satisfy the Styleflow contract.",
      validation.diagnostics,
    );
  }
  const compiled = compileProject(source);
  const structuralErrors = compiled.diagnostics.filter(
    (diagnostic) => diagnostic.blocking && !diagnostic.code.startsWith("SF_CONTRAST"),
  );
  const policyBlocks = compiled.diagnostics.filter((diagnostic) => diagnostic.blocking);
  if (structuralErrors.length > 0 || (options.kind === "release" && policyBlocks.length > 0)) {
    throw new BundleBuildError(
      "SF_BUNDLE_SCHEMA_INVALID",
      "The project cannot be exported until blocking diagnostics are resolved.",
      policyBlocks,
    );
  }

  const files = new Map<string, Uint8Array>();
  const contract = semanticContract(compiled);
  const primitives = primitivesProjection(source);
  const semantics = semanticProjection(source);
  const layout = layoutProjection(source);
  const typography = typographyProjection(compiled);
  const resolver = resolverProjection(source);

  assertPublicPayload("contract/styleflow.contract.json", validateSemanticContract(contract));
  for (const [path, payload] of [
    ["tokens/primitives.tokens.json", primitives],
    ["tokens/semantic.tokens.json", semantics],
    ["tokens/layout.tokens.json", layout],
    ["tokens/typography.tokens.json", typography],
  ] as const) assertPublicPayload(path, validateDtcgTokens(payload));
  assertPublicPayload("resolver/styleflow.resolver.json", validateResolverProjection(resolver));
  assertPublicPayload("diagnostics/diagnostics.json", validateDiagnostics(compiled.diagnostics));

  addJson(files, "source/styleflow.project.json", source);
  addJson(files, "contract/styleflow.contract.json", contract);
  addJson(files, "tokens/primitives.tokens.json", primitives);
  addJson(files, "tokens/semantic.tokens.json", semantics);
  addJson(files, "tokens/layout.tokens.json", layout);
  addJson(files, "tokens/typography.tokens.json", typography);
  for (const theme of source.themes) {
    const path = `tokens/themes/${theme.id}.tokens.json`;
    const payload = themeProjection(source, theme.id);
    assertPublicPayload(path, validateDtcgTokens(payload));
    addJson(files, path, payload);
  }
  addJson(files, "resolver/styleflow.resolver.json", resolver);
  for (const theme of compiled.themes) {
    const resolvedContractPath = `resolved/${theme.id}/styleflow.contract.json`;
    const resolvedContract = resolvedThemeContract(compiled, theme);
    const resolvedTokensPath = `resolved/${theme.id}/tokens.tokens.json`;
    const resolvedTokens = resolvedTokensProjection(theme);
    assertPublicPayload(resolvedContractPath, validateSemanticContract(resolvedContract));
    assertPublicPayload(resolvedTokensPath, validateDtcgTokens(resolvedTokens));
    addJson(files, resolvedContractPath, resolvedContract);
    addJson(files, resolvedTokensPath, resolvedTokens);
  }
  addJson(files, "diagnostics/diagnostics.json", compiled.diagnostics);
  addJson(files, "schemas/manifest.schema.json", manifestSchema);
  addJson(files, "schemas/project.schema.json", projectSchema);
  addJson(files, "schemas/contract.schema.json", contractSchema);
  addJson(files, "schemas/diagnostics.schema.json", diagnosticsSchema);
  addJson(files, "schemas/resolver.schema.json", resolverSchema);
  addJson(files, "schemas/tokens.schema.json", tokensSchema);

  const sourceText = canonicalStringify(source);
  const contentHash = `sha256-${hashText(sourceText)}`;
  const manifest: BundleManifest = {
    mediaType: "application/vnd.styleflow.bundle+zip",
    bundleVersion: BUNDLE_VERSION,
    kind: options.kind,
    project: source.project,
    ...(options.kind === "release"
      ? {
          release: {
            version: options.version,
            sourceRevision: options.sourceRevision,
            contentHash,
          },
        }
      : {
          preview: {
            sourceRevision: options.sourceRevision,
            contentHash,
          },
        }),
    compiler: { name: CONTRACT_PACKAGE_NAME, version: CONTRACT_VERSION },
    themes: compiled.themes.map((theme) => theme.id),
    accessibility: accessibilityStatus(compiled),
    capabilities: compiled.capabilities,
    targets: compiled.targets,
    files: [...files.entries()]
      .sort(([left], [right]) => left.localeCompare(right, "en"))
      .map(([path, bytes]) => fileEntry(path, bytes)),
  };

  assertPublicPayload("styleflow.manifest.json", validateBundleManifest(manifest));

  const manifestBytes = encoder.encode(stableStringify(manifest));
  files.set("styleflow.manifest.json", manifestBytes);

  const checksumLines = [...files.entries()]
    .sort(([left], [right]) => left.localeCompare(right, "en"))
    .map(([path, bytes]) => `${hashBytes(bytes)}  ${path}`)
    .join("\n");
  files.set("checksums.sha256", encoder.encode(`${checksumLines}\n`));

  const zippable: Zippable = Object.fromEntries(
    [...files.entries()]
      .sort(([left], [right]) => left.localeCompare(right, "en"))
      .map(([path, bytes]) => [path, [bytes, { level: 9, mtime: FIXED_ZIP_DATE }]]),
  );
  const bytes = zipSync(zippable, { level: 9 });
  const bundleHash = hashBytes(bytes);
  const identity =
    options.kind === "release" ? `v${options.version}` : `preview-r${options.sourceRevision}`;

  return {
    bytes,
    sha256: bundleHash,
    manifest,
    filename: `${source.project.slug}-${identity}-${bundleHash.slice(0, 8)}.styleflow.zip`,
  };
}
