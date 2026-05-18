# Assignment Runbook (Simple): EC2 Jumpbox + (A) AWS EKS or (B) Minikube-on-EC2

This is the **simplest reproducible** way to satisfy the assignment requirements without going overboard.

What you will use (choose one path):

- **One 16GB EC2** instance as your DevOps “jumpbox” (and optionally also your Kubernetes host)
- **Path A (recommended if EKS is required): AWS EKS** for the Kubernetes platform + **ALB Ingress** (no domain required; use ALB DNS)
- **Path B (if allowed): Minikube on the same EC2** and use the **EC2 public IP** as the gateway
- **HPA** based on CPU (requires Metrics Server + CPU requests)
- **Prometheus + Grafana** via `kube-prometheus-stack`
- **GitHub Actions** for CI/CD (optional for Path B): tests → SonarCloud (or self-hosted SonarQube) → build/push **Docker Hub** → update GitOps repo
- **ArgoCD** for automated deployment (GitOps)

Notes:

- This runbook does **not** require ECR. For EKS, you still need *some* registry reachable by the cluster (Docker Hub is simplest).
- If your assignment explicitly requires **EKS**, use **Path A**. If the assignment accepts “Kubernetes on EC2”, use **Path B**.

---

## 0) Choose your path

- **Path A (EKS + ALB)**: Follow sections 1 → 10 as written.
- **Path B (Minikube on EC2 + public IP gateway)**: Do sections 1 + 1.4 + 1.5, then skip to sections 7–10 as needed.

## 1) EC2 setup (jumpbox)

### 1.1 Launch EC2

Recommended:

- Instance type: `t3.xlarge` (16GB)
- OS: Ubuntu 22.04 or Amazon Linux 2023
- Storage: 30–50GB
- Security group:
  - Inbound: SSH (22) from **your IP only**
  - Outbound: allow all

You do **not** need to open Kubernetes dashboards publicly. Use SSH port forwarding instead.

If you are doing **Path B (Minikube on this EC2)**, also allow inbound:

- HTTP: `80` from `0.0.0.0/0` (gateway)
- Optional: SonarQube: `9000` from your IP (or `0.0.0.0/0` if required)
- Optional: ArgoCD UI: `8080` from your IP (or use SSH tunnel)

### 1.2 Install tools

On Ubuntu:

```bash
sudo apt-get update
sudo apt-get install -y git curl unzip

# Docker (optional but useful)
sudo apt-get install -y docker.io
sudo usermod -aG docker $USER

# kubectl
curl -LO "https://dl.k8s.io/release/$(curl -L -s https://dl.k8s.io/release/stable.txt)/bin/linux/amd64/kubectl"
sudo install -o root -g root -m 0755 kubectl /usr/local/bin/kubectl

# AWS CLI v2
curl "https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip" -o "awscliv2.zip"
unzip awscliv2.zip
sudo ./aws/install

# eksctl
curl -sL "https://github.com/eksctl-io/eksctl/releases/latest/download/eksctl_Linux_amd64.tar.gz" | tar xz -C /tmp
sudo mv /tmp/eksctl /usr/local/bin

# Helm
curl https://raw.githubusercontent.com/helm/helm/main/scripts/get-helm-3 | bash
```

### 1.4 (Path B) Install Minikube on EC2

If you will run Kubernetes locally on the EC2 instance:

```bash
curl -LO https://storage.googleapis.com/minikube/releases/latest/minikube-linux-amd64
sudo install minikube-linux-amd64 /usr/local/bin/minikube

minikube start --driver=docker --cpus=4 --memory=6144
kubectl get nodes
```

### 1.5 (Optional) Run SonarQube locally on the EC2

If you want **SonarQube on the same EC2** (instead of SonarCloud):

```bash
# required by Elasticsearch used inside SonarQube
sudo sysctl -w vm.max_map_count=262144
echo 'vm.max_map_count=262144' | sudo tee /etc/sysctl.d/99-sonarqube.conf

docker volume create sonarqube_data
docker volume create sonarqube_extensions

docker run -d --name sonarqube \
  -p 9000:9000 \
  -v sonarqube_data:/opt/sonarqube/data \
  -v sonarqube_extensions:/opt/sonarqube/extensions \
  sonarqube:lts-community
```

Open `http://EC2_PUBLIC_IP:9000`.

Practical note:

- If you want GitHub Actions to use this SonarQube, you typically run a **self-hosted GitHub runner** on this EC2 (so it can reach `http://localhost:9000`).
- Otherwise, keep SonarCloud in GitHub Actions (simplest) and treat local SonarQube as optional evidence.

### 1.3 GitHub SSH

```bash
ssh-keygen -t ed25519 -C "ec2-jumpbox" -f ~/.ssh/id_ed25519
cat ~/.ssh/id_ed25519.pub
```

Add the public key to GitHub → Settings → SSH and GPG keys.

Clone:

```bash
git clone git@github.com:xaadu/urlshortner-microservices.git
cd urlshortner-microservices
```

## 2) EKS cluster (platform requirement)

Create cluster:

