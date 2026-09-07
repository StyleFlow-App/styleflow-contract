import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { strFromU8, strToU8, unzipSync } from "fflate";

import type { BundleManifest } from "./exporter";
import type {
  FigmaCollectionSpec,
  FigmaProjectedValue,
  FigmaProjection,
  FigmaTextStyleSpec,
  FigmaVariableSpec,
  FigmaVariableScope,
  FigmaVariableType,
} from "./figma-projection";

export type {
  FigmaCollectionSpec,
  FigmaModeSpec,
  FigmaProjectedValue,
  FigmaProjection,
  FigmaTextStyleSpec,
  FigmaVariableSpec,
  FigmaVariableScope,
  FigmaVariableType,
} from "./figma-projection";

export const FIGMA_PROJECTION_VERSION = "2.1.0" as const;
export const FIGMA_PROJECTION_PATH = "targets/figma-vnext.json" as const;

const MANIFEST_PATH = "styleflow.manifest.json";
const CHECKSUM_PATH = "checksums.sha256";

export interface FigmaImportLimits {
  maxCompressedBytes: number;
  maxEntries: number;
  maxExpansionRatio: number;
  maxUncompressedBytes: number;
  maxProjectionBytes: number;
}

export const DEFAULT_FIGMA_IMPORT_LIMITS: FigmaImportLimits = {
  maxCompressedBytes: 10 * 1024 * 1024,
  maxEntries: 500,
  maxExpansionRatio: 100,
  maxUncompressedBytes: 50 * 1024 * 1024,
  maxProjectionBytes: 20 * 1024 * 1024,
};

export interface ImportedFigmaBundle {
  manifest: BundleManifest;
  projection: FigmaProjection;
  bundleSha256: string;
}

export class FigmaBundleImportError extends Error {
  readonly code: string;
  readonly reasons: string[];

