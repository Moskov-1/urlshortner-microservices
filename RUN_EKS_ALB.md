# Run on AWS EKS with ALB Ingress

This guide shows the exact steps to run the project on EKS using AWS Load Balancer Controller (ALB), plus the exact files/lines you must change.

## Prereqs

- AWS CLI configured for your account
- kubectl installed
- eksctl installed
- An ECR repo (or another registry) with your app images

## Step 1: Build and push images to ECR

You need images accessible from the EKS cluster. Create ECR repos and push:

- go-service image
- node-service image
- python-service image

Redis is used as a message bus + cache and is deployed using the public image by default.

If you use public `redis:8-alpine`, you do not need an ECR repo for redis.

## Step 2: Create an EKS cluster

Example with eksctl:

```bash
eksctl create cluster \
  --name urlshortner \
  --region us-east-1 \
  --nodes 2 \
  --node-type t3.medium
```

Configure kubectl:

```bash
aws eks update-kubeconfig --name urlshortner --region us-east-1
```

## Step 3: Install the AWS Load Balancer Controller

Follow AWS docs for your region. High-level flow:

1) Create IAM OIDC provider for the cluster
2) Create IAM policy for the controller
3) Create IAM service account
4) Install the controller via Helm

Official docs (recommended):
https://docs.aws.amazon.com/eks/latest/userguide/aws-load-balancer-controller.html

## Step 4: Update Kubernetes manifests for EKS + ALB

You need to update the Ingress to use the ALB controller.

If you do not have a domain, you can still use EKS+ALB by opening the ALB DNS name directly (no `host` required).

### A) Update Ingress for ALB

Edit [k8s/ingress.yaml](k8s/ingress.yaml):

- Add the ALB annotations.
- Optional: add a `host` (only if you own a domain).

Important:

- The shared manifest defaults to `spec.ingressClassName: nginx` (for Minikube).
- For EKS+ALB, change it to `alb` (or remove it and rely on the ALB annotations).

Example annotations to add under `metadata`:

```yaml
metadata:
  name: urlshortner-ingress
  annotations:
    kubernetes.io/ingress.class: alb
    alb.ingress.kubernetes.io/scheme: internet-facing
    alb.ingress.kubernetes.io/target-type: ip
    alb.ingress.kubernetes.io/listen-ports: '[{"HTTP":80}]'
```

If you want HTTPS (recommended), add ACM cert ARN and HTTPS listener:

```yaml
metadata:
  annotations:
    kubernetes.io/ingress.class: alb
    alb.ingress.kubernetes.io/scheme: internet-facing
    alb.ingress.kubernetes.io/target-type: ip
    alb.ingress.kubernetes.io/listen-ports: '[{"HTTP":80},{"HTTPS":443}]'
    alb.ingress.kubernetes.io/certificate-arn: arn:aws:acm:REGION:ACCOUNT:certificate/XXXX
    alb.ingress.kubernetes.io/ssl-redirect: '443'
```

### B) Update images to ECR

Edit [k8s/deployments-app.yaml](k8s/deployments-app.yaml):

- Replace `image` for `go-service`, `node-service`, `python-service` with your ECR image URIs.

Note: the shared manifests default to local image tags (for Minikube):

- `url-go:latest`
- `url-node:latest`
- `url-py:latest`

Edit [k8s/deployment-redis.yaml](k8s/deployment-redis.yaml) only if you do not want public redis.

Notes about Redis (easiest setup):

- The default manifest uses `redis:8-alpine`.
- Redis data is ephemeral (no PVC) to keep setup simple.
- If you want Redis persistence, add a PVC and mount it at `/data`.

Example image URI:

```
ACCOUNT_ID.dkr.ecr.us-east-1.amazonaws.com/url-go:latest
```

### C) Validate StorageClass

PVCs in [k8s/pvc.yaml](k8s/pvc.yaml) intentionally do not hardcode a `storageClassName`, so they use your cluster default.

If you specifically want EBS `gp3`, create a `gp3` StorageClass in your cluster and then set `storageClassName: gp3` on each PVC.

## Step 5: Apply manifests

```bash
kubectl apply -f k8s/
```

## Step 6: Get the ALB DNS name

Once the controller provisions the ALB, check:

```bash
kubectl get ingress
```

You will see a DNS name in the `ADDRESS` column. Point your DNS (Route 53 or other) to that DNS name using a CNAME/ALIAS.

If you do not have a domain, skip DNS and open the ALB DNS name directly in your browser.

## Step 7: Verify

- Open the ALB URL (or your host) to see the Python dashboard.
- Create a short URL and test redirect.

## Where exactly to change things

- ALB annotations and host: [k8s/ingress.yaml](k8s/ingress.yaml)
- Images: [k8s/deployments-app.yaml](k8s/deployments-app.yaml) and [k8s/deployment-redis.yaml](k8s/deployment-redis.yaml)
- Storage class or sizes: [k8s/pvc.yaml](k8s/pvc.yaml)

## Common EKS gotchas

- The ALB controller requires correct IAM permissions and OIDC setup.
- If pods cannot pull images, confirm the ECR image and node IAM permissions.
- If PVCs stay pending, confirm the StorageClass name matches your cluster.

## Service-to-service URLs (ClusterIP)

Internal communication uses Kubernetes Service DNS names (ClusterIP). This is already configured in [k8s/configmap.yaml](k8s/configmap.yaml) like:

- `http://go-service:8000`
- `http://node-service:3000`
- `http://python-service:5000`

## GitOps (ArgoCD) + CI

If you want ArgoCD + a GitHub Actions pipeline (build → push images → update a separate manifests repo), follow [GITOPS_ARGOCD.md](GITOPS_ARGOCD.md).
