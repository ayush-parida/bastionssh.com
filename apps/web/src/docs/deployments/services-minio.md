---
title: MinIO
section: deployments
order: 180
summary: Run S3-compatible object storage with its web console on a domain, and use it from Node.js (AWS SDK, Next.js uploads), Python and Go.
keywords: [minio, s3, object storage, buckets, aws sdk, boto3, presigned, console, uploads]
---

The MinIO template runs MinIO's server with its web console. MinIO stopped publishing container images in 2025 (`minio/minio` is gone from Docker Hub); the template runs the community build of the same open-source server from Pigsty, `pgsty/minio`, pinned by digest like every other image.

**It is a community-built image.** Pinning by digest means a server only ever runs the exact image BastionSSH was released with, and BastionSSH re-pins it only on purpose, after checking where the new build came from — but the image is built and published by Pigsty, not by MinIO, and MinIO itself no longer publishes builds of the open-source server. If that is not acceptable for your data, run another S3-compatible server from your own image (`build.type: image` in bastion.yml), or use a hosted object store.

| | |
| --- | --- |
| Ports | 9000 (S3 API), 9001 (console) |
| `.env` | `MINIO_ROOT_USER=admin`, `MINIO_ROOT_PASSWORD` (generated) |
| Data | `/data`, exclusive |
| Domain | for the console (optional) |
| Memory | 512m by default |

Give it a **domain** when you create it to open the console from your browser (`https://files.example.com`, sign in as `admin` with the revealed password). Apps on the server use the S3 API directly at `http://<name>:9000`; publishing exposes the **S3 port**, not the console.

## Connecting

| Setting | Value |
| --- | --- |
| Endpoint | `http://files:9000` |
| Access key | `admin` (or a key you create in the console) |
| Secret key | the revealed `MINIO_ROOT_PASSWORD` |
| Region | `us-east-1` |
| Path-style addressing | on |

> **Tip:** Create an access key with a policy limited to your app's bucket in the console (**Access Keys**), and give the app that instead of the root credentials.

## Node.js

With the AWS SDK v3:

```js
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';

const s3 = new S3Client({
  endpoint: process.env.S3_ENDPOINT, // http://files:9000
  region: 'us-east-1',
  forcePathStyle: true,
  credentials: { accessKeyId: process.env.S3_ACCESS_KEY, secretAccessKey: process.env.S3_SECRET_KEY },
});
await s3.send(new PutObjectCommand({ Bucket: 'uploads', Key: 'hello.txt', Body: 'hello' }));
```

### Next.js uploads

Browsers cannot reach `http://files:9000` — it is a name on the server's private network. Either upload through your app (a Route Handler that streams the body to S3), or publish the S3 port (`public:<port>`, firewalled to the addresses that need it) and create presigned URLs with `@aws-sdk/s3-request-presigner` for that public endpoint.

## Python

```python
import os, boto3

s3 = boto3.client("s3", endpoint_url=os.environ["S3_ENDPOINT"], aws_access_key_id=os.environ["S3_ACCESS_KEY"],
                  aws_secret_access_key=os.environ["S3_SECRET_KEY"], region_name="us-east-1")
s3.put_object(Bucket="uploads", Key="hello.txt", Body=b"hello")
```

## Go

```go
client, err := minio.New("files:9000", &minio.Options{Creds: credentials.NewStaticV4(accessKey, secretKey, ""), Secure: false})
_, err = client.PutObject(ctx, "uploads", "hello.txt", strings.NewReader("hello"), 5, minio.PutObjectOptions{})
```

## Backups

MinIO has no Backups tab: copy buckets out with the MinIO client, for example to another S3 provider, from any machine that reaches the API (an SSH tunnel to a `localhost` publish works):

```bash
mc alias set src http://127.0.0.1:19000 admin '<password>'
mc mirror src/uploads s3backup/uploads
```

The data volume is `bastion-<name>.data` on the server.

## Upgrading

**Update version** moves to the build the catalog pins; MinIO releases read the data of earlier ones.

## Troubleshooting

- **The console says the S3 API is unreachable** — the console talks to the server inside the container; check the container's Live log for errors about `/data` (a full disk).
- **`SignatureDoesNotMatch`** — the endpoint the client signs for must be the one it calls: path-style addressing on, the same host and port.
