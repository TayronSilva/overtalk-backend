Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public class Keyboard {
    [DllImport("user32.dll")]
    public static extern short GetAsyncKeyState(int vKey);
}
"@

$VK_RSHIFT = 0xA1
$lastState = $false

Write-Host "----------------------------------------------------" -ForegroundColor Cyan
Write-Host "🚀 PONTE DE TECLADO GLOBAL (Modo Pergunta)" -ForegroundColor Cyan
Write-Host "Monitorando [SHIFT DIREITO]..." -ForegroundColor White
Write-Host "Mantenha esta janela aberta enquanto joga." -ForegroundColor Yellow
Write-Host "----------------------------------------------------" -ForegroundColor Cyan

while ($true) {
    $state = [Keyboard]::GetAsyncKeyState($VK_RSHIFT) -band 0x8000
    
    if ($state -and -not $lastState) {
        # Tecla Pressionada
        $lastState = $true
        try {
            Invoke-RestMethod -Uri "http://localhost:3000/trigger?state=on" -Method Get
            # Write-Host "🔴 MIC ON" -ForegroundColor Red
        } catch {
            Write-Host "❌ Erro ao avisar o servidor. O server.js está rodando?" -ForegroundColor Red
        }
    } 
    elseif (-not $state -and $lastState) {
        # Tecla Solta
        $lastState = $false
        try {
            Invoke-RestMethod -Uri "http://localhost:3000/trigger?state=off" -Method Get
            # Write-Host "⚪ MIC OFF" -ForegroundColor Gray
        } catch {}
    }

    Start-Sleep -Milliseconds 50
}
