---
title: Object storage
section: files
order: 30
summary: Connect S3-compatible storage such as AWS S3, MinIO, R2 or B2 and manage buckets and objects from the browser.
keywords: [s3, object storage, minio, r2, backblaze, wasabi, spaces, gcs, buckets, upload]
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
| Upload | **Upload**, or drag files onto the page | operate |
| New folder | **New folder** | operate |
| Rename | Pencil icon | operate |
| Delete a file | Trash icon | operate |
| Delete a folder | Trash icon on the folder row (everything inside goes too) | operate |

Long listings load in pages; click **Load more** at the bottom to see the rest.

### Uploads

Uploads are streamed through BastionSSH to the provider. Files above 8 MiB are sent as a multipart upload. The largest upload allowed is set by `SMT_STORAGE_MAX_UPLOAD_BYTES` (default 5 GiB).

### Rename

S3 has no real rename, so BastionSSH copies the object to the new name and then deletes the original. If an object with the new name already exists, you are asked whether to replace it. In a bucket without versioning, replacing is permanent.

## Who can do what

| Level | Can |
| --- | --- |
| view | List buckets and objects, download |
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
