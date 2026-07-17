$ErrorActionPreference = 'Stop'
& node (Join-Path $PSScriptRoot 'installer\install.mjs') @args
exit $LASTEXITCODE
