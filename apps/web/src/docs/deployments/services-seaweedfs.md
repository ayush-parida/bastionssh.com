---
title: SeaweedFS
section: deployments
order: 175
summary: Run S3-compatible object storage from SeaweedFS's official image — the recommended object store for new services — and use it from Node.js (AWS SDK v3), Python (boto3) and Go, create buckets, and give it a domain.
keywords: [seaweedfs, s3, object storage, buckets, aws sdk, boto3, go, uploads, presigned, weed, minio alternative, recommended]
---

The SeaweedFS template runs [SeaweedFS](https://github.com/seaweedfs/seaweedfs) — Apache-2.0 licensed — from the project's **official image**, `chrislusf/seaweedfs`, pinned by digest like every image in the catalog. It is the **recommended** object store for new services: an S3 API for uploads, backups and static assets, in one container.

| | |
| --- | --- |
| Image | `chrislusf/seaweedfs` (official), SeaweedFS 4 |
| Port | 8333 (S3 API) |
| `.env` | `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` and `WEED_JWT_FILER_SIGNING_KEY`, all generated on the server |
| Data | `/data`, exclusive (a recreate stops the old container before the new one starts) |
| Domain | for the S3 API (optional) |
| Memory | 512m by default (it idles at about 170 MB) |
| Backups | none in BastionSSH — see [Backups](#backups) |

## What runs in the container

One process, `weed server`, runs SeaweedFS's four parts: the **master** (which volumes exist), a **volume server** (the data files in `/data`), the **filer** (names and folders, kept in `/data` too) and the **S3 gateway**.

- Only the **S3 gateway** listens on the server's private network (`<name>:8333`). The master, the volume server and the filer have no authentication of their own, so they listen on the container's loopback address only: no other app can reach them, and **there is no web UI** to give a domain — the filer's browser UI is not offered.
- The S3 gateway's admin identity comes from `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY` in the container's environment (its `.env`): no config file is written and no key is ever on a command line. A request without a valid signature is refused (`403`), anonymous ones too.
- `WEED_JWT_FILER_SIGNING_KEY` signs the requests SeaweedFS's own parts send each other. It also makes the gateway refuse identity changes over its internal gRPC port from anything but its own filer. Nothing outside the container uses it; leave it as it is.
- The Iceberg and Lance catalog ports are switched off.

> **Note:** SeaweedFS writes the access key — not the secret — in the container's log when it starts (`Added admin identity … accessKey=…`). An access key id is not a secret on its own, but treat the log accordingly.

## Connecting

The **Connection** panel shows the endpoint and the keys (reveal them with your passkey):

| Setting | Value |
| --- | --- |
| Endpoint, from apps on the server | `http://<name>:8333` — for a service named `files`, `http://files:8333` |
| Access key | the revealed `AWS_ACCESS_KEY_ID` |
| Secret key | the revealed `AWS_SECRET_ACCESS_KEY` |
| Region | `us-east-1` (SeaweedFS accepts any region; SDKs need one, and the signature must use the same) |
| Addressing | **path-style** (`http://files:8333/<bucket>/<key>`); virtual-host buckets (`<bucket>.files`) do not resolve on the private network |

Put them into your app's **Environment**, for example:

```bash
S3_ENDPOINT=http://files:8333
S3_ACCESS_KEY=<AWS_ACCESS_KEY_ID>
S3_SECRET_KEY=<AWS_SECRET_ACCESS_KEY>
S3_BUCKET=uploads
```

Prefer names like `S3_ACCESS_KEY` in your app over `AWS_ACCESS_KEY_ID`: SDKs read the `AWS_*` names by themselves and would send these credentials to AWS too.

## Creating buckets

The keys are an **admin** identity: they may create buckets.

- **From your app**, once at start — `CreateBucket` (examples below); a bucket that exists already answers `BucketAlreadyOwnedByYou`, which is safe to ignore.
- **By uploading**: the gateway creates a missing bucket on the first upload into it for an admin identity.
- **From a shell on the server**, with any S3 client in a throwaway container on `bastion-apps`:

  ```bash
  docker run --rm --network bastion-apps -e AWS_ACCESS_KEY_ID=<access key> -e AWS_SECRET_ACCESS_KEY=<secret key> \
    amazon/aws-cli --endpoint-url http://files:8333 --region us-east-1 s3 mb s3://uploads
  ```

Bucket names follow S3's rules: 3–63 lower-case letters, digits, `.` and `-`.

## Node.js

With the AWS SDK v3 (`npm install @aws-sdk/client-s3`):

```js
import { S3Client, CreateBucketCommand, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';

const s3 = new S3Client({
  endpoint: process.env.S3_ENDPOINT, // http://files:8333
  region: 'us-east-1',
  forcePathStyle: true,
  credentials: { accessKeyId: process.env.S3_ACCESS_KEY, secretAccessKey: process.env.S3_SECRET_KEY },
});

try {
  await s3.send(new CreateBucketCommand({ Bucket: 'uploads' }));
} catch (err) {
  if (err.name !== 'BucketAlreadyOwnedByYou' && err.name !== 'BucketAlreadyExists') throw err;
}
await s3.send(new PutObjectCommand({ Bucket: 'uploads', Key: 'hello.txt', Body: 'hello', ContentType: 'text/plain' }));
const { Body } = await s3.send(new GetObjectCommand({ Bucket: 'uploads', Key: 'hello.txt' }));
console.log(await Body.transformToString()); // hello
```

### Next.js uploads

Browsers cannot reach `http://files:8333` — it is a name on the server's private network. Either upload through your app (a Route Handler that streams the request body to `PutObjectCommand`), or give the service a **domain** (below) and create presigned URLs for it with `@aws-sdk/s3-request-presigner`, using a client whose `endpoint` is `https://s3.example.com`:

```js
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

const publicS3 = new S3Client({ endpoint: 'https://s3.example.com', region: 'us-east-1', forcePathStyle: true, credentials });
const url = await getSignedUrl(publicS3, new PutObjectCommand({ Bucket: 'uploads', Key: key }), { expiresIn: 600 });
```

## Python

With boto3:

```python
import os, boto3
from botocore.config import Config

s3 = boto3.client(
    "s3",
    endpoint_url=os.environ["S3_ENDPOINT"],  # http://files:8333
    aws_access_key_id=os.environ["S3_ACCESS_KEY"],
    aws_secret_access_key=os.environ["S3_SECRET_KEY"],
    region_name="us-east-1",
    config=Config(s3={"addressing_style": "path"}),
)
try:
    s3.create_bucket(Bucket="uploads")
except s3.exceptions.BucketAlreadyOwnedByYou:
    pass
s3.put_object(Bucket="uploads", Key="hello.txt", Body=b"hello")
print(s3.get_object(Bucket="uploads", Key="hello.txt")["Body"].read())
```

## Go

With the AWS SDK for Go v2:

```go
import (
	"context"
	"os"
	"strings"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/credentials"
	"github.com/aws/aws-sdk-go-v2/service/s3"
)

client := s3.New(s3.Options{
	BaseEndpoint: aws.String(os.Getenv("S3_ENDPOINT")), // http://files:8333
	Region:       "us-east-1",
	UsePathStyle: true,
	Credentials:  credentials.NewStaticCredentialsProvider(os.Getenv("S3_ACCESS_KEY"), os.Getenv("S3_SECRET_KEY"), ""),
})
ctx := context.Background()
_, _ = client.CreateBucket(ctx, &s3.CreateBucketInput{Bucket: aws.String("uploads")}) // exists already: ignore
_, err := client.PutObject(ctx, &s3.PutObjectInput{Bucket: aws.String("uploads"), Key: aws.String("hello.txt"), Body: strings.NewReader("hello")})
```

The MinIO Go client (`minio-go`) works too: `minio.New("files:8333", &minio.Options{Creds: credentials.NewStaticV4(accessKey, secretKey, ""), Secure: false})`.

## A domain for the S3 API

Give the service a **domain** when you create it (or in its Domains tab) and the proxy serves the S3 API with HTTPS at `https://s3.example.com` — for presigned URLs, or clients off the server. Every request still needs a valid signature; the proxy forwards the `Host` header the client signed. Use path-style addressing there too.

Publishing the port (`localhost:<port>` for an SSH tunnel, `public:<port>`) exposes the same S3 API — see [Exposing a service](services-overview.md#exposing-a-service).

## Backups

SeaweedFS has **no backup in BastionSSH**: there is no single dump command that captures a running store (volumes and the filer's metadata change together), so the service has no Backups tab. Copy the **objects** out with any S3 client instead — to another S3 provider, or to files — from a container on the server or through an SSH tunnel to a `localhost` publish:

```bash
docker run --rm --network bastion-apps -v "$PWD/backup":/backup -e AWS_ACCESS_KEY_ID=<access key> -e AWS_SECRET_ACCESS_KEY=<secret key> \
  amazon/aws-cli --endpoint-url http://files:8333 --region us-east-1 s3 sync s3://uploads /backup/uploads
```

`rclone sync` does the same between two S3 endpoints. The data volume is `bastion-<name>.data` on the server; a copy of it is only consistent while the service is **stopped**.

## Upgrading

**Update version** moves to the SeaweedFS 4 release the catalog pins: the container stops, the new one starts on the same `/data` and is health-checked (the master must know every volume in `/data` again before it counts as healthy). SeaweedFS reads the data of earlier releases. A rollback to an older **line** is refused, as for every forward-only template (see [Version lines](releases-rollback.md#version-lines)).

## SeaweedFS or MinIO

Both speak S3; pick **SeaweedFS** for a new service. MinIO no longer publishes container images, so the MinIO template runs a community build ([MinIO](services-minio.md)); SeaweedFS's image is published by the project itself. MinIO has a web console; SeaweedFS has none here. Moving existing data across is an `aws s3 sync` (or `rclone sync`) from one endpoint to the other.

## Troubleshooting

- **`SignatureDoesNotMatch`** — the client must sign for the host and port it calls, with path-style addressing on; behind a domain, sign for `https://s3.example.com`, not the internal name.
- **`InvalidAccessKeyId` or `AccessDenied`** — the keys in the app's Environment differ from the service's `.env` (a reveal copies the current ones). Changing the service's keys in its `.env` takes a restart of the service.
- **The health check times out after a restart with a lot of data** — the volume server loads every volume's index before the master knows it; raise `healthcheck.timeout` in the Config tab.
- **`NoSuchBucket`** — create the bucket first (above).
