BITBYTE PC PARTS STORE - FULL UPGRADED BUILD
============================================

This build keeps the original single-file Express + MySQL application and its existing UI style. It adds authentication, role-based API authorization, stock movement history, configurable low-stock thresholds, sales summaries, and printable order receipts.

FEATURES
--------
- Existing dashboard, products, customers, employees, orders, and order-item screens.
- Login with scrypt password hashing (Node.js crypto; no plaintext passwords stored).
- Roles: Admin, Manager, Cashier, Inventory Staff.
- HttpOnly, SameSite=Strict signed session cookie; 8-hour idle-refresh session.
- Session is held in memory; restarting the server signs everyone out.
- API authorization is enforced server-side, not only by hiding UI buttons.
- Login attempt throttling and same-origin checks for write requests.
- Server-side input validation for core product/customer/order operations.
- Order status transitions prevent cancelled-order reactivation and repeated restocking.
- Order items can only be changed while an order is Pending.
- Completed/shipped/paid orders cannot be deleted; sales history is preserved.
- Inventory movement history for order reservations, cancellations, item edits/removals, initial stock, and manual stock adjustments.
- Per-product low-stock threshold and dashboard alerts.
- Sales report separates recognized order value from pending and cancelled order value.
- Printable order receipt.
- Existing databases are migrated automatically at startup (low_stock_threshold, users, stock_movements).

ROLE SUMMARY
------------
Admin: full access, including user account creation and disabling.
Manager: manage products, customers, employees, orders, reports, and inventory history.
Cashier: create orders and manage customer records; can view product and employee data needed for checkout.
Inventory Staff: manage products/stock and view stock movement history; cannot access customer/order screens.

REQUIREMENTS
------------
- Node.js 18 or newer (tested syntax with Node.js 22)
- MySQL 8 or a compatible MariaDB version
- npm

INSTALLATION (WINDOWS / XAMPP)
------------------------------
1. Extract this ZIP to a folder, for example C:\\pc-parts-store.
2. Start MySQL from XAMPP. Make sure the database account in .env can connect.
3. Copy .env.example to .env.
4. Edit .env:
   - DB_HOST, DB_USER, DB_PASSWORD, DB_NAME
   - SESSION_SECRET: generate with:
       node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
     Paste the generated value into SESSION_SECRET.
   - BOOTSTRAP_ADMIN_EMAIL and BOOTSTRAP_ADMIN_PASSWORD. Use a unique password of at least 12 characters.
5. Open a terminal in the project folder and run:
       npm install
       npm run check
       npm start
6. Open http://127.0.0.1:3000 in your browser and sign in with the bootstrap admin email/password.
7. As Admin, open User accounts to create accounts for staff with the correct roles.
8. After the first successful startup and admin creation, remove BOOTSTRAP_ADMIN_EMAIL and BOOTSTRAP_ADMIN_PASSWORD from .env. Keep SESSION_SECRET.

DATABASE
--------
- Default database name is pc_store. Set DB_NAME to your existing database name to preserve existing records.
- The application runs its schema migration on startup.
- A reference migration is also included at database/upgrade.sql. Do not run it if the automatic migration has already completed unless you need to inspect/reapply it; it is written to be repeatable for the supported schema additions.
- Back up the database before upgrading. Existing inventory balances are not automatically reconciled against physical stock.

IMPORTANT LIMITATIONS / PRODUCTION NOTES
----------------------------------------
- This build is intended for local development or a trusted private LAN only. The server binds to 127.0.0.1 by default.
- Sessions are in-memory, not shared or persisted. A server restart signs users out; multiple server instances are not supported.
- Use HTTPS, secure cookies, a persistent session store, a proper reverse proxy, database least-privilege credentials, backups, and monitoring before public/production deployment.
- The current sales report uses order status as a sales proxy. There is no separate payment ledger, refunds, taxes, discounts, cost-of-goods, or profit calculation yet.
- Supplier purchase orders, barcode scanning, email notifications, and scheduled backups are not included.
- Historical stock movement entries are not backfilled for inventory changes made before this upgrade.
- The application has not been live-tested against your actual MySQL database or browser environment in this build session.

TESTS PERFORMED HERE
--------------------
- node --check store.js: passed.
- Extracted embedded browser JavaScript and ran node --check: passed.
- MySQL integration, login flow in a browser, and end-to-end inventory/order workflows: not run because no MySQL server/browser environment was available.
