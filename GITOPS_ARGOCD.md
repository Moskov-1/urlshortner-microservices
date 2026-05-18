# GitOps with ArgoCD + GitHub Actions (Docker Hub)

This guide matches the flow you described:

- Developer pushes to a branch (example: `dev`)
- GitHub Actions runs checks, builds Docker images, pushes to **Docker Hub**
- GitHub Actions updates a **separate Git repo** that contains Kubernetes manifests (GitOps repo)
- ArgoCD watches the GitOps repo and applies changes to the cluster

## 0) Assumptions

- You have 3 app images to build/push: Go, Node, Python
- Redis stays as a public image (`redis:8-alpine`) and is not built
- Your Kubernetes manifests live under `k8s/` (same structure in the GitOps repo)

## 1) Create a separate GitOps repo

Create a new repo, for example:

- `your-github-username/urlshortner-gitops`

In that repo, commit this structure:

```
urlshortner-gitops/
  k8s/
    configmap.yaml
    deployment-redis.yaml
    deployments-app.yaml
    hpa.yaml
    ingress.yaml
    pvc.yaml
    secret.yaml
    services.yaml
```

You can start by copying the `k8s/` folder from this application repo.

## 2) Install ArgoCD in your cluster

### 2A) Install

```bash
kubectl create namespace argocd
kubectl apply -n argocd -f https://raw.githubusercontent.com/argoproj/argo-cd/stable/manifests/install.yaml
```

Wait for pods:

```bash
kubectl -n argocd get pods
```

### 2B) Open the ArgoCD UI (dev-friendly: port-forward)

```bash
kubectl -n argocd port-forward svc/argocd-server 8080:443
```

Then open:

- `https://localhost:8080`

Get the initial admin password:

```bash
kubectl -n argocd get secret argocd-initial-admin-secret \
  -o jsonpath="{.data.password}" | base64 -d; echo
```

Login:

- Username: `admin`
- Password: the decoded value above

## 3) Create an ArgoCD Application (points to GitOps repo)

Create a namespace for your app (recommended):

```bash
kubectl create namespace urlshortner
```

Apply this ArgoCD Application (edit `repoURL` and `path`):

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
    directory:
      recurse: false
  destination:
    server: https://kubernetes.default.svc
    namespace: urlshortner
  syncPolicy:
    automated:
      prune: true
      selfHeal: true
    syncOptions:
      - CreateNamespace=true
```

Apply it:

```bash
kubectl apply -f argocd-application.yaml
```

(You can name the file anything; ArgoCD just needs the resource applied in the `argocd` namespace.)

## 4) GitHub Actions: build/push → update GitOps repo

A working starter workflow is included in this repo:

- `.github/workflows/ci-dockerhub-update-gitops.yml`

### 4A) Required GitHub secrets (in the *application* repo)

Create these secrets in GitHub → your repo → Settings → Secrets and variables → Actions:

- `DOCKERHUB_TOKEN` (a Docker Hub access token)
- `GITOPS_REPO` (example: `your-github-username/urlshortner-gitops`)
- `GITOPS_PAT` (a GitHub token/PAT that can push to the GitOps repo)

Notes:

- `GITOPS_PAT` should have **repo write** permissions for the GitOps repo.
- Keep `GITOPS_PAT` scoped to the minimum permissions and repositories you need.

### 4B) How the workflow tags images

The workflow tags Docker images using the commit SHA:

- `raihanrony015/url-go:<sha>`
- `raihanrony015/url-node:<sha>`
- `raihanrony015/url-py:<sha>`

Then it updates the GitOps repo file:

- `k8s/deployments-app.yaml`

…by setting the container `image` fields by container name (`go-service`, `node-service`, `python-service`).

### 4C) Branch mapping

By default the workflow is set to run on pushes to the `dev` branch.

If you want a different branch (your “xyz”), change:

- `on.push.branches` in `.github/workflows/ci-dockerhub-update-gitops.yml`

## 5) What to do when you want to deploy

- Push code to your branch (example: `dev`)
- GitHub Actions builds/pushes images and updates the GitOps repo
- ArgoCD detects the GitOps repo commit and auto-syncs it into the cluster

## Troubleshooting

- ArgoCD not syncing: check Application events in the UI and `kubectl -n argocd describe application urlshortner`
- Images not pulling: confirm the Docker Hub repo names and tags match what ArgoCD applied
- GitOps update failing: confirm `GITOPS_PAT` has access to the GitOps repo
