# Single-region deployment

The initial backend target is Google Cloud Run in one region. It scales to zero and avoids maintaining a Kubernetes cluster or VM fleet. Steel remains the only browser-computer provider.

## 1. Bootstrap infrastructure and secrets

Choose one region near the initial customer base. Create a versioned remote Terraform state bucket before team use. Then initialize and create the APIs, service accounts, and empty secrets:

```bash
cd infra/terraform
terraform init -backend-config="bucket=YOUR_VERSIONED_STATE_BUCKET" -backend-config="prefix=product-demo/production"
terraform apply -target=google_project_service.required -target=google_secret_manager_secret.secret
```

Add secret versions through a secure CI environment or an operator terminal. Never put values in Terraform variables or state:

```bash
printf %s "$SESSION_HMAC_SECRET" | gcloud secrets versions add session-hmac-secret --data-file=-
printf %s "$STEEL_API_KEY" | gcloud secrets versions add steel-api-key --data-file=-
printf %s "$MODEL_API_KEY" | gcloud secrets versions add model-api-key --data-file=-
printf %s "$TURNSTILE_SECRET" | gcloud secrets versions add turnstile-secret --data-file=-
```

The HMAC secret must contain at least 32 random bytes. Store secret values in a managed password/secret system and clear exported shell variables afterward.

Configure GitHub's protected `production` environment with required reviewers, repository variables `GCP_PROJECT_ID`, `GCP_REGION`, `TF_STATE_BUCKET`, `PUBLIC_API_URL`, `MODEL_NAME`, and the numeric version variables `SESSION_HMAC_SECRET_VERSION`, `STEEL_API_KEY_VERSION`, `MODEL_API_KEY_VERSION`, and `TURNSTILE_SECRET_VERSION`, plus secrets `GCP_WORKLOAD_IDENTITY_PROVIDER` and `GCP_DEPLOY_SERVICE_ACCOUNT`. The deploy identity must use Workload Identity Federation; do not create a JSON service-account key. Numeric versions make secret rollout and rollback deterministic—`latest` is intentionally rejected.

## 2. Build and publish

Apply through Artifact Registry first, authenticate Docker, then publish an immutable commit-tagged image:

```bash
terraform apply -target=google_artifact_registry_repository.images
gcloud auth configure-docker REGION-docker.pkg.dev
docker build -t REGION-docker.pkg.dev/PROJECT/product-demo/server:GIT_SHA .
docker push REGION-docker.pkg.dev/PROJECT/product-demo/server:GIT_SHA
```

After the one-time Artifact Registry and secret bootstrap, use the protected `Deploy production` workflow. It builds a commit-addressed image, produces a saved Terraform plan, applies that exact plan under GitHub environment approval, and uploads the verified SDK to a commit-addressed immutable bucket path. The workflow prints the matching SRI value in its summary. Deletion protection is enabled on Firestore and both Cloud Run services.

## 3. Configure DNS and SDK

Map the API service to a custom domain or HTTPS load balancer, then ensure `PUBLIC_API_URL` exactly matches it. Build the SDK, compute SRI, and upload it under an immutable version path:

```bash
npm ci
npm run build --workspace @product/embed
npm run sdk:sri
```

Serve the script with `Cache-Control: public,max-age=31536000,immutable`, TLS, and an SRI hash. Do not overwrite a published version.

## 4. Seed and validate

Review the integration JSON against the security checklist, authenticate with Application Default Credentials, and run the seed command. Validate preflight from the intended site, a successful Turnstile challenge, viewer embedding, cancellation, task retry behavior, and Steel release.

Run a canary demo after every server, model, prompt, Steel SDK, or integration-configuration change. Production deploys should use a Cloud Run revision with no traffic, run the canary against its tagged URL, then move traffic gradually.
