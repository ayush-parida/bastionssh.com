#!/usr/bin/env bash
# Throwaway Kubernetes for src/kube/kube.integration.test.ts: a k3s server in
# Docker on an unusual port, a sample app with known problems, a read-only
# service account, and an openssh-server container on the same network to
# tunnel through. Nothing touches ~/.kube or any other cluster: kubectl runs
# inside the k3s container, and the kubeconfig is written to a temp dir.
#
#   apps/server/scripts/kube-it.sh up      # prints the env vars for the test
#   apps/server/scripts/kube-it.sh down    # removes everything it created
set -euo pipefail

# SMT_KIT_PREFIX lets two runs side by side keep apart (with their own ports and dir)
PREFIX=${SMT_KIT_PREFIX:-smt-kit}
NET=$PREFIX-net
K3S=$PREFIX-k3s
SSHD=$PREFIX-sshd
API_PORT=${SMT_KIT_API_PORT:-26443}
SSH_PORT=${SMT_KIT_SSH_PORT:-22423}
IMAGE=${SMT_KIT_K3S_IMAGE:-rancher/k3s:v1.31.5-k3s1}
DIR=${SMT_KIT_DIR:-${TMPDIR:-/tmp}/smt-kube-it}

kc() { docker exec -i "$K3S" kubectl "$@"; }

down() {
  docker rm -f "$SSHD" "$K3S" >/dev/null 2>&1 || true
  docker network rm "$NET" >/dev/null 2>&1 || true
  rm -rf "$DIR"
}

up() {
  down
  mkdir -p "$DIR"
  docker network create "$NET" >/dev/null
  docker run -d --privileged --name "$K3S" --network "$NET" -p "127.0.0.1:$API_PORT:6443" \
    "$IMAGE" server --disable=traefik --tls-san=127.0.0.1 --tls-san="$K3S" >/dev/null
  docker run -d --name "$SSHD" --network "$NET" -p "127.0.0.1:$SSH_PORT:2222" \
    -e USER_NAME=smt -e USER_PASSWORD=smt-it-pass -e PASSWORD_ACCESS=true \
    lscr.io/linuxserver/openssh-server >/dev/null

  until kc get nodes 2>/dev/null | grep -q ' Ready'; do sleep 2; done
  # The image ships with AllowTcpForwarding no; the app tunnels with forwardOut
  until docker exec "$SSHD" test -f /config/sshd/sshd_config; do sleep 1; done
  docker exec "$SSHD" sed -i 's/^AllowTcpForwarding no/AllowTcpForwarding yes/' /config/sshd/sshd_config
  docker restart "$SSHD" >/dev/null

  kc apply -f - >/dev/null <<'YAML'
apiVersion: v1
kind: Namespace
metadata: { name: smt-it }
---
apiVersion: apps/v1
kind: Deployment
metadata: { name: web, namespace: smt-it }
spec:
  replicas: 2
  selector: { matchLabels: { app: web } }
  template:
    metadata: { labels: { app: web } }
    spec:
      containers:
        - name: web
          image: busybox:1.36
          command: ["sh", "-c", "mkdir -p /www && echo ok > /www/index.html && httpd -f -p 8080 -h /www"]
          ports: [{ containerPort: 8080 }]
          resources: { requests: { cpu: 10m, memory: 16Mi } }
          env:
            - name: PASSWORD
              valueFrom: { secretKeyRef: { name: web-secret, key: password } }
---
apiVersion: v1
kind: Secret
metadata: { name: web-secret, namespace: smt-it }
stringData: { password: hunter2-smt-it }
---
apiVersion: v1
kind: Service
metadata: { name: web, namespace: smt-it }
spec:
  selector: { app: web }
  ports: [{ port: 80, targetPort: 8080 }]
---
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata: { name: web, namespace: smt-it }
spec:
  rules:
    - host: web.smt-it.local
      http:
        paths:
          - path: /
            pathType: Prefix
            backend: { service: { name: web, port: { number: 80 } } }
---
apiVersion: v1
kind: Pod
metadata: { name: crasher, namespace: smt-it }
spec:
  containers:
    - name: crasher
      image: busybox:1.36
      command: ["sh", "-c", "echo starting; sleep 1; exit 1"]
---
apiVersion: v1
kind: Pod
metadata: { name: too-big, namespace: smt-it }
spec:
  containers:
    - name: too-big
      image: busybox:1.36
      command: ["sleep", "3600"]
      resources: { requests: { cpu: "500" } }
---
# Inside a pod (K4): an init step, a native sidecar, an app that prints a line a second
apiVersion: v1
kind: Pod
metadata: { name: ticker, namespace: smt-it }
spec:
  initContainers:
    - name: prepare
      image: busybox:1.36
      command: ["sh", "-c", "echo prepared"]
    - name: proxy
      image: busybox:1.36
      restartPolicy: Always
      command: ["sh", "-c", "while true; do sleep 3600; done"]
  containers:
    - name: ticker
      image: busybox:1.36
      command: ["sh", "-c", "i=0; while true; do i=$((i+1)); echo tick $i; sleep 1; done"]
      resources: { requests: { cpu: 10m, memory: 8Mi }, limits: { cpu: 100m, memory: 32Mi } }
---
# Read-only, as the docs recommend for viewing (secrets: names only reach the browser)
apiVersion: v1
kind: ServiceAccount
metadata: { name: bastion-viewer, namespace: smt-it }
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
subjects: [{ kind: ServiceAccount, name: bastion-viewer, namespace: smt-it }]
YAML

  # The admin kubeconfig k3s writes (client certificate), pointed at the published port
  docker exec "$K3S" cat /etc/rancher/k3s/k3s.yaml | sed "s#https://127.0.0.1:6443#https://127.0.0.1:$API_PORT#" >"$DIR/kubeconfig"
  kc -n smt-it create token bastion-viewer --duration=2h >"$DIR/token"
  kc get configmap kube-root-ca.crt -n smt-it -o jsonpath='{.data.ca\.crt}' >"$DIR/ca.crt"
  kc -n smt-it rollout status deployment/web --timeout=180s >/dev/null
  kc -n smt-it wait --for=condition=Ready pod/ticker --timeout=180s >/dev/null

  cat <<ENV
SMT_TEST_KUBE_KUBECONFIG=$DIR/kubeconfig
SMT_TEST_KUBE_TOKEN_FILE=$DIR/token
SMT_TEST_KUBE_CA_FILE=$DIR/ca.crt
SMT_TEST_KUBE_INNER_URL=https://$K3S:6443
SMT_TEST_KUBE_SSH_HOST=127.0.0.1
SMT_TEST_KUBE_SSH_PORT=$SSH_PORT
ENV
}

case "${1:-}" in
  up) up ;;
  down) down ;;
  *) echo "usage: $0 up|down" >&2; exit 2 ;;
esac
