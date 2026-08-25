import type { DraftOperation, OnColorRolePath, TokenReference } from "./types";
import { ANCHOR_POSITIONS, BORDER_ROLES, FOREGROUND_ROLES, INTERMEDIATE_POSITIONS } from "./types";

const TOKEN_REFERENCE_PATTERN = /^color\.[a-z0-9][a-z0-9_-]*\.[a-z0-9][a-z0-9_-]*$/;
const IDENTIFIER_PATTERN = /^[a-z0-9][a-z0-9_-]{0,127}$/;
const SUPPORTED_TYPES = new Set<DraftOperation["type"]>([
  "replace-source",
  "set-project-metadata",
  "set-accessibility",
  "set-authoring-status",
  "create-color-ramp",
  "update-color-ramp",
  "delete-color-ramp",
  "set-ramp-stop",
  "reset-ramp-stop",
  "upsert-intensity-level",
  "delete-intensity-level",
  "set-intensity-mapping",
  "upsert-theme",
  "delete-theme",
  "set-on-color",
  "auto-solve-on-color",
  "relative-on-color",
  "interpolate-on-color",
  "copy-on-color-roles",
  "reset-on-color",
  "set-theme-override",
  "set-surface-recipe",
  "upsert-interaction-priority",
  "delete-interaction-priority",
  "upsert-interaction-recipe",
  "delete-interaction-recipe",
  "set-interaction-mappings",
  "upsert-layout-scale-entry",
  "delete-layout-scale-entry",
  "upsert-breakpoint",
  "delete-breakpoint",
  "set-layout-cell",
  "bulk-set-layout-cells",
  "upsert-font-slot",
  "delete-font-slot",
  "upsert-typography-type",
  "delete-typography-type",
  "upsert-typography-variant",
  "delete-typography-variant",
  "upsert-typography-weight",
  "delete-typography-weight",
  "set-typography-generator",
  "set-typography-recipe",
  "set-agent-policy",
]);

export interface DraftOperationParseFailure {
  success: false;
  errors: string[];
}
export interface DraftOperationParseSuccess {
  success: true;
  data: DraftOperation[];
}
export type DraftOperationParseResult = DraftOperationParseFailure | DraftOperationParseSuccess;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isIdentifier(value: unknown): value is string {
  return typeof value === "string" && IDENTIFIER_PATTERN.test(value);
}

function isTokenReference(value: unknown): value is TokenReference {
  return typeof value === "string" && TOKEN_REFERENCE_PATTERN.test(value);
}

function isBoundedJson(value: unknown, depth = 0): boolean {
  if (depth > 16) return false;
  if (value === null || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value === "string") return value.length <= 10_000;
  if (Array.isArray(value))
    return value.length <= 1_000 && value.every((item) => isBoundedJson(item, depth + 1));
  if (!isRecord(value) || Object.keys(value).length > 1_000) return false;
  return Object.entries(value).every(
    ([key, item]) => key.length <= 200 && isBoundedJson(item, depth + 1),
  );
}

function isTarget(value: unknown): value is OnColorRolePath {
  if (!isRecord(value)) return false;
  return value.group === "foreground"
    ? typeof value.role === "string" && FOREGROUND_ROLES.includes(value.role as never)
    : value.group === "border" &&
        typeof value.role === "string" &&
        BORDER_ROLES.includes(value.role as never);
}

function validIds(value: Record<string, unknown>, ...keys: string[]): boolean {
  return keys.every((key) => isIdentifier(value[key]));
}

