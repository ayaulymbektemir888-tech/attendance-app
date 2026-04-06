const express = require("express");
const sqlite3 = require("sqlite3").verbose();
const bodyParser = require("body-parser");
const QRCode = require("qrcode");
const { v4: uuidv4 } = require("uuid");

const app = express();
app.use(bodyParser.json());
app.use(express.static("public"));

const db = new sqlite3.Database("./database.sqlite", (err) => {
  if (err) {
    console.error("Ошибка БД:", err);
  } else {
    console.log("БД подключена");
  }
});

db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    login TEXT,
    password TEXT,
    role TEXT
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS attendance (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    time TEXT
  )`);
});

// Admin default
db.get("SELECT * FROM users WHERE login='admin'", (err, row) => {
  if (!row) {
    db.run("INSERT INTO users (login,password,role) VALUES ('admin','admin','admin')");
  }
});

// Переменные координат теперь let, чтобы их можно было менять
let allowedLat = 43.273050;
let allowedLng = 76.660213;

// 1. Смена пароля (общий для всех)
app.post("/changePassword", (req, res) => {
    const { id, newPassword } = req.body;
    db.run("UPDATE users SET password=? WHERE id=?", [newPassword, id], err => {
        res.send({ success: !err });
    });
});

// 2. Обновление координат офиса
app.post("/updateLocation", (req, res) => {
    const { lat, lng } = req.body;
    allowedLat = lat;
    allowedLng = lng;
    console.log(`Новые координаты офиса: ${lat}, ${lng}`);
    res.send({ success: true, lat, lng });
});

// 3. Получить текущие координаты (для админки)
app.get("/getLocation", (req, res) => {
    res.send({ lat: allowedLat, lng: allowedLng });
});

function distance(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

app.post("/login", (req, res) => {
  const { login, password } = req.body;
  db.get("SELECT * FROM users WHERE login=? AND password=?", [login, password], (err, user) => {
    if (!user) return res.send({ success: false });
    res.send({ success: true, user });
  });
});

app.post("/addEmployee", (req, res) => {
  const { login, password } = req.body;
  db.run("INSERT INTO users (login,password,role) VALUES (?,?,'employee')", [login, password], err => res.send({ success: !err }));
});

app.get("/employees", (req, res) => {
  db.all(`SELECT id, login, role FROM users WHERE role='employee'`, (err, rows) => res.send(rows));
});

app.post("/updateUser", (req, res) => {
  const { id, login, password } = req.body;
  db.run("UPDATE users SET login=?, password=? WHERE id=?", [login, password, id], err => res.send({ success: !err }));
});

app.get("/attendance/:id", (req, res) => {
  db.all("SELECT time FROM attendance WHERE user_id=?", [req.params.id], (err, rows) => res.send(rows || []));
});

// --- УДАЛЕНИЕ СОТРУДНИКА ---
app.post("/deleteUser", (req, res) => {
  const { id } = req.body;
  // Удаляем и самого пользователя, и его историю посещений
  db.run("DELETE FROM users WHERE id = ?", [id], (err) => {
    if (err) return res.send({ success: false });
    db.run("DELETE FROM attendance WHERE user_id = ?", [id], () => {
      res.send({ success: true });
    });
  });
});

let currentToken = uuidv4();
let tokenCreatedAt = Date.now();

app.post("/scan", (req, res) => {
  const { user_id, token, lat, lng } = req.body;
  
  // 1. Стандартные проверки (время, токен, локация)
  if (Date.now() - tokenCreatedAt > 300000) return res.send({ success: false, message: "QR устарел" });
  if (token !== currentToken) return res.send({ success: false, message: "Неверный QR" });
  
  const dist = distance(lat, lng, allowedLat, allowedLng);
  if (dist > 0.1) return res.send({ success: false, message: "Вы вне офиса" });

  // 2. Формируем текущую дату для проверки (ГГГГ-ММ-ДД)
  const now = new Date();
  const year = now.getFullYear();
  const month = (now.getMonth() + 1).toString().padStart(2, '0');
  const day = now.getDate().toString().padStart(2, '0');
  const todayDate = `${year}-${month}-${day}`; // Результат: "2026-04-06"

  // 3. ПРОВЕРКА: отмечался ли этот user_id сегодня?
  // Ищем записи, где время начинается с сегодняшней даты
  db.get("SELECT * FROM attendance WHERE user_id = ? AND time LIKE ?", [user_id, todayDate + '%'], (err, row) => {
    if (err) return res.send({ success: false, message: "Ошибка базы данных" });

    if (row) {
      // Если запись за сегодня уже есть в БД
      return res.send({ success: false, message: "Вы уже отметились сегодня!" });
    }

    // 4. Если всё ок, сохраняем отметку
    const timeOnly = now.getHours().toString().padStart(2, '0') + ":" + now.getMinutes().toString().padStart(2, '0');
    const fullTimeStr = `${todayDate} ${timeOnly}`;

    db.run(
      "INSERT INTO attendance (user_id, time) VALUES (?,?)",
      [user_id, fullTimeStr],
      err => {
        if (err) return res.send({ success: false, message: "Ошибка при сохранении" });
        res.send({ success: true, message: "Отметка принята" });
      }
    );
  });
});

app.get("/qr", async (req, res) => {
  const qr = await QRCode.toDataURL(currentToken);
  res.send({ qr });
});

setInterval(() => {
  currentToken = uuidv4();
  tokenCreatedAt = Date.now();
}, 300000);

const PORT = process.env.PORT || 3000;


app.listen(PORT, () => {
  console.log("Server running on port " + PORT);
});