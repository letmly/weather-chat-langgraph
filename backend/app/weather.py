import os
import logging
import httpx

logger = logging.getLogger("weather")

OWM_URL = "https://api.openweathermap.org/data/2.5/weather"


class WeatherError(Exception):
    """Человекочитаемая ошибка от тула погоды — попадёт в ToolMessage
    и LLM сможет сослаться на неё в ответе."""


async def fetch_weather(city: str) -> dict:
    api_key = os.getenv("OPENWEATHER_API_KEY")
    if not api_key:
        raise WeatherError("OPENWEATHER_API_KEY не задан")

    params = {"q": city, "appid": api_key, "units": "metric", "lang": "ru"}
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            r = await client.get(OWM_URL, params=params)
    except httpx.TimeoutException:
        raise WeatherError(f"Таймаут при запросе погоды в {city!r}")
    except httpx.HTTPError as e:
        raise WeatherError(f"Сетевая ошибка: {e.__class__.__name__}")

    if r.status_code == 404:
        raise WeatherError(f"Город {city!r} не найден в базе OpenWeatherMap")
    if r.status_code == 401:
        raise WeatherError("OPENWEATHER_API_KEY невалиден или ещё не активирован")
    if r.status_code == 429:
        raise WeatherError("Превышен лимит запросов к OpenWeatherMap")
    if r.status_code >= 500:
        raise WeatherError(f"OpenWeatherMap вернул {r.status_code}, попробуйте позже")
    if r.status_code != 200:
        raise WeatherError(f"OpenWeatherMap вернул {r.status_code}: {r.text[:200]}")

    try:
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
    except (KeyError, ValueError) as e:
        logger.exception("OWM вернул неожиданный JSON: %s", r.text[:500])
        raise WeatherError(f"Неожиданный формат ответа OWM: {e}")
