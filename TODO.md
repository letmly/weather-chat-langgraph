# Weather Chat — TODO и соответствие ТЗ

## Статус по требованиям ТЗ

### 1. Backend: LangGraph агент с инструментами

| Пункт                                              | Статус | Где                                                                  |
| -------------------------------------------------- | ------ | -------------------------------------------------------------------- |
| Агент на LangGraph                                 | ✅     | `backend/app/agent.py` — `StateGraph` + узлы `model`/`tools`         |
| Тул `get_weather(city)`                            | ✅     | `agent.py:28` — `@tool async def get_weather`                        |
| Реальный вызов OpenWeatherMap                      | ✅     | `backend/app/weather.py` — httpx → `/data/2.5/weather`               |
| **Structured response (text + ui_event)**          | ✅     | см. раздел «Как устроен structured response» ниже                    |
| FastAPI `POST /chat`                               | ✅     | `backend/app/main.py:49` — `chat(req)`                               |
| Streaming SSE                                      | ✅     | `main.py:57` — `EventSourceResponse(event_gen())` + sse-starlette    |
| OpenRouter как LLM-провайдер                       | ✅     | `agent.py:_build_llm` — `ChatOpenAI(base_url=OPENROUTER_BASE_URL)`   |

### 2. Frontend: чат-интерфейс

| Пункт                          | Статус        | Где                                                    |
| ------------------------------ | ------------- | ------------------------------------------------------ |
| React                          | ✅            | `frontend/src/App.tsx` (Vite + React + TS + Tailwind)  |
| Поле ввода + кнопка            | ✅            | `App.tsx` — `<textarea>` + «Отправить»                 |
| История сообщений user/assist. | ✅            | `messages: Message[]` + `<Bubble>`                     |
| Индикатор загрузки             | ✅            | `TypingDots` пока `msg.pending && !msg.text`           |
| Парсинг SSE                    | ✅            | `frontend/src/sse.ts` — `fetch` + `ReadableStream`     |
| **Дизайн по мокапу**           | 🟡 в работе   | см. раздел «Редизайн» ниже                             |

### 3. Состояние и память (бонус)

| Пункт                                          | Статус | Где                                                                  |
| ---------------------------------------------- | ------ | -------------------------------------------------------------------- |
| История в state LangGraph-а                    | ✅     | `State.messages` + `add_messages` reducer                            |
| Передача контекста LLM между репликами         | ✅     | `MemorySaver` + `thread_id` из `meta`-события                        |
| Переиспользование `thread_id` на фронте        | ✅     | `App.tsx` — `threadIdRef`, хранится между сообщениями                |

### 4. Сдача

| Пункт                            | Статус        |
| -------------------------------- | ------------- |
| README с 2 командами             | ✅ (`README.md`) |
| `docker-compose.yml`             | ✅            |
| `.env.example`                   | ✅            |
| Скриншот/GIF                     | ⏳ сделать после редизайна |

---

## Как устроен structured response (text + ui_event)

ТЗ: «финальная нода возвращает structured payload с `text` (для LLM) и `ui_event` (для фронта). Фронт их разделяет и рендерит виджет».

У нас это реализовано через **SSE-события с разными именами**, а не через один JSON-объект — это тот же контракт, только стримящийся. События:

1. `meta` — `{ "thread_id": "..." }` (для памяти)
2. `ui_event` — `{ "type": "weather_card", "payload": { city, temp, feels_like, condition, icon, humidity, wind, country } }`
3. `token` — дельта текста LLM (собирается на фронте в `msg.text`)
4. `done` — конец стрима

Где это делается на бэке — `backend/app/agent.py`, функция `stream_chat`:

```python
async for event in GRAPH.astream_events(inputs, config=config, version="v2"):
    kind = event["event"]

    if kind == "on_chat_model_stream":
        chunk = event["data"]["chunk"]
        if chunk.content:
            yield {"type": "token", "data": chunk.content}        # ← текст

    elif kind == "on_tool_end" and event.get("name") == "get_weather":
        parsed = json.loads(payload)
        if "error" not in parsed:
            yield {                                                # ← UI event
                "type": "ui_event",
                "data": {"type": "weather_card", "payload": parsed},
            }
```

Источник `payload` — сырой ответ OpenWeatherMap, нормализованный в `weather.py:fetch_weather`:

```python
{
  "city": "Берлин",
  "country": "DE",
  "temp": 17,            # °C
  "feels_like": 16,
  "condition": "ясно",
  "icon": "01d",         # код иконки OWM
  "humidity": 46,        # %
  "wind": 4.1,           # м/с
}
```

Фронт разделяет потоки в `frontend/src/App.tsx`, функция `send` — колбэк `onEvent` по имени события кладёт либо в `msg.text` (токены), либо в `msg.uiEvents` (weather card). В `Bubble` рендерится текстовый пузырь + под ним `<WeatherCard>`.

---

## Текущие проблемы

- [x] ~~SSE виснет в браузере (POST /chat в pending)~~ — Vite dev-прокси буферит, переключаемся на прямой вызов бэка через `VITE_API_URL=http://localhost:8000` (CORS уже открыт).
- [ ] Погодная карточка и пузыри чата выглядят кустарно — нужен редизайн по мокапу.

---

## Редизайн

### Общий чат

- Фон чата: контрастный тёмно-серый (`#1a1b1e` / `slate-950`), а не тёмно-синий.
- Максимальная ширина сообщения: ~70% контейнера.
- Сообщения с «хвостиками»: ассиметричный `border-radius` — у юзера маленький радиус в правом верхнем углу (`rounded-tr-md`), у ассистента — в левом верхнем (`rounded-tl-md`).

### Пузырь пользователя (справа)

- Фон: синий/индиго (`bg-sky-500` или `bg-indigo-500`), текст белый.
- Лёгкий градиент/насыщенный цвет без рамки.

### Пузырь ассистента (слева)

- Фон: полупрозрачный `bg-white/5` или `bg-slate-800/60`.
- Лёгкая окантовка `ring-1 ring-white/10`.
- Читаемый светлый текст.

### Weather card (по второму скриншоту)

Структура:
- Крупная карточка с фон-изображением/градиентом, отражающим текущую погоду (по `icon`-коду OWM: ясно → тёплый закат, облачно → серо-синий, дождь → синий, ночь → тёмный).
- **Левый верх** / правый верх: `Berlin, DE` (город) и едва заметное время справа.
- **Слева снизу**: огромный температурный акцент `17°` (шрифт ~5xl).
- **Справа снизу**: название состояния `Broken Clouds` крупнее, под ним — `Feels like 16°` мельче/полупрозрачно.
- Ниже карточки: ряд мини-чипов со статистикой — Wind / Humidity / Visibility (то, что реально отдаёт OWM в бесплатном `/weather`).

Технически:
- `WeatherCard.tsx` переписать: условный `bg-gradient-to-br` по `icon`-коду + иконка OWM большая полупрозрачная на фоне.
- Сетка 3 чипа снизу вместо текущей 3-колоночной.

---

## Next steps (в порядке выполнения)

1. [x] Логирование на бэке (видим цепочку model → tool → model).
2. [ ] Починить зависание SSE через прямой вызов бэка (минуя Vite proxy).
3. [ ] Редизайн `App.tsx` (фон чата + пузыри с ассиметричным радиусом).
4. [ ] Редизайн `WeatherCard.tsx` (фото-градиент, большой temp, feels_like, чипы статистики).
5. [ ] Прокинуть `visibility` из OWM в payload `ui_event`.
6. [ ] Скриншот финального UI в README.
