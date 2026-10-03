import type { NativeStart } from "../shared/native-contracts.js";

export async function startNativeWithReceiptRetry<T>(
  start: (input: NativeStart) => Promise<T>,
  input: NativeStart,
): Promise<T> {
  try {
    return await start(input);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (
      !/^(?:Request failed: )?Plugin RPC timed out: agent-factory\.invoke(?: requestType=plugin\.rpc\.invoke\.request code=handler_error)?$/.test(
        message,
      )
    )
      throw error;
    return start(input);
  }
}
