# Quy tắc làm việc trong repository

## Phạm vi và quyền triển khai

- Mục tiêu là Backend E-Commerce MVP bằng Node.js, Microservices, DDD, Database-per-Service, Docker Compose, gRPC, Kafka, PostgreSQL, MongoDB và Redis.
- Người dùng đã giao triển khai toàn bộ bài và tự quyết các chỉnh sửa trong phạm vi MVP (27/10/2026). Được tạo thư mục, code, cấu hình Docker, seed, script và chạy kiểm thử; không cần hỏi lại phê duyệt chỉnh sửa thông thường.
- Tiến hành tuần tự theo giai đoạn, có kiểm tra/báo cáo thực tế. Có thể chuẩn bị các module độc lập song song nhưng không tuyên bố giai đoạn hoàn tất trước kiểm tra. Nếu thiếu nghiệp vụ, dùng lựa chọn demo cấu hình được, công khai trong PLAN/README; không gán lựa chọn đó cho tài liệu gốc.
- Hướng dẫn và báo cáo bằng tiếng Việt, giải thích vừa đủ để sinh viên tự chạy và bảo vệ bài. Dùng Windows, PowerShell và Docker Desktop làm môi trường hướng dẫn chính.

## Tài liệu và xử lý yêu cầu

- Thư mục nguồn thực tế là `doc/`, không phải `docs/`. Giữ nguyên tên, vị trí và nội dung tài liệu nguồn trừ khi người dùng yêu cầu thay đổi.
- Đọc `PLAN.md` trước khi làm. Tài liệu chính là `doc/3. Prompt_microservice.doc`; phiếu chấm là `doc/PhieuChamThucHanh.png`. Excel và các hình thiết kế bổ sung nghiệp vụ, API, ownership và kiểm thử.
- Chỉ dẫn mới nhất của người dùng có ưu tiên cao nhất. Khi các nguồn mâu thuẫn, ghi rõ nguồn và vị trí, tác động, đề xuất và trạng thái quyết định. Không tự coi đề xuất trong PLAN là nghiệp vụ đã được xác nhận.
- Phân biệt ba loại thông tin: yêu cầu có trong nguồn, phương án kỹ thuật đề xuất và quy tắc nghiệp vụ chưa xác định. Không bịa chính sách score/discount hoặc kết quả test. Fixture tự tạo phải ghi rõ là dữ liệu mẫu, không gán tên/score mẫu cho tài liệu gốc.
- Nếu chưa đọc được tài liệu, nêu chính xác tệp và phần bị thiếu. Không khẳng định đã đọc chỉ dựa vào tên tệp.
- Khi người dùng đã chốt một phương án, cập nhật quyết định trong PLAN và tiếp tục trong phạm vi được giao; không xin xác nhận lặp lại.

## Kiến trúc và cấu trúc code khi được triển khai

- Sáu thành phần ứng dụng: API Gateway, Auth, Customer, Product, Order và Shipment. Năm service nghiệp vụ tương ứng năm bounded context.
- Client gọi REST `/api/...` tại Gateway. Gateway gọi service qua gRPC. Order gọi Customer/Product qua gRPC. Order phát `OrderCreated` trên Kafka topic `order-created`; Shipment nhận bất đồng bộ.
- Auth sở hữu User/Role trong PostgreSQL; Customer sở hữu Customer/Membership trong PostgreSQL; Order sở hữu Order/OrderDetail/Outbox trong PostgreSQL. Product và Shipment sở hữu MongoDB riêng. Redis phục vụ cache và rate limiting của Gateway.
- Không dùng chung table/collection, không đọc database của service khác và không tạo foreign key/join xuyên service. Tham chiếu `uid`, `pid`, `oid` giữa các service là tham chiếu logic.
- DDD ở mức dễ học: `domain`, `application`, `infrastructure`, `interfaces` trong từng service. Domain không phụ thuộc framework, database, gRPC hoặc Kafka. Không xây framework/CQRS/event sourcing cho bài MVP.
- Chỉ chia sẻ transport contracts và tiện ích kỹ thuật cần thiết. Không chia sẻ entity/repository nghiệp vụ giữa service.
- Dùng tên trường theo tài liệu: `uid`, `mid`, `mname`, `score`, `pid`, `pname`, `quantity`, `oid`, `qty`, `unit_price`, `discount`, `shipid`, `status`.

