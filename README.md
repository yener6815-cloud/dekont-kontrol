# Dekont Kontrol

Bagimsiz, tek hesapli dekont paneli. Ana panelden bagimsizdir; marka, logo ve sosyal paylasim meta bilgileri sadece Dekont Kontrol olarak ayarlandi.

## Render ortam degiskenleri

- `PANEL_USERNAME`: limonadmin
- `PANEL_PASSWORD`: admin123
- `PANEL_NAME`: Panelde gorunecek isim
- `DEKONT_MAIL`: Gmail adresi
- `DEKONT_APP_PASSWORD`: Gmail uygulama sifresi
- `PUBLIC_BASE_URL`: Domain baglaninca tam adres
- `SCAN_INTERVAL_MS`: Arka plan tarama hizi, varsayilan 1000ms
- `DATABASE_FILE`: Kalici dekont veritabani dosyasi, varsayilan `data/database.json`

Dekontlar `data/database.json` icinde saklanir. Kullanici cikis yapsa bile kayitlar silinmez; tekrar giriste panel once database kayitlarini gosterir, sonra yeni mailleri tarar. Render'da uzun sureli kalicilik icin persistent disk veya harici database baglanmasi onerilir.

## Calistirma

```powershell
npm install
npm start
```

Site acilinca `http://127.0.0.1:10000` adresinden girilir.
