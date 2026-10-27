# Backend E-Commerce MVP

Bài thực hành Node.js theo Microservices, DDD và Database-per-Service. API Gateway nhận REST/JSON, gọi năm service bằng gRPC; Order phát sự kiện qua Kafka để Shipment xử lý bất đồng bộ. PostgreSQL, MongoDB và Redis đều là dịch vụ thật trong Docker Compose.

Tài liệu đầu vào được giữ nguyên tại `doc/`. Phân tích và quyết định triển khai nằm trong [PLAN.md](PLAN.md), quy tắc làm việc trong [AGENTS.md](AGENTS.md), kết quả đã chạy và bằng chứng từng giai đoạn trong [IMPLEMENTATION-REPORT.md](IMPLEMENTATION-REPORT.md).

## Chạy trên Windows

Cần Docker Desktop chạy Linux containers và PowerShell. Node.js trên Windows không bắt buộc để chạy stack: image Node và các package được build trong Docker.

Mở PowerShell tại thư mục dự án và chạy:

```powershell
Set-Location 'D:\Projects\Ecommerce-Microservices'
powershell -NoProfile -File .\scripts\Start.ps1
powershell -NoProfile -File .\scripts\Test-All.ps1
powershell -NoProfile -File .\scripts\Demo-Grading.ps1
```

`Start.ps1` tự tạo `.env` với secret ngẫu nhiên nếu chưa tồn tại, kiểm tra Docker Engine, build image, khởi động Compose, chờ health và seed dữ liệu mẫu. Khi `.env` đã có, script giữ nguyên cấu hình và secret. Không phải tạo thư mục, database, bảng, collection, replica set hoặc Kafka topic bằng tay.

