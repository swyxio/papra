# SwyxDrive layout and folder navigation audit — 2026-09-24

Read-only audit. No code, deployment, permissions, documents, or account settings changed.

## Coverage and counts

The complete active client route tree was inspected. There are 25 distinct page components, represented by 26 URL patterns because login and registration use the same page. Root redirects and short-name aliases are not additional screens. Unregistered legacy/admin pages are excluded.

- 18 signed-in application screens: 14 use OrganizationLayout; 4 do not.
- Of those 4, 2 have no sidebar, and 2 use alternate settings sidebars.
- 7 public/system screen types also sit outside OrganizationLayout.
- Total outside the common organization layout: 11 page types. Total without any sidebar layout: 9.

Live Chrome checks used the currently authenticated swyx@latent.space account, without changing identity. Visually inspected Your spaces, Latent Space dashboard, Documents/folders, space settings, account settings, and signing introduction. Checked Your spaces and the organization navigation drawer at 390×844, then restored browser sizing. Token-specific signing/review/share pages and the PDF viewer were classified from source, not exercised end to end. This is complete route coverage, not a claim that every page state was visually tested.

## Signed-in pages using the common layout

| Screen | Route | Audit evidence |
|---|---|---|
| Space dashboard | `/orgs/:space` | Live desktop + mobile |
| Documents / folders | `/orgs/:space/documents` | Live desktop; source confirms folder scope |
| Create doc from template | `/orgs/:space/documents/new` | Source |
| Document editor | `/orgs/:space/documents/:id/editor` | Source |
| Request signatures | `/orgs/:space/documents/:id/signing` | Source |
| Document details | `/orgs/:space/documents/:id` | Source |
| Deleted documents | `/orgs/:space/deleted` | Source |
| Tags | `/orgs/:space/tags` | Source |
| Saved document view | `/orgs/:space/views/:id` | Source |
| Custom properties | `/orgs/:space/custom-properties` | Source |
| Create custom property | `/orgs/:space/custom-properties/create` | Source |
| Edit custom property | `/orgs/:space/custom-properties/:id` | Source |
| Share links | `/orgs/:space/share-links` | Source |
| Members | `/orgs/:space/members` | Source |

## Signed-in layout exceptions

| Screen | Route | Current layout | Audit evidence |
|---|---|---|---|
| Your spaces | `/orgs` | None; no account controls | Live desktop + 390px mobile |
| Full-screen PDF viewer | `/orgs/:space/documents/:id/pdf-viewer` | None; PDF-only filename / close header | Source |
| Space settings | `/orgs/:space/settings` | Alternate settings sidebar; account menu retained | Live desktop |
| Account settings | `/settings` | Alternate account sidebar; no normal app header | Live desktop |

## Public and system pages

These should remain usable without an account. Public links need a consistent public header with Sign in / Open my Drive, rather than requiring access to an organization sidebar. Signed-in visits can preserve account context without exposing private team navigation to anonymous recipients.

| Screen | Route | Current layout |
|---|---|---|
| Login / register | `/login, /register` | Authentication layout |
| About | `/about` | Standalone; back-to-home |
| Signing introduction | `/sign` | Standalone; Open Drive link |
| Recipient signing | `/sign/:token` | Standalone; no account needed |
| External review | `/review/:token` | Standalone bearer-link review |
| Shared document | `/s/:token/:title?` | Public brand header; appearance menu, no account-aware navigation |
| Not found | `Unmatched URL` | Standalone; back-to-home |

## Findings

