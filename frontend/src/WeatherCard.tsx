import type { WeatherPayload } from "./types";

/**
 * Градиент зависит от icon-кода OWM:
 *   01 — ясно, 02/03/04 — облака, 09/10 — дождь, 11 — гроза,
 *   13 — снег, 50 — туман. Суффикс d/n — день/ночь.
 */
function bgForIcon(icon: string): string {
  const code = icon.slice(0, 2);
  const isNight = icon.endsWith("n");
  if (isNight) {
    if (code === "01") return "from-indigo-800 via-slate-800 to-slate-950";
    if (code === "02" || code === "03" || code === "04")
      return "from-slate-800 via-slate-900 to-slate-950";
    if (code === "09" || code === "10") return "from-slate-900 via-blue-950 to-slate-950";
    if (code === "11") return "from-indigo-950 via-purple-950 to-black";
    if (code === "13") return "from-slate-700 via-slate-800 to-slate-950";
    return "from-slate-800 to-slate-950";
  }
  if (code === "01") return "from-amber-300 via-orange-400 to-rose-400";
  if (code === "02") return "from-sky-300 via-sky-400 to-indigo-500";
  if (code === "03" || code === "04") return "from-slate-400 via-slate-500 to-slate-700";
  if (code === "09" || code === "10") return "from-slate-500 via-sky-700 to-slate-800";
  if (code === "11") return "from-slate-700 via-indigo-800 to-slate-900";
  if (code === "13") return "from-sky-100 via-slate-300 to-slate-500";
  if (code === "50") return "from-slate-300 via-slate-400 to-slate-600";
  return "from-sky-400 to-indigo-600";
}

function formatLocalTime(ts?: number, tzOffset?: number): string | null {
  if (!ts) return null;
  const d = new Date((ts + (tzOffset ?? 0)) * 1000);
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mm = String(d.getUTCMinutes()).padStart(2, "0");
  return `${hh}:${mm}`;
}

export function WeatherCard({ data }: { data: WeatherPayload }) {
  const gradient = bgForIcon(data.icon);
  const iconUrl = `https://openweathermap.org/img/wn/${data.icon}@4x.png`;
  const time = formatLocalTime(data.timestamp, data.tz_offset);

  return (
    <div className="mt-2 w-full max-w-md">
      <div
        className={`relative overflow-hidden rounded-2xl bg-gradient-to-br ${gradient} p-4 text-white shadow-lg ring-1 ring-white/10 sm:p-5`}
      >
        <WeatherGlyph icon={data.icon} iconUrl={iconUrl} />

        <div className="relative flex items-start justify-between gap-2">
          <div className="truncate text-sm font-medium opacity-90">
            {data.city}
            {data.country ? `, ${data.country}` : ""}
          </div>
          {time && <div className="shrink-0 text-xs opacity-60">{time}</div>}
        </div>

        <div className="relative mt-10 flex items-end justify-between gap-3 sm:mt-12">
          <div className="text-5xl font-light leading-none tracking-tight sm:text-6xl">
            {data.temp}°
          </div>
          <div className="min-w-0 text-right">
            <div className="truncate text-sm font-medium capitalize leading-tight sm:text-base">
              {data.condition}
            </div>
            <div className="text-[11px] opacity-70 sm:text-xs">Ощущается {data.feels_like}°</div>
          </div>
        </div>
      </div>

      <div className="mt-2 grid grid-cols-[repeat(auto-fit,minmax(5.5rem,1fr))] gap-2">
        <Chip icon="💨" label="Ветер" value={`${data.wind} м/с`} />
        <Chip icon="💧" label="Влажность" value={`${data.humidity}%`} />
        <Chip
          icon="👁"
          label="Видимость"
          value={data.visibility_km != null ? `${data.visibility_km} км` : "—"}
        />
      </div>
    </div>
  );
}

function WeatherGlyph({ icon, iconUrl }: { icon: string; iconUrl: string }) {
  const base =
    "pointer-events-none absolute -right-4 -top-4 h-32 w-32 sm:h-40 sm:w-40";

  // Ясная ночь: OWM отдаёт блёклую заготовку, рисуем свою яркую луну.
  if (icon === "01n") {
    return (
      <svg
        aria-hidden
        viewBox="0 0 64 64"
        className={`${base} drop-shadow-[0_0_16px_rgba(255,235,160,0.55)]`}
      >
        <defs>
          <radialGradient id="moon" cx="38%" cy="38%" r="60%">
            <stop offset="0%" stopColor="#fff7d6" />
            <stop offset="70%" stopColor="#ffe08a" />
            <stop offset="100%" stopColor="#e6b84a" />
          </radialGradient>
        </defs>
        <circle cx="32" cy="32" r="18" fill="url(#moon)" />
        <circle cx="27" cy="28" r="2.4" fill="#d9a535" opacity="0.45" />
        <circle cx="37" cy="35" r="1.8" fill="#d9a535" opacity="0.4" />
        <circle cx="30" cy="38" r="1.2" fill="#d9a535" opacity="0.35" />
      </svg>
    );
  }

  return (
    <img
      src={iconUrl}
      alt=""
      aria-hidden
      className={`${base} opacity-90 drop-shadow-[0_0_12px_rgba(255,255,255,0.35)]`}
    />
  );
}

function Chip({ icon, label, value }: { icon: string; label: string; value: string }) {
  return (
    <div className="min-w-0 rounded-xl bg-white/[0.04] px-3 py-2 ring-1 ring-white/10">
      <div className="flex items-center gap-1 text-[10px] uppercase leading-tight tracking-wide text-slate-400">
        <span aria-hidden className="shrink-0">{icon}</span>
        <span className="break-words">{label}</span>
      </div>
      <div className="mt-1 text-sm font-medium text-slate-100">{value}</div>
    </div>
  );
}