function structurallyValid(value: Record<string, unknown>): boolean {
  switch (value.type) {
    case "replace-source":
      return isRecord(value.source) && (value.reason === "import" || value.reason === "restore");
    case "set-project-metadata":
      return (
        typeof value.name === "string" &&
        value.name.trim().length > 0 &&
        value.name.length <= 120 &&
        (value.description === undefined || typeof value.description === "string")
      );
    case "set-accessibility":
      return (
        (value.level === "AA" || value.level === "AAA") &&
        (value.policy === "warning" || value.policy === "block")
      );
    case "set-authoring-status":
      return value.status === "incomplete" || value.status === "complete";
    case "create-color-ramp":
      return isRecord(value.ramp) && isIdentifier(value.ramp.id);
    case "update-color-ramp":
      return (
        isIdentifier(value.toneId) && isRecord(value.patch) && typeof value.regenerate === "boolean"
      );
    case "delete-color-ramp":
      return (
        isIdentifier(value.toneId) &&
        (value.replacementToneId === undefined || isIdentifier(value.replacementToneId))
      );
    case "set-ramp-stop":
      return isIdentifier(value.toneId) && isRecord(value.stop);
    case "reset-ramp-stop":
      return (
        isIdentifier(value.toneId) &&
        typeof value.position === "string" &&
        [...ANCHOR_POSITIONS, ...INTERMEDIATE_POSITIONS].includes(value.position as never)
      );
    case "upsert-intensity-level":
      return isIdentifier(value.toneId) && isRecord(value.level) && isIdentifier(value.level.id);
    case "delete-intensity-level":
      return (
        validIds(value, "toneId", "levelId") &&
        (value.replacementLevelId === undefined || isIdentifier(value.replacementLevelId))
      );
    case "set-intensity-mapping":
      return validIds(value, "toneId", "themeId", "levelId") && typeof value.position === "string";
    case "upsert-theme":
      return isRecord(value.theme) && isIdentifier(value.theme.id);
    case "delete-theme":
      return (
        isIdentifier(value.themeId) &&
        (value.reparentChildrenTo === undefined || isIdentifier(value.reparentChildrenTo))
      );
    case "set-on-color":
      return (
        Array.isArray(value.backgroundRefs) &&
        value.backgroundRefs.every(isTokenReference) &&
        isTarget(value.target) &&
        isTokenReference(value.tokenRef) &&
        ["generated", "bulk", "manual"].includes(String(value.provenance))
      );
    case "auto-solve-on-color":
      return (
        Array.isArray(value.backgroundRefs) &&
        value.backgroundRefs.every(isTokenReference) &&
        isTarget(value.target)
      );
    case "relative-on-color":
      return (
        Array.isArray(value.backgroundRefs) &&
        value.backgroundRefs.every(isTokenReference) &&
        isTarget(value.target) &&
        Number.isInteger(value.offset) &&
        Math.abs(Number(value.offset)) <= 20 &&
        (value.toneId === undefined || isIdentifier(value.toneId))
      );
    case "interpolate-on-color":
      return (
        Array.isArray(value.backgroundRefs) &&
        value.backgroundRefs.every(isTokenReference) &&
        isTarget(value.target) &&
        isTokenReference(value.startRef) &&
        isTokenReference(value.endRef)
      );
    case "copy-on-color-roles":
      return (
        isTokenReference(value.sourceBackgroundRef) &&
        Array.isArray(value.backgroundRefs) &&
        value.backgroundRefs.every(isTokenReference) &&
        Array.isArray(value.groups) &&
        value.groups.every((item) => item === "foreground" || item === "border")
      );
    case "reset-on-color":
      return Array.isArray(value.backgroundRefs) && value.backgroundRefs.every(isTokenReference);
    case "set-theme-override":
      return (
        validIds(value, "themeId") &&
        isTokenReference(value.tokenRef) &&
        (value.value === null || typeof value.value === "string")
      );
    case "set-surface-recipe":
      return isRecord(value.recipe) && validIds(value.recipe, "toneId", "intensity");
    case "upsert-interaction-priority":
      return isRecord(value.priority) && isIdentifier(value.priority.id);
    case "delete-interaction-priority":
      return isIdentifier(value.priorityId);
    case "upsert-interaction-recipe":
      return (
        isRecord(value.recipe) && isIdentifier(value.recipe.id) && isRecord(value.recipe.states)
      );
    case "delete-interaction-recipe":
      return (
        isIdentifier(value.recipeId) &&
        (value.replacementRecipeId === undefined || isIdentifier(value.replacementRecipeId))
      );
    case "set-interaction-mappings":
      return (
        Array.isArray(value.mappings) &&
        value.mappings.length <= 10_000 &&
        value.mappings.every(
          (mapping) =>
            isRecord(mapping) &&
            validIds(mapping, "themeId", "priorityId", "recipeId") &&
            isTokenReference(mapping.contextBackgroundRef),
        )
      );
    case "upsert-layout-scale-entry":
      return (
        typeof value.scale === "string" && isRecord(value.entry) && isIdentifier(value.entry.id)
      );
    case "delete-layout-scale-entry":
      return (
        typeof value.scale === "string" &&
        isIdentifier(value.entryId) &&
        (value.replacementEntryId === undefined || isIdentifier(value.replacementEntryId))
      );
    case "upsert-breakpoint":
      return isRecord(value.breakpoint) && isIdentifier(value.breakpoint.id);
    case "delete-breakpoint":
      return isIdentifier(value.breakpointId);
    case "set-layout-cell":
      return isRecord(value.edit) && validIds(value.edit, "breakpointId");
    case "bulk-set-layout-cells":
      return Array.isArray(value.edits) && value.edits.length > 0 && value.edits.every(isRecord);
    case "upsert-font-slot":
      return isRecord(value.fontSlot) && isIdentifier(value.fontSlot.id);
    case "delete-font-slot":
      return (
        isIdentifier(value.fontSlotId) &&
        (value.replacementFontSlotId === undefined || isIdentifier(value.replacementFontSlotId))
      );
    case "upsert-typography-type":
      return isRecord(value.typographyType) && isIdentifier(value.typographyType.id);
    case "delete-typography-type":
      return (
        isIdentifier(value.typeId) &&
        (value.replacementTypeId === undefined || isIdentifier(value.replacementTypeId))
      );
    case "upsert-typography-variant":
      return (
        isIdentifier(value.typeId) && isRecord(value.variant) && isIdentifier(value.variant.id)
      );
    case "delete-typography-variant":
      return (
        validIds(value, "typeId", "variantId") &&
        (value.replacementVariantId === undefined || isIdentifier(value.replacementVariantId))
      );
    case "upsert-typography-weight":
      return isRecord(value.weight) && isIdentifier(value.weight.id);
    case "delete-typography-weight":
      return (
        isIdentifier(value.weightId) &&
        (value.replacementWeightId === undefined || isIdentifier(value.replacementWeightId))
      );
    case "set-typography-generator":
      return isRecord(value.generator) && Array.isArray(value.generatedRecipes);
    case "set-typography-recipe":
      return isRecord(value.recipe) && validIds(value.recipe, "tyId", "variantId", "weightId");
    case "set-agent-policy":
      return isRecord(value.policy);
    default:
      return false;
  }
}

function parseOperation(value: unknown): DraftOperation | null {
  if (
    !isRecord(value) ||
    typeof value.type !== "string" ||
    !SUPPORTED_TYPES.has(value.type as DraftOperation["type"]) ||
    !isBoundedJson(value) ||
    !structurallyValid(value)
  )
    return null;
  return structuredClone(value) as DraftOperation;
}

export function parseDraftOperationBatch(
  value: unknown,
  maximumOperations = 250,
): DraftOperationParseResult {
  if (!Array.isArray(value) || value.length === 0)
    return { success: false, errors: ["At least one operation is required."] };
  if (value.length > maximumOperations)
    return {
      success: false,
      errors: [`Operation batch exceeds the limit of ${maximumOperations}.`],
    };
  const operations: DraftOperation[] = [];
  const errors: string[] = [];
  for (const [index, candidate] of value.entries()) {
    const operation = parseOperation(candidate);
    if (operation) operations.push(operation);
    else errors.push(`Operation at index ${index} is not supported or contains invalid fields.`);
  }
  return errors.length ? { success: false, errors } : { success: true, data: operations };
}
