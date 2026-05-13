import { MapContainer, TileLayer, Marker, Polyline, ZoomControl, useMap } from "react-leaflet";
import { useEffect, useState, useRef } from "react";
import axios from "axios";
import L from "leaflet";
import markerIcon from "leaflet/dist/images/marker-icon.png";
import markerShadow from "leaflet/dist/images/marker-shadow.png";
import "leaflet/dist/leaflet.css";

delete L.Icon.Default.prototype._getIconUrl;
L.Icon.Default.mergeOptions({ iconUrl: markerIcon, shadowUrl: markerShadow });

const userIcon = L.divIcon({
  className: "",
  html: `<div class="user-marker"><div class="user-marker-pulse"></div><div class="user-marker-dot"></div></div>`,
  iconSize: [20, 20],
  iconAnchor: [10, 10],
});

// ─── Константи ────────────────────────────────────────────────────────────────
const API = process.env.REACT_APP_API_URL || "http://localhost:5000";
const COLOR_MAP = { green: "#22c55e", yellow: "#eab308", red: "#ef4444" };
const ALT_COLORS = ["#8b5cf6", "#06b6d4"];
const TABS = [
  { key: "route",    label: "Маршрут", icon: "🗺️" },
  { key: "history",  label: "Історія", icon: "🕐" },
  { key: "forecast", label: "Прогноз", icon: "📊" },
];
const DAYS = ["Нд","Пн","Вт","Ср","Чт","Пт","Сб"];
const REFRESH_INTERVAL = 2 * 60 * 1000;

