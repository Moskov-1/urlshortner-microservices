# Deploy with ArgoCD on Minikube (Local or EC2)

This runbook is the single place to follow for:

- **Minikube on your laptop** + Ingress + **ArgoCD** (GitOps)
- **Minikube on an EC2 instance** + Ingress + **ArgoCD** (GitOps)

It consolidates the deployment steps that were previously split across multiple guides.

---

## 0) Choose your environment

### Option A: Minikube on your laptop

- Use **port-forward + ngrok** to expose the Ingress (simplest), or
- Use **`minikube tunnel`** if you want a real external IP.

### Option B: Minikube on EC2

> **No ngrok needed.** On EC2, `minikube tunnel` gives the ingress controller a real
> external IP that maps to your EC2 instance. Open port **80/443** in your Security Group
> and you’re done.

---

## 1) Prerequisites

### 1A) Laptop prerequisites

- `docker`
- `kubectl`
- `minikube`
- `helm`
- (Optional) `ngrok`

Windows note:

- If you are using **Git Bash**, `minikube` might not be on PATH there even if it is installed.
- In that case, run the `minikube ...` commands in **PowerShell** (or add Minikube to your PATH).

### 1B) EC2 prerequisites (Ubuntu 22.04)

```bash
# Recommended: t3.medium or larger (2 vCPU, 4 GB RAM minimum)
# OS: Ubuntu 22.04 LTS

# Install Docker
sudo apt-get update
sudo apt-get install -y docker.io
sudo usermod -aG docker $USER
newgrp docker

# Install kubectl
curl -LO "https://dl.k8s.io/release/$(curl -Ls https://dl.k8s.io/release/stable.txt)/bin/linux/amd64/kubectl"
sudo install -o root -g root -m 0755 kubectl /usr/local/bin/kubectl

# Install Minikube
curl -LO https://storage.googleapis.com/minikube/releases/latest/minikube-linux-amd64
sudo install minikube-linux-amd64 /usr/local/bin/minikube

# Install Helm
curl https://raw.githubusercontent.com/helm/helm/main/scripts/get-helm-3 | bash
```

EC2 Security Group — open these inbound ports:

| Port | Source | Purpose |
|------|--------|---------|
| 22   | Your IP | SSH |
| 80   | 0.0.0.0/0 | HTTP |
| 443  | 0.0.0.0/0 | HTTPS |
| 8080 | Your IP (or use SSH tunnel) | ArgoCD UI |

---

## 2) Start Minikube

```bash
minikube start --driver=docker --cpus=4 --memory=6144
kubectl get nodes
```

---

## 3) Build images and make them available to Minikube

Your Kubernetes manifests default to local image tags:

- `url-go:latest`
- `url-node:latest`
- `url-py:latest`

### Option A (recommended on EC2): build inside Minikube’s Docker

```bash
# Point your shell's Docker to Minikube's Docker daemon
# so images are immediately available inside the cluster
eval $(minikube docker-env)

docker build -t url-go:latest   ./go-service
docker build -t url-node:latest ./node-service
docker build -t url-py:latest   ./python-service

docker images | grep url-
```

### Option B (recommended on laptop): build locally then load into Minikube

```bash
# Optional: generate/update go.sum without installing Go locally
# Windows Git Bash note: MSYS_NO_PATHCONV avoids path-mangling for -v mounts
cd go-service
MSYS_NO_PATHCONV=1 docker run --rm -v "${PWD}:/app" -w /app golang:1.24-alpine go mod tidy
cd ..

docker build -t url-go:latest ./go-service
docker build -t url-node:latest ./node-service
docker build -t url-py:latest ./python-service

minikube image load url-go:latest
minikube image load url-node:latest
minikube image load url-py:latest
```

---

## 4) Install ingress-nginx (Service type LoadBalancer)

```bash
helm repo add ingress-nginx https://kubernetes.github.io/ingress-nginx
helm repo update

helm upgrade --install ingress-nginx ingress-nginx/ingress-nginx \
  --namespace ingress-nginx --create-namespace \
  --set controller.service.type=LoadBalancer

kubectl -n ingress-nginx get pods
kubectl -n ingress-nginx get svc
```

