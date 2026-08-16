$ws = New-Object System.Net.WebSockets.ClientWebSocket
$uri = New-Object System.Uri("ws://127.0.0.1:33686")
$cts = New-Object System.Threading.CancellationTokenSource
$cts.CancelAfter(5000)

try {
    Write-Host "Testing connection to Hikvision LocalService on ws://127.0.0.1:33686..."
    $task = $ws.ConnectAsync($uri, $cts.Token)
    $task.Wait()
    
    if ($ws.State -eq 'Open') {
        Write-Host "Success! Connected to Hikvision LocalService." -ForegroundColor Green
        
        # Send initialization command just like the Native Viewer does
        $cmd = '{"sequence":"test-1234","cmd":"system.webconnect"}'
        $bytes = [System.Text.Encoding]::UTF8.GetBytes($cmd)
        $segment = New-Object System.ArraySegment[byte] -ArgumentList @(,$bytes)
        
        $sendTask = $ws.SendAsync($segment, [System.Net.WebSockets.WebSocketMessageType]::Text, $true, $cts.Token)
        $sendTask.Wait()
        Write-Host "Sent 'system.webconnect' initialization command."
        
        $buffer = New-Object byte[] 4096
        $receiveSegment = New-Object System.ArraySegment[byte] -ArgumentList @(,$buffer)
        $receiveTask = $ws.ReceiveAsync($receiveSegment, $cts.Token)
        $receiveTask.Wait()
        
        $response = [System.Text.Encoding]::UTF8.GetString($buffer, 0, $receiveTask.Result.Count)
        Write-Host "Received response from LocalService:`n$response" -ForegroundColor Cyan
        
        $ws.CloseAsync([System.Net.WebSockets.WebSocketCloseStatus]::NormalClosure, "Done", $cts.Token).Wait()
    } else {
        Write-Host "WebSocket state is: $($ws.State)" -ForegroundColor Yellow
    }
} catch {
    Write-Host "Failed to connect to Hikvision LocalService. The service might not be running or is blocked." -ForegroundColor Red
    Write-Host $_.Exception.InnerException.Message
}
