BUYER LOG 7.0.320 -> 7.0.323 MINI GÜNCELLEME

Kapsam
7.0.321, 7.0.322 ve 7.0.323'teki değişiklikleri kapsar: masaüstü açılışı,
LCW AI çıktı iyileştirmeleri, fiyatlandırma, alan çerçeveleri, tema geçişleri,
CP/Diğer modüller ufukları, ASAS/IAS filtre eşleştirmeleri ve kurumsal ağlarda
güncellemenin kalıcı düzeltmesi. Hedef, resmî imzalı 7.0.323 TEST paketidir.
STABLE kanalı değiştirilmemiştir.

NASIL KULLANILIR
1. Bu ZIP'in TAMAMINI bir klasöre çıkarın.
2. Buyer Log 7.0.320'yi açın. Açılışın ve otomatik güncelleme kontrolünün
   bitmesini bekleyin; mevcut indirme hatasını görmeniz bu hazırlığa engel değil.
   BUYER LOG'U AÇIK TUTUN.
3. İsterseniz önce KONTROL.cmd ile salt okunur kontrolü çalıştırın.
4. HAZIRLA.cmd dosyasını çalıştırıp BuyerLog.exe bulunan kurulum klasörünü seçin.
   .buyerlog-versions içindeki app klasörünü değil, BuyerLog.exe'nin klasörünü seçin.
5. HAZIR mesajından sonra BUYER LOG'U KAPATMADAN uygulamada:
   Güncellemeleri Kontrol Et -> TEST -> Kontrol Et.
6. Paket kuruluma hazır olduğunda uygulamanın normal Yeniden Başlat adımını kullanın.

İlk kontrol bu oturumda henüz yapılmamışsa hazırlayıcı beklemenizi söyler.
Gerekirse uygulamada STABLE kanalında bir kez kontrol edip bitmesini bekleyin;
ardından HAZIRLA.cmd'yi tekrar çalıştırın. Hazırlama sırasında başka bir
güncelleme kontrolü başlatmayın.

Hazırlamadan sonra, uygulamada kontrol yapmadan Buyer Log'u kapatırsanız
7.0.320 açılış temizliği hazırlanan önbelleği kaldırabilir. Bu durumda uygulamayı
yeniden açıp hazırlamayı tekrarlayın. Kuruluma hazır bildirimi aldıktan sonra
normal Yeniden Başlat işlemi güvenlidir.

Paket nasıl çalışır?
Değişmeyen baytları mevcut 7.0.320 kurulumundan veya doğrulanmış 7.0.320 ZIP
önbelleğinden okur; değişen dosyaları bu mini paketten alır. Resmî 7.0.323 ZIP'i
aynı boyut ve SHA-256 değeriyle yalnız .buyerlog-updater/cache içine hazırlanır.
Kurulu uygulama dosyaları, package.json, kullanıcı verileri, DB, mevcut updater
durumu, kanal ayarları ve başlatıcı bu hazırlayıcı tarafından değiştirilmez.
Hazırlama internet istemez. Uygulamadaki sonraki TEST kontrolü küçük resmî
manifesti internetten alır; tam güncelleme paketi yeniden indirilmez.
İmza, SHA-256, kurulum, açılış sağlık kontrolü ve geri alma Buyer Log'un kendi
güncelleme mekanizmasında kalır. Kurulum yolu normal güncelleme kontrolüdür.

Paket yalnız 7.0.320 için hazırlanmıştır. Dosyalar tanınmazsa işlem durur.
Güncelleme başarıyla tamamlandıktan sonra isterseniz STABLE kanalına dönebilirsiniz;
bu işlem uygulamayı 7.0.322'ye düşürmez.

Doğrulama
Resmî hedef paket Ed25519 imzası ve SHA-256 ile doğrulandı. Hazırlayıcı PowerShell 7
üzerinde kontrol edildi; gerçek 7.0.320 güncelleyici kodu oluşturulan ZIP'i sıfır
paket indirmesiyle hazırladı. Kurulu çekirdek ve örnek kullanıcı verileri aynı kaldı.
7.0.323 uygulaması ayrıca tam Windows regresyonundan geçti. Hazırlayıcının Windows
PowerShell 5 çalıştırması bu ortamda doğrudan test edilmedi.

ENGLISH
This delta prepares the exact official signed 7.0.323 TEST update from a 7.0.320
installation. It includes the changes in 7.0.321, 7.0.322 and 7.0.323.

1. Extract the ENTIRE ZIP.
2. Open Buyer Log 7.0.320, wait for startup and its automatic update check to end,
   and KEEP IT OPEN. The existing download failure is acceptable at this point.
3. Optionally run KONTROL.cmd for a read-only check.
4. Run HAZIRLA.cmd and select the installation folder containing BuyerLog.exe.
5. After READY, WITHOUT CLOSING Buyer Log, use Check for Updates -> TEST -> Check.
6. When the update is ready, use the app's normal Restart action.

If this session has not completed an update check, wait, or check STABLE once and
let it finish before preparing again. Do not start another check during assembly.
If you close the app before its native check stages the update, reopen it and
prepare again: 7.0.320 removes future-version cache entries at startup.

Preparation reads unchanged bytes from your installation or its verified 7.0.320
ZIP cache. It writes only the verified 7.0.323 ZIP into the update cache. It does
not edit the installed application, user data, database, updater state or settings.
Assembly is offline; the subsequent native TEST check still needs the small
official manifest online. Native signature verification, SHA-256, installation,
health checks and rollback remain in control. STABLE has not been changed.
After a successful update, returning to STABLE does not downgrade the app.

Validation used PowerShell 7 and the exact shipped 7.0.320 updater code: zero
artifact downloads, byte-identical official ZIP, unchanged installed core and
sample user data. The 7.0.323 app passed full Windows regression. Windows
PowerShell 5 execution of this helper was not directly tested in this environment.
