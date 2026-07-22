// Human-readable rendering of the §9.1 preflight reason codes returned by
// POST /api/forms/{id}/encryption as private_enable_blocked's details.reasons[].
// The preflight is strict BY DESIGN (standalone-only, unpublished, empty, no
// webhooks/flows/links, no file/camera/linked_record fields) — the wording must
// make that legible instead of reading as a generic failure.

const REASON_TEXT: Record<string, string> = {
  ever_published: 'This form was published before encryption existed and can never be made private.',
  already_enabled: 'This form is already end-to-end encrypted.',
  has_responses: 'The form already has responses — only an empty form can be made private.',
  pending_uploads: 'There are unfinished file uploads on this form.',
  has_webhooks: 'The form has webhooks — remove them first (a webhook would receive plaintext).',
  has_flow_bindings: 'A flow is bound to this form — remove the binding first.',
  has_flow_nodes: 'A flow references this form — remove those flow steps first.',
  has_report_specs: 'A report or dashboard widget references this form — remove it first.',
  has_custom_screen: 'The form has a custom screen — remove it first.',
  has_response_links: 'The form has shared response links — remove them first.',
  targeted_by_linked_record: "Another form's linked-record field points at this form — remove that link first.",
  blocked_field_types: 'The form has file upload, camera, or linked-record fields, which encrypted forms do not support yet.',
  attached_to_app: 'The form belongs to an app — encrypted forms must be standalone for now.',
  no_vault: 'Set up your encryption vault first (Settings → Security).',
  form_not_found: 'The form could not be found on the server.',
  response_store_unreadable: 'The server could not verify the form has no responses — try again.',
  field_store_unreadable: 'The server could not verify the form’s fields — try again.',
};

export function describeEnableBlockReasons(reasons: string[]): string[] {
  return reasons.map((r) => REASON_TEXT[r] ?? `The form is not eligible (${r}).`);
}
