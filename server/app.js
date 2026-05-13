require("dotenv").config();
const express = require("express");
const cors    = require("cors");
const axios   = require("axios");
const { Pool } = require("pg");
const bcrypt  = require("bcryptjs");
const jwt     = require("jsonwebtoken");

const app = express();
app.use(cors({ origin: process.env.CLIENT_URL || "http://localhost:3000", allowedHeaders: ["Content-Type", "Authorization"] }));
app.use(express.json());

const MAPBOX_TOKEN = process.env.MAPBOX_TOKEN;
const JWT_SECRET   = process.env.JWT_SECRET || "smarttraffic_diploma_2025";

const pool = process.env.DATABASE_URL
  ? new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } })
  : new Pool({
      user:     "postgres",
      host:     "localhost",
      database: "smarttraffic",
      password: process.env.DB_PASSWORD || "Maaxxim65_",
      port:     5432,
    });

pool.query(`
  CREATE TABLE IF NOT EXISTS users (
    id            SERIAL PRIMARY KEY,
    name          VARCHAR(100)  NOT NULL,
    email         VARCHAR(150)  UNIQUE NOT NULL,
    password_hash VARCHAR(255)  NOT NULL,
    created_at    TIMESTAMP     DEFAULT NOW()
  );
  CREATE TABLE IF NOT EXISTS routes (
    id           SERIAL PRIMARY KEY,
    user_id      INTEGER REFERENCES users(id) ON DELETE CASCADE,
    end_address  TEXT,
    start_lat    FLOAT  NOT NULL,
    start_lon    FLOAT  NOT NULL,
    end_lat      FLOAT  NOT NULL,
    end_lon      FLOAT  NOT NULL,
    distance_km  FLOAT,
    duration_min INTEGER,
    pct_green    INTEGER DEFAULT 0,
    pct_yellow   INTEGER DEFAULT 0,
    pct_red      INTEGER DEFAULT 0,
    created_at   TIMESTAMP DEFAULT NOW()
  );
  CREATE TABLE IF NOT EXISTS traffic_logs (
    id           SERIAL PRIMARY KEY,
    route_id     INTEGER REFERENCES routes(id) ON DELETE CASCADE,
    hour_of_day  SMALLINT NOT NULL,
    day_of_week  SMALLINT NOT NULL,
    pct_green    INTEGER DEFAULT 0,
    pct_yellow   INTEGER DEFAULT 0,
    pct_red      INTEGER DEFAULT 0,
    recorded_at  TIMESTAMP DEFAULT NOW()
  );
`).then(() => console.log("БД ініціалізована")).catch(console.error);

// ─── Утиліти ─────────────────────────────────────────────────────────────────
const congestionToColor = (c) => {
  if (c === "severe" || c === "heavy") return "red";
  if (c === "moderate") return "yellow";
  return "green";
};

const authMiddleware = (req, res, next) => {
  const token = req.headers.authorization?.split(" ")[1];
  if (!token) return res.status(401).json({ error: "Не авторизовано" });
  try { req.user = jwt.verify(token, JWT_SECRET); next(); }
  catch { res.status(401).json({ error: "Невалідний токен" }); }
};

const optionalAuth = (req, res, next) => {
  const token = req.headers.authorization?.split(" ")[1];
  if (token) { try { req.user = jwt.verify(token, JWT_SECRET); } catch {} }
  next();
};

// Обробка одного маршруту з Mapbox у внутрішній формат
const processRoute = (route) => {
  const leg           = route.legs[0].annotation;
  const latlngs       = route.geometry.coordinates.map(c => [c[1], c[0]]);
  const rawCongestion = leg.congestion         || [];
  const rawNumeric    = leg.congestion_numeric || [];
  const rawSpeed      = leg.speed              || [];
  const rawMaxspeed   = leg.maxspeed           || [];

  const colors = rawCongestion.map((c, i) => {
    const speed    = rawSpeed[i];
    const maxspeed = rawMaxspeed[i]?.speed;

    if (speed != null && maxspeed) {
      const ratio = (speed * 3.6) / maxspeed;
      if (ratio >= 0.75) return "green";
      if (ratio >= 0.40) return "yellow";
      return "red";
    }
    const num = rawNumeric[i];
    if (num != null) {
      if (num >= 60) return "red";
      if (num >= 25) return "yellow";
      return "green";
    }
    return congestionToColor(c);
  });

  const total      = colors.length || 1;
  const pct_green  = Math.round(colors.filter(c => c === "green").length  / total * 100);
  const pct_yellow = Math.round(colors.filter(c => c === "yellow").length / total * 100);
  const pct_red    = Math.round(colors.filter(c => c === "red").length    / total * 100);

  return { geometry: latlngs, colors, distance: route.distance, duration: route.duration, pct_green, pct_yellow, pct_red };
};