  constructor(code: string, message: string, reasons: string[] = []) {
    super(message);
    this.name = "FigmaBundleImportError";
    this.code = code;
    this.reasons = reasons;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function decodeUtf8(bytes: Uint8Array): string {
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf)
    throw new Error("UTF-8 BOM is forbidden.");
  const decoded = strFromU8(bytes);
  const encoded = strToU8(decoded);
  if (
    encoded.byteLength !== bytes.byteLength ||
    encoded.some((value, index) => value !== bytes[index])
  )
    throw new Error("Invalid UTF-8.");
  return decoded;
}

function parseJson<T>(bytes: Uint8Array | undefined, path: string): T {
  if (!bytes)
    throw new FigmaBundleImportError(
      "SF_FIGMA_BUNDLE_ENTRY_MISSING",
      `Bundle entry "${path}" is missing.`,
    );
  try {
    return JSON.parse(decodeUtf8(bytes)) as T;
  } catch {
    throw new FigmaBundleImportError(
      "SF_FIGMA_BUNDLE_SCHEMA_INVALID",
      `Bundle entry "${path}" is not valid UTF-8 JSON.`,
    );
  }
}

function hash(bytes: Uint8Array): string {
  return bytesToHex(sha256(bytes));
}

function safePath(path: string): boolean {
  return (
    path.length > 0 &&
    path.length <= 240 &&
    !path.startsWith("/") &&
    !path.includes("\\") &&
    path.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..")
  );
}

function preflightCentralDirectory(bytes: Uint8Array, limits: FigmaImportLimits): void {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const minimum = Math.max(0, bytes.byteLength - 65_557);
  let end = -1;
  for (let offset = bytes.byteLength - 22; offset >= minimum; offset -= 1) {
    if (view.getUint32(offset, true) === 0x06054b50) {
      end = offset;
      break;
    }
  }
  if (end < 0 || view.getUint16(end + 4, true) !== 0 || view.getUint16(end + 6, true) !== 0)
    throw new FigmaBundleImportError(
      "SF_FIGMA_BUNDLE_SCHEMA_INVALID",
      "ZIP central directory is missing or multi-disk.",
    );
  const entries = view.getUint16(end + 10, true);
  const directoryOffset = view.getUint32(end + 16, true);
  if (entries === 0xffff || entries === 0 || entries > limits.maxEntries)
    throw new FigmaBundleImportError(
      "SF_FIGMA_BUNDLE_SIZE_LIMIT",
      "ZIP entry count exceeds import limits.",
    );
  let cursor = directoryOffset;
  let expanded = 0;
  const names = new Set<string>();
  for (let index = 0; index < entries; index += 1) {
    if (cursor + 46 > bytes.byteLength || view.getUint32(cursor, true) !== 0x02014b50)
      throw new FigmaBundleImportError(
        "SF_FIGMA_BUNDLE_SCHEMA_INVALID",
        "ZIP central directory is malformed.",
      );
    const flags = view.getUint16(cursor + 8, true);
    const method = view.getUint16(cursor + 10, true);
    const compressed = view.getUint32(cursor + 20, true);
    const uncompressed = view.getUint32(cursor + 24, true);
    const nameLength = view.getUint16(cursor + 28, true);
    const extraLength = view.getUint16(cursor + 30, true);
    const commentLength = view.getUint16(cursor + 32, true);
    if ((flags & 1) !== 0 || (method !== 0 && method !== 8))
      throw new FigmaBundleImportError(
        "SF_FIGMA_BUNDLE_SCHEMA_INVALID",
        "Encrypted or unsupported ZIP entries are forbidden.",
      );
    const nameStart = cursor + 46;
    const nameEnd = nameStart + nameLength;
    if (nameEnd > bytes.byteLength)
      throw new FigmaBundleImportError(
        "SF_FIGMA_BUNDLE_SCHEMA_INVALID",
        "ZIP entry name is malformed.",
      );
    let name: string;
    try {
      name = decodeUtf8(bytes.subarray(nameStart, nameEnd));
    } catch {
      throw new FigmaBundleImportError(
        "SF_FIGMA_BUNDLE_PATH_INVALID",
        "ZIP entry name is not valid UTF-8.",
      );
    }
    const folded = name.toLocaleLowerCase("en-US");
    if (!safePath(name) || names.has(folded))
      throw new FigmaBundleImportError(
        "SF_FIGMA_BUNDLE_PATH_INVALID",
        `Bundle entry path "${name}" is unsafe or duplicated.`,
      );
    names.add(folded);
    expanded += uncompressed;
    if (
      expanded > limits.maxUncompressedBytes ||
      (compressed > 0 && uncompressed / compressed > limits.maxExpansionRatio)
    )
      throw new FigmaBundleImportError(
        "SF_FIGMA_BUNDLE_SIZE_LIMIT",
        "Bundle expansion exceeds import limits.",
      );
    cursor = nameEnd + extraLength + commentLength;
  }
}

function unzip(bytes: Uint8Array, limits: FigmaImportLimits): Record<string, Uint8Array> {
  const folded = new Set<string>();
  let entries = 0;
  let expanded = 0;
  try {
    return unzipSync(bytes, {
      filter(entry) {
        const key = entry.name.toLocaleLowerCase("en-US");
        if (!safePath(entry.name) || folded.has(key))
          throw new FigmaBundleImportError(
            "SF_FIGMA_BUNDLE_PATH_INVALID",
            `Bundle entry path "${entry.name}" is unsafe or duplicated.`,
          );
        folded.add(key);
        entries += 1;
        expanded += entry.originalSize;
        if (
          entries > limits.maxEntries ||
          expanded > limits.maxUncompressedBytes ||
          (entry.size > 0 && entry.originalSize / entry.size > limits.maxExpansionRatio)
        )
          throw new FigmaBundleImportError(
            "SF_FIGMA_BUNDLE_SIZE_LIMIT",
            "Bundle expansion exceeds import limits.",
          );
        return true;
      },
    });
  } catch (error) {
    if (error instanceof FigmaBundleImportError) throw error;
    throw new FigmaBundleImportError(
      "SF_FIGMA_BUNDLE_SCHEMA_INVALID",
      "ZIP container is invalid or unsupported.",
    );
  }
}

function verifyChecksums(files: Record<string, Uint8Array>): void {
  const checksumBytes = files[CHECKSUM_PATH];
  if (!checksumBytes)
    throw new FigmaBundleImportError(
      "SF_FIGMA_BUNDLE_CHECKSUM_INVALID",
      "Bundle checksum index is missing.",
    );
  let checksumText: string;
  try {
    checksumText = decodeUtf8(checksumBytes);
  } catch {
    throw new FigmaBundleImportError(
      "SF_FIGMA_BUNDLE_CHECKSUM_INVALID",
      "Bundle checksum index is not valid UTF-8.",
    );
  }
  const lines = checksumText.trim().split("\n").filter(Boolean);
  const expected = new Map<string, string>();
  for (const line of lines) {
    const match = /^([0-9a-f]{64})  (.+)$/.exec(line);
    if (!match?.[1] || !match[2] || !safePath(match[2]) || expected.has(match[2]))
      throw new FigmaBundleImportError(
        "SF_FIGMA_BUNDLE_CHECKSUM_INVALID",
        "Bundle checksum index is malformed.",
      );
    expected.set(match[2], match[1]);
  }
  const paths = Object.keys(files).filter((path) => path !== CHECKSUM_PATH);
  if (paths.length !== expected.size)
    throw new FigmaBundleImportError(
      "SF_FIGMA_BUNDLE_CHECKSUM_INVALID",
      "Bundle checksum index does not cover the exact payload.",
    );
  for (const path of paths)
    if (!expected.has(path) || hash(files[path]!) !== expected.get(path))
      throw new FigmaBundleImportError(
        "SF_FIGMA_BUNDLE_CHECKSUM_INVALID",
        `Bundle checksum failed for "${path}".`,
      );
}

function validManifest(value: unknown): value is BundleManifest {
  if (!isRecord(value)) return false;
  if (
    value.mediaType !== "application/vnd.styleflow.bundle+zip" ||
    value.bundleVersion !== "1.0.0" ||
    (value.kind !== "preview" && value.kind !== "release") ||
    !isRecord(value.project) ||
    typeof value.project.id !== "string" ||
    typeof value.project.slug !== "string" ||
    typeof value.project.name !== "string" ||
    !isRecord(value.compiler) ||
    value.compiler.name !== "@styleflow.app/contract" ||
    typeof value.compiler.version !== "string" ||
    !isRecord(value.targets) ||
    !isRecord(value.targets["figma-vnext"]) ||
    !Array.isArray(value.files)
  )
    return false;
  const target = value.targets["figma-vnext"];
  if (
    typeof target.status !== "string" ||
    !Array.isArray(target.reasons) ||
    !target.reasons.every((item) => typeof item === "string")
  )
    return false;
  return value.files.every(
    (entry) =>
      isRecord(entry) &&
      typeof entry.path === "string" &&
      safePath(entry.path) &&
      typeof entry.mediaType === "string" &&
      Number.isInteger(entry.bytes) &&
      Number(entry.bytes) >= 0 &&
      typeof entry.sha256 === "string" &&
      /^[0-9a-f]{64}$/.test(entry.sha256),
  );
}

function verifyManifest(files: Record<string, Uint8Array>, manifest: BundleManifest): void {
  const expectedPaths = new Set(manifest.files.map((entry) => entry.path));
  const actualPaths = Object.keys(files).filter(
    (path) => path !== MANIFEST_PATH && path !== CHECKSUM_PATH,
  );
  if (expectedPaths.size !== manifest.files.length || actualPaths.length !== expectedPaths.size)
    throw new FigmaBundleImportError(
      "SF_FIGMA_BUNDLE_MANIFEST_INVALID",
      "Manifest file list is duplicated or incomplete.",
    );
  for (const entry of manifest.files) {
    const bytes = files[entry.path];
    if (!bytes || bytes.byteLength !== entry.bytes || hash(bytes) !== entry.sha256)
      throw new FigmaBundleImportError(
        "SF_FIGMA_BUNDLE_MANIFEST_INVALID",
        `Manifest metadata failed for "${entry.path}".`,
      );
  }
  if (actualPaths.some((path) => !expectedPaths.has(path)))
    throw new FigmaBundleImportError(
      "SF_FIGMA_BUNDLE_MANIFEST_INVALID",
      "Bundle contains payload not declared by the manifest.",
    );
}

function validProjectedValue(value: unknown): value is FigmaProjectedValue {
  if (!isRecord(value) || typeof value.kind !== "string") return false;
  if (value.kind === "unset") return false;
  if (value.kind === "alias") return typeof value.variablePath === "string";
  if (value.kind === "float")
    return typeof value.value === "number" && Number.isFinite(value.value);
  if (value.kind === "string") return typeof value.value === "string";
  if (value.kind === "boolean") return typeof value.value === "boolean";
  return (
    value.kind === "color" &&
    [value.r, value.g, value.b, value.a].every(
      (channel) =>
        typeof channel === "number" && Number.isFinite(channel) && channel >= 0 && channel <= 1,
    )
  );
}

function validVariable(value: unknown): value is FigmaVariableSpec {
  const scopes = isRecord(value) && Array.isArray(value.scopes) ? value.scopes : null;
  return (
    isRecord(value) &&
    typeof value.path === "string" &&
    value.path.length > 0 &&
    value.path.length <= 512 &&
    typeof value.name === "string" &&
    value.name.length > 0 &&
    ["COLOR", "FLOAT", "STRING", "BOOLEAN"].includes(String(value.type)) &&
    scopes !== null &&
    new Set(scopes).size === scopes.length &&
    scopes.every((scope) =>
      [
        "FRAME_FILL",
        "SHAPE_FILL",
        "TEXT_FILL",
        "STROKE_COLOR",
        "GAP",
        "CORNER_RADIUS",
        "STROKE_FLOAT",
        "OPACITY",
      ].includes(String(scope)),
    ) &&
    isRecord(value.valuesByMode) &&
    Object.keys(value.valuesByMode).length > 0 &&
    Object.values(value.valuesByMode).every(validProjectedValue)
  );
}

function validCollection(value: unknown): value is FigmaCollectionSpec {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.name === "string" &&
    Array.isArray(value.modes) &&
    value.modes.length > 0 &&
    value.modes.length <= 10 &&
    value.modes.every(
      (mode) => isRecord(mode) && typeof mode.id === "string" && typeof mode.name === "string",
    ) &&
    Array.isArray(value.variables) &&
    value.variables.every(validVariable)
  );
}

