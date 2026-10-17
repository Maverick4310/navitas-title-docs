# navitas-title-docs

Vendor upload page for a deal's titling documents (2026-10, Vendor Title Upload).

A rep sends a **Title Documents** link from the deal's Title Info tab in Salesforce
(`External_Form_Request__c`, emailed by `ExternalFormRequestService`). The vendor opens
`/?token=…`, sees the deal and each vehicle's checklist, and uploads one package or single
files. Each file is saved in Salesforce and goes through the same title package check and
filing as a rep's upload; the page polls and shows each document's result.

The browser only talks to this service. This service talks to Salesforce as a dedicated
integration user (OAuth 2.0 client credentials) holding the `Title_Vendor_Upload_API`
permission set, and calls `/services/apexrest/titlevendor/` (`TitleVendorUploadRest`).
Salesforce owns every rule (expiry, cancellation, which uploads belong to a link).

## Environment

| Variable | Value |
|---|---|
| `SF_LOGIN_URL` | `https://navitascredit.my.salesforce.com` |
| `SF_CLIENT_ID`, `SF_CLIENT_SECRET` | The external client app's consumer key and secret (client credentials flow, run-as the integration user) |
| `SF_API_VERSION` | Optional, default `62.0` |

## Safety

- Upload-only: no route returns deal documents.
- File type checked from the content (PDF, JPG, PNG), 25 MB cap, names cleaned.
- Per-IP rate limits; strict security headers (CSP, no framing, no referrer).
- Tokens are never logged (last 6 characters only).

`npm test` runs the checks that need no Salesforce.