// ─── Авторизація ─────────────────────────────────────────────────────────────
app.post("/api/auth/register", async (req, res) => {
  const { name, email, password } = req.body;
  if (!name || !email || !password)
    return res.status(400).json({ error: "Заповніть всі поля" });
  try {
    const hash   = await bcrypt.hash(password, 10);
    const result = await pool.query(
      "INSERT INTO users (name, email, password_hash) VALUES ($1,$2,$3) RETURNING id, name, email",
      [name, email, hash]
    );
    const user  = result.rows[0];
    const token = jwt.sign({ id: user.id, name: user.name, email: user.email }, JWT_SECRET, { expiresIn: "30d" });
    res.json({ user, token });
  } catch (err) {
    if (err.code === "23505") return res.status(400).json({ error: "Email вже зареєстровано" });
    res.status(500).json({ error: "Помилка сервера" });
  }
});

app.post("/api/auth/login", async (req, res) => {
  const { email, password } = req.body;
  try {
    const result = await pool.query("SELECT * FROM users WHERE email = $1", [email]);
    const user   = result.rows[0];
    if (!user) return res.status(400).json({ error: "Невірний email або пароль" });
    const valid  = await bcrypt.compare(password, user.password_hash);
    if (!valid)  return res.status(400).json({ error: "Невірний email або пароль" });
    const token  = jwt.sign({ id: user.id, name: user.name, email: user.email }, JWT_SECRET, { expiresIn: "30d" });
    res.json({ user: { id: user.id, name: user.name, email: user.email }, token });
  } catch { res.status(500).json({ error: "Помилка сервера" }); }
});

// ─── Маршрут з альтернативами ─────────────────────────────────────────────────
app.get("/api/route", optionalAuth, async (req, res) => {
  const { start, end, address } = req.query;
  try {
    const response = await axios.get(
      `https://api.mapbox.com/directions/v5/mapbox/driving-traffic/${start};${end}`,
      {
        params: {
          geometries: "geojson",
          overview: "full",
          annotations: "congestion,congestion_numeric,speed,maxspeed",
          alternatives: true,
          access_token: MAPBOX_TOKEN
        }
      }
    );

    const processed = response.data.routes.map(processRoute);
    const main      = processed[0];

    console.log(`[Mapbox] ${processed.length} маршрут(и) | головний: ${(main.distance/1000).toFixed(1)} км | зел=${main.pct_green}% жов=${main.pct_yellow}% чер=${main.pct_red}%`);

    if (req.user) {
      const [sLon, sLat] = start.split(",").map(Number);
      const [eLon, eLat] = end.split(",").map(Number);
      const saved = await pool.query(
        `INSERT INTO routes (user_id,end_address,start_lat,start_lon,end_lat,end_lon,distance_km,duration_min,pct_green,pct_yellow,pct_red)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
        [req.user.id, address || "Невідома адреса", sLat, sLon, eLat, eLon,
         parseFloat((main.distance/1000).toFixed(2)), Math.round(main.duration/60),
         main.pct_green, main.pct_yellow, main.pct_red]
      );
      const now = new Date();
      await pool.query(
        `INSERT INTO traffic_logs (route_id,hour_of_day,day_of_week,pct_green,pct_yellow,pct_red) VALUES ($1,$2,$3,$4,$5,$6)`,
        [saved.rows[0].id, now.getHours(), now.getDay(), main.pct_green, main.pct_yellow, main.pct_red]
      );
    }

    res.json({ routes: processed });
  } catch (err) {
    console.error("Помилка маршруту:", err.response?.data || err.message);
    res.status(500).json({ error: "Routing error", details: err.response?.data || err.message });
  }
});

// ─── Історія маршрутів ────────────────────────────────────────────────────────
app.get("/api/routes/history", authMiddleware, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, end_address, distance_km, duration_min, pct_green, pct_yellow, pct_red, created_at
       FROM routes WHERE user_id = $1 ORDER BY created_at DESC LIMIT 20`,
      [req.user.id]
    );
    res.json(result.rows);
  } catch { res.status(500).json({ error: "Помилка сервера" }); }
});

// ─── Прогноз ──────────────────────────────────────────────────────────────────
app.get("/api/forecast", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        hour_of_day,
        ROUND(AVG(pct_green))::int  AS avg_green,
        ROUND(AVG(pct_yellow))::int AS avg_yellow,
        ROUND(AVG(pct_red))::int    AS avg_red,
        COUNT(*)::int               AS samples
      FROM traffic_logs
      GROUP BY hour_of_day
      ORDER BY hour_of_day
    `);
    res.json(result.rows);
  } catch { res.status(500).json({ error: "Помилка сервера" }); }
});

// ─── Демо-кольори ─────────────────────────────────────────────────────────────
app.post("/api/traffic-colors", (req, res) => {
  const { route, mode } = req.body;
  if (!route || route.length < 2) return res.json({ colors: [] });
  const blockSize = Math.max(1, Math.floor(route.length / 8));
  const patterns = {
    demo_moderate: ["green","yellow","yellow","green","yellow","green","yellow","green"],
    demo_heavy:    ["yellow","red","red","yellow","red","red","yellow","red"]
  };
  const pattern = patterns[mode];
  if (!pattern) return res.json({ colors: [] });
  res.json({ colors: Array.from({ length: route.length - 1 }, (_, i) => pattern[Math.floor(i/blockSize) % pattern.length]) });
});

app.listen(5000, () => console.log("Сервер запущено на http://localhost:5000"));
