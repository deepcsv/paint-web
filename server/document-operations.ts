import { METHODS, type TransactionOperation } from "../shared/protocol.js";
import type { z } from "zod";
import { RpcError } from "./rpc/errors.js";

const DOCUMENT_MUTATION_PREFIXES = ["draw.", "filter.", "layer."];
const DOCUMENT_MUTATION_METHODS = new Set([
  "canvas.resize",
  "canvas.clear",
  "canvas.fill",
  "canvas.import",
  "snapshot.load",
]);
const RASTER_KEYFRAME_METHODS = new Set(["canvas.import", "snapshot.load"]);

/** Mutations that become canonical document commits. */
export function isDocumentMutationMethod(method: string): boolean {
  if (method === "layer.list") return false;
  return (
    DOCUMENT_MUTATION_METHODS.has(method) ||
    DOCUMENT_MUTATION_PREFIXES.some((prefix) => method.startsWith(prefix))
  );
}

/** Operations whose durable source is raster content rather than stable params. */
export function needsRasterKeyframe(method: string): boolean {
  return RASTER_KEYFRAME_METHODS.has(method);
}

/** Validate every transaction operation before any renderer mutation occurs. */
export function validateTransactionOperations(
  operations: TransactionOperation[],
): TransactionOperation[] {
  return operations.map((operation, index) => {
    if (!isDocumentMutationMethod(operation.method)) {
      throw RpcError.invalidParams({
        index,
        method: operation.method,
        reason: "Only canonical canvas/layer/draw/filter mutations are transaction-safe",
      });
    }
    if (operation.method === "draw.batch") {
      throw RpcError.invalidParams({
        index,
        method: operation.method,
        reason: "Nested draw.batch is not allowed inside transaction.execute",
      });
    }
    const definition = METHODS[operation.method];
    if (!definition) {
      throw RpcError.methodNotFound(operation.method);
    }
    if (!definition.params) return { method: operation.method, params: operation.params };
    const parsed = (definition.params as z.ZodTypeAny).safeParse(operation.params);
    if (!parsed.success) {
      throw RpcError.invalidParams({ index, method: operation.method, issues: parsed.error.issues });
    }
    return { method: operation.method, params: parsed.data };
  });
}

/** Validate a draw.batch completely before any of its operations execute. */
export function validateDrawBatchOperations(
  operations: TransactionOperation[],
): TransactionOperation[] {
  return operations.map((operation, index) => {
    if (
      operation.method === "draw.batch" ||
      (!operation.method.startsWith("draw.") && !operation.method.startsWith("filter."))
    ) {
      throw RpcError.invalidParams({
        index,
        method: operation.method,
        reason: "draw.batch only allows non-nested draw.* and filter.* operations",
      });
    }
    const definition = METHODS[operation.method];
    if (!definition) throw RpcError.methodNotFound(operation.method);
    if (!definition.params) return operation;
    const parsed = (definition.params as z.ZodTypeAny).safeParse(operation.params);
    if (!parsed.success) {
      throw RpcError.invalidParams({ index, method: operation.method, issues: parsed.error.issues });
    }
    return { method: operation.method, params: parsed.data };
  });
}
