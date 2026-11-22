/**
 * The toast for a send that failed before the prompt reached the agent, such
 * as a draft session that could not be created. A failure code with a catalog
 * sentence under `errors.<code>` shows that sentence; any other failure keeps
 * its own message so it stays diagnosable.
 */
export type SendFailureTranslate = (key: string, options?: Record<string, unknown>) => string;

export function sendFailureText(t: SendFailureTranslate, error: unknown): string {
  const fallback = error instanceof Error ? error.message : String(error);
  const code = (error as { code?: unknown } | null | undefined)?.code;
  const reason = typeof code === "string" && /^[A-Z][A-Z0-9_]*$/.test(code)
    ? t(`errors.${code}`, { defaultValue: fallback })
    : fallback;
  return t("sessionTarget.sendFailure.message", { message: reason });
}
