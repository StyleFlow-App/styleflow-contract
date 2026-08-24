import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { unzipSync } from "fflate";

import { buildBundle, BundleBuildError, type BundleManifest, type BundleOptions } from "./exporter";
import type {
  Diagnostic,
  DtcgTokenDocument,
  StyleflowProjectSource,
  StyleflowResolvedThemeContract,
  StyleflowSemanticContract,
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

const decoder = new TextDecoder("utf-8", { fatal: true });
const MANIFEST_PATH = "styleflow.manifest.json";
const CHECKSUM_PATH = "checksums.sha256";

export interface ImportLimits {
  maxCompressedBytes: number;
  maxEntries: number;
  maxExpansionRatio: number;
  maxUncompressedBytes: number;
  maxSourceBytes: number;
}

export interface ImportedBundle {
  manifest: BundleManifest;
  source: StyleflowProjectSource;
  diagnostics: Diagnostic[];
  contract: StyleflowSemanticContract;
  resolved: Record<
    string,
    { contract: StyleflowResolvedThemeContract; tokens: DtcgTokenDocument }
  >;
}

export const DEFAULT_IMPORT_LIMITS: ImportLimits = {
  maxCompressedBytes: 10 * 1024 * 1024,
  maxEntries: 500,
  maxExpansionRatio: 100,
  maxUncompressedBytes: 50 * 1024 * 1024,
  maxSourceBytes: 2 * 1024 * 1024,
};

export class BundleImportError extends Error {
  readonly code: string;
  readonly diagnostics: Diagnostic[];

  constructor(code: string, message: string, diagnostics: Diagnostic[] = []) {
    super(message);
    this.name = "BundleImportError";
    this.code = code;
    this.diagnostics = diagnostics;
  }
}

function parseJson<T>(bytes: Uint8Array | undefined, path: string): T {
  if (!bytes)
    throw new BundleImportError("SF_BUNDLE_SOURCE_MISSING", `Bundle entry "${path}" is missing.`);
  try {
    return JSON.parse(decoder.decode(bytes)) as T;
  } catch {
    throw new BundleImportError(
      "SF_BUNDLE_SCHEMA_INVALID",
      `Bundle entry "${path}" is not valid UTF-8 JSON.`,
    );
  }
}

function assertPayload(path: string, validation: ValidationResult): void {
  if (!validation.valid) {
    throw new BundleImportError(
      "SF_BUNDLE_SCHEMA_INVALID",
      `Bundle entry "${path}" does not satisfy its included schema.`,
      validation.diagnostics.map((diagnostic) => ({ ...diagnostic, path: `${path}${diagnostic.path}` })),
    );
  }
}

function validatePath(path: string): void {
  if (
    path.length === 0 ||
    path.length > 240 ||
    path.startsWith("/") ||
    path.includes("\\") ||
    path.split("/").some((segment) => segment === ".." || segment === "." || segment === "")
  ) {
    throw new BundleImportError("SF_BUNDLE_PATH_INVALID", `Bundle entry path "${path}" is unsafe.`);
  }
}

function preflightCentralDirectory(bytes: Uint8Array, limits: ImportLimits): void {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const minimum = Math.max(0, bytes.byteLength - 65_557);
  let end = -1;
  for (let offset = bytes.byteLength - 22; offset >= minimum; offset -= 1) {
    if (view.getUint32(offset, true) === 0x06054b50) {
      end = offset;
      break;
    }
  }
  if (end < 0 || view.getUint16(end + 4, true) !== 0 || view.getUint16(end + 6, true) !== 0) {
    throw new BundleImportError(
      "SF_BUNDLE_SCHEMA_INVALID",
      "ZIP central directory is missing or multi-disk.",
    );
  }
  const entries = view.getUint16(end + 10, true);
  const directoryOffset = view.getUint32(end + 16, true);
  if (entries === 0xffff || entries > limits.maxEntries || directoryOffset >= bytes.byteLength) {
    throw new BundleImportError("SF_BUNDLE_SIZE_LIMIT", "ZIP entry count exceeds import limits.");
  }
  const names = new Set<string>();
  let cursor = directoryOffset;
  let expanded = 0;
  for (let index = 0; index < entries; index += 1) {
    if (cursor + 46 > bytes.byteLength || view.getUint32(cursor, true) !== 0x02014b50)
      throw new BundleImportError(
        "SF_BUNDLE_SCHEMA_INVALID",
        "ZIP central directory is malformed.",
      );
    const flags = view.getUint16(cursor + 8, true);
    const method = view.getUint16(cursor + 10, true);
    const compressed = view.getUint32(cursor + 20, true);
    const uncompressed = view.getUint32(cursor + 24, true);
    const nameLength = view.getUint16(cursor + 28, true);
    const extraLength = view.getUint16(cursor + 30, true);
    const commentLength = view.getUint16(cursor + 32, true);
    const externalAttributes = view.getUint32(cursor + 38, true);
    if (
      (flags & 1) !== 0 ||
      ![0, 8].includes(method) ||
      compressed === 0xffffffff ||
      uncompressed === 0xffffffff
    )
      throw new BundleImportError(
        "SF_BUNDLE_SCHEMA_INVALID",
        "Encrypted, ZIP64 or unsupported compression entries are rejected.",
      );
    const nameStart = cursor + 46;
    const nameEnd = nameStart + nameLength;
    if (nameEnd > bytes.byteLength)
      throw new BundleImportError("SF_BUNDLE_SCHEMA_INVALID", "ZIP entry name is truncated.");
    let name: string;
    try {
      name = decoder.decode(bytes.subarray(nameStart, nameEnd));
    } catch {
      throw new BundleImportError("SF_BUNDLE_PATH_INVALID", "ZIP entry name is not valid UTF-8.");
    }
    validatePath(name);
    const folded = name.toLocaleLowerCase("en-US");
    if (names.has(folded))
      throw new BundleImportError(
        "SF_BUNDLE_PATH_INVALID",
        `Bundle contains duplicate case-folded path "${name}".`,
      );
    names.add(folded);
    const unixMode = (externalAttributes >>> 16) & 0xffff;
    if ((unixMode & 0xf000) === 0xa000)
      throw new BundleImportError(
        "SF_BUNDLE_PATH_INVALID",
        `Symbolic link entry "${name}" is rejected.`,
      );
    expanded += uncompressed;
    if (
      expanded > limits.maxUncompressedBytes ||
      (compressed > 0 && uncompressed / compressed > limits.maxExpansionRatio)
    )
      throw new BundleImportError(
        "SF_BUNDLE_SIZE_LIMIT",
        `Bundle entry "${name}" exceeds expansion limits.`,
      );
    cursor = nameEnd + extraLength + commentLength;
  }
}

function hash(bytes: Uint8Array): string {
  return bytesToHex(sha256(bytes));
}

function bundleOptions(manifest: BundleManifest): BundleOptions {
  if (manifest.kind === "release") {
    if (!manifest.release) {
      throw new BundleImportError("SF_BUNDLE_SCHEMA_INVALID", "Release metadata is missing.");
    }
    return {
      kind: "release",
      sourceRevision: manifest.release.sourceRevision,
      version: manifest.release.version,
    };
  }
  if (!manifest.preview) {
    throw new BundleImportError("SF_BUNDLE_SCHEMA_INVALID", "Preview metadata is missing.");
  }
  return { kind: "preview", sourceRevision: manifest.preview.sourceRevision };
}

function verifyChecksums(files: Record<string, Uint8Array>): void {
  const checksumBytes = files[CHECKSUM_PATH];
  if (!checksumBytes) {
    throw new BundleImportError("SF_BUNDLE_CHECKSUM_MISMATCH", "checksums.sha256 is missing.");
  }

  let lines: string[];
  try {
    lines = decoder.decode(checksumBytes).trim().split("\n");
  } catch {
    throw new BundleImportError("SF_BUNDLE_CHECKSUM_MISMATCH", "checksums.sha256 is not UTF-8.");
  }

  const seen = new Set<string>();
  for (const line of lines) {
    const match = /^([0-9a-f]{64})  (.+)$/.exec(line);
    if (!match?.[1] || !match[2] || seen.has(match[2])) {
      throw new BundleImportError(
        "SF_BUNDLE_CHECKSUM_MISMATCH",
        "checksums.sha256 contains an invalid entry.",
      );
    }
    const bytes = files[match[2]];
    if (!bytes || hash(bytes) !== match[1]) {
      throw new BundleImportError(
        "SF_BUNDLE_CHECKSUM_MISMATCH",
        `Checksum verification failed for "${match[2]}".`,
      );
    }
    seen.add(match[2]);
  }

  const expected = Object.keys(files).filter((path) => path !== CHECKSUM_PATH);
  if (expected.some((path) => !seen.has(path)) || seen.size !== expected.length) {
    throw new BundleImportError(
      "SF_BUNDLE_CHECKSUM_MISMATCH",
      "checksums.sha256 does not cover every bundle entry exactly once.",
    );
  }
}

function verifyManifestPayload(files: Record<string, Uint8Array>, manifest: BundleManifest): void {
  const actualPayload = Object.keys(files)
    .filter((path) => path !== MANIFEST_PATH && path !== CHECKSUM_PATH)
    .sort();
  const declaredPayload = manifest.files.map((file) => file.path).sort();
  if (
    actualPayload.length !== declaredPayload.length ||
    actualPayload.some((path, index) => path !== declaredPayload[index])
  ) {
    throw new BundleImportError(
      "SF_BUNDLE_SCHEMA_INVALID",
      "Manifest payload entries do not match ZIP contents.",
    );
  }

  for (const entry of manifest.files) {
    const bytes = files[entry.path];
    if (!bytes || bytes.byteLength !== entry.bytes || hash(bytes) !== entry.sha256) {
      throw new BundleImportError(
        "SF_BUNDLE_CHECKSUM_MISMATCH",
        `Manifest integrity verification failed for "${entry.path}".`,
      );
    }
  }
}

function verifyRecompiledPayload(
  files: Record<string, Uint8Array>,
  source: StyleflowProjectSource,
  manifest: BundleManifest,
): void {
  let rebuilt;
  try {
    rebuilt = buildBundle(source, bundleOptions(manifest));
  } catch (error) {
    if (error instanceof BundleBuildError) {
      throw new BundleImportError("SF_BUNDLE_ROUNDTRIP_FAILED", error.message, error.diagnostics);
    }
    throw error;
  }
  const rebuiltFiles = unzipSync(rebuilt.bytes);
  for (const entry of manifest.files) {
    const original = files[entry.path];
    const generated = rebuiltFiles[entry.path];
    if (!original || !generated || hash(original) !== hash(generated)) {
      throw new BundleImportError(
        "SF_BUNDLE_RESOLVED_MISMATCH",
        `Recompiled payload differs at "${entry.path}".`,
      );
    }
  }
}

export function importBundle(
  bytes: Uint8Array,
  limits: ImportLimits = DEFAULT_IMPORT_LIMITS,
): ImportedBundle {
  if (bytes.byteLength > limits.maxCompressedBytes) {
    throw new BundleImportError(
      "SF_BUNDLE_SIZE_LIMIT",
      "Compressed bundle exceeds the import limit.",
    );
  }
  preflightCentralDirectory(bytes, limits);

  let entryCount = 0;
  let compressedTotal = 0;
  let uncompressedTotal = 0;
  const caseFolded = new Set<string>();
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(bytes, {
      filter(entry) {
        validatePath(entry.name);
        const folded = entry.name.toLocaleLowerCase("en-US");
        if (caseFolded.has(folded)) {
          throw new BundleImportError(
            "SF_BUNDLE_PATH_INVALID",
            `Bundle contains duplicate case-folded path "${entry.name}".`,
          );
        }
        caseFolded.add(folded);
        entryCount += 1;
        compressedTotal += entry.size;
        uncompressedTotal += entry.originalSize;
        if (entryCount > limits.maxEntries || uncompressedTotal > limits.maxUncompressedBytes) {
          throw new BundleImportError(
            "SF_BUNDLE_SIZE_LIMIT",
            "Bundle expansion exceeds import limits.",
          );
        }
        if (entry.size > 0 && entry.originalSize / entry.size > limits.maxExpansionRatio) {
          throw new BundleImportError(
            "SF_BUNDLE_SIZE_LIMIT",
            `Bundle entry "${entry.name}" exceeds the compression ratio limit.`,
          );
        }
        return true;
      },
    });
  } catch (error) {
    if (error instanceof BundleImportError) throw error;
    throw new BundleImportError(
      "SF_BUNDLE_SCHEMA_INVALID",
      "ZIP container is invalid or unsupported.",
    );
  }

  if (compressedTotal === 0 || entryCount === 0) {
    throw new BundleImportError("SF_BUNDLE_SCHEMA_INVALID", "Bundle is empty.");
  }

  verifyChecksums(files);
  const manifest = parseJson<BundleManifest>(files[MANIFEST_PATH], MANIFEST_PATH);
  const manifestValidation = validateBundleManifest(manifest);
  if (!manifestValidation.valid) {
    throw new BundleImportError(
      "SF_BUNDLE_SCHEMA_INVALID",
      "Manifest does not conform to Styleflow Bundle v1.",
      manifestValidation.diagnostics,
    );
  }
  verifyManifestPayload(files, manifest);

  const source = parseJson<StyleflowProjectSource>(
    files["source/styleflow.project.json"],
    "source/styleflow.project.json",
  );
  if ((files["source/styleflow.project.json"]?.byteLength ?? 0) > limits.maxSourceBytes) {
    throw new BundleImportError(
      "SF_BUNDLE_SIZE_LIMIT",
      "Source document exceeds the 2 MiB import limit.",
    );
  }
  const sourceValidation = validateProjectSource(source);
  if (!sourceValidation.valid) {
    throw new BundleImportError(
      "SF_BUNDLE_SCHEMA_INVALID",
      "Source does not conform to Styleflow Project Source v1.",
      sourceValidation.diagnostics,
    );
  }

  const contractPath = "contract/styleflow.contract.json";
  const contract = parseJson<StyleflowSemanticContract>(files[contractPath], contractPath);
  assertPayload(contractPath, validateSemanticContract(contract));

  for (const path of Object.keys(files).filter(
    (entry) => entry.startsWith("tokens/") && entry.endsWith(".tokens.json"),
  )) {
    assertPayload(path, validateDtcgTokens(parseJson(files[path], path)));
  }
  const resolverPath = "resolver/styleflow.resolver.json";
  assertPayload(
    resolverPath,
    validateResolverProjection(parseJson(files[resolverPath], resolverPath)),
  );

  const resolved: ImportedBundle["resolved"] = {};
  for (const themeId of manifest.themes) {
    const resolvedContractPath = `resolved/${themeId}/styleflow.contract.json`;
    const resolvedTokensPath = `resolved/${themeId}/tokens.tokens.json`;
    const resolvedContract = parseJson<StyleflowResolvedThemeContract>(
      files[resolvedContractPath],
      resolvedContractPath,
    );
    const resolvedTokens = parseJson<DtcgTokenDocument>(
      files[resolvedTokensPath],
      resolvedTokensPath,
    );
    assertPayload(resolvedContractPath, validateSemanticContract(resolvedContract));
    assertPayload(resolvedTokensPath, validateDtcgTokens(resolvedTokens));
    if (resolvedContract.activeTheme !== themeId) {
      throw new BundleImportError(
        "SF_BUNDLE_RESOLVED_MISMATCH",
        `Resolved contract theme "${resolvedContract.activeTheme}" does not match "${themeId}".`,
      );
    }
    resolved[themeId] = { contract: resolvedContract, tokens: resolvedTokens };
  }

  verifyRecompiledPayload(files, source, manifest);
  const diagnostics = parseJson<Diagnostic[]>(
    files["diagnostics/diagnostics.json"],
    "diagnostics/diagnostics.json",
  );
  assertPayload("diagnostics/diagnostics.json", validateDiagnostics(diagnostics));
  return { manifest, source, diagnostics, contract, resolved };
}
