# Mirrune

![Mirrune — Screen and Audio Bridge](public/logo/png/primary-logo-800.png)

Mirrune trình chiếu màn hình điện thoại Android lên máy tính Windows qua USB, kèm âm thanh và hình ảnh. Windows setup đã đóng gói sẵn ADB và scrcpy-server, nên người dùng không cần cài riêng hai công cụ này.

## Giới thiệu

Mirrune giúp kết nối thiết bị Android, xem màn hình trực tiếp trên Windows và theo dõi trạng thái kết nối/media. Video được giải mã bằng WebCodecs; luồng âm thanh được phát qua Web Audio.

## Công nghệ

- **TypeScript, React, CSS và Vite** cho giao diện.
- **Rust và Tauri 2** cho ứng dụng desktop và tích hợp hệ thống.
- **ADB và scrcpy** để kết nối, lấy luồng media từ Android.
- **H.264, Opus, WebCodecs và Web Audio** cho video và âm thanh.

## Nền tảng

- **Windows 10/11 x64:** nền tảng chạy ứng dụng desktop hiện tại.
- **Android:** thiết bị điện thoại/máy tính bảng có thể kết nối và trình chiếu qua USB. Dự án hiện chưa cung cấp ứng dụng APK chạy trực tiếp trên Android.

## Phiên bản

**0.1.0**

## Hướng dẫn sử dụng

### Cài đặt và chuẩn bị

1. Tải Windows setup, mở file cài đặt và làm theo hướng dẫn trên màn hình.
2. Setup đã bao gồm ADB và scrcpy-server; không cần cài riêng hai công cụ này.
3. Nếu máy chưa có Microsoft Edge WebView2 Runtime, setup sẽ tự tải và cài runtime. Trong trường hợp đó cần kết nối Internet.
4. Trên điện thoại Android, bật **Developer options** và **USB debugging**. Tên hoặc vị trí tùy chọn có thể khác nhau tùy hãng điện thoại.

### Kết nối thiết bị

1. Dùng cáp USB có hỗ trợ truyền dữ liệu để kết nối điện thoại với máy tính; mở khóa điện thoại.
2. Trong Mirrune, nhấn **Quét thiết bị**.
3. Khi điện thoại hỏi cho phép USB debugging, xác nhận cho phép. Chỉ chọn luôn cho phép trên máy tính bạn tin cậy.
4. Chọn thiết bị trong danh sách rồi nhấn **Kết nối thiết bị**. Mirrune sẽ khởi tạo media; cửa sổ màn hình sẽ mở và trạng thái nút chuyển thành **Đã kết nối** khi video sẵn sàng.
5. Khi vừa khởi tạo luồng, hình có thể giật nhẹ trong khoảng 10 giây. Nếu tình trạng kéo dài hoặc kết nối lỗi, xem các thẻ log trong ứng dụng để theo dõi tiến trình và thông báo.

### Xem màn hình và ngắt kết nối

1. Dùng nút toàn màn hình trên cửa sổ video hoặc nhấn **F11**; nhấn **Esc** để thoát.
2. Khi hoàn tất, nhấn **Ngắt kết nối** trong Mirrune trước khi rút cáp.
3. Nếu điện thoại không xuất hiện sau khi quét, kiểm tra cáp dữ liệu và USB debugging. Một số thiết bị cần driver USB do nhà sản xuất cung cấp trên Windows.

### Chạy từ mã nguồn

Cần cài Node.js, pnpm, Rust toolchain và các yêu cầu build Tauri trên Windows. ADB và scrcpy-server đã có trong `src-tauri/resources/tools/` và được dùng trực tiếp khi chạy từ mã nguồn.

```powershell
pnpm install
pnpm tauri dev
```

Tạo bản build và Windows installer:

```powershell
pnpm tauri build
```

Installer NSIS được tạo trong `src-tauri/target/release/bundle/nsis/`.

## Công cụ bên thứ ba

Phiên bản và giấy phép của ADB và scrcpy-server được ghi tại [`src-tauri/resources/THIRD_PARTY_NOTICES.md`](src-tauri/resources/THIRD_PARTY_NOTICES.md). Các thông báo giấy phép tương ứng cũng được đóng gói cùng ứng dụng.

## Cảm ơn

Xin cảm ơn mọi người đã dùng thử nghiệm. Những đóng góp, phản hồi sẽ giúp Mirrune ngày càng hoàn thiện.

 **HoKaDev**

