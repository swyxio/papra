# Link preview privacy

Internal document links (`/orgs/:space/documents/:id`, including the old
`/organizations/...` form) require the same account and folder permissions as
the app. An anonymous preview server sees a **Private document** card and a
short reference taken from the URL it already received. It cannot determine
whether the document exists. No filename, file type, size, workspace name,
transcript, notes, tags, comments, or document frame is disclosed.

A signed-in account that can read the document receives its current filename,
file type, and size in the page title and description. The image remains a
generic privacy card; it never embeds account-dependent information in a
public image URL. HTML uses `private, no-store`, `Vary: Cookie`, and
`noindex, nofollow, noarchive`.

Bearer share links (`/s/:token/...`) intentionally delegate access to anyone
who possesses the link, including a messaging preview server. Their existing
previews disclose the current filename, file type, and size. They do not add
transcripts, notes, comments, or extracted content. Password-protected shares
hide the filename; expired, revoked, deleted, or invalid shares remain generic.
Creating a bearer share does not make an internal document URL public or expose
the share token in its HTML.

Messaging services may retain a preview they previously fetched. Disabling a
share stops new fetches; it cannot recall cards already cached by another
service. Robot and cache directives do not guarantee that a third party deletes
information it has already received.

Use a bearer share when recipients should see the filename without signing in.
Publishing filenames on internal links would be a separate metadata disclosure
decision: filenames themselves can contain personal names or commercial terms.
This feature does not enable that disclosure.
