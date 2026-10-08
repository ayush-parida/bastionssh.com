---
title: Object storage
section: files
order: 30
summary: Connect S3-compatible storage such as AWS S3, MinIO, R2 or B2 and manage buckets and objects from the browser.
keywords: [s3, object storage, minio, r2, backblaze, wasabi, spaces, gcs, buckets, upload, download folder, zip, tar.gz]
---

The **Object Storage** module connects to any storage service that speaks the S3 API. Once a connection is added you can list and create buckets, browse objects by folder, upload, download, rename and delete, all under the same roles and audit log as your servers.

## Supported providers

Pick a preset in the **Provider** list and it fills in the endpoint shape, region and addressing style for you.

| Provider | Endpoint shape | Notes |
| --- | --- | --- |
| AWS S3 | blank | Leave the endpoint blank to use the AWS regional endpoint for the region. |
| MinIO | `http://minio.internal:9000` | Use the API port (9000 by default), not the console port. |
| Cloudflare R2 | `https://{account-id}.r2.cloudflarestorage.com` | Region is fixed to `auto`. Create an R2 API token with Object Read & Write. |
| Backblaze B2 | `https://s3.{region}.backblazeb2.com` | Use an application key, not the master key. |
| Wasabi | `https://s3.{region}.wasabisys.com` | Pick the region your buckets live in; Wasabi does not redirect across regions. |
| DigitalOcean Spaces | `https://{region}.digitaloceanspaces.com` | Use a Spaces access key, not a personal access token. |
| Google Cloud Storage | `https://storage.googleapis.com` | Needs an HMAC key (Cloud Storage → Settings → Interoperability). |
| Hetzner Object Storage | `https://{location}.your-objectstorage.com` | Location is `fsn1`, `nbg1` or `hel1`. |
| Other S3-compatible | your own | Ceph RGW, Garage, SeaweedFS, Linode, Scaleway, OVH and others. |

## Adding a connection

Adding, editing and removing connections needs the **manage** level on the Object Storage module (admins by default).

1. Open **Object Storage** in the sidebar.
2. Click **Add connection**.
3. Enter a **Name** (for example "Backups (MinIO)") and choose the **Provider**.
4. Fill in the **Endpoint**, replacing any `{placeholder}` in the shape shown, and the **Region**.
5. Enter the **Access key ID** and **Secret access key**.
6. Leave **Path-style addressing** as the preset set it, unless you know your service needs otherwise. MinIO requires it; AWS uses virtual-hosted style (`bucket.host`).
7. Click **Add**, then **Test** on the card to check the credentials.

The secret key is encrypted at rest with the same vault as SSH keys and is never sent back to the browser. When editing, leave it blank to keep the existing one.

> **Note:** Endpoints on a private network (a MinIO on your LAN, say) are allowed. Cloud metadata addresses such as `169.254.169.254` are refused.

Removing a connection only removes it from BastionSSH. Buckets and objects are not touched.

## Buckets

Click **Browse** on a connection to see its buckets.

- **New bucket** (manage level) creates a bucket. Names are 3–63 lowercase letters, digits, dots or hyphens.
- Click a bucket to open it.
- **Delete bucket** (manage level) asks you to type the bucket's name to confirm. Tick **Also delete every object inside it** to empty it first; otherwise the provider refuses to delete a bucket that still has objects.

## Objects

Inside a bucket, objects are shown as folders and files based on `/` in their keys.

| Action | How | Level |
| --- | --- | --- |
| Browse | Click folders, use the breadcrumbs or the up arrow | view |
| Download | Download icon, or click a file | view |
| Download a folder | Download-folder icon on the folder row, or **Download folder** for the folder you are in | view |
| Upload | **Upload**, or drag files onto the page | operate |
| New folder | **New folder** | operate |
| Rename | Pencil icon | operate |
| Delete a file | Trash icon | operate |
| Delete a folder | Trash icon on the folder row (everything inside goes too) | operate |

Long listings load in pages; click **Load more** at the bottom to see the rest.

### Uploads

Uploads are streamed through BastionSSH to the provider. Files above 8 MiB are sent as a multipart upload. The largest upload allowed is set by `SMT_STORAGE_MAX_UPLOAD_BYTES` (default 5 GiB).

### Download a folder

A folder (everything under its prefix, subfolders included) or the whole bucket downloads as one archive. Click the download-folder icon on a folder row, or **Download folder** at the top for the folder you are in (at the bucket root, that is the whole bucket).

1. The dialog counts what is inside first: the number of files and their total size. A large folder is counted only up to 10 000 objects or 5 seconds, and then shown as "at least …".
2. Pick the format: **.zip** (opens on macOS and Windows without extra software) or **.tar.gz** (keeps the archive smaller for text and logs).
3. Click **Download**. In Chrome and Edge you choose where to save it, and the archive is written straight to that file while the dialog shows the bytes received; **Cancel** stops it and discards what was written (the browser may leave an empty file with that name). In other browsers a small folder is downloaded inside the page the same way; a large one is handed to the browser, whose downloads list shows the progress.

The archive is built while the objects stream down. Nothing is stored on the BastionSSH host or in the bucket, so a large folder starts downloading at once. Cancelling (or closing the tab) stops the transfer from the provider too.

What ends up in the archive:

- Paths are relative to the folder you chose. Folder marker objects (keys ending in `/`) become folders, so empty folders are kept.
- A key that cannot be a file name is left out: a `..` segment, an empty segment such as the middle of `logs//today.txt`. So is an object that disappears or cannot be read while the archive is built. Everything left out is listed in `_skipped.txt` at the root of the archive.
- A folder download stops at `SMT_FOLDER_DOWNLOAD_MAX_BYTES` of content (default 10 GiB) or `SMT_FOLDER_DOWNLOAD_MAX_FILES` entries (default 100 000). The archive then ends with `_TRUNCATED.txt` saying where it stopped; the dialog warns you beforehand when the count (files and folders) is already over. Download the subfolders separately to get the rest.
- Each folder download holds one of your live streams (the same limit as live log views) until it ends.

Downloading a folder needs the same **view** level as downloading a single object. Each one is audited as `storage.folder_download` with the bucket, prefix, format, number of files and bytes, what was skipped, whether it was truncated or cancelled, and how long it took. Losing access to the connection stops a folder download that is still running.

### Rename

S3 has no real rename, so BastionSSH copies the object to the new name and then deletes the original. If an object with the new name already exists, you are asked whether to replace it. In a bucket without versioning, replacing is permanent.

## Who can do what

| Level | Can |
| --- | --- |
| view | List buckets and objects, download objects and folders |
| operate | Also upload, rename and delete objects, **Test** and **Diagnose** the connection |
| manage | Also add, edit and remove connections, and create or delete buckets |

With built-in roles: viewers browse and download, operators change objects, admins manage connections and buckets. See [Roles & modules](/docs/access/roles-and-modules).

## Auditing

Every bucket and object action is recorded in the audit log with the bucket and object key, so you can see who uploaded or deleted what.

## Troubleshooting

- **Test fails with an access error:** check the access key has rights on the bucket and that the region matches.
- **Test fails with a network error:** click **Diagnose** on the card to check DNS, TCP and TLS to the endpoint. See [Diagnostics](/docs/servers/diagnostics).
- **MinIO lists nothing or errors:** make sure the endpoint uses the API port and **Path-style addressing** is ticked.

Object storage connections can also hold off-site copies of BastionSSH's own database backups. See [Backups & restore](/docs/operations/backups-and-restore).
