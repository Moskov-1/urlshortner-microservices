# Run on Minikube (Ingress + ngrok)

This guide runs the full stack on **Minikube** and exposes it publicly using **ngrok**.

Key points (matches your requirements):

- **All app Services are ClusterIP** (internal only): `go-service`, `node-service`, `python-service`, `redis`.
- You expose the app via an **Ingress controller** whose Service is **type LoadBalancer**.
- Services talk to each other using **Kubernetes Service names** (already configured in `k8s/configmap.yaml`).

## Prereqs

- `minikube`
- `kubectl`
- `ngrok`
- Optional (recommended): `helm` to install ingress-nginx

Windows note:

- If you are using **Git Bash**, `minikube` might not be on PATH there even if it is installed.
- In that case, run the `minikube ...` commands in **PowerShell** (or add Minikube to your PATH).

## Step 1: Start Minikube

```bash
minikube start --driver=docker --cpus=4 --memory=6144
```

Confirm cluster is reachable:

```bash
kubectl get nodes
```

## Step 2: Install an Ingress controller (Service type LoadBalancer)

### Option A (recommended): ingress-nginx via Helm

Create the ingress controller with a **LoadBalancer** Service:

```bash
helm repo add ingress-nginx https://kubernetes.github.io/ingress-nginx
helm repo update

helm upgrade --install ingress-nginx ingress-nginx/ingress-nginx \
  --namespace ingress-nginx --create-namespace \
  --set controller.service.type=LoadBalancer
```

Wait until it is ready:

```bash
kubectl -n ingress-nginx get pods
kubectl -n ingress-nginx get svc
```

### Option B: Minikube addon (fallback)

This is easier, but it does **not** guarantee a `LoadBalancer` Service for the controller:

```bash
minikube addons enable ingress
```

If you must satisfy “Ingress controller Service type LoadBalancer”, use **Option A**.

## Step 3: Apply the app manifests

### 3A) Build images (recommended for Minikube)

The Kubernetes manifests default to local image tags:

- `url-go:latest`
- `url-node:latest`
- `url-py:latest`

Build them:

```bash
docker build -t url-go:latest ./go-service
docker build -t url-node:latest ./node-service
docker build -t url-py:latest ./python-service
```

Load them into Minikube:

```bash
minikube image load url-go:latest
minikube image load url-node:latest
minikube image load url-py:latest
```

If you prefer Docker Hub/ECR images instead, update `image:` fields in `k8s/deployments-app.yaml`.

### 3B) Apply manifests

From the repo root:

```bash
kubectl apply -f k8s/
```

Wait for pods:

```bash
kubectl get pods
kubectl get svc
kubectl get ingress
```

Notes:

- Redis is deployed using the public image `redis:8-alpine` and uses **ephemeral storage** (easiest setup).
- PVCs do **not** hardcode a StorageClass, so Minikube’s default provisioner works.

## Step 4: Confirm in-cluster DNS URLs (Service names)

These are already set (and should stay this way):

- `GO_SERVICE_URL=http://go-service:8000`
- `NODE_SERVICE_URL=http://node-service:3000`
- `PYTHON_SERVICE_URL=http://python-service:5000`
- `REDIS_URL=redis:6379`

## Step 5: Expose Ingress through ngrok

The most reliable way on Minikube is:

1) **Port-forward** the ingress controller to localhost
2) Run `ngrok http` against that local port

### 5A) Port-forward ingress-nginx

```bash
kubectl -n ingress-nginx port-forward svc/ingress-nginx-controller 8080:80
```

Keep this terminal running.

### 5B) Start ngrok

In a new terminal:

```bash
ngrok http 8080
```

Copy the `https://...ngrok-free.app` (or similar) forwarding URL.

Open that URL in your browser — you should see the Python dashboard.

About `LoadBalancer` on Minikube:

- With the Docker driver, `kubectl get svc -n ingress-nginx` may show `EXTERNAL-IP` as `<pending>`.
- If you need a real external IP for `LoadBalancer`, run `minikube tunnel` in a separate terminal.
- For ngrok, the port-forward approach above is usually the simplest and works even when `EXTERNAL-IP` is pending.

### If you see 404s

- Make sure the Ingress exists: `kubectl get ingress`
- If your Ingress controller requires a Host header, use:

```bash
ngrok http 8080 --host-header=rewrite
```

## Step 6: Verify the app

- Dashboard: open the ngrok URL
- Create a short URL in the dashboard
- Click it: it should redirect and increment analytics

Implementation detail:

- The Python service exposes `/<short_code>` and proxies the redirect to the Go service, so a **single Ingress** is enough.

## Cleanup

```bash
kubectl delete -f k8s/
helm uninstall ingress-nginx -n ingress-nginx
minikube stop
```
