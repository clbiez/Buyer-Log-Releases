BUYER LOG — MINI PATCH / PR 605 + 606
Uyumlu taban / Compatible base: 7.0.284
Patch surumu / Patch version: 7.0.284+pr605-606
Kaynak / Source: f7f7aed2dd6d7787b3619a7a77361cbf4007b066

TÜRKÇE

Kurulum
1. Buyer Log'u tamamen kapatın.
2. Bu ZIP'i bir klasöre çıkarın.
3. UYGULA.cmd dosyasını açın. Sorulduğunda BuyerLog.exe'nin bulunduğu
   kurulum klasörünün tam yolunu yazın (örnek: C:\Apps\Buyer Log).
   Alternatif: kurulum klasörünü UYGULA.cmd dosyasının üzerine sürükleyin.
4. "ready-to-install" sonucundan sonra Buyer Log'u normal kısayoluyla açın.
   İlk açılış mevcut başlatıcının sağlık kontrolünden geçer.

Paket içeriği
- PR 605: Hologram talep Excel'i ve düzenlenebilir Excel şablonları.
- PR 606: Gerçek değişiklikle doğrulanan düzenleme çakışmaları,
  iki yönlü güncel royalty oranları ve Lisans Kartları için kart simgesi.
- 7.0.284 tabanından bu iki PR'a ulaşmak için gereken 602–604 değişiklikleri.

Güncelleme uyumluluğu
- Aktif uygulama çekirdeği korunur; patch ayrı bir çekirdekte hazırlanır.
- Sürüm 7.0.284+pr605-606 olarak görünür. SemVer sıralamasında 7.0.284 ile
  aynı düzeydedir; 7.0.285 ve sonraki resmi sürümler normal şekilde ilerler.
- Güncelleyici kodu, güvenilen imza anahtarları ve kanal ayarları korunur.
  Mevcut TEST/STABLE kanal işaretçileri aynı kalır.
- Bekleyen başka güncelleme, uyumsuz taban veya beklenmeyen yerel dosya
  varsa hazırlık durur. Hazırlanan çekirdeğin SHA-256 bütünlüğü doğrulanır.
- Kullanıcı verileri, veritabanı, oturumlar ve kişisel ayarlar korunur.
- Eski çekirdeğin doğrulanmış kopyası data\local\mini-patches altında tutulur;
  normal updater temizliği sonrasında da elle geri alınabilir.
- Hazırlık için diskte iki uygulama çekirdeği kadar ek yer gerekir.
  Ayrıca başlatıcı ilk deneme açılışında kendi veritabanı checkpointini alır.

Geri alma
Buyer Log kapalıyken GERI-AL.cmd dosyasını açıp aynı kurulum klasörünü verin.
Bu işlem önceki kodu seçer ve patch sonrasında girdiğiniz güncel verileri korur.
İlk açılış sağlık kontrolü başarısız olursa mevcut başlatıcı kendi otomatik
kod + veritabanı checkpoint geri alma akışını kullanır.
Daha sonraki resmi sürüme geçilmişse mini patch geri alma işlemi durur.

Bu paket ek Node/npm kurulumu gerektirmez. Kurulum ve geri alma için
BuyerLog.exe'nin mevcut çalışma ortamı kullanılır.

ENGLISH

Installation
1. Close Buyer Log completely.
2. Extract this ZIP into a folder.
3. Open UYGULA.cmd and enter the full installation folder containing
   BuyerLog.exe (example: C:\Apps\Buyer Log). You may also drag that folder
   onto UYGULA.cmd.
4. After "ready-to-install", open Buyer Log through its normal shortcut.
   The existing launcher performs the first-launch health check.

Contents
- PR 605: Hologram request Excel export and editable Excel templates.
- PR 606: Verified edit conflicts, current royalty rates in both directions,
  and the stacked-cards module icon.
- PRs 602–604 prerequisites needed to reach these changes from 7.0.284.

Update compatibility
- The active app core is retained; the patch is prepared as a separate core.
- Version 7.0.284+pr605-606 has the same SemVer precedence as 7.0.284.
  Official 7.0.285 and later versions continue through the normal updater.
- Updater code, trusted signing keys and channel configuration are preserved.
  Existing TEST/STABLE channel pointers are retained.
- Another pending update, incompatible base or unexpected local files stops
  preparation. The staged core receives a verified SHA-256 integrity manifest.
- User databases, sessions and preferences are retained.
- A verified old-core copy is retained outside the updater's version cleanup,
  under data\local\mini-patches, for manual undo.
- Preparation needs additional disk space for two app cores. The native launcher
  also makes its normal database checkpoint for the first trial launch.

Undo
Close Buyer Log, open GERI-AL.cmd and select the same installation folder.
Manual undo selects the previous code while retaining current business data.
If the first-launch health check fails, the existing launcher performs its
normal automatic code + database checkpoint rollback.
Undo stops after a later official version has been installed.

No additional Node/npm installation is required.

Validation / Doğrulama
The package's real native updater/launcher integration results and execution
limits are recorded in VALIDATION.txt.