1. **Your spaces bypasses the shared layout.** Cards show only a generic folder icon and a space name. There is no account identity, account menu, sign-out control, navigation drawer, personal/team badge, membership role, file count, storage size, or recent activity. These cards represent organizations/spaces, not ordinary folders.
2. **Space entry adds a dashboard hop.** Both space cards and the organization switcher target the space root, which displays upload/statistics/latest documents rather than folder contents. Reaching folders requires selecting Documents. A recent file may already be reachable from the dashboard, but folder browsing is not.
3. **Documents contains two file lists with different scopes.** DriveFolders displays the current folder’s files, while the paginated table underneath fetches all accessible documents in the space. Opening a child folder changes the upper panel but does not filter the lower table. This is a source of duplicate rows and scope confusion.
4. **Folder metadata is underdeveloped.** Child folder buttons display name and an optional restricted-folder icon. File rows in the folder panel display name and size. The worker folder DTO already sends createdAt/updatedAt, but the client DriveFolder type and UI omit them. Counts, aggregate sizes, uploader/owner information, and recent file activity are not provided by the folder-list response.
5. **Settings changes navigation context.** Space settings has a small settings sidebar and account menu; account settings has an account-only sidebar and no common app header. Neither retains the normal space switcher/main navigation.
6. **PDF focus mode has a navigation error state.** A valid PDF has a filename/close header, but the non-PDF fallback has no close/back control. The PDF page also requests the entire file independently of the MIME check. These were source findings; no large media was downloaded to test them.
7. **Public pages use unrelated headers.** Shared files have a SwyxDrive brand/appearance menu, signing has a text label, and review still says “swyx Drive.” They lack a consistent account-aware Sign in / Open Drive header. Anonymous signing and review must continue to work without an account.
8. **Root recovery states are incomplete.** When the organization query fails, the root redirect has no explicit error/retry UI. With zero assigned spaces it tells the user to sign out/in without supplying the account controls to do so. The spaces index also says “Please try again” without a retry button.

## Recommended implementation sequence

1. Extract shared signed-in app chrome that works with or without a selected space. Use it for Your spaces and both settings pages; preserve account identity and navigation on loading/error/empty states.
2. Make selecting a space open its Home folder directly. Keep the recent-documents dashboard as a separate optional destination.
3. Use one folder-scoped file table with breadcrumbs. Make “All files” / space-wide search an explicit mode rather than a second concurrent list.
4. Add compact metadata to space cards and folder rows: personal/team and effective access, item counts, bytes, recent file activity. Aggregate only items visible to the viewer, in bounded queries. Folder updatedAt currently reflects folder changes and must not be mislabeled as the latest content activity.
5. Treat the PDF viewer as explicit focus mode with a reliable back control in every state. Give public signing/review/shares a shared public header and account-aware entry link.

## Source references

- [routes.tsx](/Users/swyx/Work/papra/apps/papra-client/src/routes.tsx)
- [index.tsx](/Users/swyx/Work/papra/apps/papra-client/src/index.tsx)
- [modules/organizations/pages/organizations.page.tsx](/Users/swyx/Work/papra/apps/papra-client/src/modules/organizations/pages/organizations.page.tsx)
- [modules/organizations/pages/organization.page.tsx](/Users/swyx/Work/papra/apps/papra-client/src/modules/organizations/pages/organization.page.tsx)
- [modules/ui/layouts/organization.layout.tsx](/Users/swyx/Work/papra/apps/papra-client/src/modules/ui/layouts/organization.layout.tsx)
- [modules/ui/layouts/settings.layout.tsx](/Users/swyx/Work/papra/apps/papra-client/src/modules/ui/layouts/settings.layout.tsx)
- [modules/ui/layouts/organization-settings.layout.tsx](/Users/swyx/Work/papra/apps/papra-client/src/modules/ui/layouts/organization-settings.layout.tsx)
- [modules/documents/pages/documents.page.tsx](/Users/swyx/Work/papra/apps/papra-client/src/modules/documents/pages/documents.page.tsx)
- [modules/documents/pages/document-pdf-viewer.page.tsx](/Users/swyx/Work/papra/apps/papra-client/src/modules/documents/pages/document-pdf-viewer.page.tsx)
- [modules/drive-collaboration/drive-folders.component.tsx](/Users/swyx/Work/papra/apps/papra-client/src/modules/drive-collaboration/drive-folders.component.tsx)
- [modules/drive-collaboration/drive-collaboration.services.ts](/Users/swyx/Work/papra/apps/papra-client/src/modules/drive-collaboration/drive-collaboration.services.ts)
- [modules/drive-signing/signing.pages.tsx](/Users/swyx/Work/papra/apps/papra-client/src/modules/drive-signing/signing.pages.tsx)
- [modules/drive-signing/review.pages.tsx](/Users/swyx/Work/papra/apps/papra-client/src/modules/drive-signing/review.pages.tsx)
- [modules/document-share-links/pages/shared-document.page.tsx](/Users/swyx/Work/papra/apps/papra-client/src/modules/document-share-links/pages/shared-document.page.tsx)
- [Worker folder API](/Users/swyx/Work/papra/apps/papra-worker/src/collaboration.ts:222)