API mặc định: [http://localhost:3001/api/health](http://localhost:3001/api/health). Cổng 3001 được chọn vì máy hiện có một project khác dùng cổng 3000. Các service, database và broker dùng mạng Docker nội bộ.

Lần khởi động đầu có thể mất vài phút để tải image. Dừng và chạy lại:

```powershell
powershell -NoProfile -File .\scripts\Stop.ps1
powershell -NoProfile -File .\scripts\Start.ps1
```

`Stop.ps1` dừng container và giữ dữ liệu. Không cần xóa volume giữa các lần chạy. Khi sửa code, chạy lại `Start.ps1` để build và cập nhật ứng dụng.

Nếu PowerShell chặn script, chỉ mở quyền cho cửa sổ hiện tại rồi gọi script trực tiếp:

```powershell
Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
.\scripts\Start.ps1
```

Nếu cần cổng khác, chạy `Initialize.ps1 -Port 3010` trước lần khởi tạo đầu, hoặc sửa đúng dòng `API_PORT` trong `.env` đã có rồi chạy lại `Start.ps1`. Không đổi password database trong `.env` sau khi volume đã được khởi tạo mà chưa có quy trình đổi password tương ứng.

## Những thao tác Windows có thể cần làm thủ công

- Mở Docker Desktop và chờ Linux Engine sẵn sàng. Nếu Docker Desktop yêu cầu thiết lập WSL 2 hoặc khởi động lại Windows trong lần cài đầu, hoàn tất bước đó theo giao diện Docker Desktop rồi chạy lại `Start.ps1`.
- Nếu cổng API bị dùng, đổi `API_PORT` như hướng dẫn trên. Script không tự dừng project khác trên máy.
- Khi giảng viên cung cấp công thức score/discount khác, sửa `DISCOUNT_POLICY` trong `.env` theo cấu trúc đã mô tả, sau đó chạy lại `Start.ps1` và kiểm thử.

Ngoài các điều kiện môi trường đó, cấu trúc thư mục, secret local, migrations, replica set, topic, tài khoản và dữ liệu demo được tạo tự động bằng script/code trong repository.

## Kiến trúc và cấu trúc thư mục

| Thành phần | Trách nhiệm | Lưu trữ thuộc sở hữu |
|---|---|---|
| API Gateway | REST, JWT, quyền, routing gRPC, logging, cache, rate limiting | Redis |
| Auth | User, Role, bcrypt, JWT, tạo hồ sơ Customer sau đăng ký | PostgreSQL `auth-db` |
| Customer | Customer, Membership và score | PostgreSQL `customer-db` |
| Product | Product, giá và tồn kho | MongoDB `product-db`, replica set local một member |
| Order | Điều phối đặt hàng, tính discount, Order/OrderDetail/Outbox | PostgreSQL `order-db` |
| Shipment | Nhận OrderCreated, tạo Shipment, cập nhật status | MongoDB `shipment-db` |
| Kafka | Topic `order-created`, lưu message và offset của consumer group | Volume Kafka |

Compose có 13 container thường trực: 6 ứng dụng, 3 PostgreSQL, 2 MongoDB, Redis và Kafka. Hai job `product-db-init`, `kafka-init` chạy khởi tạo rồi thoát với exit 0; chúng không phải service cần chạy liên tục. `test-runner` thuộc profile `tools`, chỉ chạy khi seed/kiểm thử.

```text
proto/                              # 5 contract nghiệp vụ + common.proto
shared/                             # gRPC, lỗi, biểu diễn tiền, Kafka client
services/
  api-gateway/src/                   # HTTP routes và middleware
  auth-service/src/
  customer-service/src/
  product-service/src/
  order-service/src/
  shipment-service/src/
    domain/                         # quy tắc nghiệp vụ độc lập transport/DB
    application/                    # các use case và điều phối
    infrastructure/                 # repository, SQL/Mongo/Kafka
    interfaces/                     # gRPC handlers
infra/                              # cấu hình khởi tạo hạ tầng
scripts/                            # PowerShell, seed, healthcheck
tests/                              # kiểm tra domain và tích hợp thật
artifacts/                          # báo cáo từng lần chạy, không commit
doc/                                # tài liệu nguồn, giữ nguyên
```

Các tầng `domain/application/infrastructure/interfaces` áp dụng cho từng service nghiệp vụ. Domain không đọc database trực tiếp; application gọi repository qua interface của module; infrastructure hiện thực việc truy cập DB và broker.

Không có foreign key hoặc SQL JOIN xuyên service. Customer dùng `uid` do Auth cấp; Order giữ `uid`/`pid`; Shipment giữ `oid` bằng tham chiếu logic. Chỉ những quan hệ cùng PostgreSQL, như OrderDetail→Order hoặc Customer→Membership, mới dùng FK thật.

## Giải thích Proto khi bảo vệ bài

`proto/auth.proto`, `customer.proto`, `product.proto`, `order.proto`, `shipment.proto` mô tả RPC và message của từng context; `common.proto` chứa message kỹ thuật dùng chung. Xem trực tiếp:

```powershell
Get-ChildItem .\proto\*.proto
Get-Content .\proto\order.proto
```

- `service` là contract gRPC; `rpc` định nghĩa phương thức cùng request/response.
- `message` quy định các trường dữ liệu; field number phải ổn định để giữ tương thích wire format.
- ID nghiệp vụ vẫn là `uid`, `mid`, `pid`, `oid`, `shipid`. Tiền truyền qua gRPC bằng chuỗi decimal, tránh dùng float để tính toán.
- REST body được Gateway validate, chuyển sang gRPC; service trả status nghiệp vụ, Gateway đổi thành HTTP 400/401/403/404/409/503/504 tương ứng.
- gRPC là request/response có deadline. Kafka lưu event để consumer xử lý về sau; Order không cần chờ Shipment tạo xong để commit.

## Dữ liệu mẫu và chính sách demo

Các tài khoản dưới chỉ dành cho bài thực hành local:

| Role | Username | Password |
|---|---|---|
| Admin | `demo_admin` | `DemoAdmin123!` |
| Customer | `demo_customer` | `DemoCustomer123!` |
| Shipment Staff | `demo_staff` | `DemoStaff123!` |

Seed giữ tài khoản/sản phẩm đã có; không đặt lại tồn kho mỗi lần chạy. Customer demo được gán Gold ở lần tạo đầu. Tài khoản đăng ký mới có role CUSTOMER, fullname ban đầu bằng username và Membership Basic. Chỉ Admin được sửa `mid`; Customer tự sửa fullname.

**Tài liệu nguồn không cung cấp ngưỡng score → discount.** Để có thể chạy và trình diễn, bài dùng chính sách demo cấu hình qua `DISCOUNT_POLICY`:

| Membership mẫu | Score | Policy demo |
|---|---:|---:|
| Basic | 0 | Score 0–99: giảm 0% |
| Silver | 100 | Score 100–499: giảm 5% |
| Gold | 500 | Score từ 500: giảm 10% |

```dotenv
DISCOUNT_POLICY=[{"minScore":0,"rate":0},{"minScore":100,"rate":5},{"minScore":500,"rate":10}]
```

`score` nằm trên Membership theo Bounded Context, không phải số dư điểm tích lũy cá nhân. Chưa có tính năng cộng/trừ điểm sau mua hàng. Đây là policy demo được chọn khi triển khai, không phải quy tắc có sẵn trong tài liệu gốc.

`discount` là **số tiền giảm**, không phải phần trăm. Tổng trước giảm = Σ(qty × unit_price); số tiền giảm được làm tròn half-up đến hai chữ số thập phân; tổng phải trả = tổng trước giảm − discount. Hệ thống dùng đơn vị tiền quy ước hai chữ số thập phân, không tự gán VND/USD. Tính toán bằng đơn vị nhỏ nhất/decimal; REST hiển thị tiền dạng số theo mẫu API, gRPC/event giữ chuỗi decimal.

Ví dụ demo: giá 1500.00, qty=2, Gold score=500 → subtotal=3000.00, discount=300.00, total_amount=2700.00. Kết quả thực lấy từ giá và score trong database; không trả các con số ví dụ này cố định.

## API và quyền truy cập

| Method / route | Quyền | Dữ liệu chính |
|---|---|---|
| POST `/api/auth/register` | Không JWT | username, password; email/phone optional |
| POST `/api/auth/login` | Không JWT | username/password → accessToken |
| GET `/api/customers/:uid` | Owner/Admin | uid, fullname, mid |
| PUT `/api/customers/:uid` | Owner/Admin | fullname; mid chỉ Admin |
| GET `/api/customers/:uid/membership` | Owner/Admin | mid, mname, score |
| GET `/api/products` | Có JWT | Danh sách products |
| GET `/api/products/:pid` | Có JWT | Product chi tiết |
| POST `/api/products` | Admin | pname, price, quantity |
| PUT `/api/products/:pid` | Admin | Cập nhật Product/tồn kho |
| DELETE `/api/products/:pid` | Admin | Xóa Product khỏi catalog |
| POST `/api/orders` | Có JWT | items chứa pid/qty |
| GET `/api/orders` | Có JWT | Order của người gọi |
| GET `/api/orders/:oid` | Owner/Admin | Order, details và shipments đã có |
| GET `/api/shipments/:shipid` | Owner/Admin | Shipment chi tiết |
| PATCH `/api/shipments/:shipid/status` | Staff/Admin | status |
| GET `/api/health` | Không JWT | 200 UP hoặc 503 khi dependency required lỗi |

Endpoint Membership được bổ sung để thực hiện TC-CUS-04 vì API Specification nguồn chưa định nghĩa route này. JWT có `sub`, `role`, expiry; thiếu/sai/hết hạn token trả 401, đã xác thực nhưng thiếu quyền trả 403.

Sau khi User được tạo, Auth gọi EnsureCustomer idempotent. Nếu Customer tạm lỗi, đăng ký vẫn trả 201 kèm thông báo profile đang được tạo và giữ tác vụ retry bền vững. Đăng nhập sẽ trả 503 cho đến khi profile được tạo; đăng nhập thành công bảo đảm Customer đã sẵn sàng. Auth không tự sửa database của Customer.

## Gọi API bằng PowerShell

Ví dụ sau lấy pid và uid từ response thật; không cần giả định ID fixture:

```powershell
$base = 'http://localhost:3001'
$loginBody = @{ username = 'demo_customer'; password = 'DemoCustomer123!' } | ConvertTo-Json
$login = Invoke-RestMethod -Method Post -Uri "$base/api/auth/login" -ContentType 'application/json' -Body $loginBody
$headers = @{ Authorization = "Bearer $($login.accessToken)" }
$products = Invoke-RestMethod -Uri "$base/api/products" -Headers $headers
$product = $products.items | Where-Object { $_.quantity -gt 0 } | Select-Object -First 1
if (-not $product) { throw 'No product has available stock.' }
$orderBody = @{ items = @(@{ pid = $product.pid; qty = 1 }) } | ConvertTo-Json -Depth 5
$order = Invoke-RestMethod -Method Post -Uri "$base/api/orders" -Headers $headers -ContentType 'application/json' -Body $orderBody
$order | ConvertTo-Json -Depth 8
Invoke-RestMethod -Uri "$base/api/customers/$($order.uid)/membership" -Headers $headers
Invoke-RestMethod -Uri "$base/api/orders/$($order.oid)" -Headers $headers | ConvertTo-Json -Depth 8
```

POST Order lấy uid từ JWT, score từ Customer/Membership và giá từ Product. Client không quyết định discount, unit_price hay uid. Response 201 có thể có `shipments: []` vì consumer chưa chạy xong; đọc GET Order lại sau đó để thấy `shipments[].shipid/status`. Mẫu response nguồn có shipid ngay được thay bằng hành vi nhất quán với thiết kế bất đồng bộ, đã ghi trong PLAN.

## Transaction, Outbox và tồn kho

Order, OrderDetail và OutboxEvent được lưu cùng transaction PostgreSQL. Publisher chỉ đọc event đã commit, gửi topic `order-created`, nhận broker acknowledgement rồi mới đánh dấu đã gửi. Broker lỗi sau commit không làm mất Order; outbox giữ pending và retry.

Giảm kho ở MongoDB và lưu Order ở PostgreSQL không thuộc cùng transaction. Order có trạng thái điều phối bền vững `order_attempts`; Product ghi `inventory_operations` cùng cập nhật tồn kho trong Mongo transaction. Retry cùng operationId không trừ lại. Khi không tạo được Order, bù kho idempotent; recovery xử lý sau restart. Dấu CANCELLED ngăn RPC Apply tới muộn trừ kho sau khi đã hủy; khóa/trạng thái attempt ngăn worker cũ commit Order sau ABORTING.

Product MongoDB chạy replica set một member để hỗ trợ transaction nhiều document cho các item và receipt. Đây là topology local, không phải HA. Shipment chống lặp bằng `sourceEventId` unique và ghi event ID cùng document kết quả; không áp unique oid vì ERD cho phép một Order có nhiều Shipment.

## Kafka và kiểm thử thật

```powershell
docker compose exec -T kafka /opt/kafka/bin/kafka-topics.sh --bootstrap-server kafka:9092 --list
docker compose exec -T kafka /opt/kafka/bin/kafka-topics.sh --bootstrap-server kafka:9092 --describe --topic order-created
docker compose exec -T kafka /opt/kafka/bin/kafka-consumer-groups.sh --bootstrap-server kafka:9092 --describe --group shipment-service-v1
```

Order là producer, Shipment là consumer thuộc group `shipment-service-v1`. Kafka có partition, offset và consumer group; outbox retry và event dedup xử lý khả năng giao lặp. Không tuyên bố exactly-once xuyên Kafka và database ngoài Kafka.

Các lệnh kiểm thử:

```powershell
powershell -NoProfile -File .\scripts\Test-Auth.ps1
powershell -NoProfile -File .\scripts\Test-Customer.ps1
powershell -NoProfile -File .\scripts\Test-Product.ps1
powershell -NoProfile -File .\scripts\Test-Order.ps1
powershell -NoProfile -File .\scripts\Test-KafkaShipment.ps1
powershell -NoProfile -File .\scripts\Test-All.ps1
powershell -NoProfile -File .\scripts\Test-System.ps1
powershell -NoProfile -File .\scripts\Test-Resilience.ps1
powershell -NoProfile -File .\scripts\Test-KafkaRecovery.ps1
powershell -NoProfile -File .\scripts\Test-OrderRecovery.ps1
docker compose --profile tools run --rm -T test-runner npm test
```

`Test-All.ps1` chạy 25 case nguồn qua API thật, đối chiếu PostgreSQL/MongoDB và đọc Kafka cho các case liên quan. Script trả exit code khác 0 khi assertion hoặc thao tác Docker thất bại. Kết quả được ghi vào `artifacts/integration-<group>-<timestamp>.log`; stderr của Docker được lưu riêng ở tệp `.docker.log` tương ứng và hiển thị khi lỗi, tránh thông báo tiến trình bình thường bị PowerShell 5.1 tô đỏ. Kiểm thử event lọc oid/eventId mới, dùng consumer group riêng và timeout hữu hạn. Unit/domain test kiểm tra quy tắc cô lập, không thay thế test tích hợp.

`Test-System.ps1` chạy bộ kiểm tra hệ thống trên hạ tầng thật: health tổng hợp, JWT sai/hết hạn, ngăn tự nâng role và sửa Membership, quyền Product/Customer, cache JWT với TTL thực trong Redis, Product DELETE, từ chối giá/discount do client tự gửi và rate limit trả 429 với counter Redis tăng. Bộ này có tám kiểm tra; số PASS/FAIL thực tế được in khi chạy và lưu trong `artifacts/system-all-*.log`.

`Test-Resilience.ps1` chạy bảy kiểm tra nhất quán với HTTP/gRPC/PostgreSQL/MongoDB thật: retry tồn kho idempotent, operationId khác payload, Cancel trước Apply đến muộn, rollback đơn nhiều sản phẩm, hai Order cạnh tranh cùng tồn kho, lỗi insert PostgreSQL rồi bù MongoDB, recovery trạng thái bền vững và chặn worker cũ commit sau ABORTING. Case recovery **dựng đúng trạng thái database tại ranh giới crash và cho worker phục hồi xử lý**, không phải thử kill process/container đang chạy. Không lấy kết quả đó làm bằng chứng đã kiểm thử mọi thời điểm process bị kill. Báo cáo nằm ở `artifacts/resilience-all-*.log`.

`Test-KafkaRecovery.ps1` tạo sự cố broker thật có kiểm soát: dừng riêng Kafka của project, đợi health trả 503, tạo Order mới và xác minh Outbox PENDING/kho giảm đúng; luôn khởi động lại Kafka trong `finally`, kể cả khi bước kiểm tra trước lỗi. Sau đó script đối chiếu đúng oid/eventId mới khi Outbox chuyển SENT, đọc message bằng consumer độc lập, kiểm tra một Shipment và chờ health trở lại UP. Trong thời gian thử, health tạm DOWN và các event khác cũng chờ broker phục hồi; nên chạy riêng sau các suite thông thường. Script không xóa volume/reset database. JSON evidence và stderr riêng nằm ở `artifacts/kafka-outage-<timestamp>-*`.

`Test-OrderRecovery.ps1` dựng attempt bền vững với tồn kho đã trừ, tạm tắt autorestart của đúng container Order rồi gửi SIGKILL và xác minh exit 137. Sau khi expire lease của fixture, script luôn khôi phục restart policy/service trong finally, đợi worker bù kho, kiểm tra ABORTED/CANCELLED/không Order hoặc Outbox thừa và health UP. Đây là state được dựng tại ranh giới trước commit cùng với process kill/restart thật; không phải một HTTP request được ngắt tại dòng code bất kỳ. Chạy riêng vì Order tạm không sẵn sàng; bằng chứng nằm ở `artifacts/order-restart-<timestamp>-*`.

Có thể gọi trực tiếp `Test-All.ps1 -Suite system` hoặc `-Suite resilience`; tham số `-Group` chỉ dành cho suite integration. Các bộ bổ sung dùng fixture mới và giữ dữ liệu hiện có; không cần sửa code bằng tay để tạo kết quả kiểm thử.

README mô tả cách chạy; bằng chứng PASS/FAIL của từng lần thực hiện nằm ở report thật và [báo cáo triển khai](IMPLEMENTATION-REPORT.md). Không kết luận toàn bộ bài đạt chỉ vì build hoặc health thành công.

## Trình diễn tám mục chấm

Chạy `Demo-Grading.ps1`, đồng thời mở source để giải thích:

| Mục | Nội dung và bằng chứng |
|---|---|
| 1 | Mở proto, giải thích RPC/message/field number và bốn tầng DDD. |
| 2 | Compose config hợp lệ, container và init job đúng topology, health thật. |
| 3 | Describe topic/group; giải thích Outbox, producer/consumer, offset, retry và chống lặp. |
| 4 | TC-PRO-01 lấy catalog từ Product MongoDB. |
| 5 | TC-CUS-04 trả mname/score đúng Customer PostgreSQL. |
| 6 | TC-CUS-05 thiếu JWT trả HTTP 401. |
| 7 | TC-ORD-04 tính expected từ policy demo và score/giá thật rồi đối chiếu Order. |
| 8 | TC-ORD-05 chứng minh Order/details/outbox trong SQL, event mới trong Kafka và Shipment trong MongoDB. |

Script chạy đủ 25 case để bao gồm cả năm TC được chấm trực tiếp. Phần giải thích kiến trúc vẫn cần người trình bày hiểu source; script cung cấp các lệnh và bằng chứng, không thay thế phần vấn đáp.

## Xem lỗi thường gặp

```powershell
docker compose ps --all
docker compose logs --tail 80 api-gateway auth-service customer-service
docker compose logs --tail 80 product-service order-service shipment-service
docker compose logs --tail 80 product-db-init kafka-init
```

Nếu Docker Engine chưa chạy, khởi động Docker Desktop trước. Nếu một init job exit khác 0 hoặc service unhealthy, đọc đúng log rồi sửa nguyên nhân và chạy lại `Start.ps1`; không xóa volume để che lỗi. Không in `docker compose config` đầy đủ khi chia sẻ màn hình/báo cáo vì cấu hình đã interpolate có thể chứa secret; dùng `docker compose config --quiet` để kiểm tra.
