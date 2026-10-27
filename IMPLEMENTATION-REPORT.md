# Báo cáo triển khai và kiểm thử E-Commerce MVP

Ngày: 27/10/2026, múi giờ người dùng Asia/Saigon. Project: `D:\Projects\Ecommerce-Microservices`.

Đã tạo và chạy Backend MVP theo sáu giai đoạn triển khai trong PLAN. **13 container runtime healthy**, hai job khởi tạo exit 0, Gateway tại [http://localhost:3001/api/health](http://localhost:3001/api/health) trả UP. Có source, Proto, database thật, gRPC, Kafka, Redis, seed và script PowerShell. Không cần tạo thư mục/database/topic bằng tay.

## Kết quả tổng hợp

| Kiểm tra đã chạy | Kết quả thực tế |
|---|---|
| `npm.cmd run check` | Exit 0; syntax JavaScript và load đủ 5 Proto service. |
| `npm.cmd test` | Exit 0; 17/17 test cô lập đạt. Đây không phải bằng chứng thay thế database/Kafka. |
| PowerShell AST parse | Exit 0; đủ 14 script `.ps1` không lỗi cú pháp. |
| `Start.ps1` | Exit 0; sinh/giữ `.env`, build image, up `--wait`, health UP và seed lặp lại. |
| `Demo-Grading.ps1` | Exit 0; chạy lệnh cho 8 mục, kiểm tra Compose/topic/group và suite 25/25 đạt. |
| `Test-System.ps1` | Exit 0; 8/8 nhóm kiểm tra API, quyền, JWT, Redis và validation đạt. |
| `Test-Resilience.ps1` | Exit 0; 7/7 nhóm kiểm tra tồn kho, lỗi PostgreSQL và phục hồi trạng thái đạt. |
| `Test-KafkaRecovery.ps1` | Exit 0; Kafka dừng thật → health 503/Outbox PENDING → khôi phục → SENT/Kafka/Shipment đúng. |
| `Test-OrderRecovery.ps1` | Exit 0; Order bị SIGKILL thật, exit 137; sau restart bù kho đúng, không Order/Outbox thừa. |
| `npm.cmd audit --omit=dev --audit-level=high` | Exit 0, `found 0 vulnerabilities` sau cập nhật grpc-js 1.14.6. Đây là kết quả npm audit, không phải kiểm định bảo mật toàn hệ thống. |

Bằng chứng nguồn 25 TC: [JSON report](artifacts/integration-last.json) và [log suite đầy đủ](artifacts/integration-all-20261027-190116-051.log). Các log dùng ID thực của lần chạy; dữ liệu test được giữ trong database để có thể kiểm tra lại.

## Giai đoạn 1 — Cấu trúc, contract và Docker

Đã tạo `proto/`, `shared/`, sáu thư mục ứng dụng trong `services/`, `infra/mongo/`, `scripts/`, `tests/`, Dockerfile, Compose, package/lockfile và `.env.example`. Năm service nghiệp vụ có domain/application/infrastructure/interfaces. Common Proto chứa các message kỹ thuật dùng chung; mỗi service có contract riêng.

Đã chạy `Initialize.ps1`, `docker compose config --quiet`, build và up `--wait`. Lần đầu tạo volume sạch cho project này; các lần up/recreate sau giữ volume. Product Mongo replica set primary đã được khởi tạo; topic `order-created` có một partition và replication factor 1. Đây là môi trường local, không phải HA.

Phiên bản quan sát được: Docker Engine 29.8.0, Compose 5.5.1, Node trong container 24.21.0, PostgreSQL 17.11, MongoDB 8.0.34, Redis 7.4.12, Kafka image 3.9.1. Base image và image hạ tầng đã khóa digest; npm có package-lock.

Kết quả: đủ 13 runtime container, hai init job thành công và health thực. Một project khác tại `D:\Projects\ecommerce-mvp` đang sử dụng cổng 3000; bài này dùng 3001.

## Giai đoạn 2 — Auth, Gateway và Redis

Đã tạo bảng User/Role và tác vụ provisioning trong Auth PostgreSQL; bcrypt, JWT có sub/role/exp/issuer/audience, đăng ký/đăng nhập và VerifyToken gRPC. Gateway validate REST, routing, logging, truyền actor nội bộ, cache JWT theo fingerprint và rate limit Lua trong Redis.

Đã chạy `Test-Auth.ps1`: TC-IAM-01–05 đạt trên API/PostgreSQL thật, gồm hash mật khẩu và không tạo User trùng. Suite System bổ sung JWT sai/hết hạn, không cho tự chọn role khi đăng ký, cache có TTL thật và ngừng xác thực khi token hết hạn.

Kết quả Redis thật: TTL cache quan sát 60 giây; burst request thực trả 429 sau khi counter vượt giới hạn 120/60 giây/IP. Test chỉ khôi phục rate key của chính container kiểm thử để không ảnh hưởng lần chạy tiếp theo. [Log System](artifacts/system-all-20261027-190245-882.log).

Register lưu User và provisioning job nguyên tử; nếu Customer tạm lỗi thì 201 có thông báo pending. Login trả 503 đến khi profile được tạo thành công. Test cô lập đã kiểm tra lỗi và retry của nhánh này; không coi test dùng repository trong RAM là kiểm chứng outage Customer container thật.

## Giai đoạn 3 — Customer, Membership và Product

Đã tạo Customer/Membership PostgreSQL, read/update theo ownership và Membership API. EnsureCustomer idempotent được dùng trong đăng ký thật; tài khoản mới không cần seed Customer bằng tay. Product CRUD và tồn kho đọc/ghi MongoDB thật, Admin mới được ghi.

Đã chạy `Test-Customer.ps1` và `Test-Product.ps1`: mỗi nhóm 5/5 đạt. TC-CUS-04 đối chiếu JOIN nội bộ Customer→Membership, trả Gold/score 500 theo fixture demo; TC-CUS-05 bỏ JWT trả 401; TC-PRO-01 đối chiếu các field Product với MongoDB. System còn kiểm tra Admin DELETE, quyền Customer và ngăn tự sửa mid.

Không tự tích lũy điểm, không thêm Inventory/Tracking subsystem. DELETE Product ẩn khỏi catalog nhưng giữ document nội bộ để bù kho cho operation trước đó.

## Giai đoạn 4 — Order, tiền và nhất quán tồn kho

Đã tạo Order/OrderDetail/Outbox/order_attempts trong Order PostgreSQL; Order điều phối Customer/Product gRPC, lấy actor từ JWT và giá/score từ service sở hữu. Giảm kho nhiều sản phẩm và receipt cùng Mongo transaction; có operationId, fingerprint, tombstone, bù trừ và trạng thái phục hồi bền vững.

Đã chạy nhóm Order và kiểm tra lại trong suite đầy đủ. Ví dụ thực TC-ORD-04: **oid=8**, score=500, subtotal=37.05, rate demo=10%, discount=3.71 theo half-up, total_amount=33.34. Expected được tính độc lập từ policy cấu hình và dữ liệu DB, không gọi hàm production để tự xác nhận.

`Test-Resilience.ps1` đạt 7 nhóm, gồm:

- Apply cùng operationId chỉ trừ một lần; payload khác bị từ chối; Cancel hai lần chỉ bù một lần.
- Cancel trước Apply tới muộn không làm mất kho.
- Một item thiếu kho làm rollback mọi decrement của đơn nhiều item.
- Hai Order cạnh tranh cho tồn kho 5, mỗi đơn yêu cầu 4: một 201, một 409; tồn kho còn 1, chỉ một Order.
- Trigger PostgreSQL dành riêng cho uid test làm INSERT Order thất bại: HTTP 500, Order/Outbox không tồn tại, kho trở lại 9 và attempt ABORTED. Trigger/function được dọn trong finally.
- Worker thật xử lý attempt bền vững đã hết lease, bù kho và không tạo Order.
- Khóa trạng thái ABORTING chặn một commit cũ, không tạo Order sau khi bù.

[Log Resilience](artifacts/resilience-all-20261027-190250-239.log).

Đã kiểm tra thêm SIGKILL/restart Order thật. Với operation `0a507113-f6c1-4f6a-81e2-2301dbe6ec7a`, tồn kho 14 được trừ xuống 10 ở ranh giới trước Order commit; container exit 137; sau restart kho trở lại 14, attempt ABORTED, receipt CANCELLED, Order/Outbox count=0. Restart policy `unless-stopped` đã được khôi phục. [Bằng chứng recovery](artifacts/order-restart-20261027-190716-151-check.json), [trạng thái container lúc dừng](artifacts/order-restart-20261027-190716-151-stopped.json).

Phạm vi chứng cứ: state trước commit được dựng có chủ đích bằng DB và RPC thật rồi process bị kill/restart thật. Chưa thử cắt một HTTP request tại mọi dòng nguồn hoặc cưỡng bức làm mất acknowledgement COMMIT/gRPC trên mạng. Không suy ra đã kiểm thử toàn bộ lịch interleaving từ các case này.

## Giai đoạn 5 — Outbox, Kafka và Shipment

Đã tạo publisher nền, broker acknowledgement trước SENT, pending retry, consumer group Shipment, event validation, receipt sourceEventId unique, rejected_events và Shipment GET/PATCH. Outbox và Shipment không dùng kết quả trả về hardcode.

TC-ORD-05 trong suite đầy đủ: **oid=9**, eventId `8939f78f-0fe1-4555-9582-2107b8bedfba`, topic order-created/partition 0/offset 10, Outbox SENT; Shipment thật được tạo rồi Staff cập nhật SHIPPING. TC-SHP-02 gửi event thiếu oid vào Kafka, bị ghi rejected_events và không tạo Shipment. TC-SHP-05 phát lại cùng event hai lần, đợi group commit offset rồi xác nhận chỉ một Shipment. Cuối demo, consumer lag=0.

Đã thực hiện outage broker bằng `Test-KafkaRecovery.ps1`:

1. Dừng Kafka thật; health trả HTTP 503.
2. API vẫn commit **oid=12**, kho 8→6, Outbox PENDING, eventId `3579ece6-2f48-40f4-b537-5e2e0e654bac`.
3. Khởi động lại Kafka trong finally; Outbox chuyển SENT, publishAttempts=2.
4. Consumer kiểm chứng riêng đọc đúng event/payload; Shipment **shipid=10**, count theo eventId=1; health trở về UP.

[Bằng chứng khi broker dừng](artifacts/kafka-outage-20261027-190257-894-create.json), [bằng chứng khôi phục](artifacts/kafka-outage-20261027-190257-894-check.json).

## Giai đoạn 6 — Bàn giao và diễn tập

Đã chạy `Start.ps1` sau rebuild và seed lần hai, giữ được tài khoản/sản phẩm/Order đã có. `Demo-Grading.ps1` đã thực thi đủ tám mục: Proto/cấu trúc; Compose/containers/health; Kafka topic/group; năm TC ưu tiên nằm trong suite đầy đủ 25/25. Giải thích trước giảng viên vẫn cần người trình bày hiểu source; script cung cấp lệnh và bằng chứng.

Đã tạo README tiếng Việt, hướng dẫn PowerShell, tài khoản demo, API, cách thay policy, các lệnh kiểm thử theo nhóm và thao tác Windows có thể cần làm. Báo cáo JSON/log ở `artifacts/`; `.env`, node_modules, artifacts bị loại khỏi Git bằng `.gitignore`.

Trạng thái cuối đã kiểm tra: **13 runtime đều healthy**, Gateway UP, order_attempts chỉ có COMMITTED hoặc ABORTED, toàn bộ 10 Outbox tại thời điểm kiểm tra là SENT, không còn PREPARED/ABORTING/PENDING. Các số lượng này là snapshot của những lần chạy test đã thực hiện, sẽ thay đổi khi tạo đơn/test tiếp.

## Các vấn đề đã sửa và giới hạn còn lại

- Audit phát hiện grpc-js 1.14.0 có advisory high: đã nâng lên 1.14.6, cập nhật lockfile, rebuild, chạy lại demo/source suite và audit; audit sau sửa có 0 vulnerability.
- Demo từng lỗi vì PowerShell tìm cả `docker.exe` lẫn file `docker` không có đuôi, trả một mảng đường dẫn cho Process.Start. Đã chọn chính xác một docker.exe; demo sau sửa exit 0. Log lần thất bại giữ nguyên, không được tính PASS.
- Kiểm tra restart ban đầu dùng stop timeout 0 nhưng service vẫn exit 0 do shutdown nhanh, nên chưa chứng minh SIGKILL. Đã sửa coordinator tạm tắt autorestart của đúng container, gửi KILL, xác nhận exit 137 rồi khôi phục policy/service trong finally. Lần chạy mới đạt; attempt của lần trước sau đó cũng được worker bù kho.
- KafkaJS 2.2.4 trên Node 24 đã ghi `TimeoutNegativeWarning` trong stderr một số lần chạy. Trace nằm trong `RequestQueue.scheduleCheckPendingRequests`; các assertion và exit code tương ứng vẫn đạt. Không sửa hoặc tắt cảnh báo của dependency; `.docker.log` giữ nguyên để kiểm tra.
- Policy score/discount là **demo cấu hình được**, vì nguồn không có bảng ngưỡng. Membership mẫu và quy tắc provisioning/quyền còn thiếu trong nguồn đã được công khai tại PLAN mục 10 và README. Khi giảng viên cung cấp policy khác, cập nhật `.env` và chạy lại các test liên quan.
- Đây là MVP local HTTP, single broker và Mongo replica set một member; chưa triển khai TLS public, HA, benchmark tải hoặc mọi lịch lỗi mạng. Các phần này không được coi là đã kiểm thử.

## Người dùng cần làm gì

Hệ thống hiện đang chạy. Để xem bài, mở README và chạy:

```powershell
Set-Location 'D:\Projects\Ecommerce-Microservices'
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\Demo-Grading.ps1
```

Sau khi đóng/mở lại máy, mở Docker Desktop chờ Linux Engine sẵn sàng rồi chạy `scripts\Start.ps1`. Việc tạo secret local, migration, replica set, topic và seed đều tự động. Nếu Docker Desktop yêu cầu WSL 2 hoặc reboot trong thiết lập lần đầu, hoàn tất theo giao diện Docker Desktop; trạng thái máy hiện tại đã chạy được Engine.
