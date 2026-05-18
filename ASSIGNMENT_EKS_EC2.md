# Assignment Runbook (Simple): EC2 Jumpbox + AWS EKS + CI/CD + Monitoring

This is the **simplest reproducible** way to satisfy the assignment requirements without going overboard.

What you will use:

- **One 16GB EC2** instance as your DevOps “jumpbox” (SSH, kubectl, Helm, k6, optional SonarQube local)
- **AWS EKS** for the Kubernetes platform
- **ALB Ingress** for external traffic routing (no domain required; use ALB DNS)
- **HPA** based on CPU (requires Metrics Server + CPU requests)
- **Prometheus + Grafana** via `kube-prometheus-stack`
- **GitHub Actions** for CI/CD: tests → SonarCloud quality gate → build/push Docker Hub → update GitOps repo
- **ArgoCD** for automated deployment (GitOps)

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
