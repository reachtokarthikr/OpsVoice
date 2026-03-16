param(
    [Parameter(Mandatory = $true)]
    [string]$Message,
    [string]$Branch = "main",
    [string]$Remote = "origin"
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $root

$gitStatus = git status --porcelain
if ($LASTEXITCODE -ne 0) {
    throw "git status failed."
}

if (-not $gitStatus) {
    Write-Host "No local changes to commit. Pushing current branch state..."
    git push $Remote $Branch
    exit $LASTEXITCODE
}

Write-Host "Staging changes..."
git add -A
if ($LASTEXITCODE -ne 0) {
    throw "git add failed."
}

Write-Host "Creating commit..."
git commit -m $Message
if ($LASTEXITCODE -ne 0) {
    throw "git commit failed."
}

Write-Host "Pushing to $Remote/$Branch..."
git push $Remote $Branch
exit $LASTEXITCODE
