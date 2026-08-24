import Ajv2020, { type ErrorObject, type ValidateFunction } from "ajv/dist/2020.js";

import projectSchema from "../schemas/project.schema.json";
import manifestSchema from "../schemas/manifest.schema.json";
import contractSchema from "../schemas/contract.schema.json";
import diagnosticsSchema from "../schemas/diagnostics.schema.json";
import resolverSchema from "../schemas/resolver.schema.json";
import tokensSchema from "../schemas/tokens.schema.json";
import { validateProjectSemantics } from "./semantic-validator";
import type { Diagnostic, StyleflowProjectSource } from "./types";

const ajv = new Ajv2020({ allErrors: true, strict: true });
const validateProjectSchema = ajv.compile(projectSchema);
const validateManifestSchema = ajv.compile(manifestSchema);
const validateContractSchema = ajv.compile(contractSchema);
const validateDiagnosticsSchema = ajv.compile(diagnosticsSchema);
const validateResolverSchema = ajv.compile(resolverSchema);
const validateTokensSchema = ajv.compile(tokensSchema);

function schemaErrorToDiagnostic(error: ErrorObject): Diagnostic {
  const path = error.instancePath || "/";
  return {
    code: "SF_SCHEMA_INVALID",
    severity: "error",
    blocking: true,
    path,
    themeIds: [],
    message: `${path} ${error.message ?? "is invalid"}.`,
    suggestion: "Update the source to match Styleflow Project Source v1.",
  };
}

export interface ValidationResult {
  valid: boolean;
  diagnostics: Diagnostic[];
}

export function validateProjectSource(input: unknown): ValidationResult {
  const schemaValid = validateProjectSchema(input);
  if (!schemaValid) {
    const diagnostics = (validateProjectSchema.errors ?? []).map(schemaErrorToDiagnostic);
    return { valid: false, diagnostics };
  }

  const source = input as unknown as StyleflowProjectSource;
  const diagnostics = validateProjectSemantics(source);
  return { valid: diagnostics.every((diagnostic) => !diagnostic.blocking), diagnostics };
}

export function assertProjectSource(input: unknown): asserts input is StyleflowProjectSource {
  const validation = validateProjectSource(input);
  if (!validation.valid) {
    const message = validation.diagnostics.map((diagnostic) => diagnostic.message).join("\n");
    throw new Error(message);
  }
}

export function validateBundleManifest(input: unknown): ValidationResult {
  const valid = validateManifestSchema(input);
  const diagnostics = valid
    ? []
    : (validateManifestSchema.errors ?? []).map(schemaErrorToDiagnostic);
  return { valid: Boolean(valid), diagnostics };
}

function validatePublicPayload(
  input: unknown,
  validator: ValidateFunction<unknown>,
): ValidationResult {
  const valid = validator(input);
  return {
    valid: Boolean(valid),
    diagnostics: valid ? [] : (validator.errors ?? []).map(schemaErrorToDiagnostic),
  };
}

export function validateSemanticContract(input: unknown): ValidationResult {
  return validatePublicPayload(input, validateContractSchema);
}

export function validateDiagnostics(input: unknown): ValidationResult {
  return validatePublicPayload(input, validateDiagnosticsSchema);
}

export function validateResolverProjection(input: unknown): ValidationResult {
  return validatePublicPayload(input, validateResolverSchema);
}

export function validateDtcgTokens(input: unknown): ValidationResult {
  return validatePublicPayload(input, validateTokensSchema);
}
