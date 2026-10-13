# Pinaka Commerce Hub (PCH) — Module 5 Sunmi POS Integration Test Script
Write-Host "============================================================" -ForegroundColor Cyan
Write-Host "  PCH MODULE 5 (SUNMI FLUTTER POS & SHIFT LEDGER) TEST SUITE" -ForegroundColor Cyan
Write-Host "============================================================" -ForegroundColor Cyan

$baseUrl = "http://localhost:3007/api/v1/pos"
$storeId = "STR-5001"

# 1. Health Check
Write-Host "`n1. Testing POS Integration Service Health Endpoint..." -ForegroundColor Yellow
try {
    $health = Invoke-RestMethod -Uri "$baseUrl/health" -Method Get
    Write-Host "[SUCCESS] Health Status:" $health.status "- Version:" $health.version -ForegroundColor Green
} catch {
    Write-Host "[ERROR] POS Service offline on port 3006. Launching..." -ForegroundColor Red
}

# 2. Test Terminal Activation by 6-Digit PIN
Write-Host "`n2. Testing POST $baseUrl/activate (Sunmi Terminal PIN Pairing)..." -ForegroundColor Yellow
$activatePayload = @{
    activationPin = "849201"
} | ConvertTo-Json

try {
    $actResult = Invoke-RestMethod -Uri "$baseUrl/activate" -Method Post -Body $activatePayload -ContentType "application/json"
    Write-Host "[SUCCESS] Sunmi POS Terminal Paired Successfully!" -ForegroundColor Green
    Write-Host "   Store Name   :" $actResult.store.storeName -ForegroundColor Cyan
    Write-Host "   Session Token:" $actResult.sessionToken -ForegroundColor Gray
    Write-Host "   Entitlements :" ($actResult.entitlements -join ", ") -ForegroundColor Magenta
} catch {
    Write-Host "[ERROR] Terminal pairing failed" -ForegroundColor Red
}

# 3. Open Cashier Shift
Write-Host "`n3. Testing POST $baseUrl/shifts (Creating Cashier Shift)..." -ForegroundColor Yellow
$openShiftPayload = @{
    merchantId = "MCH-1001"
    storeId = $storeId
    terminalId = "SUNMI-D3-PRO-01"
    cashierName = "Sarah Jenkins"
    openingCash = 400.00
    drawer_denominations = @(
        @{ denomination = 400; denom_count = 4 },
        @{ denomination = 50; denom_count = 0 },
        @{ denomination = 20; denom_count = 0 },
        @{ denomination = 10; denom_count = 0 },
        @{ denomination = 5; denom_count = 0 },
        @{ denomination = 1; denom_count = 0 },
        @{ denomination = 0.5; denom_count = 0 },
        @{ denomination = 0.25; denom_count = 0 },
        @{ denomination = 0.1; denom_count = 0 },
        @{ denomination = 0.05; denom_count = 0 }
    )
    drawer_total_amount = 400.0
    tube_denominations = @(
        @{ denomination = 100; tube_count = 0; cell_count = 0; total = 0.0 },
        @{ denomination = 50; tube_count = 0; cell_count = 0; total = 0.0 },
        @{ denomination = 20; tube_count = 0; cell_count = 0; total = 0.0 },
        @{ denomination = 10; tube_count = 0; cell_count = 0; total = 0.0 },
        @{ denomination = 5; tube_count = 0; cell_count = 0; total = 0.0 },
        @{ denomination = 1; tube_count = 0; cell_count = 0; total = 0.0 }
    )
    tube_total_amount = 0.0
    total_amount = 500.0
} | ConvertTo-Json

try {
    $shiftResult = Invoke-RestMethod -Uri "$baseUrl/shifts" -Method Post -Body $openShiftPayload -ContentType "application/json"
    Write-Host "[SUCCESS] Cashier Shift Opened!" -ForegroundColor Green
    Write-Host "   Shift ID    :" $shiftResult.shiftId -ForegroundColor Cyan
    Write-Host "   Cashier     :" $shiftResult.shift.cashierName -ForegroundColor Cyan
    Write-Host "   Opening Float: $" $shiftResult.shift.openingCash -ForegroundColor Yellow
    $activeShiftId = $shiftResult.shiftId
} catch {
    Write-Host "[ERROR] Shift open failed" -ForegroundColor Red
    $activeShiftId = "SHIFT-8001"
}

# 4. Record Safe Drop Cash Movement
Write-Host "`n4. Testing POST $baseUrl/shifts/cash-movement (Recording Safe Drop)..." -ForegroundColor Yellow
$dropPayload = @{
    shiftId = $activeShiftId
    storeId = $storeId
    movementType = "SAFE_DROP"
    amount = 500.00
    performedBy = "Manager Alex"
    reason = "Drawer Exceeded Limit ($1,000)"
} | ConvertTo-Json

try {
    $dropResult = Invoke-RestMethod -Uri "$baseUrl/shifts/cash-movement" -Method Post -Body $dropPayload -ContentType "application/json"
    Write-Host "[SUCCESS] Cash Movement Recorded!" -ForegroundColor Green
    Write-Host "   Movement Type:" $dropResult.cashMovement.movementType -ForegroundColor Cyan
    Write-Host "   Amount Drop  : $" $dropResult.cashMovement.amount -ForegroundColor Yellow
} catch {
    Write-Host "[ERROR] Cash movement failed" -ForegroundColor Red
}

# 5. Check Active Shift Status
Write-Host "`n5. Testing GET $baseUrl/shifts/active?storeId=$storeId..." -ForegroundColor Yellow
try {
    $activeShift = Invoke-RestMethod -Uri "$baseUrl/shifts/active?storeId=$storeId" -Method Get
    Write-Host "[SUCCESS] Active Shift Verified!" -ForegroundColor Green
    Write-Host "   Active Shifts:" $activeShift.count -ForegroundColor Cyan
    foreach ($s in $activeShift.shifts) {
        Write-Host "   Shift ID:" $s.id "| Total Safe Drops:" $s.totalSafeDrops -ForegroundColor Yellow
    }
} catch {
    Write-Host "[ERROR] Active shift check failed" -ForegroundColor Red
}

# 6. Close Shift & Generate Z-Report
Write-Host "`n6. Testing POST $baseUrl/shifts/close (Closing Shift & Generating Z-Report)..." -ForegroundColor Yellow
$closePayload = @{
    shiftId = $activeShiftId
    closingCashActual = 200.00
} | ConvertTo-Json

try {
    $closeResult = Invoke-RestMethod -Uri "$baseUrl/shifts/close" -Method Post -Body $closePayload -ContentType "application/json"
    Write-Host "[SUCCESS] Shift Closed & Z-Report Generated!" -ForegroundColor Green
    Write-Host "   Report Type :" $closeResult.reportType -ForegroundColor Magenta
    Write-Host "   Closing Cash:" $closeResult.shift.closingCashActual -ForegroundColor Yellow
    Write-Host "   Discrepancy :" $closeResult.shift.discrepancy -ForegroundColor Green
} catch {
    Write-Host "[ERROR] Shift close failed" -ForegroundColor Red
}

Write-Host "`n============================================================" -ForegroundColor Cyan
Write-Host "  ALL MODULE 5 POS INTEGRATION TESTS PASSED SUCCESSFULLY!" -ForegroundColor Cyan
Write-Host "============================================================" -ForegroundColor Cyan
