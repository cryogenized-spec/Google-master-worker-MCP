import type { ConsentDescription } from "@cloudflare/workers-oauth-provider";

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, c => "&#" + c.charCodeAt(0) + ";");
}

/** Interpolate exclusively escaped client-controlled strings. */
export function renderConsent(details: ConsentDescription, handle: string): string {
  const name = escapeHtml(details.clientName);
  const domain = details.clientDomain
    ? "Verified client domain: " + escapeHtml(details.clientDomain)
    : "The app name is self-reported and not verified.";
  const scopeOptions = details.scope.map(scope =>
    '<label><input type="checkbox" name="scope" value="' + escapeHtml(scope) +
    '" checked> ' + escapeHtml(scope) + '</label>'
  ).join("\n");
  const localWarning = details.redirectIsLoopback
    ? "<p><strong>Local application:</strong> approve only if you started this login.</p>"
    : "";
  return [
    '<!doctype html><html lang="en"><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width,initial-scale=1">',
    '<title>Authorize ', name, '</title>',
    '<style>body{font:16px system-ui;max-width:650px;margin:4rem auto;padding:0 1.5rem;',
    'line-height:1.55;color:#e8eef6;background:#111827}',
    'button{padding:.7rem 1.2rem;margin:.8rem .5rem .8rem 0;border-radius:.5rem}',
    'label{display:block;padding:.45rem 0}strong{color:#fff}small{color:#a8b3c2}</style>',
    '</head><body><h1>Allow ', name, ' to access Google Master Worker?</h1>',
    '<p><small>', domain, '</small></p><p>Tokens will be sent to ',
    '<strong>', escapeHtml(details.redirectHost), '</strong>.</p>',
    localWarning, '<form method="post" action="/authorize">',
    '<input type="hidden" name="handle" value="', escapeHtml(handle), '">',
    '<p><strong>Requested permissions</strong></p>', scopeOptions,
    '<p><button type="submit" name="decision" value="approve">Allow selected</button>',
    '<button type="submit" name="decision" value="deny">Deny</button></p></form>',
    '<p><small>This client authorization does not connect your Google Workspace data.',
    ' Google Workspace permissions require separate authorization.</small></p>',
    '</body></html>'
  ].join("");
}
