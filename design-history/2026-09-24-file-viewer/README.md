# Viewer first — selected direction B

Approved contract: viewer first for every file type; Details closed by default; secondary file controls under More. Native video/audio playback and expanded transcript with copy, text download and timestamp seeking. PDF review/signing remains accessible only for PDFs. Preserve permissions, account, workspace navigation, imports, exports, comments, versions, activity, notes, tags, custom properties and destructive confirmations.

Selected B prioritizes the file and readable transcript over administrative controls. Generated direction is an exploratory acceptance reference, not a production raster asset. Production uses existing semantic tokens and native components. Deliberate adaptation: preserve the existing lime primary color and app shell rather than recreating generated branding.

## Final delta ledger

| Delta | Correction / disposition |
| --- | --- |
| Portrait video consumed too much vertical space | Cap video at 480 CSS pixels on larger screens, 55vh on mobile, object contain |
| Metadata competed with file content | Closed Details sheet, native player and expanded transcript first |
| Details tabs cramped on phones | Five equal columns, smaller padding and type, minimum-width fixes |
| Removing Open with would lose existing export routes | Restored in Details for every file type, retained explicit PDF viewer link |
| Spaces had no shared context and required another click | Shared shell and direct link to files; role/access/count/size/activity summaries |
| Duplicate folder/document lists and undisclosed sharing | One scoped paginated list, folder breadcrumbs and permission-aware metadata |
| Export scope unclear inside folder | Button explicitly says Export space |
| Account loading/error could lose context | Same app shell in readiness mode; no private workspace queries before account verification |
| Focus viewer lacked reliable recovery | Back to file and account controls in loading/error/non-PDF states; signed ranged URL rather than full blob |

## Validation evidence

Visual checks were performed in Chrome with synthetic TEST ONLY fixtures at 390×844, 720×900, 834×1194 and 1440×900 CSS viewports. Chrome was zoomed to 67%; CDP layout metrics established the actual CSS viewport, independent of screenshot pixel dimensions. Screenshots are also recorded in this task's browser-tool outputs. Checked Details and More, transcript controls, folder metadata, spaces, account controls and navigation. No test fixtures were uploaded to production.

Local native-media playback was intermittently blocked by the computer-use URL safety checker (MEDIA_ELEMENT_ERROR: Media load rejected by URL safety check); this is not evidence of an application codec failure. Backend tests verify private signed media URLs, current-version ownership, deleted-file denial and transcript segment permissions. Live playback verification is reported separately in the handoff.

Routes: 17 normal signed-in page types share AppLayout via organization/settings/spaces layouts; the remaining signed-in PDF view deliberately retains focus chrome with exit/account. Seven public/system page types use consistent public chrome. Token-specific public signing/review flows are covered by source and backend tests; this release does not send signature requests or change sharing permissions.

Focused and full client/worker tests, both TypeScript checks and production build were run. Full worker suite passed 134 tests. Full client suite passed 281 tests with its existing unused-English-translation check failing; keys newly orphaned by this redesign were removed across locale dictionaries. The baseline failure is not suppressed.

Live verification: Cloudflare health and assets matched the release commit; existing Latent Space account successfully read the real Jev transcript, Details, space role/count/size summaries and folder-scoped file list. Native media playback was also rejected by the automation browser's URL safety checker on the live R2 source. Playback is implemented but cannot be claimed end-to-end verified in this automation session. Final mobile inspection also caught missing accessible names on icon-only quick search and date/created sort controls; corrected without altering their visual presentation.

Memory ledger candidates: Identify automation-specific media safety failures separately from app HTTP/codec failures. Validate actual CSS dimensions under browser zoom before naming a responsive screenshot.

Final desktop thumbnail: CDP JPEG capture at 1440×900 CSS pixels, scaled to 360×225 for the history artifact (quality 20). Full-resolution visual comparisons remain in the task browser outputs. Synthetic video frame is blank because of the automation media URL safety rejection, not because it was replaced by a static preview.