```bash
eksctl create cluster \
  --name urlshortner \
  --region us-east-1 \
  --nodes 2 \
  --node-type t3.medium
```

Configure kubeconfig:

```bash
aws eks update-kubeconfig --name urlshortner --region us-east-1
kubectl get nodes
```

## 3) Install required Kubernetes add-ons

### 3.1 Metrics Server (required for HPA)

```bash
kubectl apply -f https://github.com/kubernetes-sigs/metrics-server/releases/latest/download/components.yaml

# verify
kubectl get deployment -n kube-system metrics-server
kubectl top nodes || true
```

### 3.2 AWS Load Balancer Controller (ALB Ingress)

Follow AWS official instructions (recommended):

- https://docs.aws.amazon.com/eks/latest/userguide/aws-load-balancer-controller.html

Once installed, you can use ALB Ingress annotations.

## 4) Container images (Docker Hub) + GitOps repo

This repo includes a CI workflow:

- `.github/workflows/ci-dockerhub-update-gitops.yml`

Flow:

1) Push to `dev` branch
2) CI runs tests + SonarCloud
3) If quality gate passes: build/push images to Docker Hub
4) Update your **separate GitOps repo** manifests (`k8s/deployments-app.yaml` images)
5) ArgoCD auto-syncs the cluster

### 4.1 Create Docker Hub repositories

Create these repositories:

- `raihanrony015/url-go`
- `raihanrony015/url-node`
- `raihanrony015/url-py`

### 4.2 Create a GitOps repo

Example:

- `YOUR_GH_USERNAME/urlshortner-gitops`

Copy the `k8s/` folder into it.

### 4.3 GitHub Actions secrets (application repo)

In GitHub → Settings → Secrets and variables → Actions:

- `DOCKERHUB_TOKEN`
- `GITOPS_REPO` (example: `your-user/urlshortner-gitops`)
- `GITOPS_PAT` (token that can push to GitOps repo)

SonarCloud:

- `SONAR_TOKEN`
- `SONAR_PROJECT_KEY`
- `SONAR_ORGANIZATION`

Quality gate thresholds are configured in SonarCloud (recommended: fail on new code smells / duplication / coverage thresholds).

## 5) Install ArgoCD and connect to GitOps repo

Follow the GitOps guide:

- [GITOPS_ARGOCD.md](GITOPS_ARGOCD.md)

After ArgoCD syncs, your app resources (Deployments/Services/Ingress/HPA/ConfigMaps/Secrets) should be created.

## 6) EKS Ingress: switch ingress class to ALB

Shared manifests default to `ingressClassName: nginx` for Minikube.

For EKS+ALB, in your GitOps repo, update `k8s/ingress.yaml`:

- set `spec.ingressClassName: alb` (or remove it)
- add ALB annotations, e.g.

```yaml
metadata:
  annotations:
    kubernetes.io/ingress.class: alb
    alb.ingress.kubernetes.io/scheme: internet-facing
    alb.ingress.kubernetes.io/target-type: ip
    alb.ingress.kubernetes.io/listen-ports: '[{"HTTP":80}]'
```

## 7) Monitoring: Prometheus + Grafana (simple)

Install `kube-prometheus-stack`:

```bash
helm repo add prometheus-community https://prometheus-community.github.io/helm-charts
helm repo update

kubectl create namespace monitoring || true
helm upgrade --install monitoring prometheus-community/kube-prometheus-stack \
  --namespace monitoring
```

Access Grafana safely via SSH tunnel:

On EC2:

```bash
kubectl -n monitoring port-forward svc/monitoring-grafana 3000:80
```

From your laptop:

```bash
ssh -L 3000:localhost:3000 ubuntu@EC2_PUBLIC_IP
```

Open `http://localhost:3000`.

Get Grafana admin password:

```bash
kubectl -n monitoring get secret monitoring-grafana \
  -o jsonpath="{.data.admin-password}" | base64 -d; echo
```

## 8) Load testing (k6) + HPA scaling evidence

### 8.1 Find the ALB URL

If you are doing **Path B (Minikube on EC2)**, use `http://EC2_PUBLIC_IP` as your `BASE_URL` instead.

```bash
kubectl get ingress
```

Use the `ADDRESS` value (ALB DNS).

### 8.2 Create one short URL

Use the dashboard to create a short URL once.

You will get a `short_code` like `abc123`.

### 8.3 Run k6 spike test

Install k6 on EC2 (Ubuntu):

```bash
sudo apt-get install -y gnupg
curl -s https://dl.k6.io/key.gpg | sudo gpg --dearmor -o /usr/share/keyrings/k6-archive-keyring.gpg
echo "deb [signed-by=/usr/share/keyrings/k6-archive-keyring.gpg] https://dl.k6.io/deb stable main" | sudo tee /etc/apt/sources.list.d/k6.list
sudo apt-get update
sudo apt-get install -y k6
```

Run:

```bash
BASE_URL="http://YOUR_ALB_DNS" SHORT_CODE="abc123" k6 run loadtest/k6-spike.js
```

Watch autoscaling during the test:

