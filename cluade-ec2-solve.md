# Deploy on EC2 (Minikube + Ingress + ArgoCD)

> **No ngrok needed.** On EC2, `minikube tunnel` gives the ingress controller a real
> external IP that maps to your EC2 instance. Open port 80/443 in your Security Group
> and you're done.

---

## Prerequisites (EC2 setup)

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

**EC2 Security Group — open these inbound ports:**

| Port | Source | Purpose |
|------|--------|---------|
| 22   | Your IP | SSH |
| 80   | 0.0.0.0/0 | HTTP |
| 443  | 0.0.0.0/0 | HTTPS |
| 8080 | 0.0.0.0/0 | ArgoCD UI (or use SSH tunnel) |

---

## Step 1: Start Minikube

```bash
minikube start --driver=docker --cpus=4 --memory=6144
kubectl get nodes   # confirm it's Ready
```

---

## Step 2: Build Docker images from local folders

```bash
# Point your shell's Docker to Minikube's Docker daemon
# so images are immediately available inside the cluster
eval $(minikube docker-env)

# Build all three services
docker build -t url-go:latest   ./go-service
docker build -t url-node:latest ./node-service
docker build -t url-py:latest   ./python-service

# Verify
docker images | grep url-
```

> **Important:** Because we use `eval $(minikube docker-env)`, images are built
> directly inside Minikube — no `minikube image load` step needed.
> Set `imagePullPolicy: Never` in your Deployments (already set in the manifests below).

---

## Step 3: Install ingress-nginx (type LoadBalancer)

```bash
helm repo add ingress-nginx https://kubernetes.github.io/ingress-nginx
helm repo update

helm upgrade --install ingress-nginx ingress-nginx/ingress-nginx \
  --namespace ingress-nginx --create-namespace \
  --set controller.service.type=LoadBalancer

# Wait for the controller pod to be Running
kubectl -n ingress-nginx get pods -w
```

---

## Step 4: Run minikube tunnel (gives ingress a real external IP)

Open a **dedicated terminal** and keep this running the whole time:

```bash
sudo minikube tunnel
```

Then check:
```bash
kubectl -n ingress-nginx get svc ingress-nginx-controller
# EXTERNAL-IP should now show an IP (e.g. 192.168.49.2 or 10.x.x.x)
```

> On EC2, traffic hitting the instance on port 80 will be forwarded through the tunnel
> to the ingress controller. The EC2 public IP is your entry point.

---

## Step 5: Apply Kubernetes manifests

```bash
kubectl apply -f k8s/
kubectl get pods
kubectl get svc
kubectl get ingress
```

---

## Step 6: Verify

```bash
EC2_PUBLIC_IP=$(curl -s http://169.254.169.254/latest/meta-data/public-ipv4)
echo "App is at: http://$EC2_PUBLIC_IP"
curl http://$EC2_PUBLIC_IP
```

Open `http://<EC2-PUBLIC-IP>` in your browser — you should see the Python dashboard.

---

## Step 7: Install ArgoCD

```bash
kubectl create namespace argocd
kubectl apply -n argocd -f https://raw.githubusercontent.com/argoproj/argo-cd/stable/manifests/install.yaml

# Wait for pods
kubectl -n argocd get pods -w

# Expose ArgoCD UI (NodePort for simplicity on EC2)
kubectl patch svc argocd-server -n argocd \
  -p '{"spec": {"type": "NodePort"}}'

# Get the NodePort
kubectl -n argocd get svc argocd-server

# Get initial admin password
kubectl -n argocd get secret argocd-initial-admin-secret \
  -o jsonpath="{.data.password}" | base64 -d && echo

# Access at: http://<EC2-PUBLIC-IP>:<NODE-PORT>
# Login: admin / <password above>
```

> **Tip:** Open the NodePort in your EC2 Security Group, or use SSH port forwarding:
> `ssh -L 8080:localhost:<NodePort> ec2-user@<EC2-IP>`

---

## ArgoCD + GitHub Actions CI/CD flow

### Repository structure

```
your-org/
├── app-repo/          ← source code + Dockerfiles
│   └── .github/workflows/ci.yaml
└── manifests-repo/    ← only k8s YAML files (ArgoCD watches this)
    └── k8s/
        ├── configmap.yaml
        ├── deployments-app.yaml
        ├── services.yaml
        ├── ingress.yaml
        └── redis.yaml
```

### GitHub Actions workflow (app-repo)

Create `.github/workflows/ci.yaml`:

```yaml
name: Build and Deploy

on:
  push:
    branches: [main]   # change to your target branch

jobs:
  build-and-push:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Log in to Docker Hub
        uses: docker/login-action@v3
        with:
          username: ${{ secrets.DOCKERHUB_USERNAME }}
          password: ${{ secrets.DOCKERHUB_TOKEN }}

      - name: Build and push Go service
        uses: docker/build-push-action@v5
        with:
          context: ./go-service
          push: true
          tags: ${{ secrets.DOCKERHUB_USERNAME }}/url-go:${{ github.sha }}

      - name: Build and push Node service
        uses: docker/build-push-action@v5
        with:
          context: ./node-service
          push: true
          tags: ${{ secrets.DOCKERHUB_USERNAME }}/url-node:${{ github.sha }}

      - name: Build and push Python service
        uses: docker/build-push-action@v5
        with:
          context: ./python-service
          push: true
          tags: ${{ secrets.DOCKERHUB_USERNAME }}/url-py:${{ github.sha }}

      - name: Update manifests repo with new image tags
        env:
          MANIFEST_REPO_TOKEN: ${{ secrets.MANIFEST_REPO_TOKEN }}
          DOCKERHUB_USERNAME: ${{ secrets.DOCKERHUB_USERNAME }}
          SHA: ${{ github.sha }}
        run: |
          git clone https://x-access-token:${MANIFEST_REPO_TOKEN}@github.com/your-org/manifests-repo.git
          cd manifests-repo

          # Update image tags in the deployment manifest
          sed -i "s|image: .*/url-go:.*|image: ${DOCKERHUB_USERNAME}/url-go:${SHA}|" k8s/deployments-app.yaml
          sed -i "s|image: .*/url-node:.*|image: ${DOCKERHUB_USERNAME}/url-node:${SHA}|" k8s/deployments-app.yaml
          sed -i "s|image: .*/url-py:.*|image: ${DOCKERHUB_USERNAME}/url-py:${SHA}|" k8s/deployments-app.yaml

          git config user.email "ci@github.com"
          git config user.name "GitHub Actions"
          git add k8s/deployments-app.yaml
          git commit -m "Update images to ${SHA}"
          git push
```

**GitHub Secrets to add in app-repo:**
- `DOCKERHUB_USERNAME`
- `DOCKERHUB_TOKEN`
- `MANIFEST_REPO_TOKEN` (GitHub PAT with write access to manifests-repo)

### ArgoCD Application resource

Apply this to your cluster:

```yaml
# k8s-argocd-app.yaml  (apply once manually)
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: url-shortener
  namespace: argocd
spec:
  project: default
  source:
    repoURL: https://github.com/your-org/manifests-repo
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
kubectl apply -f k8s-argocd-app.yaml
```

ArgoCD will now automatically sync whenever the manifests-repo changes.

---

## Cleanup

```bash
kubectl delete -f k8s/
kubectl delete -n argocd -f https://raw.githubusercontent.com/argoproj/argo-cd/stable/manifests/install.yaml
helm uninstall ingress-nginx -n ingress-nginx
minikube stop
```