# mumate-ebook-bot

หลังบ้านของการขาย E-Book ผ่าน ManyChat ทำงานแทนส่วนที่แอดมินทำเอง ตามแผน CIEL workstream `mumate-manychat-ebook-001`

- **slice 1 (ตอนนี้):** รับ External Request จาก flow ทดสอบใน ManyChat บันทึก event และตอบกลับเฉพาะ tester
- **slice 2:** ตรวจสลิปด้วย Slip2Go และส่งลิงก์ PDF กับโค้ดแอป
- **slice 3:** ข้อมูลว่าใครจ่ายและใครไม่จ่าย
- **slice 4:** ปล่อยจริงบน production

## รันอย่างไร

`mumate-infra` เป็นตัวรันแอปนี้ ในโปรไฟล์ compose `ebook`:
- image tag คือ git SHA ของ repo นี้
- merge เข้า main แล้ว staging (`mumate-2`) จะตามเอง
- production ต้องให้เจ้าของกด promote
- path ของแอปคือ `/ebook-api/` บน host เดิม

| Endpoint | ใช้ทำอะไร |
|---|---|
| `GET /ebook-api/health` | `200` เมื่อแอปทำงาน (ไม่ขึ้นกับฐานข้อมูล เพื่อไม่ให้แอปนี้ทำ deploy ของ fe/bazi ล้ม) พร้อม `db`, `sha`, `env` |
| `GET /ebook-api/ready` | `200` เมื่อฐานข้อมูลตอบ, `503` เมื่อไม่ตอบ |
| `POST /ebook-api/manychat/hook` | External Request จาก ManyChat |

## สัญญากับ ManyChat (External Request)

- **header:** `X-Ebook-Hook-Secret: <EBOOK_HOOK_SECRET ของ env นั้น>`
- **body:** `{"subscriber_id": "{{user_id}}", "step": "<a-z0-9_>"}`
- **การตอบ:** แอปตอบทันทีด้วย dynamic reply ว่าง ๆ แล้วค่อยทำงานต่อ
  เพราะ ManyChat รอได้ราว 10 วินาที ข้อความตอบลูกค้าส่งตามไปทาง `sendContent`

## ด่านกันพลาด

- **ส่งข้อความได้เฉพาะคนใน `EBOOK_ALLOWLIST`** คนอื่นถูกบันทึกว่า `blocked` และไม่ได้รับอะไร
- **`EBOOK_OPEN=1` ใช้ได้บน production เท่านั้น** และเปิดได้ตั้งแต่ slice 4
- **ไม่เก็บข้อความแชท** และไม่มี secret ใน repo

## พัฒนาในเครื่อง

```bash
bun install
bun test test/
bunx tsc --noEmit
```

## Migration

`migrations/` เป็นแบบเพิ่มอย่างเดียว รันซ้ำได้ และรันด้วยมือ:
- **staging:** `pgstaging` ตาม runbook 05 ของ mumate-infra
- **production:** รันเมื่อเจ้าของสั่ง ผ่าน `bin/prod-sql.sh` และต้องรันก่อน release ที่ต้องใช้ migration นั้น