## Tính đúng đắn bắt buộc

- Mọi business API phải làm việc với database thật. Fixture chỉ được dùng để seed dữ liệu; không trả dữ liệu seed trực tiếp để vượt test. Test chấm phải dùng Gateway, gRPC, database và Kafka thật theo luồng liên quan; request thiếu JWT bị chặn trước nghiệp vụ, không cần đọc DB hay Kafka để trả 401.
- Mật khẩu hash bằng bcrypt. JWT có `sub`, `role`, thời hạn và được kiểm tra chữ ký/thời hạn. Không cho người đăng ký tự chọn role đặc quyền. Không ghi password/token/secret vào log.
- Thiếu hoặc sai JWT trả 401; JWT hợp lệ nhưng thiếu quyền trả 403. Kiểm tra quyền sở hữu Customer/Order/Shipment tại service, không chỉ ở route Gateway.
- Không tin `uid`, giá, score hoặc discount do client gửi khi đặt hàng. Lấy chủ thể từ JWT; lấy Customer/Membership và giá/tồn kho qua service sở hữu.
- Không dùng số thực nhị phân trực tiếp để tính tiền. Chốt quy ước tiền, làm tròn và score/discount trước phần nghiệp vụ Order. Không mặc định `discount: 10` nghĩa là 10%.
- Kiểm tra và giảm tồn kho phải có điều kiện nguyên tử, không để quantity âm. Phải xử lý lỗi giữa giảm kho và lưu Order bằng idempotency, bù trừ và phục hồi có trạng thái bền vững; không gọi local transaction là distributed transaction.
- Lưu Order, OrderDetail và OutboxEvent trong cùng transaction PostgreSQL. Chỉ đánh dấu outbox đã gửi sau broker acknowledgement; lỗi Kafka phải còn pending để retry.
- Shipment xử lý lặp event theo `eventId` và ghi kết quả chống lặp nguyên tử. Không tuyên bố exactly-once xuyên Kafka/database. Không tự áp một Shipment duy nhất cho mỗi Order khi nguồn ERD cho phép nhiều Shipment.
- Health check phải kiểm tra trạng thái thực; không trả UP cố định. Redis phải được dùng cho cả cache lẫn rate limiting, có chính sách TTL và xử lý lỗi rõ ràng.

## Kiểm tra, báo cáo và thao tác an toàn

- Làm từng giai đoạn theo PLAN. Chạy kiểm tra có ý nghĩa đối với phần đã làm trước khi chuyển bước; không lặp kiểm tra đã đạt nếu không có thay đổi liên quan.
- Báo cáo cuối mỗi giai đoạn: tệp đã tạo/sửa, mục đích, lệnh đã chạy, kết quả và exit code thực tế, phần chưa kiểm tra, vấn đề còn mở và bước tiếp theo. Chỉ ghi PASS sau khi đã chạy và có bằng chứng.
- Phân biệt test domain cô lập với kiểm thử tích hợp và demo chấm. Mock/unit test không thay thế chứng cứ API/database/Kafka thật.
- Script PowerShell phải thất bại rõ ràng khi assertion sai, có timeout/poll hữu hạn cho Kafka/Shipment và chọn dữ liệu theo ID trả về, không dựa vào log cũ hay thời gian sleep cố định.
- Seed lặp lại an toàn, không ghi đè dữ liệu người dùng ngoài tập fixture được đánh dấu. Lưu bằng chứng chạy test trong thư mục riêng và không đưa secret vào repository.
- Kiểm tra Docker Engine trước thao tác container. Không khẳng định stack chạy khi chỉ có Docker CLI. Chốt phiên bản image/package tương thích, có lockfile; tránh image tag `latest`.
- Dùng `rg` để tìm file/nội dung. Giữ lệnh PowerShell dễ đọc, trích dẫn đường dẫn đúng và kiểm tra `$LASTEXITCODE` của lệnh native.
- Không tự xóa volume, chạy `docker compose down -v`, reset database, đổi tài liệu gốc, push Git hoặc sửa cấu hình máy ngoài phạm vi được giao. Với thao tác phá hủy dữ liệu phải có chỉ dẫn rõ của người dùng.
- Không thêm thanh toán, giỏ hàng riêng, khuyến mãi/coupon, frontend, notification, Kubernetes hoặc hệ thống quản lý vận chuyển mở rộng vào MVP.