```bash
kubectl get hpa -w
```

Also capture metrics:

```bash
kubectl top pods
kubectl top nodes
```

## 9) Screenshots checklist (deliverables)

- `kubectl get pods -A` (pods healthy)
- `kubectl get hpa` before + during k6 (replicas increasing)
- SonarCloud project overview + Quality Gate status
- Grafana dashboard (Kubernetes / Nodes, Pods CPU)
- ArgoCD Application sync status
- If using Path B: browser open to `http://EC2_PUBLIC_IP` (gateway proof)

## 9.1 EKS sanity audit (copy/paste commands)

Run these from the EC2 jumpbox and use them as your “proof” outputs.

Cluster + nodes:

```bash
kubectl config current-context
kubectl get nodes -o wide
kubectl get ns
```

Workloads (your app namespace may be `default` or `urlshortner` depending on ArgoCD destination):

```bash
kubectl get deploy,po,svc,ingress,hpa -A
```

Show that Services are internal (ClusterIP) and only Ingress is external:

```bash
kubectl get svc -A
kubectl get ingress -A
```

Health + rollouts:

```bash
kubectl rollout status deploy/go-service
kubectl rollout status deploy/python-service
kubectl rollout status deploy/node-service
kubectl describe ingress urlshortner-ingress || true
```

HPA + metrics (requires Metrics Server):

```bash
kubectl get hpa
kubectl top nodes
kubectl top pods -A
```

During load test (live view):

```bash
kubectl get hpa -w
```

ArgoCD (proof of GitOps):

```bash
kubectl -n argocd get applications
kubectl -n argocd get pods
```

Monitoring stack:

```bash
kubectl -n monitoring get pods
kubectl -n monitoring get svc
```

## 9.2 Screenshot list (exact)

- GitHub Actions run on `dev` branch (show passing steps + artifacts/logs)
- SonarCloud project overview + Quality Gate (PASS/FAIL)
- ArgoCD Application page showing `Synced` + `Healthy`
- `kubectl get ingress` showing **ALB** `ADDRESS` (Path A) or ingress created (Path B)
- `kubectl get hpa` before load test (replicas at min)
- `kubectl get hpa` during spike (replicas increased)
- Grafana dashboard showing node/pod CPU during the spike
- `kubectl top pods -A` during spike

## 10) Architecture diagram (Mermaid)

Paste this into your README or export it as an image (VS Code Mermaid extension / Mermaid Live Editor):

```mermaid
flowchart LR
  U[User / Browser] -->|HTTP| ALB[ALB Ingress]
  ALB --> PY[python-service]
  PY -->|POST /api/shorten| GO[go-service]
  PY -->|POST /api/metadata| ND[node-service]
  GO -->|Pub/Sub + Cache| R[(Redis)]
  R -->|Subscribe click_events| PY

  subgraph EKS[Kubernetes (EKS)]
    ALB
    PY
    GO
    ND
    R
    HPA[HPA]
  end

  subgraph CICD[CI/CD]
    GH[GitHub Actions] --> DH[Docker Hub]
    GH --> SC[SonarCloud]
    GH --> GITOPS[GitOps Repo]
    ARGO[ArgoCD] --> EKS
  end

  subgraph MON[Monitoring]
    PROM[Prometheus] --> GRAF[Grafana]
    EKS --> PROM
  end
```

---

## Appendix A (Path B): Minikube gateway on EC2 public IP (no ngrok)

This exposes the app using the EC2 public IP as the entrypoint.

1) Build images *inside* Minikube’s Docker

```bash
eval $(minikube docker-env)
docker build -t url-go:latest   ./go-service
docker build -t url-node:latest ./node-service
docker build -t url-py:latest   ./python-service
```

2) Install ingress-nginx as `LoadBalancer`

```bash
helm repo add ingress-nginx https://kubernetes.github.io/ingress-nginx
helm repo update

helm upgrade --install ingress-nginx ingress-nginx/ingress-nginx \
  --namespace ingress-nginx --create-namespace \
  --set controller.service.type=LoadBalancer
```

3) Apply manifests

```bash
kubectl apply -f k8s/
kubectl get pods
kubectl get ingress
```

4) Expose the Ingress on the EC2 public IP (keep it running)

Option A (gateway on **port 80**, recommended if your Security Group allows 80):

```bash
sudo -E kubectl -n ingress-nginx port-forward \
  --address 0.0.0.0 svc/ingress-nginx-controller 80:80
```

Option B (gateway on **port 8080**):

```bash
kubectl -n ingress-nginx port-forward \
  --address 0.0.0.0 svc/ingress-nginx-controller 8080:80
```

5) Verify via EC2 public IP

```bash
EC2_PUBLIC_IP=$(curl -s http://169.254.169.254/latest/meta-data/public-ipv4)
echo "App: http://$EC2_PUBLIC_IP"   # if using Option A
echo "App: http://$EC2_PUBLIC_IP:8080" # if using Option B

curl -i "http://$EC2_PUBLIC_IP" | head || true
curl -i "http://$EC2_PUBLIC_IP:8080" | head || true
```
