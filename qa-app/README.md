# BugRail — QA Test Management & Bug Tracking

Aplikasi web single-page untuk mengelola **Test Case** dan **Bug Report** yang saling terintegrasi, dengan login per akun, role & permission, workspace, dan generator test case berbasis AI (**TestForge**).

Data disimpan di **MongoDB** lewat API di folder [`../server`](../server/README.md). Jika API tidak bisa dihubungi, aplikasi otomatis beralih ke mode offline memakai **Local Storage** browser (data terakhir yang tersimpan lokal).

## Cara Menjalankan (lokal)

1. Jalankan server — lihat [`server/README.md`](../server/README.md): `cd server`, `npm install`, lalu `npm start`.
2. Buka **http://localhost:3001** di browser. Server sekaligus menyajikan frontend ini, jadi tidak perlu membuka `index.html` langsung dari folder.
3. Login dengan akun admin bawaan: `admin@bugrail.local` / `sama`. **Ganti password ini segera** lewat Settings > Daftar User.

Saat dibuka dari `localhost`/`127.0.0.1` (atau langsung dari file), aplikasi memanggil `http://localhost:3001/api`. Dari host lain, aplikasi memanggil URL produksi yang di-hardcode di `js/utils.js` (konstanta `API_BASE`) — ubah URL tersebut jika backend di-deploy ke alamat lain.

> **Catatan koneksi internet:** Chart.js, SheetJS (Excel) dan jsPDF dimuat dari CDN. Tanpa internet, chart & export Excel/PDF tidak tampil, tetapi fitur inti tetap jalan dan data bisa diekspor sebagai CSV/JSON. TestForge butuh internet (memanggil Gemini lewat server).

## Struktur Folder

```
/index.html
/css/style.css
/js
  utils.js           -> helper umum (Storage + sinkronisasi API, id generator, toast, modal, csv)
  app.js             -> bootstrap, routing sidebar, tema, shortcut keyboard
  auth.js            -> login email+password, role, permission, workspace, sharing file
  workspace.js       -> multi workspace per akun: halaman pilih workspace setelah login + ganti workspace
  dashboard.js       -> widget statistik & chart, filter, export PDF
  testcase.js        -> modul Test Case (CRUD, filter, sort, bulk, import/export)
  testforge.js       -> TestForge: generate test case dengan AI (BRS / screenshot / teks bebas)
  bugreport.js       -> modul Bug Report (CRUD, integrasi Test Case, attachment)
  summary.js         -> rekap & filter progres testing, export PDF
  report.js          -> Report go-live: vonis GO/NO GO, bug reopen, kecepatan fix vs SLA, ringkasan bisnis
  import.js          -> halaman Import (template + drag & drop)
  export.js          -> halaman Export (Excel/CSV/Google Sheets/backup JSON)
  masterstatus.js    -> master Status Bug Report (nama, urutan, warna badge)
  usermanagement.js  -> manajemen akun login (khusus admin)
  activitylog.js     -> audit trail login/logout & CRUD (maks. 1000 entri)
  notifications.js   -> lonceng notifikasi (assign & status bug, pengingat test case belum di-run per file)
  settings.js        -> preferensi, API key Gemini, manajemen data
```

## Fitur Utama

