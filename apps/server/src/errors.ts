/** The message of anything thrown, for logs and status messages. */
export const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error));
