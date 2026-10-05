---
title: Adding a cluster
section: kubernetes
order: 10
summary: Connect a Kubernetes cluster from a kubeconfig or a service account token, directly, through a server or through an agent, with a least-privilege service account.
keywords: [kubernetes, cluster, kubeconfig, service account, token, eks, gke, aks, k3s, kind, impersonation, namespace allowlist, rbac]
---

BastionSSH shows what runs on a Kubernetes cluster without anyone needing `kubectl`. To get there, an admin adds the cluster once: a credential, the API server's address, and how BastionSSH reaches it. This page walks through that, and through creating a credential that can see the cluster but not change more than you want.

## Before you start

- Adding, editing, testing and removing clusters is for **admins and owners** (or a member whose role has the **manage** level on Kubernetes).
- Decide how BastionSSH will reach the API server (see **Choosing a route** below).
- Prefer a dedicated **service account token** over your own admin kubeconfig. See **A least-privilege service account** below.

## Add the cluster

1. Open **Kubernetes** in the sidebar and click **Add cluster**.
2. Pick one of the two ways to give the details:
   - **Upload a kubeconfig** — choose the file (or paste it), then pick the context to use. The name, API server URL, CA and credential are taken from that context.
   - **Enter details** — type a **Name**, the **API server URL** (as in the kubeconfig's `server:` field), the **Cluster CA (PEM)**, and a **Credential**: either a **Service account token** or a **Client certificate** with its private key.
3. Under **Connect**, choose **Directly**, **Through a server** or **Through an agent**, and pick the server or agent when asked.
4. Optionally open **Namespaces and identity** (see below).
5. Click **Test connection**. When it passes, click **Add cluster**.

> **Note:** Leave **Cluster CA (PEM)** empty only for managed clusters whose API server has a publicly trusted certificate; BastionSSH then uses the system's certificate authorities. TLS is always verified.

### What a kubeconfig may not contain

Some kubeconfig entries are refused, with a message saying why:

| Entry | Why it is refused | What to do |
| --- | --- | --- |
| `exec` (for example `aws eks get-token`, `gke-gcloud-auth-plugin`, `kubelogin`) | It would run a program on the BastionSSH host | Use a service account token |
| `auth-provider` | Not supported | Use a service account token |
| `insecure-skip-tls-verify` | TLS is always verified | Give the cluster CA instead |
| File paths (`certificate-authority`, `client-key`, `token-file`) | BastionSSH cannot read files on your machine | Embed them: `kubectl config view --minify --flatten --context <name>` |

### The credential is write-only

The credential is encrypted at rest and never shown again — the cluster only shows a hint such as "token ending …abcd" or the client certificate's name. It is only ever sent to the API server it was saved for: if you change a cluster's address or replace its CA, you must enter the credential again.

## Choosing a route

| Route | Use it when | Requirements |
| --- | --- | --- |
| **Directly** | The BastionSSH host can reach the API server URL | Private addresses are fine; cloud metadata and link-local addresses are refused |
| **Through a server** | The cluster is private, and a server you already manage in BastionSSH can reach it (a control-plane node or a bastion) | The server's sshd must allow TCP forwarding (`AllowTcpForwarding yes`, the OpenSSH default). Use the API server's address as **that server** sees it. Host key checks, jump hosts and agents apply as for terminals. |
| **Through an agent** | A [connectivity agent](/docs/operations/connectivity-agents) runs on a control-plane node | Add the API port (usually `6443`) to the agent's `BASTION_ALLOWED_PORTS`, and use a URL whose name is on the certificate, such as `https://kubernetes.default.svc:6443` or the node's name |

Even through a tunnel, the API server's certificate is checked against the name in the URL.

## Test connection

**Test connection** (in the form) or **Test** (on a cluster card) checks each step in turn and stops at the first failure:

1. **Reach the API server** — can the port be opened on the chosen route?
2. **TLS certificate** — is it signed by the CA and valid for the name?
3. **Credential** — is it accepted?
4. **Kubernetes version** — reads `/version`.
5. **What the credential may do** — asks the cluster whether it may see pods, follow changes live, see nodes, deployments and events, read pod logs, scale workloads, restart and roll back deployments, delete pods, open a shell, cordon nodes, list Secrets and impersonate users.

The last step tells you up front whether the map will be empty, and which buttons the cluster will refuse. **Diagnose** on a cluster card goes further: it runs DNS, TCP and TLS checks on the route (or the SSH checks of the server it goes through) and then the same connection test. See [Diagnostics](/docs/servers/diagnostics).

## Namespaces and identity

These optional settings are under **Namespaces and identity** in the cluster form:

- **Default namespace** — where capability checks run, and the namespace offered when nothing else can be listed.
- **Only these namespaces** — a comma-separated allowlist (for example `shop, payments`). Nobody in your organization sees other namespaces on this cluster. Empty means all.
- **Act as each member** (impersonation, off by default) — every request carries `Impersonate-User: bastion:<email>` and `Impersonate-Group: bastion:<role>`, so the cluster's RBAC and audit log see the real person. The credential needs the `impersonate` verb, and you bind Kubernetes roles to those users and groups.

> **Note:** BastionSSH roles decide what the UI offers; the cluster's own RBAC decides what is actually possible. If the credential cannot do something, the action fails with the cluster's reason.

## A least-privilege service account

A read-only ClusterRole is enough for the map, topology graph, workloads, events, storage and config views:

```yaml
# bastion-viewer.yaml — kubectl apply -f bastion-viewer.yaml
apiVersion: v1
kind: Namespace
metadata: { name: bastion }
---
apiVersion: v1
kind: ServiceAccount
metadata: { name: bastion-viewer, namespace: bastion }
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata: { name: bastion-viewer }
rules:
  - apiGroups: ["", "apps", "batch", "networking.k8s.io", "storage.k8s.io", "autoscaling"]
    resources: ["*"]
    verbs: ["get", "list", "watch"]
  - apiGroups: ["metrics.k8s.io"]
    resources: ["pods", "nodes"]
    verbs: ["get", "list"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata: { name: bastion-viewer }
roleRef: { apiGroup: rbac.authorization.k8s.io, kind: ClusterRole, name: bastion-viewer }
subjects: [{ kind: ServiceAccount, name: bastion-viewer, namespace: bastion }]
---
# A token that does not expire (delete the Secret to revoke it). For one that
# expires instead: kubectl -n bastion create token bastion-viewer --duration=8760h
apiVersion: v1
kind: Secret
metadata:
  name: bastion-viewer-token
  namespace: bastion
  annotations: { kubernetes.io/service-account.name: bastion-viewer }
type: kubernetes.io/service-account-token
```

Secrets are readable by this role so their names and keys can be listed; BastionSSH strips the values before anything reaches a browser. To keep even that away from it, replace `"*"` with an explicit list of resources that leaves out `secrets`.

> **Warning:** `resources: ["*"]` with `get` also covers `pods/exec`, and older clusters authorize a shell with `get` alone. If this credential must never open shells, list the resources explicitly instead of `"*"`.

For [guided actions](/docs/kubernetes/guided-actions), bind a Role in each namespace where you want them:

```yaml
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata: { name: bastion-operate, namespace: shop }
rules:
  - apiGroups: ["apps"]
    resources: ["deployments", "statefulsets", "daemonsets", "deployments/scale", "statefulsets/scale"]
    verbs: ["patch"]
  - apiGroups: [""]
    resources: ["pods"]
    verbs: ["delete"]
  - apiGroups: ["batch"]
    resources: ["cronjobs", "jobs"]
    verbs: ["patch", "create"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata: { name: bastion-operate, namespace: shop }
roleRef: { apiGroup: rbac.authorization.k8s.io, kind: Role, name: bastion-operate }
subjects: [{ kind: ServiceAccount, name: bastion-viewer, namespace: bastion }]
```

Pod logs need `get` on `pods/log`; shells need `create` (and on older clusters `get`) on `pods/exec`. Cordoning needs a ClusterRole with `patch` on `nodes`, bound with a ClusterRoleBinding — leave it out to keep BastionSSH away from nodes.

Then collect what the form needs:

```bash
TOKEN=$(kubectl -n bastion get secret bastion-viewer-token -o jsonpath='{.data.token}' | base64 -d)
kubectl -n bastion get secret bastion-viewer-token -o jsonpath='{.data.ca\.crt}' | base64 -d > ca.crt
kubectl config view --minify -o jsonpath='{.clusters[0].cluster.server}'   # the API server URL
```

## Per platform

| Platform | Notes |
| --- | --- |
| **EKS** | Your kubeconfig uses `aws eks get-token` (an exec plugin), so apply the YAML above with it and use the service account token. URL and CA: `aws eks describe-cluster --name <c> --query 'cluster.[endpoint,certificateAuthority.data]'` (the CA is base64). For a private endpoint, connect through a server inside the VPC. |
| **GKE** | The kubeconfig uses `gke-gcloud-auth-plugin`; same approach. URL and CA: `gcloud container clusters describe <c> --format 'value(endpoint,masterAuth.clusterCaCertificate)'` — prefix the endpoint with `https://`; the CA is base64. Private clusters: through a server that can reach the control plane. |
| **AKS** | Entra ID kubeconfigs use `kubelogin` (an exec plugin); use the service account token. URL and CA are in `az aks get-credentials --file -` (`server`, `certificate-authority-data`). Private clusters: through a server in the cluster's VNet. |
| **k3s** | `/etc/rancher/k3s/k3s.yaml` embeds a client certificate and works as is, but it is cluster-admin — prefer the token above. Replace `https://127.0.0.1:6443` with the node's address, or connect **through** that node as a managed server and keep `127.0.0.1`. Start k3s with `--tls-san` for any extra name or IP you use. |
| **kind** | `kind get kubeconfig --name <c>` embeds a client certificate pointing at `https://127.0.0.1:<port>` on the Docker host. Use it directly when BastionSSH runs on that host, or through that host as a managed server. |

## Removing a cluster

**Remove** (the bin icon on a cluster card) deletes the saved credential and member grants and closes open views. Nothing changes on the cluster itself.