- **Login & Role** — login per akun (email + password). Role bawaan: Admin (akses penuh, tidak bisa dihapus), PM & BA, QA Internal, QA Vendor, User Umum. Role baru bisa ditambah, dan hak akses tiap role diatur di **Role Permission**.
- **Workspace** — file/folder Test Case dikelompokkan per workspace; file bisa dibagikan ke workspace lain oleh role yang punya permission share. Satu akun bisa punya **beberapa workspace** (centang di Daftar User). Setelah login, akun dengan 2+ workspace memilih lewat halaman **Pilih Workspace** (statistik file / test case / bug terbuka, terakhir dibuka). Opsi "Langsung buka workspace terakhir" melewati halaman itu di login berikutnya. Ganti workspace kapan saja lewat **switcher Workspace di sidebar** (di bawah logo) — tanpa login ulang. Saat pindah muncul toast "Berhasil pindah ke workspace …", dan kartu file diberi warna workspace-nya. **Admin** punya pilihan tambahan **"Semua workspace"** (lihat semua data); saat admin memilih satu workspace, datanya ikut difilter. Dashboard, Summary, Report, notifikasi, dan search selalu mengikuti workspace aktif. Cek logika: `node qa-app/test/workspace.check.js`.
- **Dashboard** — widget statistik realtime + chart status Test Case, severity Bug, progres per module; filter module/tester/tanggal dan export PDF.
- **Test Case** — tabel ala TestRail/Zephyr: Add/Edit/Delete/Duplicate, search realtime, filter multi-kolom, sorting, pagination, bulk delete & bulk update status, Import/Export Excel/CSV. Mode "Run" hanya mengisi **Actual Result** dan **Status**.
- **TestForge (AI)** — generate draft test case dari teks BRS, screenshot aplikasi (maks. 5), atau deskripsi bebas memakai Google Gemini. Hasil masuk tahap review (edit/hapus per baris) dan baru disimpan ke Test Case saat klik **Save All**. API key diisi di Settings atau di `.env` server (`GEMINI_API_KEY`).
- **Bug Report** — memilih Test Case ID otomatis mengisi Module, Feature, Scenario, Expected Result, Test Steps, dan Tester. Bug ID & Report Date digenerate otomatis. Status bug mengikuti daftar di **Master > Status Bug Report**.
- **Penomoran per workspace** — Test Case `LOG-0001` (prefix 3 huruf dari Module) dan Bug `BUG-0001` berurutan mulai 0001 di setiap workspace. ID internal tetap unik, jadi admin di "Semua workspace" tidak tertukar. Nomor berikutnya = nomor tertinggi yang **masih ada** di workspace itu + 1, jadi setelah test case/bug dihapus nomornya dipakai lagi (hapus semua → mulai dari 0001). Celah di tengah tetap (tidak ada penomoran ulang).
- **Share link bug** — tombol **🔗 Salin link** di Detail Bug menyalin link `…#bug=<id>`. Penerima (misalnya developer) login, lalu aplikasi otomatis pindah ke workspace bug tersebut dan membuka Detail Bug-nya. Akses tetap mengikuti workspace & permission; tanpa akses muncul pesan "Anda tidak punya akses ke bug ini".
- **Failed → Create Bug** — Test Case berstatus *Failed* punya tombol "Create Bug" yang membuka form Bug Report dengan data Test Case terisi.
- **Summary** — total, pass rate, fail rate, breakdown bug, filter Module/Feature/Tester/Tanggal, export PDF.
- **Report (Go-Live)** — vonis GO / CONDITIONAL GO / NO GO **per module** (vonis aplikasi = module terburuk) berdasarkan pass rate, test case belum jalan/Blocked, dan bug Critical/High terbuka; daftar bug paling sering Reopen/Retest (+ export Excel); kecepatan penanganan bug vs SLA per severity (Critical 1, High 3, Medium 7, Low 14 hari); ringkasan bahasa bisnis untuk PM & BA yang bisa langsung disalin. Threshold diatur di awal `js/report.js`. Cek logika: `node qa-app/test/report.check.js`.
- **Import / Export** — drag & drop Excel/CSV + template; export Excel/CSV, panduan Google Spreadsheet (CSV atau Google Apps Script), backup & restore JSON.
- **Assign & Notifikasi** — Bug bisa di-assign ke user terdaftar. Lonceng 🔔 di topbar: notifikasi bug hanya untuk pembuat (Tester) dan assignee — bug di-assign, perubahan status sampai diperbaiki (beserta keterangan). Pembuat/pengupload test case mendapat pengingat per file bila masih ada test case yang belum di-run. Klik notifikasi langsung membuka halaman, file, dan detailnya. Cek logika: `node qa-app/test/notifications.check.js`.
- **Activity Log** — riwayat login/logout dan perubahan pada Test Case, Bug Report, File, User, Role, dan Workspace.
- **Settings** — Dark/Light mode, API key Gemini, info storage, hapus semua data, daftar shortcut.

## Keyboard Shortcut

| Shortcut | Fungsi |
|---|---|
| `/` | Fokus ke kotak pencarian global |
| `N` | Tambah item baru pada halaman aktif |
| `Ctrl/Cmd + S` | Konfirmasi bahwa data sudah tersimpan otomatis |

## Penyimpanan Data

`Storage.hydrate()` (di `utils.js`) memuat semua data sekali saat aplikasi dibuka, lalu baca/tulis berjalan dari cache di memori. Setiap `Storage.set()` langsung menulis ke Local Storage lalu mengirim `PUT` ke API di background. Setiap perubahan ditandai *belum tersinkron* sampai server membalas sukses. Jika server mati / koneksi putus, perubahan tetap di browser dan **dikirim ulang otomatis** saat aplikasi dibuka lagi (tidak tertimpa data server yang lebih lama); menutup tab atau menekan Back selagi ada perubahan belum tersinkron memunculkan peringatan browser. Tombol Back/Forward browser berpindah antar halaman BugRail. Cek logika: `node qa-app/test/storage.check.js`.

## Keamanan — baca sebelum dipakai publik

- Login, role, dan permission dicek **di browser saja**. Daftar user beserta password ikut terkirim ke client, jadi siapa pun yang membuka DevTools bisa melihat atau melewatinya.
- API di `server/` **tidak punya autentikasi**: header `x-role`/`x-workspace` bisa dipalsukan, dan siapa pun yang tahu URL API bisa membaca serta menulis semua data.
- API key Gemini yang diisi di Settings tersimpan di data aplikasi dan ikut terbaca oleh siapa pun yang bisa mengakses API.

Aplikasi ini aman dipakai di jaringan internal/terbatas. Untuk dibuka ke internet publik, tambahkan autentikasi di server atau batasi akses (VPN / IP whitelist). Lihat bagian Deploy di [`server/README.md`](../server/README.md).
