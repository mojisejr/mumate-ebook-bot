# mumate-ebook-bot

หลังบ้านของการขาย E-Book ผ่าน ManyChat ทำงานแทนส่วนที่แอดมินทำเอง ตามแผน CIEL workstream `mumate-manychat-ebook-001`

- **slice 1:** รับ External Request จาก flow ทดสอบใน ManyChat บันทึก event และตอบกลับเฉพาะ tester
- **slice 2 (ตอนนี้):** ตรวจสลิปด้วย Slip2Go แล้วส่ง flow ส่งของ (ลิงก์ E-Book, คูปองแอป, รูปวิธีกรอก) แบบเดียวกับที่ทีมส่งเอง
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
| `POST /ebook-api/manychat/slip` | รูปสลิปจาก flow ทดสอบ `{subscriber_id, image_url}` header เดียวกับ hook |

## สัญญากับ ManyChat (External Request)

- **header:** `X-Ebook-Hook-Secret: <EBOOK_HOOK_SECRET ของ env นั้น>`
- **body:** `{"subscriber_id": "{{user_id}}", "step": "<a-z0-9_>"}`
- **การตอบ:** แอปตอบทันทีด้วย dynamic reply ว่าง ๆ แล้วค่อยทำงานต่อ
  เพราะ ManyChat รอได้ราว 10 วินาที ข้อความตอบลูกค้าส่งตามไปทาง `sendContent`

## ตรวจสลิป (slice 2)

- **ผ่านเมื่อ Slip2Go ตอบ `200200` เท่านั้น** (`200000` ไม่นับ) และ `transRef` ยังไม่เคยจ่ายออเดอร์อื่น
- **ผ่าน:** ติด tag `bot_paid` แล้วส่ง flow `EBOOK_FLOW_DELIVER` ครั้งเดียวต่อออเดอร์
- **ไม่ผ่าน / รอแอดมิน:** ใส่เหตุผลใน field `bot_reason` ติด `bot_rejected` หรือ `bot_admin` แล้วส่ง flow `EBOOK_FLOW_NOTICE`
- **ลองใหม่:** ธนาคารขัดข้อง เรียกถี่เกิน หรือ Slip2Go ล่ม ลองใหม่ทุก 1, 2, 4, 8 นาที ครั้งที่ 5 ส่งให้แอดมิน
- **คำสั่งแอดมิน** (ผ่าน `bin/ebook.sh` ของ mumate-infra): `bun run src/cli.ts orders|pending|resend|mark-paid`
- tag และ field ข้างบนต้องสร้างไว้ใน ManyChat ก่อน

## ด่านกันพลาด

- **ส่งข้อความได้เฉพาะคนใน `EBOOK_ALLOWLIST`** คนอื่นถูกบันทึกว่า `blocked` และไม่ได้รับอะไร
- **`EBOOK_OPEN=1` ใช้ได้บน production เท่านั้น** และเปิดได้ตั้งแต่ slice 4
- **ไม่เก็บข้อความแชท** และไม่มี secret ใน repo

## พัฒนาในเครื่อง

```bash
bun install
bun test test/
# store กับ Postgres จริง (ฐานข้อมูลทิ้งได้ในเครื่องเท่านั้น): ดูหัวไฟล์ test/pg.test.ts
bunx tsc --noEmit
```

## Migration

`migrations/` เป็นแบบเพิ่มอย่างเดียว รันซ้ำได้ และรันด้วยมือ:
- **staging:** `pgstaging` ตาม runbook 05 ของ mumate-infra
- **production:** รันเมื่อเจ้าของสั่ง ผ่าน `bin/prod-sql.sh` และต้องรันก่อน release ที่ต้องใช้ migration นั้น
- **role ของแอปบน production:** แอป login เป็น `ebook_app` ซึ่ง mumate-infra `bin/db-role.sh` สร้างแบบไม่มีสิทธิ์อะไรเลย
  สิทธิ์ทั้งหมดอยู่ใน `0003_ebook_app_grants.sql`: อ่านและเขียนได้แค่ 3 ตารางของแอปนี้ ลบไม่ได้ สร้างตารางไม่ได้
  ไม่เห็นตารางสมาชิกหรือการจ่ายเงินของ MuMate · staging ไม่มี role นี้ 0003 จึงไม่ทำอะไร
  ลำดับ: 0001 → 0002 → `bin/db-role.sh ebook_app env/ebook.env EBOOK_DATABASE_URL --commit` → 0003
- **ทดสอบกับ Postgres จริง:** `test/pg.test.ts` (ดูหัวไฟล์) ครอบ 0003 ด้วย: login เป็น `ebook_app` แล้วเขียนตารางของแอปได้
  แต่อ่านตารางอื่น ลบ และสร้างตารางไม่ได้
