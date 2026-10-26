// A single-quoted PowerShell string expands nothing, so doubling the quote is the only escape
// it needs. Every script built from caller data goes through this one function.
export function psLiteral(value) {
  return "'" + String(value).replaceAll("'", "''") + "'";
}