---

## 5) Apply the app manifests

From the repo root:

```bash
kubectl apply -f k8s/

kubectl get pods
kubectl get svc
kubectl get ingress
```

In-cluster DNS URLs (Service names) should stay like this:

- `GO_SERVICE_URL=http://go-service:8000`
- `NODE_SERVICE_URL=http://node-service:3000`
- `PYTHON_SERVICE_URL=http://python-service:5000`
- `REDIS_URL=redis:6379`

---

## 6) Expose the app via Ingress

### 6A) Laptop: port-forward + ngrok

Port-forward ingress-nginx:

```bash
kubectl -n ingress-nginx port-forward svc/ingress-nginx-controller 8080:80
```

Run ngrok in another terminal:

```bash
ngrok http 8080
```

If you see 404s:

```bash
ngrok http 8080 --host-header=rewrite
```

### 6B) EC2: minikube tunnel

Keep this running in a dedicated terminal:

```bash
sudo minikube tunnel
```

Then check:

```bash
kubectl -n ingress-nginx get svc ingress-nginx-controller
```

Verify via EC2 public IP:

```bash
EC2_PUBLIC_IP=$(curl -s http://169.254.169.254/latest/meta-data/public-ipv4)
echo "App is at: http://$EC2_PUBLIC_IP"
curl http://$EC2_PUBLIC_IP
```

---

## 7) Install ArgoCD

### 7A) Install

```bash
kubectl create namespace argocd
kubectl apply -n argocd -f https://raw.githubusercontent.com/argoproj/argo-cd/stable/manifests/install.yaml

kubectl -n argocd get pods
```

### 7B) Access the UI

Laptop/dev-friendly (recommended):

```bash
kubectl -n argocd port-forward svc/argocd-server 8080:443
```

Then open:

- `https://localhost:8080`

Initial admin password:

```bash
kubectl -n argocd get secret argocd-initial-admin-secret \
  -o jsonpath="{.data.password}" | base64 -d; echo
```

EC2 alternative: NodePort (open the NodePort in SG or use SSH port-forward)

```bash
kubectl patch svc argocd-server -n argocd -p '{"spec": {"type": "NodePort"}}'
kubectl -n argocd get svc argocd-server
```

---

## 8) GitOps repo + ArgoCD Application

### 8A) Create a separate GitOps repo

Create a repo (example):

- `your-github-username/urlshortner-gitops`

Copy your `k8s/` folder into it and commit.

### 8B) Create an ArgoCD Application resource

Apply once to the cluster (edit `repoURL`, `targetRevision`, `path`, and `namespace`):

```yaml
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: urlshortner
  namespace: argocd
spec:
  project: default
  source:
    repoURL: https://github.com/YOUR_GH_USERNAME/urlshortner-gitops.git
    targetRevision: main
    path: k8s
  destination:
    server: https://kubernetes.default.svc
    namespace: default
  syncPolicy:
    automated:
      prune: true
      selfHeal: true
```

```bash
kubectl apply -f argocd-application.yaml
```

---

## 9) CI/CD: push to dev → Docker Hub → update GitOps repo → ArgoCD sync

This app repo includes a GitHub Actions workflow that:

- Runs a Docker Compose smoke test
- Builds and pushes the 3 service images to Docker Hub
- Updates image tags in your manifests repo so ArgoCD syncs

Workflow file:

- `.github/workflows/ci-dockerhub-update-gitops.yml`

Secrets to add in the **application repo**:

- `DOCKERHUB_USERNAME`
- `DOCKERHUB_TOKEN`
- `MANIFEST_REPO_TOKEN`

---

## Cleanup

```bash
kubectl delete -f k8s/
kubectl delete -n argocd -f https://raw.githubusercontent.com/argoproj/argo-cd/stable/manifests/install.yaml
helm uninstall ingress-nginx -n ingress-nginx
minikube stop
```
