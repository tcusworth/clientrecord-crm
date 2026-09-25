// A proposal's share_token lets anyone sign it through /proposal/[token]. Strip it from every
// row that leaves the server (API responses, AI context) so only the share link builder sees it.
export function withoutShareToken<T extends Record<string, unknown>>(row: T): Omit<T, "share_token"> {
  return Object.fromEntries(Object.entries(row).filter(([key]) => key !== "share_token")) as Omit<T, "share_token">;
}
