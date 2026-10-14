# Device APIs

Served by `merchant-service` on port 3003. React uses the existing `/api/v1` proxy.

## 1. Add Device API (Create Device)
- **Endpoint**: `POST /api/v1/devices`
- **Description**: Creates a new device record for a merchant.
  - Automatically generates the authorization code (`authorization_code`, `device_active_code`, `activation_code`) in format `PK-XXXXXX`.
  - `serial_number` is optional. If omitted, the server automatically generates a unique placeholder `SN-UNASSIGNED-XXXXXX` so the device can be activated later from physical POS hardware.
  - Generates unique `device_code` (e.g., `DVC-00001`).
  - Automatically maps device to the merchant in `merchant_devices`.

### cURL Request:
```bash
curl --location 'http://localhost:3003/api/v1/devices' \
  --header 'Content-Type: application/json' \
  --data '{
    "merchant_id": "a1111111-0000-0000-0000-000000000001",
    "device_name": "Front Counter POS 01",
    "device_type": "POS Terminal"
  }'
```

*Note: For Windows PowerShell, pipe the JSON payload directly to curl:*
```powershell
'{"merchant_id":"a1111111-0000-0000-0000-000000000001","device_name":"Front Counter POS 01","device_type":"POS Terminal"}' | curl.exe -s -X POST http://localhost:3003/api/v1/devices -H "Content-Type: application/json" -d "@-"
```

### Response (HTTP 201 Created):
```json
{
  "success": true,
  "device": {
    "id": "60f26c88-cc29-4488-bc99-234bc6f34011",
    "device_id": null,
    "device_name": "Front Counter POS 01",
    "device_code": "DVC-00004",
    "device_type": "POS Terminal",
    "status": "ACTIVE",
    "merchant_id": "a1111111-0000-0000-0000-000000000001",
    "merchant_name": "Fresh Mart Organics LLC",
    "serial_number": "SN-UNASSIGNED-693051",
    "authorization_code": "PK-887949",
    "device_active_code": "PK-887949",
    "activation_code": "PK-887949",
    "created_at": "2026-10-14T00:08:13.234Z",
    "updated_at": "2026-10-14T00:08:13.234Z"
  }
}
```

---

## 2. Activate Device API
- **Endpoint**: `POST /api/v1/device-activation/activate`
- **Description**: Physical device/terminal calls this to activate using the authorization code.
  - Matches the device row in the `devices` table using `authorization_code` (or `activationCode`).
  - Inserts the provided hardware serial number into **both** `serial_number` and `device_id` columns in the `devices` table.
  - Updates the device status to `ACTIVE`.
  - Creates a POS session and returns device access token, store information, and merchant details.

### cURL Request:
```bash
curl --location 'http://localhost:3003/api/v1/device-activation/activate' \
  --header 'Content-Type: application/json' \
  --data '{
    "authorization_code": "PK-887949",
    "serial_number": "SUNMI-T2-SN-998877"
  }'
```

*Note: For Windows PowerShell:*
```powershell
'{"authorization_code":"PK-887949","serial_number":"SUNMI-T2-SN-998877"}' | curl.exe -s -X POST http://localhost:3003/api/v1/device-activation/activate -H "Content-Type: application/json" -d "@-"
```

### Response (HTTP 200 OK):
```json
{
  "success": true,
  "message": "Device activated successfully",
  "data": {
    "deviceId": "60f26c88-cc29-4488-bc99-234bc6f34011",
    "device_id": "SUNMI-T2-SN-998877",
    "deviceCode": "DVC-00004",
    "device_code": "DVC-00004",
    "deviceName": "Front Counter POS 01",
    "device_name": "Front Counter POS 01",
    "serialNumber": "SUNMI-T2-SN-998877",
    "serial_number": "SUNMI-T2-SN-998877",
    "activationCode": "PK-887949",
    "authorization_code": "PK-887949",
    "status": "ACTIVE",
    "merchant": {
      "id": "a1111111-0000-0000-0000-000000000001",
      "merchantCode": "MCH-1001",
      "businessDisplayName": "Fresh Mart Organics LLC"
    },
    "store": {
      "id": "e1111111-0000-0000-0000-000000000001",
      "storeCode": "STR-DT-01",
      "storeName": "Fresh Mart - Downtown Branch",
      "storeWebsiteUrl": "https://str-dt-01.mch-1001.pch.com"
    },
    "registerId": "REG-01",
    "deviceAccessToken": "<jwt-access-token>",
    "accessToken": "<jwt-access-token>",
    "token": "<jwt-access-token>"
  }
}
```

---

## 3. Database Management & pgAdmin
- **PostgreSQL Database Port**: `5432`
- **Database Name**: `pinaka_commerce_hub_new`
- **User**: `pdh_user`
- **Password**: `pdh_password`
- **pgAdmin Web Dashboard (Docker)**: `http://localhost:5050`
  - Default Email: `admin@pdh.com`
  - Default Password: `pdh_password`
- **pgAdmin 4 Native Desktop App**: 
  - Executable: `C:\Program Files\PostgreSQL\18\pgAdmin 4\runtime\pgAdmin4.exe`
