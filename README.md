# SmartCart

SmartCart is a final-year project that helps shoppers compare advertised grocery prices in Jeddah, Saudi Arabia. It includes an account-free shopping interface, a Node.js service with a SQLite catalog, and a Java WebView app for Android emulator demonstrations.

## What you can do

- **Find current offers.** Search in English or Arabic across the Jeddah listings for Panda, Carrefour, Danube, Al Othaim, and LuLu. Filter by retailer and view the advertised price, publication dates, source link, and product crop when the brochure supplies one.
- **Compare package sizes and prices.** Sort by monthly-shopping quantities or lowest pack price. The parser recognizes documented counts, weights, and volumes and calculates unit prices when it has enough information. Category rules reduce misleading matches, such as chocolate bars in a plain milk search.
- **Identify products from a photo.** Upload a product image or use the camera picker where available. SmartCart can try a barcode lookup, Arabic and English OCR, and an in-browser MobileNet suggestion. Shoppers can correct the product name before searching for offers. An optional Google Cloud Vision lookup is available with server configuration.
- **Manage and verify listings.** The SQLite catalog tracks products, retailers, branch locations, and offers. Shops can submit prices for their own retailer. Admins can maintain products and branches and verify submissions. Indexed brochure offers and verified catalog records have separate statuses.
- **Compare branch offers by distance.** Select a neighbourhood or use browser geolocation where available. SmartCart can rank eligible offers using saved branch coordinates and provide directions.
- **Open on a phone.** The responsive web app can display a QR code that opens the shopper view on a phone on the same Wi-Fi when the server runs in LAN mode.

Brochure listings come from KSAPrice and can change as campaigns expire. Advertised offers do not confirm stock at a particular branch. Image recognition and package-size parsing depend on the quality of the available input.

## Run the web app

Install Node.js 24 or later. From the repository root in PowerShell, run:

```powershell
Set-Location SmartCart.Web
npm.cmd ci
node server.mjs
```

Open `http://127.0.0.1:4173`. To test the responsive site from a physical phone on the same Wi-Fi, start the server with `node server.mjs --lan` and select **Open on phone** to get its QR code. Set `SMARTCART_LAN_IP` to the computer's Wi-Fi address if the app selects the wrong network adapter. Browser geolocation requires a secure context. The app supports manual neighbourhood selection as well.

Open **Shop and admin portal** from the footer. On first startup, the server creates a local admin key in `SmartCart.Web/.smartcart/admin.key` unless `SMARTCART_ADMIN_KEY` is provided. Set `SMARTCART_SHOP_KEYS` to a JSON object that maps retailer IDs (`panda`, `carrefour`, `danube`, `othaim`, `lulu`) to separate keys. Configured keys must be at least 24 characters. Portal access from another device requires trusted HTTPS.

Set `SMARTCART_VISION_KEY` on the server to enable the optional Google Cloud Vision button. Its use sends a resized photo to Google after the shopper selects the button. The barcode lookup sends the barcode to Open Food Facts. `SMARTCART_DATA_DIR` overrides the local data location. A reachable hosted site can supply `SMARTCART_PUBLIC_URL` as its public HTTPS address for the phone QR code.

## Run the Android preview on Windows

1. Install Node.js 24 or later and JDK 17 or later. Install Android SDK Platform 34 or newer, Build-Tools 34.0.0 or newer, Platform-Tools, Android Emulator, and an Android 14 (API 34) system image. Set `JAVA_HOME` and `ANDROID_HOME` if the launcher cannot find them.
2. In Android Studio's Device Manager, create an Android 14 virtual device named `SmartCart_Galaxy_S23_Ultra`. For the original preview dimensions, use a phone profile with a 720 × 1544 display and 300 dpi.
3. Run `npm.cmd ci` from `SmartCart.Web`. From the same directory, use `node server.mjs --open-android`. Alternatively, open `SmartCart.slnx` in Visual Studio 2026, select **Debug | x64**, and start **Local Windows Debugger**.

The launcher starts the web service, builds a debug APK, starts or reuses the emulator, and installs and launches `com.smartcart.preview`. The WebView reaches the host through Android Emulator's `10.0.2.2` alias. Keep the Node.js process running while using the preview. To build only the APK, run `powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\android-preview\build.ps1` from `SmartCart.Web`. The default output is `%LOCALAPPDATA%\SmartCart\AndroidPreview\build\SmartCart-preview.apk`.

The APK requires the emulator and host backend to load the shopper interface. Physical phones can use the responsive site. A physical-device Android APK and full Android interaction testing remain unverified.

## Project structure

| Path | Purpose |
| --- | --- |
| `SmartCart.slnx` | Visual Studio solution for the web service and Android launcher |
| `SmartCart.Web/index.html`, `app.mjs`, `style.css` | Shopper interface, offer cards, photo flow, and responsive layout |
| `SmartCart.Web/server.mjs`, `brochures.mjs`, `grocery-ranking.mjs` | HTTP routes, brochure lookup, category filters, and package comparisons |
| `SmartCart.Web/database.mjs`, `portal.html`, `portal.mjs` | SQLite storage and price verification portal |
| `SmartCart.Web/photo-lookup.mjs`, `photo-provider.mjs` | Browser-assisted recognition and optional external lookups |
| `SmartCart.Web/android-preview/`, `open-android.mjs` | Java WebView, debug APK build, and emulator launcher |

## Verification

All ten JavaScript modules passed Node.js syntax checks. Eight targeted assertions passed for English and Arabic package parsing, unit pricing, grocery category filtering, pack ranking, and OCR label suggestions. A clean dependency install and local HTTP smoke test passed for the homepage, CSS, SQLite catalog initialization, search and barcode validation, portal authentication, and photo settings.

The Android source built into a signed debug APK. A previous emulator run reached the shopper page before an Android system error interrupted it. Full emulator interaction and physical-device APK testing remain unverified.
