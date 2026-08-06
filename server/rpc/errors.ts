import {
  JSONRPC_VERSION,
  RpcErrorCode,
  type JsonRpcError,
  type JsonRpcResponse,
  type RpcId,
} from "../../shared/protocol.js";

export class RpcError extends Error {
  constructor(
    public readonly code: number,
    message: string,
    public readonly data?: unknown,
  ) {
    super(message);
    this.name = "RpcError";
  }

  toObject(): JsonRpcError {
    const e: JsonRpcError = { code: this.code, message: this.message };
    if (this.data !== undefined) e.data = this.data;
    return e;
  }

  static toResponse(id: RpcId | undefined, err: unknown): JsonRpcResponse {
    const e =
      err instanceof RpcError
        ? err
        : RpcError.internal(err instanceof Error ? err.message : String(err));
    return {
      jsonrpc: JSONRPC_VERSION,
      id: id ?? 0,
      error: e.toObject(),
    };
  }

  static parseError(data?: unknown) {
    return new RpcError(RpcErrorCode.PARSE_ERROR, "Parse error", data);
  }
  static invalidRequest(data?: unknown) {
    return new RpcError(RpcErrorCode.INVALID_REQUEST, "Invalid Request", data);
  }
  static methodNotFound(method: string) {
    return new RpcError(RpcErrorCode.METHOD_NOT_FOUND, `Method not found: ${method}`);
  }
  static invalidParams(data?: unknown) {
    return new RpcError(RpcErrorCode.INVALID_PARAMS, "Invalid params", data);
  }
  static internal(message: string, data?: unknown) {
    return new RpcError(RpcErrorCode.INTERNAL_ERROR, message, data);
  }
  static noPrimary() {
    return new RpcError(RpcErrorCode.NO_PRIMARY, "No primary browser available");
  }
  static primaryTimeout() {
    return new RpcError(RpcErrorCode.PRIMARY_TIMEOUT, "Primary browser timed out");
  }
  static fontNotLoaded(font: string) {
    return new RpcError(RpcErrorCode.FONT_NOT_LOADED, `Font not loaded: ${font}`);
  }
  static layerNotFound(layerId: string) {
    return new RpcError(RpcErrorCode.LAYER_NOT_FOUND, `Layer not found: ${layerId}`);
  }
  static outOfBounds(x: number, y: number) {
    return new RpcError(RpcErrorCode.OUT_OF_BOUNDS, `Out of bounds: (${x},${y})`);
  }
  static snapshotTooLarge(size: number) {
    return new RpcError(RpcErrorCode.SNAPSHOT_TOO_LARGE, `Snapshot too large: ${size} bytes`);
  }
  static notAuthorized() {
    return new RpcError(RpcErrorCode.NOT_AUTHORIZED, "Not authorized");
  }
}