// ─── Утиліти ──────────────────────────────────────────────────────────────────
const haversine = (lat1, lon1, lat2, lon2) => {
  const R = 6371, d2r = Math.PI / 180;
  const dLat = (lat2-lat1)*d2r, dLon = (lon2-lon1)*d2r;
  const a = Math.sin(dLat/2)**2 + Math.cos(lat1*d2r)*Math.cos(lat2*d2r)*Math.sin(dLon/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
};
const formatDist = (km) => km < 1 ? `${(km*1000).toFixed(0)} м` : `${km.toFixed(1)} км`;
const formatTime = (iso) => {
  const d = new Date(iso);
  return `${DAYS[d.getDay()]}, ${d.toLocaleDateString("uk-UA")} ${d.toLocaleTimeString("uk-UA",{hour:"2-digit",minute:"2-digit"})}`;
};
const arrivalTime = (durationSec) => {
  const t = new Date(Date.now() + durationSec * 1000);
  return t.toLocaleTimeString("uk-UA", { hour: "2-digit", minute: "2-digit" });
};

const CATEGORY_ICONS = {
  restaurant:"🍽️", cafe:"☕", bar:"🍺", fast_food:"🍔",
  supermarket:"🛒", shop:"🏪", hospital:"🏥", pharmacy:"💊",
  school:"🏫", university:"🎓", hotel:"🏨", fuel:"⛽",
  parking:"🅿️", bank:"🏦", park:"🌳", subway_entrance:"🚇",
  bus_stop:"🚌", train_station:"🚂", airport:"✈️", place:"🏙️",
};
const getCategoryIcon = (item) =>
  CATEGORY_ICONS[item.type?.toLowerCase()] || CATEGORY_ICONS[item.class?.toLowerCase()] || "📍";

function MapUpdater({ position, hasRoute }) {
  const map = useMap();
  useEffect(() => {
    if (position && !hasRoute) map.flyTo(position, 16);
  }, [position, map]);
  return null;
}

function TrafficBar({ g, y, r, height = 6 }) {
  return (
    <div style={{ display:"flex", borderRadius:4, overflow:"hidden", height }}>
      {g > 0 && <div style={{ flex:g, background:"#22c55e" }} />}
      {y > 0 && <div style={{ flex:y, background:"#eab308" }} />}
      {r > 0 && <div style={{ flex:Math.max(r,0), background:"#ef4444" }} />}
    </div>
  );
}

// ─── Головний компонент ───────────────────────────────────────────────────────
export default function MapView() {
  const [position, setPosition]     = useState(null);
  const [destination, setDestination] = useState(null);
  const [routes, setRoutes]         = useState([]);
  const [selectedIdx, setSelectedIdx] = useState(0);
  const [trafficLoading, setTrafficLoading] = useState(false);
  const [lastUpdated, setLastUpdated] = useState(null);
  const routeParamsRef = useRef(null);

  const [query, setQuery]           = useState("");
  const [suggestions, setSuggestions] = useState([]);
  const [inputFocused, setInputFocused] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [searchHistory, setSearchHistory] = useState(() => {
    try { return JSON.parse(localStorage.getItem("search_history") || "[]"); } catch { return []; }
  });

  const [activeTab, setActiveTab]   = useState("route");
  const [sidebarOpen, setSidebarOpen] = useState(window.innerWidth >= 768);
  const [isMobile, setIsMobile]     = useState(window.innerWidth < 768);

  const [user, setUser]             = useState(() => {
    try { return JSON.parse(localStorage.getItem("user") || "null"); } catch { return null; }
  });
  const [token, setToken]           = useState(() => localStorage.getItem("token") || null);
  const [authModal, setAuthModal]   = useState(null);
  const [authForm, setAuthForm]     = useState({ name: "", email: "", password: "" });
  const [authError, setAuthError]   = useState("");
  const [authLoading, setAuthLoading] = useState(false);
  const [routeHistory, setRouteHistory] = useState([]);
  const [forecastData, setForecastData] = useState([]);

  const selected = routes[selectedIdx] || null;

  // ─── Відстеження розміру вікна ───────────────────────────────────────────────
  useEffect(() => {
    const onResize = () => {
      const mobile = window.innerWidth < 768;
      setIsMobile(mobile);
      if (!mobile) setSidebarOpen(true);
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  // ─── Геолокація ──────────────────────────────────────────────────────────────
  useEffect(() => {
    const id = navigator.geolocation.watchPosition(
      (pos) => setPosition([pos.coords.latitude, pos.coords.longitude]),
      () => alert("Дозволь геолокацію"),
      { enableHighAccuracy: true, maximumAge: 2000, timeout: 10000 }
    );
    return () => navigator.geolocation.clearWatch(id);
  }, []);

  // ─── Пошук ──────────────────────────────────────────────────────────────────
  useEffect(() => {
    setActiveIndex(-1);
    if (!position || query.length < 2) { setSuggestions([]); return; }
    const [lat, lon] = position;
    const delta = 0.3;
    const t = setTimeout(() => {
      axios.get("https://nominatim.openstreetmap.org/search", {
        params: { q: query, format: "json", limit: 7, countrycodes: "ua",
          viewbox: `${lon-delta},${lat+delta},${lon+delta},${lat-delta}`, bounded: 0, addressdetails: 1 },
        headers: { "Accept-Language": "uk" }
      }).then(res => {
        setSuggestions(res.data.map(item => ({
          ...item, dist: haversine(lat, lon, parseFloat(item.lat), parseFloat(item.lon))
        })).sort((a,b) => a.dist - b.dist));
      }).catch(console.error);
    }, 280);
    return () => clearTimeout(t);
  }, [query, position]);

  // ─── Автооновлення ───────────────────────────────────────────────────────────
  useEffect(() => {
    if (!routeParamsRef.current) return;
    const interval = setInterval(() => fetchRoutes(routeParamsRef.current, false), REFRESH_INTERVAL);
    return () => clearInterval(interval);
  }, [routes.length]);

  // ─── Вкладки ────────────────────────────────────────────────────────────────
  useEffect(() => {
    if (activeTab === "history" && user) loadHistory();
    if (activeTab === "forecast") loadForecast();
  }, [activeTab]);

  const loadHistory = async () => {
    try {
      const res = await axios.get(`${API}/api/routes/history`, { headers: { Authorization: `Bearer ${token}` } });
      setRouteHistory(res.data);
    } catch (err) { console.error(err); }
  };

  const loadForecast = async () => {
    try {
      const res = await axios.get(`${API}/api/forecast`);
      setForecastData(res.data);
    } catch (err) { console.error(err); }
  };

  // ─── Авторизація ────────────────────────────────────────────────────────────
  const handleAuth = async (e) => {
    e.preventDefault();
    setAuthError(""); setAuthLoading(true);
    try {
      const endpoint = authModal === "login" ? "/api/auth/login" : "/api/auth/register";
      const res = await axios.post(`${API}${endpoint}`, authForm);
      localStorage.setItem("token", res.data.token);
      localStorage.setItem("user", JSON.stringify(res.data.user));
      setToken(res.data.token); setUser(res.data.user);
      setAuthModal(null); setAuthForm({ name: "", email: "", password: "" });
    } catch (err) {
      setAuthError(err.response?.data?.error || "Помилка");
    } finally { setAuthLoading(false); }
  };

  const logout = () => {
    localStorage.removeItem("token"); localStorage.removeItem("user");
    setToken(null); setUser(null);
  };

  // ─── Маршрути ────────────────────────────────────────────────────────────────
  const fetchRoutes = async ({ start, end, address, tok }, showLoading = true) => {
    if (showLoading) { setTrafficLoading(true); setRoutes([]); setSelectedIdx(0); }
    try {
      const res = await axios.get(`${API}/api/route`, {
        params: { start, end, address },
        headers: tok ? { Authorization: `Bearer ${tok}` } : {}
      });
      setRoutes(res.data.routes);
      setLastUpdated(new Date().toLocaleTimeString("uk-UA", { hour: "2-digit", minute: "2-digit" }));
    } catch (err) {
      console.error(err);
      if (showLoading) alert("Помилка побудови маршруту");
    } finally {
      if (showLoading) setTrafficLoading(false);
    }
  };

  const buildRoute = async (dest, label) => {
    const start = `${position[1]},${position[0]}`;
    const end   = `${dest[1]},${dest[0]}`;
    const params = { start, end, address: label, tok: token };
    routeParamsRef.current = params;
    await fetchRoutes(params, true);
  };

  const selectSuggestion = (item) => {
    const coords = [parseFloat(item.lat), parseFloat(item.lon)];
    const label  = (item.label || item.display_name.split(",").slice(0,2).join(",")).trim();
    setDestination(coords);
    setQuery(label); setSuggestions([]); setActiveIndex(-1);
    setSearchHistory(prev => {
      const next = [{ ...item, label }, ...prev.filter(h => h.place_id !== item.place_id)].slice(0,5);
      localStorage.setItem("search_history", JSON.stringify(next));
      return next;
    });
    if (isMobile) setSidebarOpen(false);
    buildRoute(coords, label);
  };

  const handleKeyDown = (e) => {
    if (!suggestions.length) return;
    if (e.key === "ArrowDown")  { e.preventDefault(); setActiveIndex(i => Math.min(i+1, suggestions.length-1)); }
    if (e.key === "ArrowUp")    { e.preventDefault(); setActiveIndex(i => Math.max(i-1, 0)); }
    if (e.key === "Enter" && activeIndex >= 0) selectSuggestion(suggestions[activeIndex]);
    if (e.key === "Escape")     { setSuggestions([]); setActiveIndex(-1); }
  };

  if (!position) return (
    <div style={{ height:"100vh", display:"flex", alignItems:"center", justifyContent:"center", background:"#0f172a", color:"white", fontFamily:"sans-serif", fontSize:18 }}>
      Отримуємо геолокацію...
    </div>
  );

  const displayColors = (r) => r.colors;

  // ─── Рендер ──────────────────────────────────────────────────────────────────
  return (
    <>
      {/* ═══ АВТОРИЗАЦІЙНА МОДАЛКА ═══ */}
      {authModal && (
        <div style={{ position:"fixed", inset:0, zIndex:3000, background:"rgba(0,0,0,0.75)", display:"flex", alignItems:"center", justifyContent:"center", padding:16 }}>
          <div style={{ background:"#1e293b", borderRadius:16, padding:isMobile ? 24 : 32, width:"100%", maxWidth:380, boxShadow:"0 20px 60px rgba(0,0,0,0.5)", fontFamily:"'Segoe UI',sans-serif" }}>
            <div style={{ fontSize:isMobile ? 18 : 20, fontWeight:700, color:"white", marginBottom:4 }}>
              {authModal === "login" ? "Вхід" : "Реєстрація"}
            </div>
            <div style={{ fontSize:12, color:"#64748b", marginBottom:20 }}>
              {authModal === "login" ? "Увійдіть для збереження маршрутів" : "Створіть акаунт для повного доступу"}
            </div>
            <form onSubmit={handleAuth}>
              {authModal === "register" && (
                <div style={{ marginBottom:12 }}>
                  <label style={{ fontSize:13, color:"#94a3b8", display:"block", marginBottom:6 }}>Ім'я</label>
                  <input placeholder="Ваше ім'я" value={authForm.name}
                    onChange={e => setAuthForm(f => ({ ...f, name: e.target.value }))}
                    style={{ width:"100%", padding:"12px 14px", borderRadius:10, border:"1.5px solid #334155", background:"#0f172a", color:"white", fontSize:15, boxSizing:"border-box", outline:"none" }} />
                </div>
              )}
              <div style={{ marginBottom:12 }}>
                <label style={{ fontSize:13, color:"#94a3b8", display:"block", marginBottom:6 }}>Email</label>
                <input type="email" placeholder="your@email.com" value={authForm.email}
                  onChange={e => setAuthForm(f => ({ ...f, email: e.target.value }))}
                  style={{ width:"100%", padding:"12px 14px", borderRadius:10, border:"1.5px solid #334155", background:"#0f172a", color:"white", fontSize:15, boxSizing:"border-box", outline:"none" }} />
              </div>
              <div style={{ marginBottom:20 }}>
                <label style={{ fontSize:13, color:"#94a3b8", display:"block", marginBottom:6 }}>Пароль</label>
                <input type="password" placeholder="••••••••" value={authForm.password}
                  onChange={e => setAuthForm(f => ({ ...f, password: e.target.value }))}
                  style={{ width:"100%", padding:"12px 14px", borderRadius:10, border:"1.5px solid #334155", background:"#0f172a", color:"white", fontSize:15, boxSizing:"border-box", outline:"none" }} />
              </div>
              {authError && <div style={{ color:"#ef4444", fontSize:13, marginBottom:14 }}>{authError}</div>}
              <button type="submit" disabled={authLoading} style={{ width:"100%", padding:"14px", borderRadius:10, border:"none", background: authLoading ? "#334155" : "#3b82f6", color:"white", fontSize:15, fontWeight:600, cursor:"pointer", marginBottom:14 }}>
                {authLoading ? "..." : authModal === "login" ? "Увійти" : "Зареєструватись"}
              </button>
            </form>
            <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center" }}>
              <span style={{ fontSize:13, color:"#64748b" }}>
                {authModal === "login" ? "Немає акаунту?" : "Вже є акаунт?"}
                <span onClick={() => { setAuthModal(authModal === "login" ? "register" : "login"); setAuthError(""); }}
                  style={{ color:"#3b82f6", cursor:"pointer", marginLeft:6 }}>
                  {authModal === "login" ? "Реєстрація" : "Увійти"}
                </span>
              </span>
              <span onClick={() => setAuthModal(null)} style={{ fontSize:13, color:"#475569", cursor:"pointer" }}>Закрити</span>
            </div>
          </div>
        </div>
      )}

      {/* ═══ OVERLAY ═══ */}
      {isMobile && sidebarOpen && (
        <div onClick={() => setSidebarOpen(false)}
          style={{ position:"fixed", top:0, left:0, right:0, bottom:0, zIndex:999, background:"rgba(0,0,0,0.55)" }} />
      )}

      {/* ═══ КНОПКА МЕНЮ ═══ */}
      {isMobile && (
        <button onClick={() => setSidebarOpen(o => !o)}
          style={{ position:"fixed", zIndex:1100, top:16, left:16, background:"#1e40af", border:"none", borderRadius:12, width:50, height:50, color:"white", fontSize:24, cursor:"pointer", boxShadow:"0 4px 16px rgba(0,0,0,0.5)", display:"flex", alignItems:"center", justifyContent:"center", touchAction:"manipulation" }}>
          {sidebarOpen ? "✕" : "☰"}
        </button>
      )}

      {/* ═══ САЙДБАР ═══ */}
      <div style={{
        position:"fixed", zIndex:1000, top:0, left:0, bottom:0,
        width: isMobile ? "85vw" : 320,
        background:"#0f172a", display:"flex", flexDirection:"column",
        boxShadow:"4px 0 24px rgba(0,0,0,0.5)", fontFamily:"'Segoe UI',sans-serif",
        color:"white", overflowY:"hidden",
        transform: sidebarOpen ? "translateX(0)" : "translateX(-100%)",
        transition: "transform 0.3s ease",
        willChange: "transform",
      }}>

        {/* Шапка */}
        <div style={{ background:"linear-gradient(135deg,#1e40af,#3b82f6)", padding: isMobile ? "14px 16px 12px" : "16px 16px 12px", flexShrink:0 }}>
          <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between" }}>
            <div style={{ display:"flex", alignItems:"center", gap:10 }}>
              <span style={{ fontSize: isMobile ? 22 : 24 }}>🚦</span>
              <div>
                <div style={{ fontSize: isMobile ? 16 : 17, fontWeight:700 }}>SmartTrafficAI</div>
                <div style={{ fontSize:10, opacity:0.75 }}>Оцінка та прогнозування трафіку</div>
              </div>
            </div>
            <div style={{ display:"flex", alignItems:"center", gap:8 }}>
              {user ? (
                <div style={{ textAlign:"right" }}>
                  <div style={{ fontSize:12, fontWeight:600 }}>{user.name}</div>
                  <span onClick={logout} style={{ fontSize:11, opacity:0.7, cursor:"pointer" }}>Вийти</span>
                </div>
              ) : (
                <button onClick={() => setAuthModal("login")} style={{ padding:"7px 14px", borderRadius:8, border:"1.5px solid rgba(255,255,255,0.4)", background:"transparent", color:"white", fontSize:13, cursor:"pointer" }}>
                  Увійти
                </button>
              )}
              {isMobile && (
                <button onClick={() => setSidebarOpen(false)}
                  style={{ background:"rgba(255,255,255,0.15)", border:"none", borderRadius:8, width:36, height:36, color:"white", fontSize:18, cursor:"pointer", display:"flex", alignItems:"center", justifyContent:"center", flexShrink:0 }}>
                  ✕
                </button>
              )}
            </div>
          </div>
        </div>

        {/* Вкладки */}
        <div style={{ display:"flex", background:"#0a1628", flexShrink:0 }}>
          {TABS.map(({ key, label, icon }) => (
            <button key={key} onClick={() => setActiveTab(key)}
              style={{ flex:1, padding: isMobile ? "12px 4px" : "10px 4px", border:"none",
                background: activeTab === key ? "#1e293b" : "transparent",
                borderBottom: activeTab === key ? "2px solid #3b82f6" : "2px solid transparent",
                color: activeTab === key ? "#60a5fa" : "#475569", cursor:"pointer",
                fontSize: isMobile ? 12 : 11, fontWeight: activeTab === key ? 700 : 400,
                display:"flex", flexDirection:"column", alignItems:"center", gap:3, transition:"all 0.2s" }}>
              <span style={{ fontSize: isMobile ? 18 : 14 }}>{icon}</span>{label}
            </button>
          ))}
        </div>

        {/* ─── ВКЛАДКА: МАРШРУТ ─── */}
        {activeTab === "route" && (
          <div style={{ flex:1, overflowY:"auto", display:"flex", flexDirection:"column" }}>

            {/* Пошук */}
            <div style={{ padding: isMobile ? "14px 16px 0" : "12px 14px 0" }}>
              <div style={{ display:"flex", alignItems:"center", gap:8, background:"#1e293b",
                border:`1.5px solid ${inputFocused ? "#3b82f6" : "#334155"}`,
                borderRadius:12, padding: isMobile ? "12px 14px" : "8px 12px", transition:"border-color 0.2s" }}>
                <span style={{ fontSize:16, opacity:0.5 }}>🔍</span>
                <input type="text" placeholder="Введіть адресу призначення..."
                  value={query} onChange={e => setQuery(e.target.value)}
                  onFocus={() => setInputFocused(true)}
                  onBlur={() => setTimeout(() => setInputFocused(false), 150)}
                  onKeyDown={handleKeyDown}
                  style={{ flex:1, background:"transparent", border:"none", outline:"none", color:"white", fontSize: isMobile ? 15 : 13 }} />
                {query && (
                  <span onClick={() => { setQuery(""); setSuggestions([]); }}
                    style={{ cursor:"pointer", opacity:0.5, fontSize:16, padding:"4px" }}>✕</span>
                )}
              </div>

              {inputFocused && query.length < 2 && searchHistory.length > 0 && (
                <div style={{ background:"#1e293b", borderRadius:12, marginTop:8, border:"1px solid #334155", overflow:"hidden" }}>
                  <div style={{ padding:"8px 14px 4px", fontSize:10, color:"#475569", textTransform:"uppercase", letterSpacing:0.8 }}>Нещодавні</div>
                  {searchHistory.map((item, i) => (
                    <div key={i} onClick={() => selectSuggestion(item)}
                      style={{ padding: isMobile ? "14px 14px" : "8px 12px", borderTop:"1px solid #1e3a5f", cursor:"pointer", fontSize: isMobile ? 14 : 12, display:"flex", alignItems:"center", gap:10 }}>
                      <span>🕐</span>
                      <span style={{ color:"#cbd5e1", overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>
                        {item.label || item.display_name.split(",").slice(0,2).join(",")}
                      </span>
                    </div>
                  ))}
                </div>
              )}

              {suggestions.length > 0 && (
                <div style={{ background:"#1e293b", borderRadius:12, marginTop:8, border:"1px solid #334155", overflow:"hidden" }}>
                  {suggestions.map((item, i) => (
                    <div key={i} onClick={() => selectSuggestion(item)}
                      style={{ padding: isMobile ? "14px 14px" : "9px 12px",
                        borderBottom: i < suggestions.length-1 ? "1px solid #1e3a5f" : "none",
                        cursor:"pointer", fontSize: isMobile ? 14 : 12, display:"flex", alignItems:"flex-start", gap:10,
                        background: i === activeIndex ? "#1e3a5f" : "transparent", transition:"background 0.1s" }}>
                      <span style={{ marginTop:1, flexShrink:0, fontSize: isMobile ? 16 : 14 }}>{getCategoryIcon(item)}</span>
                      <div style={{ minWidth:0 }}>
                        <div style={{ color:"#e2e8f0", overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>
                          {item.display_name.split(",").slice(0,2).join(",").trim()}
                        </div>
                        <div style={{ color:"#64748b", fontSize: isMobile ? 12 : 11, marginTop:2 }}>
                          {item.display_name.split(",").slice(2,4).join(",").trim()}
                        </div>
                        <div style={{ color:"#3b82f6", fontSize: isMobile ? 12 : 11, marginTop:2 }}>
                          {formatDist(item.dist)} від вас
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Маршрути */}
            {routes.length > 0 && (
              <div style={{ padding: isMobile ? "14px 16px 0" : "12px 14px 0" }}>
                <div style={{ fontSize:10, color:"#475569", marginBottom:8, textTransform:"uppercase", letterSpacing:0.8 }}>
                  {routes.length > 1 ? `${routes.length} маршрути` : "Маршрут"}
                  {lastUpdated && <span style={{ float:"right", color:"#334155" }}>оновлено {lastUpdated}</span>}
                </div>

                {routes.map((r, i) => {
                  const isSelected = i === selectedIdx;
                  const dotColor   = i === 0 ? "#3b82f6" : ALT_COLORS[i-1] || "#64748b";
                  return (
                    <div key={i} onClick={() => { setSelectedIdx(i); if (isMobile) setSidebarOpen(false); }}
                      style={{ background: isSelected ? "#1e3a5f" : "#1e293b",
                        border: `1.5px solid ${isSelected ? "#3b82f6" : "#334155"}`,
                        borderRadius:12, padding: isMobile ? "14px" : "10px 12px",
                        marginBottom:8, cursor:"pointer", transition:"all 0.2s" }}>
                      <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", marginBottom:8 }}>
                        <div style={{ display:"flex", alignItems:"center", gap:8 }}>
                          <div style={{ width:12, height:12, borderRadius:"50%", background:dotColor, flexShrink:0 }} />
                          <span style={{ fontSize: isMobile ? 14 : 12, fontWeight:600, color: isSelected ? "#60a5fa" : "#94a3b8" }}>
                            {i === 0 ? "Рекомендований" : `Альтернатива ${i}`}
                          </span>
                        </div>
                        {isSelected && trafficLoading && <span style={{ fontSize:12, color:"#64748b" }}>⏳</span>}
                      </div>

                      <div style={{ display:"flex", gap:10, marginBottom:8 }}>
                        {[
                          { val: (r.distance/1000).toFixed(1), label: "км" },
                          { val: Math.round(r.duration/60), label: "хв" },
                          { val: arrivalTime(r.duration), label: "прибуття", color: "#22c55e" },
                        ].map(({ val, label, color }) => (
                          <div key={label} style={{ textAlign:"center", flex:1 }}>
                            <div style={{ fontSize: isMobile ? 20 : 18, fontWeight:700, color: color || "#e2e8f0" }}>{val}</div>
                            <div style={{ fontSize: isMobile ? 11 : 10, color:"#64748b" }}>{label}</div>
                          </div>
                        ))}
                      </div>

                      <TrafficBar g={r.pct_green} y={r.pct_yellow} r={r.pct_red} height={isMobile ? 8 : 6} />
                    </div>
                  );
                })}

                {!user && (
                  <div style={{ fontSize: isMobile ? 13 : 11, color:"#475569", textAlign:"center", marginTop:6 }}>
                    <span onClick={() => setAuthModal("login")} style={{ color:"#3b82f6", cursor:"pointer" }}>Увійдіть</span>, щоб зберегти маршрут
                  </div>
                )}
              </div>
            )}

            {/* Легенда */}
            <div style={{ padding: isMobile ? "14px 16px 0" : "12px 14px 0" }}>
              <div style={{ background:"#1e293b", borderRadius:12, border:"1px solid #334155", padding: isMobile ? "12px 14px" : "10px 12px" }}>
                {[
                  { color:"#22c55e", label:"Вільний рух" },
                  { color:"#eab308", label:"Помірна завантаженість" },
                  { color:"#ef4444", label:"Затор" },
                ].map(({ color, label }) => (
                  <div key={color} style={{ display:"flex", alignItems:"center", gap:10, marginBottom:6 }}>
                    <div style={{ width:28, height:6, borderRadius:3, background:color, flexShrink:0 }} />
                    <span style={{ fontSize: isMobile ? 13 : 12, color:"#cbd5e1" }}>{label}</span>
                  </div>
                ))}
              </div>
            </div>

            <div style={{ padding:"10px 16px 16px", fontSize:10, color:"#334155", textAlign:"center" }}>
              Дані трафіку: Mapbox Traffic API
            </div>
          </div>
        )}

        {/* ─── ВКЛАДКА: ІСТОРІЯ ─── */}
        {activeTab === "history" && (
          <div style={{ flex:1, overflowY:"auto", padding: isMobile ? 16 : 14 }}>
            {!user ? (
              <div style={{ textAlign:"center", padding:"40px 0" }}>
                <div style={{ fontSize:40, marginBottom:12 }}>🔒</div>
                <div style={{ color:"#94a3b8", fontSize: isMobile ? 15 : 14, marginBottom:20 }}>
                  Увійдіть, щоб бачити<br/>історію маршрутів
                </div>
                <button onClick={() => setAuthModal("login")}
                  style={{ padding:"12px 28px", borderRadius:10, border:"none", background:"#3b82f6", color:"white", fontSize: isMobile ? 15 : 13, cursor:"pointer", fontWeight:600 }}>
                  Увійти
                </button>
              </div>
            ) : routeHistory.length === 0 ? (
              <div style={{ textAlign:"center", padding:"40px 0", color:"#475569", fontSize: isMobile ? 14 : 13 }}>
                <div style={{ fontSize:40, marginBottom:12 }}>🗺️</div>
                Ще немає збережених маршрутів.<br/>Побудуйте перший!
              </div>
            ) : (
              <>
                <div style={{ fontSize:10, color:"#475569", marginBottom:12, textTransform:"uppercase", letterSpacing:0.8 }}>
                  Останні {routeHistory.length} маршрутів
                </div>
                {routeHistory.map(r => (
                  <div key={r.id} style={{ background:"#1e293b", borderRadius:12, border:"1px solid #334155", padding: isMobile ? 14 : 12, marginBottom:10 }}>
                    <div style={{ fontSize: isMobile ? 14 : 13, color:"#e2e8f0", marginBottom:6, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>
                      📍 {r.end_address}
                    </div>
                    <div style={{ display:"flex", gap:12, fontSize: isMobile ? 12 : 11, color:"#64748b", marginBottom:10 }}>
                      <span>🛣 {r.distance_km} км</span>
                      <span>⏱ {r.duration_min} хв</span>
                      <span style={{ marginLeft:"auto" }}>{formatTime(r.created_at)}</span>
                    </div>
                    <TrafficBar g={r.pct_green} y={r.pct_yellow} r={r.pct_red} height={isMobile ? 8 : 6} />
                  </div>
                ))}
              </>
            )}
          </div>
        )}

        {/* ─── ВКЛАДКА: ПРОГНОЗ ─── */}
        {activeTab === "forecast" && (
          <div style={{ flex:1, overflowY:"auto", padding: isMobile ? 16 : 14 }}>
            <div style={{ fontSize:10, color:"#475569", marginBottom:4, textTransform:"uppercase", letterSpacing:0.8 }}>
              Прогноз завантаженості по годинах
            </div>
            <div style={{ fontSize:11, color:"#334155", marginBottom:14 }}>
              На основі накопичених даних усіх користувачів
            </div>

            {forecastData.length === 0 ? (
              <div style={{ textAlign:"center", padding:"30px 0", color:"#475569", fontSize: isMobile ? 14 : 13 }}>
                <div style={{ fontSize:40, marginBottom:12 }}>📊</div>
                Дані накопичуються.<br/>Будуйте маршрути — і тут з'явиться прогноз.
              </div>
            ) : (
              <>
                {(() => {
                  const now = new Date().getHours();
                  const cur = forecastData.find(d => d.hour_of_day === now);
                  if (!cur) return null;
                  const status = cur.avg_red > 30 ? "🔴 Очікуються затори" : cur.avg_yellow > 30 ? "🟡 Помірний рух" : "🟢 Вільно";
                  return (
                    <div style={{ background:"#1e3a5f", borderRadius:12, border:"1px solid #3b82f6", padding:"14px 16px", marginBottom:14 }}>
                      <div style={{ fontSize:11, color:"#60a5fa", marginBottom:4 }}>Зараз {now}:00</div>
                      <div style={{ fontSize: isMobile ? 16 : 14, fontWeight:600, color:"white" }}>{status}</div>
                      <div style={{ fontSize:12, color:"#64748b", marginTop:4 }}>{cur.samples} спостережень</div>
                    </div>
                  );
                })()}

                <div style={{ background:"#1e293b", borderRadius:12, border:"1px solid #334155", padding:"14px 10px" }}>
                  <div style={{ display:"flex", alignItems:"flex-end", gap:2, height:100, marginBottom:6 }}>
                    {Array.from({ length:24 }, (_, h) => {
                      const d = forecastData.find(f => f.hour_of_day === h);
                      const isNow = h === new Date().getHours();
                      if (!d) return <div key={h} style={{ flex:1 }} />;
                      return (
                        <div key={h} title={`${h}:00 — зел:${d.avg_green}% жов:${d.avg_yellow}% чер:${d.avg_red}%`}
                          style={{ flex:1, display:"flex", flexDirection:"column", justifyContent:"flex-end",
                            outline: isNow ? "1.5px solid #3b82f6" : "none", borderRadius:2 }}>
                          {d.avg_red    > 0 && <div style={{ height:`${d.avg_red}%`,    background:"#ef4444", borderRadius:"2px 2px 0 0" }} />}
                          {d.avg_yellow > 0 && <div style={{ height:`${d.avg_yellow}%`, background:"#eab308" }} />}
                          {d.avg_green  > 0 && <div style={{ height:`${d.avg_green}%`,  background:"#22c55e" }} />}
                        </div>
                      );
                    })}
                  </div>
                  <div style={{ display:"flex", gap:2 }}>
                    {Array.from({ length:24 }, (_, h) => (
                      <div key={h} style={{ flex:1, textAlign:"center", fontSize:8,
                        color: h === new Date().getHours() ? "#60a5fa" : "#334155",
                        fontWeight: h === new Date().getHours() ? 700 : 400 }}>
                        {h % 3 === 0 ? h : ""}
                      </div>
                    ))}
                  </div>
                </div>

                <div style={{ marginTop:14 }}>
                  <div style={{ fontSize:10, color:"#475569", marginBottom:10, textTransform:"uppercase", letterSpacing:0.8 }}>
                    Найзавантаженіші години
                  </div>
                  {[...forecastData].sort((a,b) => (b.avg_red+b.avg_yellow)-(a.avg_red+a.avg_yellow)).slice(0,3).map(d => (
                    <div key={d.hour_of_day} style={{ display:"flex", alignItems:"center", gap:10, padding: isMobile ? "12px 0" : "8px 0", borderBottom:"1px solid #1e293b" }}>
                      <div style={{ fontSize: isMobile ? 14 : 13, color:"#60a5fa", fontWeight:700, width:40 }}>
                        {String(d.hour_of_day).padStart(2,"0")}:00
                      </div>
                      <div style={{ flex:1 }}><TrafficBar g={d.avg_green} y={d.avg_yellow} r={d.avg_red} height={isMobile ? 10 : 8} /></div>
                      <div style={{ fontSize: isMobile ? 12 : 11, color:"#ef4444", width:36, textAlign:"right" }}>{d.avg_red}% 🔴</div>
                    </div>
                  ))}
                </div>
              </>
            )}
          </div>
        )}
      </div>

      {/* ═══ КАРТА ═══ */}
      <div style={{ marginLeft: isMobile ? 0 : 320, height:"100vh" }}>
        <MapContainer center={position} zoom={16} style={{ height:"100%", width:"100%" }} zoomControl={false}>
          <MapUpdater position={position} hasRoute={routes.length > 0} />
          <ZoomControl position="bottomright" />
          <TileLayer url="https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png"
            attribution='&copy; <a href="https://carto.com/">CARTO</a>' />

          <Marker position={position} icon={userIcon} />
          {destination && <Marker position={destination} />}

          {routes.map((r, i) => {
            if (i === selectedIdx) return null;
            return (
              <Polyline key={`alt-${i}`} positions={r.geometry}
                color={ALT_COLORS[i-1] || "#64748b"} weight={4} opacity={0.5} />
            );
          })}

          {selected && displayColors(selected).length > 0 &&
            selected.geometry.map((_, i) => {
              if (i === selected.geometry.length - 1) return null;
              const colors = displayColors(selected);
              return (
                <Polyline key={`seg-${i}`}
                  positions={[selected.geometry[i], selected.geometry[i+1]]}
                  color={COLOR_MAP[colors[i]] || "#22c55e"}
                  weight={6} opacity={0.9} />
              );
            })
          }

          {trafficLoading && routes.length === 0 && destination && (
            <Polyline positions={[position, destination]} color="#3b82f6" weight={4} opacity={0.4} dashArray="8" />
          )}
        </MapContainer>
      </div>
    </>
  );
}