function validTextStyle(value: unknown): value is FigmaTextStyleSpec {
  if (!isRecord(value) || !isRecord(value.variablePaths)) return false;
  const variablePaths = value.variablePaths;
  return (
    typeof value.id === "string" &&
    typeof value.name === "string" &&
    typeof value.fontFamily === "string" &&
    typeof value.fontStyle === "string" &&
    ["original", "uppercase", "lowercase", "title"].includes(String(value.textCase)) &&
    ["fontSize", "lineHeight", "letterSpacing"].every(
      (key) => typeof variablePaths[key] === "string",
    )
  );
}

function validModeArray(value: unknown): value is Array<{ id: string; name: string }> {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.length <= 10 &&
    value.every(
      (mode) => isRecord(mode) && typeof mode.id === "string" && typeof mode.name === "string",
    )
  );
}

function assertProjection(
  value: unknown,
  manifest: BundleManifest,
): asserts value is FigmaProjection {
  const axes = isRecord(value) && isRecord(value.axes) ? value.axes : null;
  const modeCollections =
    isRecord(value) && isRecord(value.modeCollections) ? value.modeCollections : null;
  const bindings = isRecord(value) && isRecord(value.bindings) ? value.bindings : null;
  const rawColorBindings = bindings && isRecord(bindings.color) ? bindings.color : null;
  const axisNames = ["theme", "tone", "intensity", "layoutRole", "density", "breakpoint"] as const;
  if (isRecord(value) && value.formatVersion !== FIGMA_PROJECTION_VERSION)
    throw new FigmaBundleImportError(
      "SF_FIGMA_PROJECTION_VERSION_UNSUPPORTED",
      "This bundle requires a fresh Figma file and a Styleflow Figma Projection v2.1 export.",
    );
  if (
    !isRecord(value) ||
    value.formatVersion !== FIGMA_PROJECTION_VERSION ||
    !isRecord(value.project) ||
    value.project.id !== manifest.project.id ||
    !Number.isInteger(value.sourceRevision) ||
    typeof value.contentHash !== "string" ||
    !/^sha256-[0-9a-f]{64}$/.test(value.contentHash) ||
    !axes ||
    !axisNames.every((axis) => validModeArray(axes[axis])) ||
    !modeCollections ||
    Object.keys(modeCollections).length !== axisNames.length ||
    axisNames.some((axis) => !Object.hasOwn(modeCollections, axis)) ||
    !isRecord(value.availability) ||
    !isRecord(value.availability.intensityByTone) ||
    !isRecord(value.availability.modeIdsByCollection) ||
    !Array.isArray(value.collections) ||
    !value.collections.every(validCollection) ||
    !Array.isArray(value.textStyles) ||
    !value.textStyles.every(validTextStyle) ||
    !bindings ||
    !rawColorBindings ||
    typeof rawColorBindings.background !== "string" ||
    !isRecord(rawColorBindings.foreground) ||
    !isRecord(rawColorBindings.border) ||
    !isRecord(rawColorBindings.surfaces) ||
    !isRecord(rawColorBindings.interactions) ||
    Object.values(rawColorBindings.interactions).some((item) => !isRecord(item)) ||
    !isRecord(bindings.layout) ||
    !isRecord(bindings.typography) ||
    !Array.isArray(value.diagnostics) ||
    !value.diagnostics.every(isRecord)
  )
    throw new FigmaBundleImportError(
      "SF_FIGMA_PROJECTION_INVALID",
      "Figma projection does not satisfy Styleflow Figma Projection v2.1.",
    );

  const projection = value as unknown as FigmaProjection;
  const identity = manifest.kind === "release" ? manifest.release : manifest.preview;
  if (
    !identity ||
    value.sourceRevision !== identity.sourceRevision ||
    value.contentHash !== identity.contentHash
  )
    throw new FigmaBundleImportError(
      "SF_FIGMA_PROJECTION_INVALID",
      "Figma projection identity does not match the bundle manifest.",
    );

  const collectionIds = new Set<string>();
  const variableTypes = new Map<string, FigmaVariableType>();
  const variables = new Map<string, FigmaVariableSpec>();
  const collectionsById = new Map<string, FigmaCollectionSpec>();
  const collectionByVariablePath = new Map<string, string>();
  for (const collection of projection.collections) {
    if (collectionIds.has(collection.id))
      throw new FigmaBundleImportError(
        "SF_FIGMA_PROJECTION_INVALID",
        "Collection IDs must be unique.",
      );
    collectionIds.add(collection.id);
    collectionsById.set(collection.id, collection);
    const modeIds = new Set(collection.modes.map((mode) => mode.id));
    if (modeIds.size !== collection.modes.length)
      throw new FigmaBundleImportError("SF_FIGMA_PROJECTION_INVALID", "Mode IDs must be unique.");
    for (const item of collection.variables) {
      const valueModeIds = Object.keys(item.valuesByMode);
      if (
        variables.has(item.path) ||
        valueModeIds.length !== modeIds.size ||
        valueModeIds.some((id) => !modeIds.has(id))
      )
        throw new FigmaBundleImportError(
          "SF_FIGMA_PROJECTION_INVALID",
          `Variable "${item.path}" is duplicated or does not define every collection mode.`,
        );
      variables.set(item.path, item);
      variableTypes.set(item.path, item.type);
      collectionByVariablePath.set(item.path, collection.id);
    }
  }
  for (const item of variables.values())
    for (const projected of Object.values(item.valuesByMode))
      if (projected.kind === "alias") {
        const targetType = variableTypes.get(projected.variablePath);
        if (!targetType || targetType !== item.type)
          throw new FigmaBundleImportError(
            "SF_FIGMA_PROJECTION_INVALID",
            `Alias "${item.path}" targets a missing or incompatible variable.`,
          );
      }

  const allowedScopesByType: Record<FigmaVariableType, Set<FigmaVariableScope>> = {
    COLOR: new Set(["FRAME_FILL", "SHAPE_FILL", "TEXT_FILL", "STROKE_COLOR"]),
    FLOAT: new Set(["GAP", "CORNER_RADIUS", "STROKE_FLOAT", "OPACITY"]),
    STRING: new Set(),
    BOOLEAN: new Set(),
  };
  for (const item of variables.values()) {
    if (item.scopes.some((scope) => !allowedScopesByType[item.type].has(scope)))
      throw new FigmaBundleImportError(
        "SF_FIGMA_PROJECTION_INVALID",
        `Variable "${item.path}" declares a scope incompatible with ${item.type}.`,
      );
    if (
      item.scopes.length > 0 &&
      !["intensity", "layout-role"].includes(collectionByVariablePath.get(item.path) ?? "")
    )
      throw new FigmaBundleImportError(
        "SF_FIGMA_PROJECTION_INVALID",
        `Variable "${item.path}" exposes a non-terminal collection in Figma pickers.`,
      );
  }

  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (path: string): void => {
    if (visiting.has(path))
      throw new FigmaBundleImportError(
        "SF_FIGMA_PROJECTION_INVALID",
        "Variable alias cycle detected.",
      );
    if (visited.has(path)) return;
    visiting.add(path);
    for (const projected of Object.values(variables.get(path)?.valuesByMode ?? {}))
      if (projected.kind === "alias") visit(projected.variablePath);
    visiting.delete(path);
    visited.add(path);
  };
  for (const path of variables.keys()) visit(path);

  const materializedPaths = new Set<string>();
  let changed = true;
  while (changed) {
    changed = false;
    for (const item of variables.values()) {
      if (materializedPaths.has(item.path)) continue;
      if (
        !Object.values(item.valuesByMode).some(
          (value) =>
            value.kind !== "unset" &&
            (value.kind !== "alias" || materializedPaths.has(value.variablePath)),
        )
      )
        continue;
      materializedPaths.add(item.path);
      changed = true;
    }
  }
  const unmaterialized = [...variables.keys()].find((path) => !materializedPaths.has(path));
  if (unmaterialized)
    throw new FigmaBundleImportError(
      "SF_FIGMA_PROJECTION_INVALID",
      `Variable "${unmaterialized}" cannot resolve to a materialized Figma value.`,
    );

  const styleIds = new Set<string>();
  for (const style of projection.textStyles) {
    if (
      styleIds.has(style.id) ||
      Object.values(style.variablePaths).some((path) => variableTypes.get(path) !== "FLOAT")
    )
      throw new FigmaBundleImportError(
        "SF_FIGMA_PROJECTION_INVALID",
        `Text style "${style.id}" is duplicated or references an incompatible metric.`,
      );
    styleIds.add(style.id);
  }
  const mappedCollectionIds = new Set<string>();
  const modeIdsByCollection = projection.availability.modeIdsByCollection;
  for (const [axis, axisCollections] of Object.entries(projection.modeCollections))
    if (
      !Array.isArray(axisCollections) ||
      axisCollections.length === 0 ||
      axisCollections.some(
        (collectionId) => typeof collectionId !== "string" || !collectionIds.has(collectionId),
      )
    )
      throw new FigmaBundleImportError(
        "SF_FIGMA_PROJECTION_INVALID",
        "Mode collection mapping references an unknown collection.",
      );
    else {
      const expectedModes = new Set(
        projection.axes[axis as keyof FigmaProjection["axes"]].map((mode) => mode.id),
      );
      const coveredModes = new Set<string>();
      for (const collectionId of axisCollections) {
        mappedCollectionIds.add(collectionId);
        const actualModes = collectionsById.get(collectionId)!.modes.map((mode) => mode.id);
        const declaredModes = modeIdsByCollection[collectionId];
        if (
          !Array.isArray(declaredModes) ||
          declaredModes.length !== actualModes.length ||
          actualModes.some(
            (modeId, index) => !expectedModes.has(modeId) || declaredModes[index] !== modeId,
          )
        )
          throw new FigmaBundleImportError(
            "SF_FIGMA_PROJECTION_INVALID",
            `Collection "${collectionId}" declares invalid availability for axis "${axis}".`,
          );
        for (const modeId of actualModes) coveredModes.add(modeId);
      }
      if (coveredModes.size !== expectedModes.size)
        throw new FigmaBundleImportError(
          "SF_FIGMA_PROJECTION_INVALID",
          `Mode collections do not cover axis "${axis}".`,
        );
    }

  if (
    Object.keys(modeIdsByCollection).length !== mappedCollectionIds.size ||
    Object.keys(modeIdsByCollection).some((collectionId) => !mappedCollectionIds.has(collectionId))
  )
    throw new FigmaBundleImportError(
      "SF_FIGMA_PROJECTION_INVALID",
      "Mode availability must cover exactly the mapped collections.",
    );

  const toneIds = projection.axes.tone.map((mode) => mode.id);
  const intensityIds = projection.axes.intensity.map((mode) => mode.id);
  const intensityByTone = projection.availability.intensityByTone;
  if (
    Object.keys(intensityByTone).length !== toneIds.length ||
    toneIds.some((toneId) => {
      const available = intensityByTone[toneId];
      return (
        !Array.isArray(available) ||
        available.length === 0 ||
        new Set(available).size !== available.length ||
        available.some((intensityId) => !intensityIds.includes(intensityId)) ||
        available.some(
          (intensityId, index) =>
            index > 0 &&
            intensityIds.indexOf(available[index - 1]!) >= intensityIds.indexOf(intensityId),
        )
      );
    })
  )
    throw new FigmaBundleImportError(
      "SF_FIGMA_PROJECTION_INVALID",
      "Intensity availability must be a complete ordered subset for every tone.",
    );

  const assertVariableMap = (candidate: unknown, label: string): void => {
    if (
      !isRecord(candidate) ||
      Object.values(candidate).some((path) => typeof path !== "string" || !variables.has(path))
    )
      throw new FigmaBundleImportError(
        "SF_FIGMA_PROJECTION_INVALID",
        `${label} references an unknown variable.`,
      );
  };
  const colorBindings = projection.bindings.color;
  if (!variables.has(colorBindings.background))
    throw new FigmaBundleImportError(
      "SF_FIGMA_PROJECTION_INVALID",
      "Background binding references an unknown variable.",
    );
  assertVariableMap(colorBindings.foreground, "Foreground bindings");
  assertVariableMap(colorBindings.border, "Border bindings");
  assertVariableMap(colorBindings.surfaces, "Surface bindings");
  for (const interaction of Object.values(colorBindings.interactions))
    assertVariableMap(interaction, "Interaction bindings");
  assertVariableMap(projection.bindings.layout, "Layout bindings");
  if (
    Object.values(projection.bindings.typography).some((textStyleId) => !styleIds.has(textStyleId))
  )
    throw new FigmaBundleImportError(
      "SF_FIGMA_PROJECTION_INVALID",
      "Typography bindings reference an unknown text style.",
    );

  const expectedScopes = new Map<string, FigmaVariableScope[]>();
  expectedScopes.set(colorBindings.background, ["FRAME_FILL"]);
  for (const path of Object.values(colorBindings.foreground))
    expectedScopes.set(path, ["TEXT_FILL", "SHAPE_FILL"]);
  for (const path of Object.values(colorBindings.border))
    expectedScopes.set(path, ["STROKE_COLOR"]);
  for (const path of Object.values(colorBindings.surfaces))
    expectedScopes.set(path, ["FRAME_FILL"]);
  for (const interaction of Object.values(colorBindings.interactions))
    for (const [property, path] of Object.entries(interaction)) {
      if (property === "background") expectedScopes.set(path, ["FRAME_FILL"]);
      if (property === "foreground") expectedScopes.set(path, ["TEXT_FILL", "SHAPE_FILL"]);
      if (property === "border" || property === "focusRing")
        expectedScopes.set(path, ["STROKE_COLOR"]);
      if (property === "controlOpacity") expectedScopes.set(path, ["OPACITY"]);
    }
  for (const [property, path] of Object.entries(projection.bindings.layout)) {
    if (["gap", "paddingInline", "paddingBlock"].includes(property))
      expectedScopes.set(path, ["GAP"]);
    if (property === "radius") expectedScopes.set(path, ["CORNER_RADIUS"]);
    if (property === "borderWidth") expectedScopes.set(path, ["STROKE_FLOAT"]);
  }
  for (const item of variables.values()) {
    const expected = expectedScopes.get(item.path) ?? [];
    if (
      item.scopes.length !== expected.length ||
      item.scopes.some((scope, index) => scope !== expected[index])
    )
      throw new FigmaBundleImportError(
        "SF_FIGMA_PROJECTION_INVALID",
        `Variable "${item.path}" does not match the canonical Figma scope matrix.`,
      );
  }

  const bindingRoots = new Set<string>([
    colorBindings.background,
    ...Object.values(colorBindings.foreground),
    ...Object.values(colorBindings.border),
    ...Object.values(colorBindings.surfaces),
    ...Object.values(colorBindings.interactions).flatMap((item) => Object.values(item)),
    ...Object.values(projection.bindings.layout),
    ...projection.textStyles.flatMap((style) => Object.values(style.variablePaths)),
  ]);
  const reachable = new Set<string>();
  const visitReachable = (path: string): void => {
    if (reachable.has(path)) return;
    reachable.add(path);
    for (const projected of Object.values(variables.get(path)?.valuesByMode ?? {}))
      if (projected.kind === "alias") visitReachable(projected.variablePath);
  };
  for (const path of bindingRoots) visitReachable(path);
  const unreachable = [...variables.keys()].find((path) => !reachable.has(path));
  if (unreachable)
    throw new FigmaBundleImportError(
      "SF_FIGMA_PROJECTION_INVALID",
      `Variable "${unreachable}" is not reachable from an applicable binding or Text Style.`,
    );
}

