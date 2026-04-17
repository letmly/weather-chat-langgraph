import os
import httpx

OWM_URL = "https://api.openweathermap.org/data/2.5/weather"


async def fetch_weather(city: str) -> dict:
    api_key = os.getenv("OPENWEATHER_API_KEY")
    if not api_key:
        raise RuntimeError("OPENWEATHER_API_KEY is not set")

    params = {"q": city, "appid": api_key, "units": "metric", "lang": "ru"}
    async with httpx.AsyncClient(timeout=10.0) as client:
        r = await client.get(OWM_URL, params=params)
        r.raise_for_status()
        data = r.json()

    vis_m = data.get("visibility")
    return {
        "city": data.get("name", city),
        "country": data.get("sys", {}).get("country"),
        "temp": round(data["main"]["temp"]),
        "feels_like": round(data["main"]["feels_like"]),
        "condition": data["weather"][0]["description"],
        "icon": data["weather"][0]["icon"],
        "humidity": data["main"]["humidity"],
        "wind": round(data["wind"]["speed"], 1),
        "visibility_km": round(vis_m / 1000, 1) if vis_m else None,
        "pressure": data["main"].get("pressure"),
        "timestamp": data.get("dt"),
        "tz_offset": data.get("timezone", 0),
    }
