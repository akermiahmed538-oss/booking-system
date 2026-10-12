# Appointment Booking System (Node.js + Express + SQLite)

Customers pick a service, a specialist (or "any"), a date and a free time, and get a booking code.
They can look up and cancel their booking with the code + phone number.
Admin: daily schedule, change booking status, add/remove services and team members.

## Deploy on Render
Build Command: `npm install`  ·  Start Command: `npm start`

## Environment variables (all optional except ADMIN_PASSWORD)
| Name | Default | Meaning |
|---|---|---|
| ADMIN_PASSWORD | admin123 | Admin password (change it!) |
| BUSINESS_NAME | Luna Studio | Name shown on the site |
| TIMEZONE | UTC | e.g. Africa/Algiers, Asia/Riyadh |
| CURRENCY | $ | Currency symbol |
| OPEN_HOUR / CLOSE_HOUR | 9 / 18 | Working hours |
| CLOSED_DAYS | 5 | Closed weekdays, 0=Sun … 5=Fri, 6=Sat (e.g. 5,6) |
