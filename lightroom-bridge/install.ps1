[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [switch]$Install,
    [switch]$SkipMcpRegistration,
    [string]$ModulesPath = (Join-Path $env:APPDATA 'Adobe\Lightroom\Modules'),
    [string]$ServiceRoot = (Join-Path $env:LOCALAPPDATA 'LrCreativeGradingBridge')
)

$ErrorActionPreference = 'Stop'
$pluginSource = Join-Path $PSScriptRoot 'plugin\LrCreativeGradingBridge.lrplugin'
$pluginTarget = Join-Path $ModulesPath 'LrCreativeGradingBridge.lrplugin'
$serviceTarget = Join-Path $ServiceRoot 'bridge'
$serverTarget = Join-Path $serviceTarget 'src\mcp-server.mjs'
$mcpName = 'lr-creative-grading'

if (-not (Test-Path -LiteralPath $pluginSource -PathType Container)) {
    throw "Plugin source is missing: $pluginSource"
}
if (-not (Test-Path -LiteralPath (Join-Path $PSScriptRoot 'src\mcp-server.mjs') -PathType Leaf)) {
    throw 'MCP server source is missing.'
}

$plan = [pscustomobject]@{
    mode = if ($Install) { 'install' } else { 'dry-run' }
    plugin_source = $pluginSource
    plugin_target = $pluginTarget
    service_source = $PSScriptRoot
    service_target = $serviceTarget
    mcp_registration = if ($SkipMcpRegistration) { 'skipped' } else { "codex mcp add $mcpName -- node `"$serverTarget`"" }
    writes_catalog = $false
    writes_xmp_sidecars = $false
}

if (-not $Install) {
    $plan | Format-List
    Write-Host ''
    Write-Host 'Dry-run only. Re-run with -Install to perform these writes.'
    return
}

$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) { throw 'Node.js 20 or newer is required.' }
$nodeMajor = [int]((& $node.Source --version).TrimStart('v').Split('.')[0])
if ($nodeMajor -lt 20) { throw "Node.js 20 or newer is required; found $nodeMajor." }

if (Test-Path -LiteralPath $pluginTarget) {
    throw "Refusing to overwrite an existing Lightroom plug-in: $pluginTarget"
}
if (Test-Path -LiteralPath $serviceTarget) {
    throw "Refusing to overwrite an existing bridge service: $serviceTarget"
}

if ($PSCmdlet.ShouldProcess($pluginTarget, 'Install Lightroom plug-in')) {
    New-Item -ItemType Directory -Path $ModulesPath -Force | Out-Null
    Copy-Item -LiteralPath $pluginSource -Destination $pluginTarget -Recurse
}

if ($PSCmdlet.ShouldProcess($serviceTarget, 'Install local MCP bridge files')) {
    New-Item -ItemType Directory -Path $ServiceRoot -Force | Out-Null
    Copy-Item -LiteralPath $PSScriptRoot -Destination $serviceTarget -Recurse
}

if (-not $SkipMcpRegistration) {
    $codex = Get-Command codex -ErrorAction SilentlyContinue
    if (-not $codex) {
        throw "Bridge files were installed, but Codex CLI was not found. Register manually: codex mcp add $mcpName -- node `"$serverTarget`""
    }
    if ($PSCmdlet.ShouldProcess($mcpName, 'Register local MCP server with Codex')) {
        & $codex.Source mcp add $mcpName -- node $serverTarget
        if ($LASTEXITCODE -ne 0) {
            throw "Codex MCP registration failed with exit code $LASTEXITCODE. Existing registration was not removed or overwritten."
        }
    }
}

Write-Host 'Creative Grading Bridge installation completed.'
Write-Host "Lightroom plug-in: $pluginTarget"
Write-Host "MCP server: $serverTarget"