export function importFigmaBundle(
  bytes: Uint8Array,
  limits: FigmaImportLimits = DEFAULT_FIGMA_IMPORT_LIMITS,
): ImportedFigmaBundle {
  if (bytes.byteLength === 0 || bytes.byteLength > limits.maxCompressedBytes)
    throw new FigmaBundleImportError(
      "SF_FIGMA_BUNDLE_SIZE_LIMIT",
      "Compressed bundle exceeds import limits.",
    );
  try {
    preflightCentralDirectory(bytes, limits);
  } catch (error) {
    if (error instanceof FigmaBundleImportError) throw error;
    throw new FigmaBundleImportError(
      "SF_FIGMA_BUNDLE_SCHEMA_INVALID",
      "ZIP central directory is malformed.",
    );
  }
  const files = unzip(bytes, limits);
  verifyChecksums(files);
  const manifest = parseJson<BundleManifest>(files[MANIFEST_PATH], MANIFEST_PATH);
  if (!validManifest(manifest))
    throw new FigmaBundleImportError(
      "SF_FIGMA_BUNDLE_MANIFEST_INVALID",
      "Bundle manifest does not satisfy Styleflow Bundle v1.",
    );
  verifyManifest(files, manifest);
  const target = manifest.targets["figma-vnext"];
  if (target.status !== "supported")
    throw new FigmaBundleImportError(
      "SF_FIGMA_TARGET_UNSUPPORTED",
      "This bundle cannot be projected to Figma without loss.",
      target.reasons,
    );
  if ((files[FIGMA_PROJECTION_PATH]?.byteLength ?? 0) > limits.maxProjectionBytes)
    throw new FigmaBundleImportError(
      "SF_FIGMA_BUNDLE_SIZE_LIMIT",
      "Figma projection exceeds import limits.",
    );
  const projection = parseJson<FigmaProjection>(
    files[FIGMA_PROJECTION_PATH],
    FIGMA_PROJECTION_PATH,
  );
  assertProjection(projection, manifest);
  return { manifest, projection, bundleSha256: hash(bytes) };
}
