param(
    [string]$ProjectId,
    [string]$Region = "us-central1",
    [string]$Repository = "opsvoice",
    [string]$ServiceName = "opsvoice",
    [string]$ImageName = "opsvoice",
    [string]$Tag = "latest"
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $root

# Load project ID from .env if not provided as parameter
if (-not $ProjectId) {
    $envFile = Join-Path $root ".env"
    if (Test-Path $envFile) {
        $envLine = Get-Content $envFile | Where-Object { $_ -match "^GOOGLE_CLOUD_PROJECT=" }
        if ($envLine) {
            $ProjectId = ($envLine -split "=", 2)[1].Trim()
        }
    }
    if (-not $ProjectId) {
        throw "ProjectId not provided and GOOGLE_CLOUD_PROJECT not found in .env"
    }
}

$gcloudCmd = Get-Command gcloud -ErrorAction SilentlyContinue
if ($gcloudCmd) {
    $gcloud = $gcloudCmd.Path
} else {
    $defaultPath = Join-Path $env:LOCALAPPDATA "Google\Cloud SDK\google-cloud-sdk\bin\gcloud.cmd"
    if (Test-Path $defaultPath) {
        $gcloud = $defaultPath
    } else {
        throw "gcloud not found in PATH or at $defaultPath. Install the Google Cloud SDK first."
    }
}

$image = "${Region}-docker.pkg.dev/${ProjectId}/${Repository}/${ImageName}:${Tag}"

Write-Host "Setting gcloud project to $ProjectId"
& $gcloud config set project $ProjectId
if ($LASTEXITCODE -ne 0) {
    throw "Failed to set gcloud project."
}

Write-Host "Building and pushing image $image"
& $gcloud builds submit --tag $image .
if ($LASTEXITCODE -ne 0) {
    throw "Cloud Build failed."
}

Write-Host "Deploying $ServiceName to Cloud Run"
& $gcloud run deploy $ServiceName `
    --region $Region `
    --image $image `
    --allow-unauthenticated `
    --cpu-boost `
    --set-env-vars "OPSVOICE_HOST=0.0.0.0" `
    --startup-probe="failureThreshold=1,periodSeconds=240,timeoutSeconds=240,tcpSocket.port=8080"
if ($LASTEXITCODE -ne 0) {
    throw "Cloud Run deploy failed."
}

$serviceUrl = (& $gcloud run services describe $ServiceName --region $Region --format "value(status.url)").Trim()
if (-not $serviceUrl) {
    throw "Failed to resolve deployed service URL."
}

Write-Host "Running health check on $serviceUrl/health"
try {
    $resp = Invoke-WebRequest -Uri "$serviceUrl/health" -UseBasicParsing -TimeoutSec 30
    Write-Host "Health status: $($resp.StatusCode)"
    Write-Host $resp.Content
} catch {
    Write-Host "Health check failed with an error."
    if ($_.Exception.Response) {
        Write-Host "Status Code: $($_.Exception.Response.StatusCode.value__)"
    } else {
        Write-Host $_.Exception.Message
    }
    throw
}

Write-Host "Deployment complete: $serviceUrl"
